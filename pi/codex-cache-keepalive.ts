import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

// Keeps the OpenAI Codex prompt cache warm while a Pi session sits idle.
// GPT-6.x caches live about 30 minutes and every read extends them, so after
// PI_CODEX_KEEPALIVE_MS (default 25 min) without a request this re-sends the
// last request's transcript plus a tiny prompt. The reply never enters the
// session. It stops when pings would cost more than one cache rebuild (from the
// model's prices; PI_CODEX_KEEPALIVE_MAX_PINGS caps it further) or when a ping
// misses the cache. PI_CODEX_KEEPALIVE=off disables it.

const PROVIDER = "openai-codex";
const PING_TEXT = "Prompt-cache keep-alive ping. Do not use tools or do anything. Reply with exactly: ok";
// Smaller prompts are cheap to rebuild; PI_CODEX_KEEPALIVE_MIN_TOKENS overrides (tests).
const MIN_PROMPT_TOKENS = Number(process.env.PI_CODEX_KEEPALIVE_MIN_TOKENS ?? 20_000);
const DEFAULT_MAX_PINGS = 24;

type Model = NonNullable<ExtensionContext["model"]>;

function enabled(): boolean {
  return !["off", "0", "false", "no"].includes((process.env.PI_CODEX_KEEPALIVE ?? "").toLowerCase());
}

function delayMs(): number {
  return Number(process.env.PI_CODEX_KEEPALIVE_MS) || 25 * 60_000;
}

/** Pings that still cost less than one rebuild, like Pi's own warmer reckons it. */
function maxPings(model: Model): number {
  const envCap = Number(process.env.PI_CODEX_KEEPALIVE_MAX_PINGS) || Infinity;
  const read = model.cost?.cacheRead ?? 0;
  const miss = (model.cost?.cacheWrite ?? 0) > 0 ? model.cost.cacheWrite : (model.cost?.input ?? 0);
  const breakEven = read > 0 && miss > read ? Math.ceil((miss - read) / read - 1e-9) - 1 : DEFAULT_MAX_PINGS;
  return Math.max(0, Math.min(breakEven, envCap));
}

function log(sessionId: string, text: string): void {
  try {
    appendFileSync(join(getAgentDir(), "cache-keepalive.log"), `${new Date().toISOString()} codex ${sessionId.slice(0, 8)} ${text}\n`);
  } catch {}
}

/** Prompt size of the latest real request on the branch, as the provider reported it. */
function lastPromptTokens(ctx: ExtensionContext): number {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type: string; message?: { role: string; usage?: { input: number; cacheRead: number; cacheWrite: number } } };
    if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
      const u = entry.message.usage;
      return u.input + u.cacheRead + u.cacheWrite;
    }
  }
  return 0;
}

export default function (pi: ExtensionAPI) {
  let last: { model: Model; messages: unknown[] } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pings = 0;
  // Bumped by every real request, so a ping that was in flight then is ignored.
  let gen = 0;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const status = (ctx: ExtensionContext, text: string | undefined) => {
    try { ctx.ui.setStatus("cache-keepalive", text); } catch {}
  };

  const stop = (ctx: ExtensionContext, reason: string) => {
    clear();
    log(ctx.sessionManager.getSessionId(), `stopped: ${reason}`);
    status(ctx, `cache keep-alive: stopped (${reason})`);
  };

  const arm = (ctx: ExtensionContext) => {
    clear();
    if (!enabled() || !last) return;
    const cap = maxPings(last.model);
    if (pings >= cap) return stop(ctx, `${pings}/${cap} pings used`);
    if (lastPromptTokens(ctx) < MIN_PROMPT_TOKENS) return status(ctx, undefined);
    const delay = delayMs();
    timer = setTimeout(() => void ping(ctx), delay);
    timer.unref?.();
    const at = new Date(Date.now() + delay).toTimeString().slice(0, 5);
    status(ctx, `cache keep-alive: on | next ping ${at} | ${pings}/${cap}`);
  };

  const ping = async (ctx: ExtensionContext) => {
    timer = undefined;
    if (!last) return;
    if (!ctx.isIdle()) return arm(ctx);
    const myGen = gen;
    const sessionId = ctx.sessionManager.getSessionId();
    const messages = [
      ...convertToLlm(last.messages as Parameters<typeof convertToLlm>[0]),
      { role: "user" as const, content: [{ type: "text" as const, text: PING_TEXT }], timestamp: Date.now() },
    ];
    const level = pi.getThinkingLevel();
    let result;
    try {
      result = await ctx.modelRegistry
        .streamSimple(last.model, { messages } as Parameters<typeof ctx.modelRegistry.streamSimple>[1], {
          sessionId,
          reasoning: level === "off" ? undefined : level,
          maxRetries: 0,
        } as Parameters<typeof ctx.modelRegistry.streamSimple>[2])
        .result();
    } catch (err) {
      if (gen === myGen) stop(ctx, `ping failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (gen !== myGen || !last) return;
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      return stop(ctx, `ping failed: ${result.errorMessage ?? result.stopReason}`);
    }
    const u = result.usage;
    const total = u.input + u.cacheRead + u.cacheWrite;
    pings += 1;
    log(sessionId, `ping ${pings}/${maxPings(last.model)} ${last.model.id} read=${u.cacheRead} write=${u.cacheWrite} input=${u.input} output=${u.output}`);
    // Mostly uncached means the entry had already gone: more pings would only pay for rebuilds.
    if (total === 0 || u.cacheRead / total < 0.5) return stop(ctx, "ping missed the cache");
    arm(ctx);
  };

  // Every real request: remember exactly what was sent and start the count over.
  pi.on("context_with_system", (event, ctx) => {
    gen += 1;
    pings = 0;
    clear();
    last = ctx.model?.provider === PROVIDER ? { model: ctx.model, messages: event.messages } : undefined;
    return undefined;
  });

  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted || !last) return;
    arm(ctx);
  });

  pi.on("session_shutdown", () => {
    clear();
    last = undefined;
  });
}
