# Backlog

Ideas parked for later. Not a roadmap — a holding pen so they don't get
forgotten. When one gets picked up, either move it to `features.md` (as
**Planned**) or delete it.

---

## Publish count scorecard

A weekly publish-count scoreboard visible on the brand dashboard home (and
probably cross-brand on `/coverage`). Publicly visible to the team.

**Why:** The whole point of this app is to publish more and get more views.
If the number isn't climbing week over week, no feature work justifies
itself. Making the count load-bearing keeps us honest.

**Sketch:**
- Count of items with `status='Published'` grouped by `publishedDate` week,
  per brand and per account.
- Week-over-week delta with a green/red arrow.
- Optional: per-person publish count (who shipped what this week).
- Optional: goal line from `brands.weeklyGoal`.

**Questions to resolve before building:**
- Does it live on the brand home or its own `/scoreboard` route?
- Do reposts / cross-posts / repurposed items count the same as originals,
  or does each source-type get its own lane?
- Is the denominator "posts published" or "accounts that published this
  week" (breadth vs. volume)?
