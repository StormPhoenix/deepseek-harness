/** Host-wide durable reminders and shared human/model management. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import z from '@deepseek-ai/schemastery'
import { Context, Service } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import { ScheduleRuntime } from './runtime.ts'
import { isScriptTask, scheduleDomain } from './storage.ts'
import type { ScheduleTask, ScriptScheduleTask } from './storage.ts'
import { appendDelivery, deliveryHistoryPage, publicReceipt } from './delivery-history.ts'
import { publicRun, runHistoryPage } from './run-history.ts'
import { ScheduleActionRegistry, fallbackSource } from './actions.ts'
import { resolveScheduleUpdate } from './update.ts'
import {
  foldScheduleEvents, ScheduleInputError, ScheduleLogError, ScheduleId, createAfterScheduleRecord, createAtScheduleRecord,
  createEveryScheduleRecord, createDailyScheduleRecord, createWeeklyScheduleRecord, createCronScheduleRecord,
  scheduleTitle,
} from './domain.ts'
import type {
  DeliveryRetentionBounds, ScheduleActionInput, ScheduleActionSummary, ScheduleCatalogEntry, ScheduleCreateActionRequest,
  ScheduleCreateRequest, ScheduleDeleteRequest, ScheduleDeleteResult, ScheduleDeliveryHistoryRequest,
  ScheduleDeliveryHistoryResult, ScheduleListRequest, ScheduleRecord, ScheduleReportPolicy, ScheduleRunHistoryRequest,
  ScheduleRunHistoryResult, ScheduleRunRequest, ScheduleRunResult, ScheduleUpdateRequest, ScheduleUpdateResult,
  SubagentSessionError,
} from './types.ts'

export type * from './types.ts'
export { scheduleDomain, isScriptTask } from './storage.ts'
export type { ScheduleTask, ScriptScheduleTask } from './storage.ts'
export { ScheduleActionRegistry, narrowSandboxPolicy, truncateOutput } from './actions.ts'
export type { ScheduleActionEnv, ScheduleActionProvider, ScheduleActionResult } from './actions.ts'
export type { RecurringOccurrence } from './domain.ts'
export {
  SCHEDULE_CHANGE_VERSION,
  MIN_EVERY_INTERVAL_SECONDS,
  MAX_TITLE_LENGTH,
  REQUIRED_TITLE_MESSAGE,
  ScheduleId,
  ScheduleInputError,
  ScheduleLogError,
  canonicalizeCronExpression,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createEveryScheduleRecord,
  createDailyScheduleRecord,
  createWeeklyScheduleRecord,
  createCronScheduleRecord,
  decodeScheduleChange,
  decodeScheduleRecord,
  foldScheduleEvents,
  isRecurringScheduleRecord,
  normalizeWeekdays,
  parseCronInput,
  parseWeeklyInput,
  renderReminderFraming,
  renderRecurringReminderBatchFraming,
  renderRunResultFraming,
  resolveEveryOccurrence,
  resolveDailyOccurrence,
  resolveWeeklyOccurrence,
  resolveCronOccurrence,
  resolveRecurringOccurrence,
  scheduleTitle,
  scheduleView,
  weeklyTime,
} from './domain.ts'


declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable Host-wide reminder management. */
    schedule: ScheduleService
  }
}

/** Configuration for the Host Schedule domain. */
export interface Config {
  /**
   * Delivery-history window retained per task, in days; omission defaults to 30.
   * Pruning happens when an acknowledgment is appended, and `lastDelivery` is always retained.
   */
  deliveryHistoryDays?: number
  /**
   * Retained delivery records per task; omission defaults to 200. The older of this
   * cap and the window wins, and the newest records survive.
   */
  deliveryHistoryRecords?: number
  /** Byte budget of each script run's saved and delivered output; omission defaults to 16384. */
  runOutputBytes?: number
  /** Elapsed budget of a script task that states none, in milliseconds; omission defaults to 120000. */
  actionTimeoutMs?: number
  /** Cap of any script task's elapsed budget, in milliseconds; omission defaults to 600000. */
  maxActionTimeoutMs?: number
}

