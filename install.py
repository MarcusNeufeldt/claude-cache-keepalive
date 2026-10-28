"""Apply the cache keepalive setup to this machine's Claude Code.

Run after a fresh install, a new machine, or whenever the setup seems lost:

    python install.py

Idempotent. It:
  1. sets "idleCompaction": false in ~/.claude/settings.json (backup first),
  2. registers this repo folder as a plugin marketplace,
  3. installs or updates cache-refresher from it,
  4. prints the result.
Restart Claude Code sessions afterwards to load the plugin.
"""

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent
MARKETPLACE = "claude-cache-keepalive"
PLUGIN = "cache-refresher@" + MARKETPLACE
SETTINGS = Path.home() / ".claude" / "settings.json"


def claude(*args):
    exe = shutil.which("claude")
    if not exe:
        sys.exit("claude CLI not found on PATH")
    proc = subprocess.run([exe, *args], capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    out = (proc.stdout + proc.stderr).strip()
    # The CLI prints symbols such as a check mark; a cp1252 console can't show them.
    return proc.returncode, out.encode("ascii", "replace").decode("ascii")


def last(out):
    return out.splitlines()[-1] if out else ""


def set_idle_compaction_off():
    data = json.loads(SETTINGS.read_text(encoding="utf-8")) if SETTINGS.exists() else {}
    if data.get("idleCompaction") is False:
        print("[ok] idleCompaction already false")
        return
    if SETTINGS.exists():
        backup = SETTINGS.with_name("settings.json.bak-%d" % int(time.time()))
        shutil.copy2(SETTINGS, backup)
        print("[ok] backed up settings to %s" % backup)
    data["idleCompaction"] = False
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("[ok] set idleCompaction false")


def install_plugin():
    code, out = claude("plugin", "marketplace", "list")
    if MARKETPLACE not in out:
        code, out = claude("plugin", "marketplace", "add", str(REPO))
        print(("[ok] " if code == 0 else "[FAIL] ") + "marketplace add: " + last(out))
        if code != 0:
            sys.exit(1)
    else:
        # Re-read the folder so a changed plugin version is seen.
        claude("plugin", "marketplace", "update", MARKETPLACE)

    code, out = claude("plugin", "list")
    if PLUGIN in out:
        code, out = claude("plugin", "update", PLUGIN)
        print(("[ok] " if code == 0 else "[FAIL] ") + "plugin update: " + last(out))
    else:
        code, out = claude("plugin", "install", PLUGIN)
        print(("[ok] " if code == 0 else "[FAIL] ") + "plugin install: " + last(out))
        if code != 0:
            sys.exit(1)


def main():
    set_idle_compaction_off()
    install_plugin()
    code, out = claude("plugin", "list")
    lines = out.splitlines()
    for i, line in enumerate(lines):
        if PLUGIN in line:
            print("\n".join(lines[i:i + 5]))
            break
    print("Restart Claude Code sessions to load it. Each session shows "
          "'cache keep-alive: on | ...' under the prompt.")


if __name__ == "__main__":
    main()
