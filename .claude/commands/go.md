---
description: GO — start the Hub & Spoke ops loop. Health checks on repeat (Sentry, Heroku, job queue, archiver) until you stop it.
argument-hint: "[optional cadence like 30m/1h, and/or a focus, e.g. 'queue']"
---

# /go — ignition

`/go` starts the Hub & Spoke **ops loop**: run `/lap` (the health checklist in
`.claude/commands/lap.md` — check, fix only known-safe things, report the rest loudly) on
repeat until told to stop. Unlike slope/starter-story's build loops, this one **observes
production and never commits or pushes** (pushes auto-deploy here).

## What to do

0. **Sync + label the session.** Run these; if either fails, continue — cosmetic:
   ```bash
   git pull --rebase --autostash
   [ -n "$CMUX_CLAUDE_HOOK_CMUX_BIN" ] && CMUX_QUIET=1 "$CMUX_CLAUDE_HOOK_CMUX_BIN" rename-workspace "H&S OPS LOOP" || true
   node -e 'const fs=require("fs"),os=require("os"),d=os.homedir()+"/.claude/sessions";const id=process.env.CLAUDE_CODE_SESSION_ID;for(const f of fs.readdirSync(d)){const p=d+"/"+f;try{const j=JSON.parse(fs.readFileSync(p,"utf8"));if(j.sessionId===id){j.name="H&S OPS LOOP";fs.writeFileSync(p,JSON.stringify(j))}}catch{}}'
   ```
1. Parse `$ARGUMENTS`:
   - A token matching `\d+[smhd]` (e.g. `30m`, `1h`) is the **cadence** — one lap per
     interval (default `30m`; health checks don't need slope's 20m).
   - Anything else is a **focus** handed to every lap (e.g. `queue` runs only that section).
2. Launch the FRESH-CONTEXT RUNNER detached (the shared vehicle — NOT the `loop` skill /
   ScheduleWakeup, which dies with its session; see the vehicle guard in lap.md):
   ```bash
   # a focus-less /go deliberately clears any persisted focus:
   rm -f ~/.claude/hubandspoke-loop-focus   # only when /go was given NO focus
   cd ~/code/hubandspoke && nohup ~/.claude/loop-runner.sh <cadence> <focus...> >> .loop.log 2>&1 & disown
   ```
   The runner refuses to double-start (`.loop.pid` lock), honors
   `LOOPS_PAUSED`/`LOOPS_THROTTLE`, stamps `~/.claude/hubandspoke-lap-stamp`, and persists
   any focus to `~/.claude/hubandspoke-loop-focus`. (No crontab recovery here yet — the cx
   tmux session keeps it alive across disconnects; a reboot needs a fresh `/go`.)
3. Confirm it's running (`pgrep -fl loop-runner.sh` + `tail .loop.log`) and report: cadence,
   focus (if any), and where the health log lives (`~/.claude/hubandspoke-health.log`).

To run exactly ONE health lap right now: `/lap`. To stop: `/pause-loops` in walls (or
`touch ~/.claude/LOOPS_PAUSED`) stops ALL loops; to stop just this one,
`kill $(cat ~/code/hubandspoke/.loop.pid)`.