/** Retained delivery-history window applied when the deployment states none. */
const DEFAULT_DELIVERY_HISTORY_DAYS = 30

/** Retained delivery-history record cap applied when the deployment states none. */
const DEFAULT_DELIVERY_HISTORY_RECORDS = 200

/** Script-run output budget applied when the deployment states none. */
const DEFAULT_RUN_OUTPUT_BYTES = 16_384

/** Script-run elapsed budget applied when neither the task nor the deployment states one. */
const DEFAULT_ACTION_TIMEOUT_MS = 120_000

/** Script-run elapsed cap applied when the deployment states none. */
const DEFAULT_MAX_ACTION_TIMEOUT_MS = 600_000

/** Longest stored action source a summary line shows. */
const SUMMARY_LENGTH = 120

/**
 * Validate an untrusted report policy.
 * @param report - Value received over the tool or RPC boundary.
 * @returns The policy, defaulting to `always`.
 */
function reportPolicy(report: unknown): ScheduleReportPolicy {
  if (report === undefined) return 'always'
  if (report === 'always' || report === 'on-failure' || report === 'never') return report
  throw new ScheduleInputError('invalid_action', 'report must be always, on-failure, or never.')
}

/**
 * One line of a source text for list display.
 * @param source - Complete source.
 * @returns First non-empty line, cut to the summary length.
 */
function summaryLine(source: string): string {
  const line = source.split('\n').find(candidate => candidate.trim().length > 0)?.trim() ?? ''
  return line.length > SUMMARY_LENGTH ? `${line.slice(0, SUMMARY_LENGTH - 1)}…` : line
}

/**
 * Shared management service; reads, deletion, and timing edits never activate a Session.
 *
 * `sessionPersistence` is a load-order requirement rather than a directly called
 * service: a delivery commits only when `ctx.sessions.flush()` reports that a
 * `session/flush` listener participated, and the persistence backend providing this
 * service is the plugin that registers that listener.
 */
