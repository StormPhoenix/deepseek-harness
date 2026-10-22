# Host-wide Schedule

English | [中文](schedule.zh.md)

Schedule stores reminders independently of Session activation and delivers them to their original Session. This page records the durable and model-facing types from [`types.ts`](../../packages/schedule/schedule/src/types.ts); the [package README](../../packages/schedule/schedule/README.md) owns composition and reminder framing.

## Durable records

`ScheduleId` is a globally unique [branded id](core.md#branded-ids). The version-1 `schedule` storage domain owns a `tasks` table whose entries bind a `ScheduleRecord` to its original `sessionId`, with stored `status: 'active' | 'inactive'` and optional `lastDelivery`. Records lacking status normalize to `active` without scanning or recreating historical Sessions. Creation canonicalizes the target into RFC 3339 UTC `scheduledAt`; `after` retains the submitted delay, `every` retains its fixed interval, `daily` and `weekly` retain normalized local `time` and their explicit `timeZone`, and `cron` retains its canonical five-field `expression` and explicit `timeZone`. Daily, weekly, and cron decoding preserve the committed instant and stored zone spelling. The stored task record declares a required `title`, the short name the task surfaces show; creation requires it and never derives it from the instruction. No stored record may omit its title: a record whose `title` is missing, blank after trimming, untrimmed, or longer than 120 characters fails durable decoding with `ScheduleLogError`, and the schedule domain declares no backup-and-skip policy, so one such stored task rejects the whole domain open instead of being dropped. Only explicit deletion removes a task; previously physically deleted tasks are not restored or fabricated.

```ts type-equiv
/** Durable one-shot reminder created from a positive delay. */
interface AfterScheduleRecord {
  /** Globally unique task identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a delayed one-shot reminder. */
  readonly kind: 'after'
  /** Required stored task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Positive safe-integer delay accepted at creation. */
  readonly afterSeconds: number
  /** Four-digit-year RFC 3339 UTC target. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** Durable one-shot reminder created from an absolute instant. */
interface AtScheduleRecord {
  /** Globally unique task identity. */
  readonly id: ScheduleId
  /** Rule discriminator for an absolute one-shot reminder. */
  readonly kind: 'at'
  /** Required stored task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Four-digit-year RFC 3339 UTC target. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** Durable fixed-rate reminder aligned to creation or its most recent interval edit. */
interface EveryScheduleRecord {
  /** Globally unique task identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a fixed-rate recurring reminder. */
  readonly kind: 'every'
  /** Required stored task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Fixed safe-integer interval, never below one minute. */
  readonly everySeconds: number
  /** Next anchor-aligned occurrence while active, or final occurrence when inactive. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** Durable daily wall-clock reminder; gaps skip a date and overlaps use the earlier instant. */
interface DailyScheduleRecord {
  /** Globally unique task identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a daily wall-clock reminder. */
  readonly kind: 'daily'
  /** Required stored task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Local time normalized to HH:mm:ss.SSS. */
  readonly time: string
  /** Explicit IANA zone; equivalent timing edits retain the stored spelling. */
  readonly timeZone: string
  /** Committed next UTC instant while active, or final occurrence when inactive. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** One-shot task variants. */
type OneShotScheduleRecord = AfterScheduleRecord | AtScheduleRecord
```

```ts type-equiv
/** Recurring Host task variants. */
type RecurringScheduleRecord = EveryScheduleRecord | DailyScheduleRecord | WeeklyScheduleRecord | CronScheduleRecord
```

```ts type-equiv
/** Reminder rule and target, stored with its original Session binding. */
type ScheduleRecord = OneShotScheduleRecord | RecurringScheduleRecord
```

## Absolute-time input

The `at` selector is either a strict offset-bearing RFC 3339 string or an exact local-calendar object. The local form keeps its interpretation explicit at the tool boundary:

```ts type-equiv
/** Structured local-calendar input accepted by creation and timing edits. */
interface LocalAtInput {
  /** Four-digit ISO calendar date. */
  readonly date: string
  /** Local wall-clock time with optional one-to-three digit milliseconds. */
  readonly time: string
  /** Explicit UTC or IANA Area/Location zone. */
  readonly time_zone: string
}
```

```ts type-equiv
/** Absolute selector accepted by creation and timing edits. */
type AtInput = string | LocalAtInput
```

The shipped Web composition mounts the `schedule` service and the `ui-schedule` task page. The clock reading and the four reminder tools are preset-owned: `standard`, `cordis`, and `ptc` declare `time-context` and `@deepseek-ai/dsh-tool-schedule` together, and `minimal` declares neither. The `tool-subagent` and `tool-subagent-fork` rows in those three presets deny the four tools, and each tool refuses a delegated caller with `subagent_session`, so a delegated child neither sees the tools nor has a call accepted. Time-context tells the model to interpret otherwise-unqualified natural-language dates and times in that request-local zone when the open turn has one unambiguous browser zone; mixed or missing browser-zone records tell the model to ask. That guidance is not a durable Session default: the model must still pass an offset in the string form or `time_zone` in the local form, and Schedule never reads browser, Session, process, or model context.

Schedule rejects invalid offsets and zones, offset-free strings, non-future targets, and local times inside daylight-saving gaps. A daylight-saving overlap chooses its first, earlier instant. Successful creation stores only canonical UTC `scheduledAt`, so replay never depends on ambient time-zone state.

<a id="daily-wall-clock-input"></a>
## Daily wall-clock input

`daily` is one of the mutually exclusive creation selectors, alongside `after_seconds`, `at`, `every_seconds`, the weekly selector, and the cron selector. For example, `daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' }` selects 23:00 in that zone on each eligible local date. The exact object has no date, offset, or interval field:

```ts type-equiv
/** Daily local-time selector accepted by creation and timing edits. */
interface DailyInput {
  /** Local HH:mm:ss time with optional one-to-three fractional digits. */
  readonly time: string
  /** Explicit UTC or IANA Area/Location zone. */
  readonly time_zone: string
}
```

Creation requires `HH:mm:ss` with optional one-to-three fractional digits, rejects leap seconds and `24:00`, canonicalizes the explicit IANA zone, and stores `time` as `HH:mm:ss.SSS`. The first `scheduledAt` is strictly after creation time. A nonexistent local time or entire date is skipped; an overlap selects the earlier instant once per local date. If that earlier instant has passed, the later duplicate is not eligible. Only UTC target years 0001–9999 are constrained; local dates at the UTC range edges may fall in year 0 or 10000.

A saved next target is a committed UTC instant. The Host decoder and restart preserve that instant without resolving it against time-zone rules again, and valid stored zone aliases remain readable when canonical names change. Subsequent targets use the Host's current IANA data. The next target must be both after the delivery decision and on a local date later than the selected occurrence's date. Creation fails with `time_out_of_range` when no future UTC target is representable.

## Fixed-rate input and catch-up

`every_seconds` is a safe-integer interval of at least 60 seconds, aligned to creation time. It measures elapsed time, not daily wall-clock time: `every_seconds: 86400` cannot substitute for `daily` across offset changes. The protocol provides no shared cooldown or cross-record admission rule; the cron selector described below is wall-clock timing, not a fixed-rate interval.

When the Host starts with an overdue Every, Daily, Weekly, or Cron record, it sends only the latest due occurrence. Every advances to the first target aligned to its current interval anchor after the delivery decision; Daily, Weekly, and Cron follow the local-date rules above and below. Missed occurrences do not accumulate. If no next UTC target is representable, delivery retains the record as inactive with its latest receipt.

One-shots produce individual follow-ups. Recurring records due in the same scan for the same Session share one follow-up rendered by `renderRecurringReminderBatchFraming`, with one latest occurrence per record. The one-minute minimum applies only to fixed-rate intervals; delivery does not wait for the target Agent to become idle.

<a id="cron-wall-clock-input"></a>
## Cron wall-clock input

`cron` is one of the mutually exclusive creation selectors. Its exact object carries only the strict five-field Vixie expression `minute hour day-of-month month day-of-week` and an explicit IANA zone, for example `cron: { expression: '*/15 9-17 * * 1-5', time_zone: 'Asia/Shanghai' }`. The field bounds are:

| Field | Accepted range | Notes |
|---|---|---|
| minute | 0-59 | |
| hour | 0-23 | |
| day-of-month | 1-31 | |
| month | 1-12 | |
| day-of-week | 0-7 | Both `0` and `7` mean Sunday. |

Every field accepts `*`, a single value, an `a-b` range, a `*/n` or `a-b/n` step with `n >= 1`, and a comma-separated list of those forms. Everything else is rejected with `invalid_rule` and a message naming the offending field: `L`, `W`, and `#` operators, `JAN`/`MON` names, `@daily`-style macros, six-field expressions with a seconds field, out-of-range values, inverted ranges, zero steps, and empty fields. Because the dialect has five fields, the smallest interval is one minute; sub-minute scheduling stays unsupported.

Creation canonicalizes the expression before storing it. Canonicalization expands each field into its matched value set and re-encodes that set deterministically: repeated values collapse, adjacent values and ranges merge, a uniform step is written as `a-b/n` or, for a field that started with `*`, as a star-step (`*` for every value, otherwise the widest star-step walk plus any remaining values), a step of `1` is dropped, and Sunday is written as `0`. A field that did not start with `*` never becomes a star-step. Preserving each field's star flag is what keeps the day-of-month/day-of-week rule below Vixie-faithful across the stored expression. The durable decoder rejects a stored expression that is not canonical.

The first target is the first strictly future instant whose local date and time in the zone match. It reuses the Daily and Weekly local-time resolution: a non-existent local time is skipped, and an ambiguous one takes the earlier occurrence once for that date. The committed UTC `scheduledAt` is never recomputed on restart.

Day-of-month and day-of-week follow Vixie semantics. A field is a star when its text starts with `*`, independently of the values it matches, so `*/1` and `*/2` are stars while `1-31` and `0-7` are restricted. When either field is a star, a local date matches only when both fields match; when neither is a star, it matches when either field matches.

Cron decoding preserves the committed instant and the stored zone spelling, and rejects a non-canonical stored expression. Cron belongs only to the current Host `ScheduleRecord`; the frozen historical Session decoder does not admit it.

## Historical Session changes

Version-1 `schedule/change` events remain decodable as historical Session data. Their create and fold types use `LegacyScheduleRecord`, which admits only After, At, and Every; Daily, Weekly, and Cron belong only to the current Host `ScheduleRecord`. The Host record decoder is separate from the frozen historical decoder. A create record written before titles existed carries no `title`, so the historical decoder admits that absent member while the Host decoder still requires it. Historical events do not populate the storage domain or schedule delivery. Existing reminders in these events require explicit recreation through `schedule_create`; no implicit Session migration or conversion of old `at` records occurs.

```ts type-equiv
/**
 * Frozen Session event and fold vocabulary; daily rules belong only to Host storage.
 *
 * A version-1 event written before titles existed persists no `title` member, so
 * `after`, `at`, and `every` decode without one and stay readable. The Host task
 * record requires the member and never persists a record without it.
 */
type LegacyScheduleRecord =
  | LegacyAfterScheduleRecord
  | LegacyAtScheduleRecord
  | LegacyEveryScheduleRecord
```

```ts type-equiv
/** Creates one durable reminder record. */
interface ScheduleCreateChange {
  readonly version: 1
  readonly operation: 'create'
  readonly schedule: LegacyScheduleRecord
}
```

```ts type-equiv
/** Deletes one currently active reminder. */
interface ScheduleDeleteChange {
  readonly version: 1
  readonly operation: 'delete'
  readonly id: ScheduleId
}
```

```ts type-equiv
/** Records that one active one-shot reminder entered the durable dispatch history. */
interface OneShotScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
}
```

```ts type-equiv
/** Records one fixed-rate decision and advances directly past missed occurrences. */
interface EveryScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
  /** Wall-clock decision time used to select the latest due occurrence. */
  readonly acceptedAt: string
}
```

```ts type-equiv
/** Durable dispatch shapes supported by the current rule set. */
type ScheduleDispatchChange = OneShotScheduleDispatchChange | EveryScheduleDispatchChange
```

```ts type-equiv
/** Strict version-1 durable Schedule mutation union. */
type ScheduleChange = ScheduleCreateChange | ScheduleDeleteChange | ScheduleDispatchChange
```

The historical decoder and fold reject unknown versions, extra fields, reused ids, and invalid transitions. The event remains indexed in the [persistence catalog](../persistence-catalog.md#schedulechange--log-only). Session history is not the authority for active tasks.

## Active views and management

Tool values combine the stored record with timing derived from the current wall clock. The Host restores the original Session when delivery requires it; listing and deleting tasks do not activate that Session.

```ts type-equiv
/** Current delivery timing derived from the durable record and wall clock. */
type ScheduleState = 'scheduled' | 'overdue'
```

```ts type-equiv
/** Host-driven delivery resumes the original Session when needed. */
type ScheduleDeliveryMode = 'host'
```

```ts type-equiv
/** Complete model-facing view of one active reminder. */
type ScheduleView = ScheduleRecord & {
  /** Whether the target remains in the future. */
  readonly state: ScheduleState
  /** Reminder delivery never leaves the owning session. */
  readonly deliveryMode: ScheduleDeliveryMode
  /** Script action configuration when this task runs a program or command. */
  readonly action?: ScheduleActionSummary
  /** Script result report policy; absent on prompt reminders. */
  readonly report?: ScheduleReportPolicy
}
```

The [tool catalog](../tool-catalog.md#deepseek-aidsh-tool-schedule) owns schemas for `schedule_create`, `schedule_list`, `schedule_delete`, and `schedule_update`, which [`@deepseek-ai/dsh-tool-schedule`](../../packages/schedule/tool-schedule/README.md) contributes to each preset that mounts it; the Host service owns storage and delivery. Create, delete, and update acknowledge the storage-domain write. A Host-wide queue serializes these mutations against due delivery; deleting a task does not remove an already queued message. Model tools address the current Session, while the shared Host create, list, update, and delete methods accept an explicit Session binding. `create` and `update` refuse a Session a delegated child owns with `subagent_session` when its delegation depth is above zero, and delivery cannot reach such a Session. The four model tools refuse a delegated caller in the tool layer, while `list`, `catalog`, `history`, and `delete` still serve that Session. Creation requires a `title` that must be non-empty after trimming and at most 120 characters; a missing, blank, or over-long title is rejected with `invalid_prompt`, and creation never derives one from the instruction. Create and list views carry the stored `title` alongside the instruction, and a stored record whose `title` is missing or invalid is rejected at decode.

```ts type-equiv
/** Reminder creation selector, shared by the model consumer and Host service. */
interface ScheduleCreateRequest {
  /** Non-empty reminder text. */
  prompt: string
  /** Required task name of at most 120 characters, non-empty after trimming; names the card, detail heading, and task lists. */
  title: string
  /** Relative one-shot delay in seconds. */
  after_seconds?: number
  /** Absolute one-shot target. */
  at?: AtInput
  /** Fixed recurrence interval in seconds. */
  every_seconds?: number
  /** Daily wall-clock time in an explicit IANA zone. */
  daily?: DailyInput
  /** Weekly wall-clock time and explicit ISO weekday set in an IANA zone. */
  weekly?: WeeklyInput
  /** Five-field cron expression evaluated in an explicit IANA zone. */
  cron?: CronInput
}
```

```ts type-equiv
/** Session-scoped task list, without Agent activation. */
interface ScheduleListRequest {
  /** Original Session binding. */
  sessionId: SessionId
}
```

```ts type-equiv
/** Delete request identifying a task within its original Session binding. */
interface ScheduleDeleteRequest extends ScheduleListRequest {
  /** Task to remove. */
  id: ScheduleId
}
```

```ts type-equiv
/** Successful `schedule_delete` value, including the non-mutating not-found result. */
type ScheduleDeleteResult =
  | { readonly id: ScheduleId; readonly deleted: true }
  | { readonly id: ScheduleId; readonly deleted: false; readonly code: 'schedule_not_found' }
```

## Web catalog

The Remote `schedule.catalog()` method returns active and inactive Host tasks with their original Session bindings, ordered by `scheduledAt` ascending and then lexicographically by `id`. It reads only the Schedule domain, without activating Sessions or reading their history. Browser consumers receive this browser-safe type:

```ts type-equiv
/** Durable Session inbox delivery acknowledgment, not model execution completion. */
interface ScheduleDeliveryReceipt {
  /** Canonical UTC target of the delivered occurrence, or the plan a manual run delivered under. */
  readonly scheduledAt: string
  /** Canonical UTC time sampled after Session persistence acknowledged delivery. */
  readonly deliveredAt: string
  /** Identity of the delivered message, shared by tasks in one recurring batch. */
  readonly messageId: MessageId
  /**
   * Person-triggered run of the stored instruction; absent means the rule's own
   * schedule delivered it. A manual run never advances or retires the rule, so
   * the receipt's `scheduledAt` still names the plan that remains armed.
   */
  readonly manual?: true
}
```

```ts type-equiv
/** Browser-safe retained reminder with its original Session binding. */
type ScheduleCatalogEntry = ScheduleRecord & {
  /** Session receiving this reminder when it becomes due. */
  readonly sessionId: SessionId
  /** Inactive reminders remain visible but never schedule another delivery. */
  readonly status: 'active' | 'inactive'
  /** Most recent durably acknowledged inbox delivery, when available. */
  readonly lastDelivery?: ScheduleDeliveryReceipt
  /** Script action this task runs; absent on a prompt reminder. */
  readonly action?: ScheduleActionSummary
  /** Result delivery policy of a script task; absent on a prompt reminder. */
  readonly report?: ScheduleReportPolicy
  /** Present while a run of this script task is in flight. */
  readonly running?: { readonly runId: string; readonly startedAt: string }
  /** Most recent saved script run, when available. */
  readonly lastRun?: ScheduleRunRecord
}
```

The Remote `schedule.list({ sessionId })`, model `schedule_list`, and Session-header catalog return only active tasks. A model view's derived timing `state` remains distinct from stored lifecycle `status`. Deletion uses `schedule.delete({ sessionId, id })` with the entry's original binding; a mismatched binding returns not found. Model tools supply the current Agent's Session, whereas the global user interface supplies the selected task's binding. The binding check alone does not establish caller authorization. The payload-free `schedule/changed` event invalidates client lists; reconnecting clients fetch current state again.

The shipped Web composition mounts `ui-schedule` with the Host capability. The [client package](../../packages/client/ui-schedule/README.md) owns the catalog, empty state, and deletion controls. The page separately filters all, active, and inactive tasks, retains inactive details and an original-Session control in the detail tab strip, and requires explicit confirmed deletion. The Rules and Records tabs separate task settings from lazily paged saved receipts. Neither a receipt nor inactive status confirms model execution.

## Timing edits

`schedule.update({ sessionId, id, expected, change })` edits an active task without activating its Session. `expected` is the complete observed `ScheduleRecord`, not a catalog entry with extra metadata. The Host compares it to the current record inside the same FIFO used by dispatch and deletion. Normal delivery can advance the target during editing; that stale snapshot returns `schedule_conflict` instead of overwriting the current rule. Missing or mismatched bindings return `schedule_not_found`, and inactive tasks return `schedule_ended`.

```ts type-equiv
/** Timing-only edit; it may select a different recurrence kind than the stored record, and one-shot targets use an absolute `at`. */
type ScheduleTimingChange =
  | { readonly kind: 'at'; readonly at: AtInput }
  | { readonly kind: 'every'; readonly every_seconds: number }
  | { readonly kind: 'daily'; readonly daily: DailyInput }
  | { readonly kind: 'weekly'; readonly weekly: WeeklyInput }
  | { readonly kind: 'cron'; readonly cron: CronInput }
```

```ts type-equiv
/** Compare-and-update request within the original Session binding. */
interface ScheduleUpdateRequest extends ScheduleDeleteRequest, ScheduleUpdateContent {
  /** Complete record observed when editing began, including the committed target. */
  readonly expected: ScheduleRecord
  /** New timing; its kind may differ from the stored record's kind, and an omitted value keeps the committed target. */
  readonly change?: ScheduleTimingChange
  /**
   * Replacement action of a script task, compared against `expectedAction`.
   * A prompt reminder cannot become a script task through an update.
   */
  readonly action?: ScheduleActionInput
  /** Source and timeout observed when editing began; required with `action`. */
  readonly expectedAction?: { readonly kind: string; readonly source: string; readonly timeoutMs?: number }
  /** Replacement result delivery policy of a script task. */
  readonly report?: ScheduleReportPolicy
}
```

```ts type-equiv
/** Successful current record, non-mutating lookup/conflict failure, or invalid name/instruction/timing. */
type ScheduleUpdateResult =
  | { readonly id: ScheduleId; readonly updated: boolean; readonly record: ScheduleRecord }
  | ScheduleUpdateMiss
  | ScheduleToolError
```

A changed Daily rule computes its first strictly future target using the saved local time and zone semantics. A changed Cron rule canonicalizes its expression and computes its first strictly future target under the same local-date, gap, and earlier-overlap rules. A changed Every interval starts a new anchor at accepted save time plus that interval. An After or At task can receive a different absolute target as an At record with the same id. These operations preserve the stored `title`, the prompt, original Session binding, lifecycle status, and all saved receipts. A change may also select a different recurrence kind, which recomputes the target from the new rule with the same id, title, prompt, Session binding, status, and saved receipts. An equivalent normalized rule returns `updated: false` with its unchanged record; it does not rewrite storage, reset the target, or emit a change event. A differently spelled but equivalent Cron expression is such a no-op, because the comparison uses the canonical expression and the canonical zone.

Input validation uses existing timing errors. A changed absolute target must still be future when its FIFO slot runs. The successful task put precedes the change notification and timer recomputation. Storage and lifecycle failures reject; cancellation is checked after queue and initialization waits but cannot roll back an in-flight write. One-shot records retain a UTC instant rather than the editing form's IANA zone. Timing edits append no historical Session event: the model reaches the same in-place update through `schedule_update`, which compares the record it read with the stored one instead of deleting and recreating the task.

## Saved delivery records

`schedule.history({ sessionId, id, limit })` reads saved receipts without activating a Session. The explicit limit is a safe integer from 1 through 100. Pages follow reverse append order, not wall-clock sorting; the optional message-id cursor excludes the oldest record from the preceding page. New arrivals do not shift that cursor. A missing task or wrong Session binding returns `schedule_not_found`; an unknown cursor returns `delivery_cursor_not_found`, not an empty successful page.

```ts type-equiv
/** Saved inbox delivery with its immutable sent prompt when recorded by this Host. */
interface ScheduleDeliveryRecord extends ScheduleDeliveryReceipt {
  /** Prompt sent for this occurrence; unavailable for legacy receipts. */
  readonly prompt?: string
}
```

```ts type-equiv
/** Explicitly bounded saved-delivery query within one Session binding. */
interface ScheduleDeliveryHistoryRequest extends ScheduleDeleteRequest {
  /** Required safe-integer page size from 1 through 100. */
  limit: number
  /** Message identity of the oldest entry in the previous page; excluded from this page. */
  before?: MessageId
}
```

```ts type-equiv
/** Configured limits applied when appending one task's delivery receipt. */
interface DeliveryRetentionBounds {
  /** Retained window in days, measured back from the acknowledgment being appended. */
  readonly days: number
  /** Maximum retained records per task; the newest survive. */
  readonly records: number
}
```

```ts type-equiv
/** Newest-first saved deliveries, or a non-mutating task/cursor lookup failure. */
type ScheduleDeliveryHistoryResult =
  | {
    readonly id: ScheduleId
    readonly records: ScheduleDeliveryRecord[]
    /** Whether earlier delivery records may be unavailable; missing receipts are never reconstructed. */
    readonly earlierRecordsUnavailable: boolean
    /** True only after an append removed saved records; absent legacy evidence is false. */
    readonly earlierRecordsPruned: boolean
    /** Current Host retention configuration, also used by the delivery writer. */
    readonly retention: DeliveryRetentionBounds
    /** Oldest returned message identity, present only when older saved records remain. */
    readonly nextBefore?: MessageId
  }
  | { readonly id: ScheduleId; readonly code: 'schedule_not_found' | 'delivery_cursor_not_found' }
```

New tasks initialize an empty history. Older task rows without history expose only their existing latest receipt, mark earlier records unavailable, and are not rewritten by reads. Future acknowledgments preserve that receipt and append actual new receipts with instruction snapshots. Lost history and missing legacy instruction snapshots are never reconstructed. The same task-row write commits history, latest receipt, status, and next target; explicit task deletion stops future delivery, removes the task row together with its saved receipts, and takes it out of `list` and `catalog`; conversation messages are unaffected. Saved delivery records are pruned on append to the configured `deliveryHistoryDays` window, measured back from each receipt's `deliveredAt`, and to the `deliveryHistoryRecords` cap; the appended latest receipt always survives, and a pruned window marks earlier records unavailable. Pagination bounds returned record count rather than storage size or instruction bytes.

## Prompt reminder delivery

The Host reads persisted tasks at startup, waits for Loader composition to settle when present, and sets its timer to the earliest active target. Inactive tasks remain queryable but never schedule another delivery. At delivery it resolves the original Session through the Session controller, including cold Sessions. After restoration it samples the wall clock again and excludes members that are no longer due after a rollback; those tasks retain their timer obligation. Neither a Goal nor a separate Run completion record participates in dispatch.

Plugin-sourced `followup()` synchronously appends the message to the Session inbox. After a successful Session flush, one task-record put appends a saved delivery with its instruction snapshot and stores the latest `ScheduleDeliveryReceipt` together with the one-shot's `inactive` status or the recurring task's next target and status. Recurring tasks in the same batch share the receipt's `messageId`; each receipt retains that task's delivered occurrence time. Delivery never steers or cancels the current turn and does not wait for model completion.

A failure to resolve the Session, enqueue the message, or confirm persistence leaves the task stored and reports a Host warning. A later management change or Host restart retries it. Session persistence and the task put are not atomic across stores. A crash after inbox persistence but before the task put can repeat delivery; the receipt does not close this gap. Prompt reminders provide no model-result acknowledgement or cancellation of the model's work, and Schedule has no external notification channel.

## Immediate runs

For script tasks, `schedule.run()` persists an in-flight run and returns `runId` and `startedAt` as admission evidence, not completion. It leaves the committed plan unchanged. A second run is refused with `schedule_running`; results are queried through `schedule.runs()`. For prompt reminders, the method delivers one active task's stored instruction now, from the same serialized queue dispatch and management writes use. It renders the same framing, appends the same `followup()` message, and requires the same Session flush, so the Session reacts exactly as it does to a due task. It consumes no occurrence: `status` and `scheduledAt` are untouched and the timer is not recomputed, so the plan stays armed and the task still fires at its committed time. The saved receipt carries `manual: true` and the committed target it ran under, which is what lets the records view tell a person's run apart from a scheduled delivery; retention prunes it like any other receipt. A missing or mismatched binding returns `schedule_not_found`, an inactive task returns `schedule_ended`, a delegated child's Session returns `subagent_session`, and an original Session that cannot be resolved returns `session_unavailable`. The method adds no model-visible surface: the delivered message is the ordinary reminder framing, and no model tool wraps it.

```ts type-equiv
/** Immediate-run request within the original Session binding. */
interface ScheduleRunRequest extends ScheduleListRequest {
  /** Task whose stored instruction is delivered now. */
  readonly id: ScheduleId
}
```

```ts type-equiv
/**
 * Non-mutating immediate-run outcome: the rule, its committed target, and its
 * status are unchanged. A prompt reminder reports its saved manual receipt; a
 * script task reports the started run, whose result arrives as a run record.
 */
type ScheduleRunResult =
  | { readonly id: ScheduleId; readonly ran: true; readonly deliveredAt: string }
  | { readonly id: ScheduleId; readonly ran: true; readonly runId: string; readonly startedAt: string }
  | {
    readonly id: ScheduleId
    readonly ran: false
    readonly code: 'schedule_not_found' | 'schedule_ended' | 'session_unavailable' | 'schedule_running'
  }
  | SubagentSessionError
```

## Script task contracts

Script tasks retain the existing timing record and original Session binding. Their optional action, report policy, captured directory, permission ceiling, and execution history are stored together on the task row; old prompt-only rows stay readable. Providers validate opaque JSON specifications and own execution under the supplied policy. The action schema is the tool value-schema DSL, not raw JSON Schema. See the [Schedule package](../../packages/schedule/schedule/README.md#script-actions) for lifecycle, approval, timeout, and reporting semantics.

```ts type-equiv
/**
 * When a script task's run result is delivered to its Session:
 * `always` after every run, `on-failure` only after a run that did not succeed,
 * `never` keeps the result in the task's run records only.
 */
type ScheduleReportPolicy = 'always' | 'on-failure' | 'never'
```

```ts type-equiv
/** Browser-safe description of a task's script action; absent on a prompt reminder. */
interface ScheduleActionSummary {
  /** Registered action provider kind, such as `command` or `program`. */
  readonly kind: string
  /** Provider-rendered one-line summary, or a bounded JSON rendering when the provider is not mounted. */
  readonly summary: string
  /** Complete stored source the action runs, rendered for read-only display. */
  readonly source: string
  /** Per-task elapsed budget in milliseconds; absent uses the Host default. */
  readonly timeoutMs?: number
  /** Absolute working directory captured at creation. */
  readonly cwd: string
  /** Widest sandbox mode a run may use; the Session's current mode narrows it further. */
  readonly sandboxCeiling: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Whether the Host currently mounts a provider for this kind. */
  readonly available: boolean
}
```

```ts type-equiv
/**
 * Script action requested at creation or replacement. `spec` is untrusted
 * provider input: the provider registered for `kind` validates and normalizes it.
 */
interface ScheduleActionInput {
  /** Registered action provider kind. */
  readonly kind: string
  /** Provider-specific specification, such as `{ command }` or `{ source }`. */
  readonly spec: JsonValue
  /** Per-task elapsed budget in milliseconds; capped by the Host's configured maximum. */
  readonly timeoutMs?: number
}
```

```ts type-equiv
/**
 * Host-side context a script-task creation carries from its trusted caller.
 * The tool consumer captures these from the calling Agent; they are never model input.
 */
interface ScheduleActionBinding {
  /** Absolute working directory every run of this task starts in. */
  readonly cwd: string
  /** Sandbox mode of the creating Session; runs never use a wider mode. */
  readonly sandboxCeiling: 'read-only' | 'workspace-write' | 'danger-full-access'
}
```

```ts type-equiv
/** Script-task part of a creation request; prompt-reminder creation omits it. */
interface ScheduleCreateActionRequest {
  /** Action to run when due; `prompt` then frames the delivered run result for the model. */
  readonly action: ScheduleActionInput
  /** Result delivery policy; omitted delivers every result. */
  readonly report?: ScheduleReportPolicy
  /** Trusted creation context. */
  readonly binding: ScheduleActionBinding
}
```

## Execution records

```ts type-equiv
/**
 * Terminal classification of one script run.
 *
 * - `succeeded` / `failed` — the action ran and reported its own success or failure.
 * - `timeout` — the elapsed budget expired.
 * - `aborted` — deletion or Host shutdown cancelled the run.
 * - `sandbox-denied` — the Session's sandbox refused a file effect or could not be established.
 * - `skipped` — the previous run of the same task was still in flight.
 * - `interrupted` — the Host stopped while the run was in flight; the run is never repeated.
 * - `unavailable` — no provider for the kind is mounted, or the Session could not be resolved.
 */
type ScheduleRunOutcome =
  | 'succeeded' | 'failed' | 'timeout' | 'aborted' | 'sandbox-denied' | 'skipped' | 'interrupted' | 'unavailable'
```

```ts type-equiv
/** One saved script run; delivery to the Session is optional and recorded by message id. */
interface ScheduleRunRecord {
  /** Globally unique run identity. */
  readonly runId: string
  /** Occurrence target the run served, or the armed target a manual run ran under. */
  readonly scheduledAt: string
  /** Canonical UTC time the run started (or was decided, for runs that never started). */
  readonly startedAt: string
  /** Canonical UTC time the outcome was recorded. */
  readonly finishedAt: string
  /** Person-triggered run; absent means the rule's own schedule started it. */
  readonly manual?: true
  /** Terminal classification. */
  readonly outcome: ScheduleRunOutcome
  /** Process exit code for actions that report one; null when a signal ended the process. */
  readonly exitCode?: number | null
  /** Captured output, cut to the Host's configured byte budget. */
  readonly output: string
  /** Whether bytes were dropped from `output`. */
  readonly outputTruncated: boolean
  /** Message that delivered this result to the Session, when the report policy delivered it. */
  readonly messageId?: MessageId
}
```

```ts type-equiv
/** Explicitly bounded saved-run query within one Session binding. */
interface ScheduleRunHistoryRequest extends ScheduleDeleteRequest {
  /** Required safe-integer page size from 1 through 100. */
  limit: number
  /** Run identity of the oldest entry in the previous page; excluded from this page. */
  before?: string
}
```

```ts type-equiv
/** Newest-first saved script runs, or a non-mutating task/cursor lookup failure. */
type ScheduleRunHistoryResult =
  | {
    readonly id: ScheduleId
    readonly records: ScheduleRunRecord[]
    /** True only after an append removed saved records. */
    readonly earlierRecordsPruned: boolean
    /** Current Host retention configuration, shared with delivery history. */
    readonly retention: DeliveryRetentionBounds
    /** Oldest returned run identity, present only when older saved records remain. */
    readonly nextBefore?: string
  }
  | { readonly id: ScheduleId; readonly code: 'schedule_not_found' | 'run_cursor_not_found' }
```

## Action provider contract

```ts type-equiv
/** Execution context one run receives; every value is resolved before the provider runs. */
interface ScheduleActionEnv {
  /** The bound Session's current policy, narrowed to the task's creation-time ceiling. */
  readonly sandboxPolicy: SandboxExecutionPolicy
  /** Absolute working directory captured at creation. */
  readonly cwd: string
  /** Elapsed budget after Host defaulting and capping. */
  readonly timeoutMs: number
  /** Fires on task deletion, archive stop, or Host disposal. */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/** Provider-reported terminal outcome of one run; the Host truncates and saves it. */
interface ScheduleActionResult {
  /** Classification a provider can observe, including an unavailable execution language or substrate. */
  readonly outcome: 'succeeded' | 'failed' | 'timeout' | 'aborted' | 'sandbox-denied' | 'unavailable'
  /** Process exit code, for actions that run one process. */
  readonly exitCode?: number | null
  /** Complete captured output; the Host applies its byte budget. */
  readonly output: string
  /** Whether the provider's own capture already dropped bytes. */
  readonly outputTruncated?: boolean
}
```

```ts type-equiv
/**
 * One script-action kind. Providers register through
 * {@link ScheduleActionRegistry.register}; the Host owns timing, storage,
 * reporting, and cancellation, and the provider owns its specification.
 */
interface ScheduleActionProvider {
  /** Kind stored on task rows; also the tool consumer's discriminator. */
  readonly kind: string
  /** Model-facing description of what this kind runs and how its output is captured. */
  readonly description: string
  /** Tool DSL schema of the specification object; required properties use `required: true`. */
  readonly specSchema: ValueSchemaSpec
  /**
   * Validate untrusted input at creation and at run time.
   * @param spec - Model or durable specification.
   * @returns The canonical specification the Host stores.
   * @throws ScheduleInputError with `invalid_action` when the specification is invalid.
   */
  decode(spec: unknown): JsonValue
  /**
   * Render the stored specification for read-only display and update comparison.
   * @param spec - Canonical specification returned by decode.
   * @returns The complete source text the action runs.
   */
  source(spec: JsonValue): string
  /**
   * Run once. Failures of the action resolve as outcomes; only provider contract misuse rejects.
   * @param spec - Canonical specification returned by decode.
   * @param env - Resolved policy, directory, budget, and cancellation.
   * @returns The terminal outcome and captured output.
   */
  run(spec: JsonValue, env: ScheduleActionEnv): Promise<ScheduleActionResult>
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxschedule--scheduleservice"></a>

### `ctx.schedule` — `ScheduleService`

Shared management service; reads, deletion, and timing edits never activate a Session.

`sessionPersistence` is a load-order requirement rather than a directly called service: a delivery commits only when `ctx.sessions.flush()` reports that a `session/flush` listener participated, and the persistence backend providing this service is the plugin that registers that listener.

```ts cordis-catalog
/**
 * Create a reminder bound to the caller-selected Session without activating it.
 *
 * The request must supply a title; a missing, blank-after-trim, or over-long
 * title rejects with `invalid_prompt` instead of deriving one from the prompt.
 * A Session a delegated child owns rejects with `subagent_session`, because delivery
 * can never reach it: the child is one whose delegation depth is above zero.
 * The record is built from the clock reading taken before the request joins the
 * serialized queue, so a create that waits behind a longer operation keeps its
 * request-time anchor and may already be due when the queue reaches it.
 * @param sessionId - Original Session receiving the reminder.
 * @param request - Validated tool selector, required title, and reminder content.
 * @param signal - Optional cancellation checked before persistence begins, including after FIFO waits.
 * @param script - Script action, report policy, and trusted binding; omitted creates a prompt reminder.
 * @returns The durably stored schedule. Cancellation does not roll back an in-flight write.
 */
async create( sessionId: SessionId, request: ScheduleCreateRequest, signal?: AbortSignal, script?: ScheduleCreateActionRequest, ): Promise<ScheduleRecord>

/**
 * Read the selected Session's active tasks without resuming its Agent.
 * @param request - Session whose task list is requested.
 * @returns Persisted reminders in storage order.
 */
@Remote('list') async list(request: ScheduleListRequest): Promise<ScheduleRecord[]>

/**
 * Read all active and inactive Host reminders with their original Session bindings.
 * A deleted reminder has no row, so it is absent here.
 * Does not activate Sessions or read Session history.
 * @returns Reminders ordered by scheduledAt ascending, then lexicographically by id.
 */
@Remote('catalog') async catalog(): Promise<ScheduleCatalogEntry[]>

/**
 * Read saved script runs without activating or reading the original Session.
 * @param request - Session binding, task identity, explicit limit, and optional exclusive run cursor.
 * @returns Newest-first runs, or a task/cursor lookup failure; a prompt reminder has no runs.
 * @throws ScheduleInputError when limit is not a safe integer from 1 through 100.
 */
@Remote('runs') async runs(request: ScheduleRunHistoryRequest): Promise<ScheduleRunHistoryResult>

/**
 * Read saved inbox deliveries without activating or reading the original Session.
 * The task's own row supplies its binding, so its records stay readable through this lookup.
 * @param request - Session binding, task identity, explicit limit, and optional exclusive message cursor.
 * @returns Newest-first deliveries in append order, or a task/cursor lookup failure.
 * @throws ScheduleInputError when limit is not a safe integer from 1 through 100.
 */
@Remote('history') async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult>

/**
 * Delete one task belonging to the selected Session, leaving queued messages intact.
 *
 * The row is removed: the task no longer schedules, leaves `list` and `catalog`, and its
 * saved delivery records go with it. A task bound to a Session a delegated child owns
 * stays deletable even though creation and timing edits refuse that binding, so a task
 * stored before that rule existed remains removable.
 * @param request - Session and exact task identity.
 * @param signal - Optional cancellation checked before persistence begins, including after FIFO waits.
 * @returns Whether that Session owned a deleted task. Cancellation does not roll back an in-flight write.
 */
@Remote('delete') async delete(request: ScheduleDeleteRequest, signal?: AbortSignal): Promise<ScheduleDeleteResult>

/**
 * Update the name, instruction, and timing of an active task within the original Session
 * binding without activating the Session or changing saved deliveries.
 *
 * Each supplied field replaces its stored value; an omitted field keeps it. A name or
 * instruction change alone does not reset the committed target. A Session a delegated
 * child owns returns the non-mutating `subagent_session` result, so an edit cannot
 * re-arm a task bound to a Session delivery can never reach, and the Web editor can
 * explain the refusal through the ordinary result it already renders.
 * @param request - Task binding, complete observed record, and any combination of timing, name, and instruction.
 * @param signal - Cancellation checked after domain readiness and FIFO waits, before persistence begins.
 * @returns The committed record, unchanged record for a no-op, or a non-mutating input/lookup/conflict/refusal result.
 * Storage and lifecycle failures reject; cancellation after a write starts does not roll it back.
 */
@Remote('update') async update(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult>

/**
 * Deliver one active task's stored instruction now without advancing or ending it.
 *
 * The run reuses the dispatch pipeline, so the Session receives the same framing,
 * the same inbox splice, and the same persistence acknowledgment a due task gets.
 * Only the bookkeeping differs: the record keeps its committed target and status,
 * and the delivery is saved as a manual receipt, which the records view tells
 * apart from a scheduled occurrence. Nothing reaches the model as a new surface.
 * @param request - Task binding whose stored instruction is delivered now.
 * @param signal - Optional cancellation checked before delivery begins, including after FIFO waits.
 * @returns The acknowledgment, or a non-mutating lookup/ended/unavailable result.
 */
@Remote('run') async run(request: ScheduleRunRequest, signal?: AbortSignal): Promise<ScheduleRunResult>
```

Types: [SessionId](core.md)

Source: [`packages/schedule/schedule/src/index.ts`](../../packages/schedule/schedule/src/index.ts)

<a id="schedule-events"></a>

### `schedule/*` events

<a id="scheduleactions-changed--emit"></a>

#### `schedule/actions-changed` — emit

The set of mounted script-action providers changed; tool consumers refresh their action schema.

```ts cordis-catalog
/** The set of mounted script-action providers changed; tool consumers refresh their action schema.
 * @mode emit
 */
'schedule/actions-changed'(): void
```

Source: [`packages/schedule/schedule/src/types.ts`](../../packages/schedule/schedule/src/types.ts)

<a id="schedulechanged--emit"></a>

#### `schedule/changed` — emit

Durable task set changed; clients refetch global task and Session-active catalogs.

```ts cordis-catalog
/** Durable task set changed; clients refetch global task and Session-active catalogs.
 * @mode emit
 */
'schedule/changed'(): void
```

Source: [`packages/schedule/schedule/src/types.ts`](../../packages/schedule/schedule/src/types.ts)
<!-- END GENERATED cordis-surface -->
