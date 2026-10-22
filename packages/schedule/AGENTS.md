# AGENTS.md — Schedule packages

These rules supplement the repository and package instructions for `packages/schedule/*`.

- The Host `schedule` storage domain owns active and ended tasks. Store each record with its original Session id and a globally unique task id; only explicit deletion removes a task. Browser and Agent management use the same service; read and delete must not activate a Session.
- One Host runtime scans active tasks at startup and schedules their next target; ended tasks never rearm. Resume due Sessions through the existing Session controller so preset composition and concurrent activation retain one owner.
- Preserve `after`, `at`, `every`, `daily`, `weekly`, and `cron`. Daily rules retain an explicit time and IANA zone; they are not fixed 86,400-second intervals. Skip missing local dates/times and select the earlier overlap once per date. Recurring tasks contribute only their latest missed occurrence and advance to a future target; due recurring tasks in one Session share a message.
- Prompt reminders enqueue with producer kind `schedule`, await Session persistence, then retire or advance. These writes are not atomic and may duplicate delivery; never describe enqueue as model completion. Script tasks instead persist the advanced plan and in-flight run before execution, run outside the management queue, and never repeat interrupted runs.
- Failed delivery leaves the task stored and reports the failure. Do not add a generic retry loop. Shutdown drains accepted work before closing storage.
- Historical `schedule/change` events retain the original three-kind `LegacyScheduleRecord`; the current Host decoder owns additional rule kinds. Warn when loading a Session with active historical reminders; do not scan or migrate all historical Sessions implicitly, or infer daily intent from an existing one-shot prompt.
- Script action providers register through effects and enforce the resolved Session policy with its creation-time ceiling. Failed runs never disable a recurring task automatically; deletion and provider unloading cancel active execution. Startup waits for Loader settlement before restoring tasks.
- Keep recurrence arithmetic pure. Production uses platform wall time and segmented timers; tests use explicit samples or restored fake timers.
