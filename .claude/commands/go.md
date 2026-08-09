---
description: GO — start the Hub & Spoke ops loop. Health checks on repeat (Sentry, Heroku, job queue, archiver) until you stop it.
argument-hint: "[optional cadence like 30m/1h, and/or a focus, e.g. 'queue']"
---

# /go — ignition

`/go` starts the Hub & Spoke **ops loop**: run `/lap` (the checklist in
`.claude/commands/lap.md`) on repeat until told to stop. The loop **SELF-HEALS within the
guardrails in lap.md** — ops runbooks freely; small, evidence-backed code fixes with at
most ONE push per lap (pushes auto-deploy, so the bar is real verification); everything
else escalates via a Sentry event on Pat's existing alerting.

## What to do

0. **Sync + label the session.** Run these; if either fails, continue — cosmetic:
   ```bash
   git pull --rebase --autostash
   [ -n "$CMUX_CLAUDE_HOOK_CMUX_BIN" ] && CMUX_QUIET=1 "$CMUX_CLAUDE_HOOK_CMUX_BIN" rename-workspace "H&S OPS LOOP" || true
   node -e 'const fs=require("fs"),os=require("os"),d=os.homedir()+"/.claude/sessions";const id=process.env.CLAUDE_CODE_SESSION_ID;for(const f of fs.readdirSync(d)){const p=d+"/"+f;try{const j=JSON.parse(fs.readFileSync(p,"utf8"));if(j.sessionId===id){j.name="H&S OPS LOOP";fs.writeFileSync(p,JSON.stringify(j))}}catch{}}'
   ```
1. Parse `$ARGUMENTS`:
   - A token matching `\d+[smhd]` (e.g. `30m`, `1h`) is the **cadence** — one lap per
     interval (default `1h` — spend-conscious; the app's own alerting covers urgent gaps between laps).
   - Anything else is a **focus** handed to every lap (e.g. `queue` runs only that section).
2. Launch the FRESH-CONTEXT RUNNER detached (the shared vehicle — NOT the `loop` skill /
   ScheduleWakeup, which dies with its session; see the vehicle guard in lap.md):
   ```bash
   # a focus-less /go deliberately clears any persisted focus:
   rm -f ~/.claude/hubandspoke-loop-focus   # only when /go was given NO focus
   cd ~/code/hubandspoke && nohup ~/.claude/loop-runner.sh <cadence, default 1h> <focus...> >> .loop.log 2>&1 & disown
   ```
   ALWAYS pass the cadence explicitly (the runner's own default is 20m — too hot for a
   spend-conscious health loop; `/go` with no cadence token means `1h`). The runner refuses
   to double-start (`.loop.pid` lock), honors `LOOPS_PAUSED`/`LOOPS_THROTTLE`, stamps
   `~/.claude/hubandspoke-lap-stamp`, and persists any focus to
   `~/.claude/hubandspoke-loop-focus`. Supervised by `home-machine/ops-loop-recovery.sh`
   (system crontab, every 15m) — it relaunches a dead/wedged runner, so the loop survives
   reboots and credit windows. If `crontab -l | grep hubandspoke-ops-loop` is empty,
   install it once: `bash home-machine/ops-loop-recovery.sh --install`.
3. Confirm it's running (`pgrep -fl loop-runner.sh` + `tail .loop.log`) and report: cadence,
   focus (if any), and where the health log lives (`~/.claude/hubandspoke-health.log`).

To run exactly ONE health lap right now: `/lap`. To stop: `/pause-loops` in walls (or
`touch ~/.claude/LOOPS_PAUSED`) stops ALL loops; to stop just this one,
`kill $(cat ~/code/hubandspoke/.loop.pid)`.
