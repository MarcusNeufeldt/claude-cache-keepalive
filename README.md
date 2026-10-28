# claude-cache-keepalive

Keeps prompt caches warm while a session sits idle: Claude Code (instead of idle compaction, "Compacted while idle, before the prompt cache expired") and Pi (claude-bridge and openai-codex).

> **Required for Claude Code: turn idle compaction off.** Since v2.1.299, Claude Code compacts a 200K+ token conversation that has been idle for about 54 minutes, just before its one-hour cache expires. That compaction runs before the keep-alive ping would, so with it on the ping never gets a chance and you get a summary instead of your full conversation. Turn it off with `"idleCompaction": false` in `~/.claude/settings.json` (or the "Idle compaction" row in `/config`). `install.py` sets it for you. Normal auto-compaction, when the context window is full, stays on.

## What's in here

| Path | What it is |
|---|---|
| `plugins/cache-refresher/` | [olddonkey/cache-refresher](https://github.com/olddonkey/cache-refresher) (MIT) at upstream commit `30d5b56` (v0.2.2), with three local patches |
| `patches/` | The local patches as `git format-patch` files, for re-applying on a newer upstream |
| `.claude-plugin/marketplace.json` | Makes this repo a Claude Code plugin marketplace |
| `install.py` | Applies everything to this machine |

Local patches:
1. Auto-refresh is **on by default** with cap 200, so the plugin's own break-even rule decides when to stop (about 37 pings, roughly 34 h after the last message on Opus 5.5).
2. A pinned status line under the prompt: `cache keep-alive: on | warm 55m | pings 0/36` (or `OFF`, or `cache cold`).
3. No trial. Upstream allows one ping per idle stretch until it has seen a ping extend the cache, which in practice means about 2 hours instead of the full budget. Here the full budget applies from the start; it drops to one ping only if a ping is seen not to extend the cache.

## How it works

- About 5 minutes before the cache expires, the plugin sends one tiny request over the session's prefix (`$.model.fork`). The cache read restarts the 1h timer.
- The ping count resets with every message you send.
- It stops once more pings would cost more than one cold cache rebuild. A ping costs about 5% of the context price; a cold 1h rewrite costs 200%.
- Every ping is checked: if one misses the cache, the plugin warns, and once a ping is seen not to extend the cache it drops to one ping per idle stretch.
- Commands: `/cache-auto [on|off] [max]`, `/cache-panel`, `/cache-ping`, `/cache-status`.

## Apply (new machine, or after a Claude Code update)

```
git clone <this repo>
cd claude-cache-keepalive
python install.py
```

Then restart Claude Code sessions. `install.py` is idempotent:

1. Sets `"idleCompaction": false` in `~/.claude/settings.json`, with a backup. The keepalive cannot work while idle compaction is on.
2. Registers this folder as the `claude-cache-keepalive` marketplace.
3. Installs or updates `cache-refresher@claude-cache-keepalive`.

Normal auto-compaction, when the context window fills up, is not touched.

## Changing the plugin

Claude Code runs a cached copy (`~/.claude/plugins/cache/...`), not this folder. After editing `plugins/cache-refresher/`:

1. Bump `version` in `plugins/cache-refresher/.claude-plugin/plugin.json`. `claude plugin test plugins/cache-refresher` should show exactly 16 failures: upstream tests that assume its defaults (auto-refresh off, cap 12, the trial). Any other failure is new.
2. Run `python install.py` and restart sessions.

## Updating to a newer upstream

```
git clone https://github.com/olddonkey/cache-refresher.git /tmp/cr
cd /tmp/cr && git am <this repo>/patches/*.patch
```

Resolve conflicts if any (the patch hunks for `marketplace.json` don't apply here and can be skipped), copy the result over `plugins/cache-refresher/` without `.git` and `.claude-plugin/marketplace.json`, regenerate `patches/`, bump the version, and run `install.py`.

## Do not

- Reinstall the upstream marketplace version over this one: auto-refresh goes back to off and the status line disappears.

## Pi

Pi has no idle compaction, but an expired cache means a full-price rebuild on the next message. Measured over three weeks of Pi sessions (Oct 2026): claude-bridge cache hits drop to 0% after a 65-minute gap, openai-codex hits drop after about 10 minutes and are gone after an hour. Pi's built-in `cacheWarming: "idle"` does not help here: it stops 30 minutes after the last request, only covers models that declare a cache lifetime, and skips anything priced at $0 (subscriptions).

| Path | What it does |
|---|---|
| `pi/claude-bridge-keepalive.patch` | Patch for pi-claude-bridge 0.9.3. After 55 minutes idle it resumes the same Claude Code session with the same options and a tiny prompt, without saving it (`persistSession: false`). Nothing is added to Pi's or Claude Code's session files. Stops before the pings' real cost (cached read, written suffix, output; pi-ai's Anthropic prices) would pass what one rebuild adds, or if a ping misses the cache. Top-level turns only, not subagents. Stops when the session runs on another provider: after a Codex turn the bridge rebuilds Claude Code's session anyway, so the old cache would not be read; the next Claude turn starts it again. |
| `pi/codex-cache-keepalive.ts` | Pi extension for `openai-codex`. After 25 minutes idle it re-sends the last request's transcript plus a tiny prompt through Pi's model registry; the reply never enters the session. GPT-6.x caches live about 30 minutes and reads extend them. Stops before the pings' real cost (read, uncached input, output, from the model's prices) would pass what one rebuild adds, or on a miss. Skips prompts under 20K tokens. |
| `pi/install.sh` | Copies the extension and applies the patch (with backups in `~/.pi/agent/backups`). Idempotent. |

Apply on a machine running Pi:

```
git clone <this repo>
bash claude-cache-keepalive/pi/install.sh
```

Re-run the script after `pi update` or a pi-claude-bridge upgrade. If the patch no longer applies to a new bridge version, re-make it against that version. Restart Pi sessions to load the changes.

Both show a status `cache keep-alive: on | next ping HH:MM | n pings` in Pi's footer and log every ping to `~/.pi/agent/cache-keepalive.log` (`read=` is the cached tokens the ping hit). Env switches: `CLAUDE_BRIDGE_KEEPALIVE=off`, `CLAUDE_BRIDGE_KEEPALIVE_MS`, `CLAUDE_BRIDGE_KEEPALIVE_MAX_PINGS` (optional hard cap), `PI_CODEX_KEEPALIVE=off`, `PI_CODEX_KEEPALIVE_MS`, `PI_CODEX_KEEPALIVE_MAX_PINGS`, `PI_CODEX_KEEPALIVE_MIN_TOKENS`.