export class ScheduleService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'storageDomain', 'sessionController', 'sessionPersistence']

  static Config: z<Config> = z.object({
    deliveryHistoryDays: z.number().step(1).min(1).max(3650).default(DEFAULT_DELIVERY_HISTORY_DAYS),
    deliveryHistoryRecords: z.number().step(1).min(1).max(10_000).default(DEFAULT_DELIVERY_HISTORY_RECORDS),
    runOutputBytes: z.number().step(1).min(256).max(1_048_576).default(DEFAULT_RUN_OUTPUT_BYTES),
    actionTimeoutMs: z.number().step(1).min(1000).max(86_400_000).default(DEFAULT_ACTION_TIMEOUT_MS),
    maxActionTimeoutMs: z.number().step(1).min(1000).max(86_400_000).default(DEFAULT_MAX_ACTION_TIMEOUT_MS),
  })

  /**
   * Script-action providers. Provider plugins register a kind here; the
   * returned disposer belongs in the registering plugin's effect.
   */
  readonly actions: ScheduleActionRegistry

  /** Resolved retention bounds shared with the runtime that appends acknowledgments. */
  private readonly retention: DeliveryRetentionBounds
  private readonly limits: { outputBytes: number; defaultTimeoutMs: number; maxTimeoutMs: number }
  private readonly ready: Promise<Domain<typeof scheduleDomain>>
  private readonly initialized: PromiseLike<unknown>
  private chain: Promise<unknown> = Promise.resolve()
  private runtime: ScheduleRuntime | undefined
  private stopping = false

  /**
   * @param ctx - Host services owning storage, dispatch, and Session restoration.
   * @param config - Validated retention configuration for delivery history.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'schedule')
    this.retention = {
      days: config.deliveryHistoryDays ?? DEFAULT_DELIVERY_HISTORY_DAYS,
      records: config.deliveryHistoryRecords ?? DEFAULT_DELIVERY_HISTORY_RECORDS,
    }
    this.limits = {
      outputBytes: config.runOutputBytes ?? DEFAULT_RUN_OUTPUT_BYTES,
      defaultTimeoutMs: config.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
      maxTimeoutMs: config.maxActionTimeoutMs ?? DEFAULT_MAX_ACTION_TIMEOUT_MS,
    }
    if (this.limits.defaultTimeoutMs > this.limits.maxTimeoutMs) {
      throw new Error(`schedule: actionTimeoutMs (${this.limits.defaultTimeoutMs}) exceeds maxActionTimeoutMs (${this.limits.maxTimeoutMs})`)
    }
    this.actions = new ScheduleActionRegistry(() => {
      try {
        ctx.emit('schedule/actions-changed')
      } catch (error: unknown) {
        // Only the synchronous observer dispatch runs here; registration already committed.
        ctx.logger.warn(`schedule: schedule/actions-changed listener failed: ${String(error)}`)
      }
    })
    this.ready = ctx.storageDomain.open(scheduleDomain).then(async (domain) => {
      for (const [key, task] of domain.table('tasks').entries()) {
        if (key !== task.record.id) {
          // The mismatch is the actionable failure; a rejecting close must not replace it.
          try {
            await domain.close()
          } catch (error: unknown) {
            ctx.logger.warn(`schedule: closing the domain after a key mismatch failed: ${String(error)}`)
          }
          throw new Error(`schedule: stored task key "${key}" differs from record id "${task.record.id}"`)
        }
      }
      return domain
    })
    this.initialized = ctx.effect(async () => {
      const domain = await this.ready
      let cleanup: () => Promise<void>
      try {
        cleanup = ctx.effect(() => async () => {
          this.stopping = true
          await this.runtime?.dispose()
          await this.chain // The chain contains failures after returning them to their callers.
          await domain.close()
        })
      } catch (error) {
        this.stopping = true
        await domain.close()
        throw error
      }
      const tasks = domain.table('tasks')
      this.runtime = new ScheduleRuntime(ctx,
        () => [...tasks.entries()].map(([, task]) => task),
        work => this.serialize(work),
        async (task) => {
          await tasks.put(task.record.id, task)
          this.emitChanged()
        },
        this.retention,
        { registry: this.actions, limits: this.limits })
      const runtime = this.runtime
      // Provider plugins inject Schedule, so Loader settlement must not be awaited by Service.init itself.
      void Promise.resolve(this.initialized).then(async () => {
        await ctx.get('loader')?.await()
        if (!this.stopping) runtime.requestDrive()
      }).catch((error: unknown) => {
        ctx.logger.warn(`schedule: initial dispatch could not start: ${String(error)}`)
      })
      return cleanup
    })
    ctx.on('session/created', (session) => {
      // Historical Schedule events remain readable but do not populate Host tasks.
      // A throwing `session/created` listener rolls the attach back, so an unreadable
      // legacy stream must warn here instead of blocking Session creation.
      let activeLegacy = 0
      try {
        // oxlint-disable-next-line typescript/no-deprecated -- Explicit warning for legacy Schedule history.
        activeLegacy = foldScheduleEvents(session.ownEvents()).active.length
      } catch (error: unknown) {
        /* v8 ignore next -- foldScheduleEvents normalizes every rejected stream to ScheduleLogError. */
        if (!(error instanceof ScheduleLogError)) throw error
        ctx.logger.warn(`schedule: Session "${session.id}" historical events could not be read (${error.message}); the legacy reminder is ignored.`)
        return
      }
      if (activeLegacy > 0) {
        ctx.logger.warn(`schedule: Session "${session.id}" contains legacy reminders; recreate active reminders with schedule_create.`)
      }
    }, { global: true })
    // Host tasks outlive their Session's Agent, so archive admission reads the
    // stored rows rather than a live runtime: an idle Session whose reminders
    // are still armed refuses the archive, and an archiving stop deletes those
    // rows instead of letting them deliver into a closed Session.
    ctx.effect(() => {
      const activity = ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
        const active = [...(await this.getDomain()).table('tasks').entries()]
          .filter(([, task]) => task.sessionId === sessionId && (task.status === 'active' || task.inFlight !== undefined))
          .map(([, task]) => task.record)
        const rest = await next()
        if (active.length === 0) return rest
        const own: SessionActivity = {
          kind: 'schedule',
          items: active.map(record => ({ id: record.id, label: record.title })),
        }
        return [own, ...rest]
      })
      const stop = ctx.on('workspace/session-stop', async ({ sessionId }) => {
        await this.stopSessionTasks(sessionId)
      })
      return () => {
        stop()
        activity()
      }
    }, 'schedule.archiveAdmission()')
  }

  async [Service.init](): Promise<void> {
    await this.initialized
  }

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
  async create(
    sessionId: SessionId, request: ScheduleCreateRequest, signal?: AbortSignal, script?: ScheduleCreateActionRequest,
  ): Promise<ScheduleRecord> {
    const scriptMembers = script === undefined ? undefined : this.scriptMembers(script)
    if (Number(request.at !== undefined) + Number(request.after_seconds !== undefined)
      + Number(request.every_seconds !== undefined) + Number(request.daily !== undefined)
      + Number(request.weekly !== undefined) + Number(request.cron !== undefined) > 1) {
      throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    }
    const title = scheduleTitle(request.title)
    const id = ScheduleId(`schedule-${randomUUID()}`)
    const now = Date.now()
    let record: ScheduleRecord
    if (request.at !== undefined) {
      record = createAtScheduleRecord(id, request.prompt, request.at, now, title)
    }
    else if (request.after_seconds !== undefined) {
      record = createAfterScheduleRecord(id, request.prompt, request.after_seconds, now, title)
    }
    else if (request.every_seconds !== undefined) {
      record = createEveryScheduleRecord(id, request.prompt, request.every_seconds, now, title)
    }
    else if (request.daily !== undefined) record = createDailyScheduleRecord(id, request.prompt, request.daily, now, title)
    else if (request.weekly !== undefined) record = createWeeklyScheduleRecord(id, request.prompt, request.weekly, now, title)
    else if (request.cron !== undefined) record = createCronScheduleRecord(id, request.prompt, request.cron, now, title)
    else throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    return this.serialize(async () => {
      const refusal = this.reminderTargetRefusal(sessionId)
      if (refusal !== undefined) throw new ScheduleInputError('subagent_session', refusal.message)
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      await domain.table('tasks').put(id, {
        sessionId, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false },
        ...scriptMembers,
      })
      this.emitChanged()
      this.runtime?.requestDrive()
      return record
    })
  }

  /**
   * Read the selected Session's active tasks without resuming its Agent.
   * @param request - Session whose task list is requested.
   * @returns Persisted reminders in storage order.
   */
  @Remote('list')
  async list(request: ScheduleListRequest): Promise<ScheduleRecord[]> {
    const domain = await this.getDomain()
    return [...domain.table('tasks').entries()]
      .filter(([, task]) => task.sessionId === request.sessionId && task.status === 'active')
      .map(([, task]) => task.record)
  }

  /**
   * Read all active and inactive Host reminders with their original Session bindings.
   * A deleted reminder has no row, so it is absent here.
   * Does not activate Sessions or read Session history.
   * @returns Reminders ordered by scheduledAt ascending, then lexicographically by id.
   */
  @Remote('catalog')
  async catalog(): Promise<ScheduleCatalogEntry[]> {
    const domain = await this.getDomain()
    return [...domain.table('tasks').entries()]
      .map(([, task]) => this.catalogEntry(task))
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id))
  }

  /**
   * Read saved script runs without activating or reading the original Session.
   * @param request - Session binding, task identity, explicit limit, and optional exclusive run cursor.
   * @returns Newest-first runs, or a task/cursor lookup failure; a prompt reminder has no runs.
   * @throws ScheduleInputError when limit is not a safe integer from 1 through 100.
   */
  @Remote('runs')
  async runs(request: ScheduleRunHistoryRequest): Promise<ScheduleRunHistoryResult> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new ScheduleInputError('invalid_rule', 'Run history limit must be a safe integer from 1 through 100.')
    }
    const task = (await this.getDomain()).table('tasks').get(request.id)
    if (task === undefined || task.sessionId !== request.sessionId) {
      return { id: request.id, code: 'schedule_not_found' }
    }
    return runHistoryPage(task, request, this.retention)
  }

  /**
   * Read saved inbox deliveries without activating or reading the original Session.
   * The task's own row supplies its binding, so its records stay readable through this lookup.
   * @param request - Session binding, task identity, explicit limit, and optional exclusive message cursor.
   * @returns Newest-first deliveries in append order, or a task/cursor lookup failure.
   * @throws ScheduleInputError when limit is not a safe integer from 1 through 100.
   */
  @Remote('history')
  async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new ScheduleInputError('invalid_rule', 'Delivery history limit must be a safe integer from 1 through 100.')
    }
    const task = (await this.getDomain()).table('tasks').get(request.id)
    if (task === undefined || task.sessionId !== request.sessionId) {
      return { id: request.id, code: 'schedule_not_found' }
    }
    return deliveryHistoryPage(task, request, this.retention)
  }

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
  @Remote('delete')
  async delete(request: ScheduleDeleteRequest, signal?: AbortSignal): Promise<ScheduleDeleteResult> {
    return this.serialize<ScheduleDeleteResult>(async () => {
      const tasks = (await this.getDomain()).table('tasks')
      signal?.throwIfAborted()
      const current = tasks.get(request.id)
      if (current === undefined || current.sessionId !== request.sessionId) {
        return { id: request.id, deleted: false, code: 'schedule_not_found' }
      }
      await tasks.delete(request.id)
      // The row is gone, so the cancelled run's outcome finds nothing to record.
      this.runtime?.abortRun(request.id)
      this.emitChanged()
      this.runtime?.requestDrive()
      return { id: request.id, deleted: true }
    })
  }

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
  @Remote('update')
  async update(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult> {
    return this.serialize<ScheduleUpdateResult>(async () => {
      const refusal = this.reminderTargetRefusal(request.sessionId)
      if (refusal !== undefined) return refusal
      const tasks = (await this.getDomain()).table('tasks')
      signal?.throwIfAborted()
      const current = tasks.get(request.id)
      if (current === undefined || current.sessionId !== request.sessionId) {
        return { id: request.id, updated: false, code: 'schedule_not_found' }
      }
      if (current.status === 'inactive') return { id: request.id, updated: false, code: 'schedule_ended' }
      if (current.inFlight !== undefined) return { id: request.id, updated: false, code: 'schedule_conflict' }
      const scriptChange = request.action !== undefined || request.report !== undefined
      if (scriptChange && !isScriptTask(current)) return { id: request.id, updated: false, code: 'not_script_task' }
      let scriptPatch: Pick<ScheduleTask, 'action' | 'report'> = {}
      if (scriptChange && isScriptTask(current)) {
        try {
          if (request.action !== undefined) {
            if (request.expectedAction === undefined || !isDeepStrictEqual(request.expectedAction, this.actionIdentity(current))) {
              return { id: request.id, updated: false, code: 'schedule_conflict' }
            }
            scriptPatch = { action: this.storedAction(request.action) }
          }
          if (request.report !== undefined) scriptPatch = { ...scriptPatch, report: reportPolicy(request.report) }
        } catch (error: unknown) {
          if (!(error instanceof ScheduleInputError)) throw error
          return { code: error.code, message: error.message }
        }
      }
      const result = resolveScheduleUpdate(current.record, request.expected, request.change, Date.now(), request)
      if (!('record' in result)) return result
      const next: ScheduleTask = { ...current, record: result.record, ...scriptPatch }
      if (!result.updated && isDeepStrictEqual(next, current)) return result
      await tasks.put(request.id, next)
      this.emitChanged()
      this.runtime?.requestDrive()
      return { ...result, updated: true }
    })
  }

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
  @Remote('run')
  async run(request: ScheduleRunRequest, signal?: AbortSignal): Promise<ScheduleRunResult> {
    return this.serialize<ScheduleRunResult>(async () => {
      const refusal = this.reminderTargetRefusal(request.sessionId)
      if (refusal !== undefined) return refusal
      const tasks = (await this.getDomain()).table('tasks')
      signal?.throwIfAborted()
      const task = tasks.get(request.id)
      if (task === undefined || task.sessionId !== request.sessionId) {
        return { id: request.id, ran: false, code: 'schedule_not_found' }
      }
      if (task.status === 'inactive') return { id: request.id, ran: false, code: 'schedule_ended' }
      const runtime = this.runtime
      /* v8 ignore next 2 -- getDomain() awaits initialization, which always constructs the runtime. */
      if (runtime === undefined) throw new Error('schedule: the runtime is not available')
      if (isScriptTask(task)) {
        if (task.inFlight !== undefined) return { id: request.id, ran: false, code: 'schedule_running' }
        // The plan stays armed: a manual run keeps the committed target and status.
        const started = await runtime.startScript(task, task.record.scheduledAt, true)
        return { id: request.id, ran: true, runId: started.runId, startedAt: started.startedAt }
      }
      const delivery = await runtime.deliverNow(task)
      if (!delivery.delivered) return { id: request.id, ran: false, code: 'session_unavailable' }
      await tasks.put(task.record.id, {
        ...task,
        ...appendDelivery(task, {
          scheduledAt: task.record.scheduledAt,
          deliveredAt: delivery.deliveredAt,
          messageId: delivery.messageId,
          manual: true,
        }, this.retention),
      })
      // Only the saved delivery changed: the plan stays armed, so the timer needs no recomputation.
      this.emitChanged()
      return { id: request.id, ran: true, deliveredAt: delivery.deliveredAt }
    })
  }

  /**
   * Validate the script part of a creation before it joins the queue.
   * @param script - Untrusted action and report with the caller's trusted binding.
   * @returns Stored script-task members.
   * @throws ScheduleInputError for an unavailable kind, invalid specification, timeout, report, or binding.
   */
  private scriptMembers(script: ScheduleCreateActionRequest): Pick<ScheduleTask, 'action' | 'report' | 'binding'> {
    if (!isAbsolute(script.binding.cwd)) {
      throw new ScheduleInputError('invalid_action', 'A script task needs an absolute working directory.')
    }
    return {
      action: this.storedAction(script.action),
      report: reportPolicy(script.report),
      binding: { cwd: script.binding.cwd, sandboxCeiling: script.binding.sandboxCeiling },
    }
  }

  /**
   * Validate an untrusted action through its provider.
   * @param input - Requested kind, specification, and optional timeout.
   * @returns The stored action.
   * @throws ScheduleInputError for an unavailable kind, invalid specification, or out-of-range timeout.
   */
  private storedAction(input: ScheduleActionInput): NonNullable<ScheduleTask['action']> {
    if (typeof input.kind !== 'string') throw new ScheduleInputError('invalid_action', 'action kind must be a string.')
    const provider = this.actions.require(input.kind)
    const spec = provider.decode(input.spec)
    if (input.timeoutMs !== undefined
      && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > this.limits.maxTimeoutMs)) {
      throw new ScheduleInputError('invalid_action', `timeout must be a positive whole number of milliseconds up to ${this.limits.maxTimeoutMs}.`)
    }
    return { kind: input.kind, spec, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) }
  }

  /**
   * The stored action as the update comparison sees it.
   * @param task - Script task.
   * @returns Kind, rendered source, and optional timeout.
   */
  private actionIdentity(task: ScriptScheduleTask): { kind: string; source: string; timeoutMs?: number } {
    const provider = this.actions.get(task.action.kind)
    return {
      kind: task.action.kind,
      source: provider === undefined ? fallbackSource(task.action.spec) : provider.source(task.action.spec),
      ...(task.action.timeoutMs === undefined ? {} : { timeoutMs: task.action.timeoutMs }),
    }
  }

  /**
   * Project one stored row onto the browser-safe catalog entry.
   * @param task - Stored row.
   * @returns The entry with script members only on a script task.
   */
  private catalogEntry(task: ScheduleTask): ScheduleCatalogEntry {
    const base = {
      ...task.record, sessionId: task.sessionId, status: task.status,
      ...(task.lastDelivery === undefined ? {} : { lastDelivery: publicReceipt(task.lastDelivery) }),
    }
    if (!isScriptTask(task)) return base
    const identity = this.actionIdentity(task)
    const action: ScheduleActionSummary = {
      ...identity,
      summary: summaryLine(identity.source),
      cwd: task.binding.cwd,
      sandboxCeiling: task.binding.sandboxCeiling,
      available: this.actions.get(task.action.kind) !== undefined,
    }
    const lastRun = task.runHistory?.records.at(-1)
    return {
      ...base,
      action,
      report: task.report,
      ...(task.inFlight === undefined ? {} : { running: { runId: task.inFlight.runId, startedAt: task.inFlight.startedAt } }),
      ...(lastRun === undefined ? {} : { lastRun: publicRun(lastRun) }),
    }
  }

  /**
   * Dispatch one post-commit `schedule/changed` notification, containing
   * synchronous listener failures: every call site emits only after its durable
   * task write landed, so a throwing listener must not reject the caller or
   * skip the following `requestDrive()`.
   */
  private emitChanged(): void {
    try {
      this.ctx.emit('schedule/changed')
    } catch (error: unknown) {
      // Swallows synchronous observer exceptions only: emit dispatches
      // listeners inline and nothing else runs in the try. The event is a
      // notification, not a transaction participant.
      this.ctx.logger.warn(`schedule: schedule/changed listener failed: ${String(error)}`)
    }
  }

  private async getDomain(): Promise<Domain<typeof scheduleDomain>> {
    await this.initialized
    return this.ready
  }

  /**
   * Refuse a Session no delivery can reach because a delegated child owns it.
   *
   * Delivery resolves the bound Session through `ctx.sessionController.resolveAgent`,
   * which rejects the live Agent of a delegated child; a stored task for such a Session
   * would stay permanently overdue and retry on every drive. Both operations that can
   * arm a delivery read that same fact here instead of restating it: a delegated child
   * is one whose {@link delegationDepthOf} is above zero, the accounting the delegation
   * cap itself enforces, which survives a cold resume through the persisted header.
   * @param sessionId - Session the task would be bound to.
   * @returns The stable refusal for a delegated child's Session, or undefined when the Session is eligible.
   */
  private reminderTargetRefusal(sessionId: SessionId): SubagentSessionError | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined || delegationDepthOf(agent) === 0) return undefined
    return {
      code: 'subagent_session',
      message: 'This Session belongs to subagent routing, which never receives reminder delivery.',
    }
  }

  /**
   * Remove every active task stored for one Session, inside the queue the tools
   * use.
   *
   * Enumerating and deleting in one queue slot is what makes an archive stop
   * ordered behind a create whose write is still in flight: a stop that read the
   * table outside the queue could miss a row the create was about to commit and
   * leave an armed reminder behind. Re-entering the public `delete()` from here
   * would deadlock on this queue, so the rows are removed directly.
   * @param sessionId - Session whose active Host tasks must stop.
   */
  private async stopSessionTasks(sessionId: SessionId): Promise<void> {
    await this.serialize(async () => {
      const tasks = (await this.getDomain()).table('tasks')
      const active = [...tasks.entries()]
        .filter(([, task]) => task.sessionId === sessionId && (task.status === 'active' || task.inFlight !== undefined))
        .map(([, task]) => task.record.id)
      if (active.length === 0) return
      // One row per write: the domain table has no batch delete, and each row is
      // durable on its own, so a failure partway through leaves the rows already
      // removed committed. Observers hear about that change before the failure
      // reaches the caller, which still receives it.
      let removed = false
      let failure: Error | undefined
      for (const id of active) {
        try {
          await tasks.delete(id)
          this.runtime?.abortRun(id)
          removed = true
        } catch (error: unknown) {
          // Every row is attempted: the archive has already landed, so a row this
          // stop skipped would stay armed in a Session whose runtime then refuses
          // its model steps. A rejection reason that carries no Error still has to
          // report a failure, so it is wrapped before the first one is kept.
          failure ??= error instanceof Error ? error : new Error(`schedule stop failed: ${String(error)}`)
        }
      }
      if (removed) {
        this.emitChanged()
        this.runtime?.requestDrive()
      }
      if (failure !== undefined) throw failure
    })
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Schedule service is stopping'))
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined) // Preserve FIFO progress after the caller receives the failure.
    return pending
  }
}

export default ScheduleService
