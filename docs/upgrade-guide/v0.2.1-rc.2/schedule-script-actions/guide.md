---
kind: upgrade-guide
description: "Schedule script tasks extend stored task rows and the immediate-run response."
---

# Schedule script tasks

English | [中文](guide.zh.md)

## Change

Schedule supports program and command actions alongside prompt reminders. Existing reminder rows remain readable. A Host that creates a script task writes additional action, binding, report, and run-history fields into the Schedule store; older DSH versions reject these fields, so downgrading a store containing script tasks is unsupported.

`schedule.run()` still returns a delivery acknowledgment for prompt reminders. For script tasks it instead acknowledges admission with `ran: true`, `runId`, and `startedAt`. This does not mean execution completed. A second manual run while one is active returns `schedule_running`. Execution results are read through `schedule.runs()`.

## Migration

1. Back up the configured Schedule storage before upgrading. Do not open the upgraded store with an older DSH after creating script tasks; restore a pre-upgrade backup if a rollback is necessary.
2. Custom profiles using script tasks mount `@deepseek-ai/dsh-schedule-action-command` alongside a shell executor, or `@deepseek-ai/dsh-schedule-action-program` alongside a function-body program runtime. The shipped Web composition mounts both. Existing prompt-reminder profiles need no action provider.
3. Update custom consumers of `schedule.run()` to distinguish `deliveredAt` from `runId`/`startedAt`. Use `schedule.runs({ sessionId, id, limit })` for script execution results; do not interpret admission as completion.
4. Confirm existing reminders remain visible and a script task's execution records show its outcome. Scripts retain their original Session binding and creation-time sandbox ceiling.
