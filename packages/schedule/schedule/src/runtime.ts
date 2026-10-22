/** Host timer over stored tasks; Session activation is a delivery operation. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'schedule': { kind: 'schedule' } & ContextFormed
  }
}
import { randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import {
  isRecurringScheduleRecord, renderReminderFraming, renderRecurringReminderBatchFraming, renderRunResultFraming,
  resolveRecurringOccurrence,
} from './domain.ts'
import type { RecurringOccurrence } from './domain.ts'
import type { DeliveryRetentionBounds, RecurringScheduleRecord, ScheduleReportPolicy } from './types.ts'
import { isScriptTask } from './storage.ts'
import type { ScheduleTask, ScriptScheduleTask, StoredRunRecord } from './storage.ts'
import { appendDelivery } from './delivery-history.ts'
import { appendRun } from './run-history.ts'
import { narrowSandboxPolicy, truncateOutput } from './actions.ts'
import type { ScheduleActionRegistry } from './actions.ts'

/** Largest delay Node timers represent without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Host limits applied to every script run. */
export interface ScriptRunLimits {
  /** Byte budget of saved and delivered output. */
  readonly outputBytes: number
  /** Elapsed budget of a task without its own. */
  readonly defaultTimeoutMs: number
  /** Cap of any task's elapsed budget. */
  readonly maxTimeoutMs: number
}

/** Script-run collaborators the service owns. */
export interface ScriptRunSupport {
  readonly registry: ScheduleActionRegistry
  readonly limits: ScriptRunLimits
}

/** Run started and persisted as in flight on its task row. */
type InFlightRun = NonNullable<ScheduleTask['inFlight']>

/** Terminal run before its optional delivery message is known. */
type RunOutcome = Omit<StoredRunRecord, 'messageId'>

/**
 * Whether a report policy delivers a run with the given outcome.
 * @param policy - Stored task policy.
 * @param outcome - Terminal run outcome.
 * @returns True when the result is delivered to the Session.
 */
function reports(policy: ScheduleReportPolicy, outcome: StoredRunRecord['outcome']): boolean {
  switch (policy) {
    case 'always': return true
    case 'on-failure': return outcome !== 'succeeded'
    case 'never': return false
    /* v8 ignore next 4 -- the storage schema admits only the three policies above. */
    default: {
      const unreachable: never = policy
      throw new Error(`Unknown report policy: ${String(unreachable)}`)
    }
  }
}

/**
 * The plan a recurring rule holds after serving its latest due occurrence.
 * @param record - Due recurring record.
 * @param occurrence - Resolved latest occurrence and optional future target.
 * @returns The advanced record and its lifecycle status; a rule with no future target ends.
 */
function advancedPlan(
  record: RecurringScheduleRecord, occurrence: RecurringOccurrence,
): { record: RecurringScheduleRecord; status: 'active' | 'inactive' } {
  return {
    record: { ...record, scheduledAt: occurrence.nextScheduledAt ?? occurrence.occurrenceAt },
    status: occurrence.nextScheduledAt === undefined ? 'inactive' : 'active',
  }
}

/** One immediate delivery's acknowledgment, or the Session that could not be resolved. */
export type ImmediateDelivery =
  | { readonly delivered: true; readonly messageId: MessageId; readonly deliveredAt: string }
  | { readonly delivered: false; readonly reason: 'session_unavailable' }

/**
 * Render the model-facing framing of one manually run task.
 *
 * A manual run consumes no occurrence, so a recurring rule states the committed
 * target it ran under rather than one newly resolved from the clock: the model
 * reads exactly the framing a scheduled delivery of that target would carry.
 * @param task - Active stored task the caller selected.
 * @returns The batch framing recurring rules receive, or the one-shot framing.
 */
function manualReminderText(task: ScheduleTask): string {
  return isRecurringScheduleRecord(task.record)
    ? renderRecurringReminderBatchFraming([{ record: task.record, occurrenceAt: task.record.scheduledAt }])
    : renderReminderFraming(task.record)
}

/** Owns at most one timer across recomputations; delivery and management share the serialized operation. */
export class ScheduleRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private stopping = false
  private readonly shutdown = new AbortController()
  private requested = false
  /** In-flight script runs keyed by task id; each runs outside the serialized queue. */
  private readonly runs = new Map<string, { readonly controller: AbortController; readonly done: Promise<void> }>()

  /**
   * @param ctx - Host services used to resume and enqueue.
   * @param tasks - Current durable tasks.
   * @param transact - Serialize delivery against management writes.
   * @param commit - Persist task status, target, receipt, and history together after durable inbox delivery.
   * @param retention - Bounds shared by delivery and run histories.
   * @param scripts - Action providers and Host run limits.
   */
  constructor(
    private readonly ctx: Context,
    private readonly tasks: () => readonly ScheduleTask[],
    private readonly transact: (work: () => Promise<void>) => Promise<void>,
    private readonly commit: (task: ScheduleTask) => Promise<void>,
    private readonly retention: DeliveryRetentionBounds,
    private readonly scripts: ScriptRunSupport,
  ) {}

  /**
   * Recompute the nearest obligation after startup or a durable change.
   * Dispatch failures are logged; refused admission does not retry automatically.
   */
  requestDrive(): void {
    if (this.stopping) return
    this.requested = true
    this.clearTimer()
    if (this.running !== undefined) return
    let run: Promise<void>
    try {
      run = this.ctx.agents.withoutInitiator(async () => {
        while (this.requested && !this.stopping) {
          this.requested = false
          await this.transact(async () => { await this.drive() })
        }
      })
    } catch (error: unknown) {
      // Ancestor unloading closes initiator admission before runtime cleanup runs.
      this.requested = false
      this.ctx.logger.warn(`schedule: dispatch stopped: ${String(error)}`)
      return
    }
    this.running = run
    void run.catch((error: unknown) => {
      this.ctx.logger.warn(`schedule: dispatch stopped: ${String(error)}`)
    }).finally(() => {
      this.running = undefined
      if (this.requested && !this.stopping) this.requestDrive()
    })
  }

  /** Stop the timer and drain an accepted delivery before storage closes. */
  async dispose(): Promise<void> {
    this.stopping = true
    this.shutdown.abort(new Error('Schedule runtime was disposed'))
    this.clearTimer()
    // requestDrive reports execution failures; teardown only waits for quiescence.
    await this.running?.catch(() => undefined)
    // A run cancelled here cannot record its outcome once the queue stops, so its
    // row keeps the in-flight marker and the next startup records it interrupted.
    for (const run of this.runs.values()) run.controller.abort(new Error('Schedule service is stopping'))
    await Promise.all([...this.runs.values()].map(run => run.done))
  }

  /**
   * Cancel the in-flight run of a task, as deletion and archive stops do.
   * @param id - Task identity.
   */
  abortRun(id: string): void {
    this.runs.get(id)?.controller.abort(new Error('The schedule task was removed'))
  }

  /**
   * Persist one run as in flight, then start it outside the serialized queue.
   * Callers hold the queue; the task row they pass already carries its next plan.
   * @param task - Script task row to persist with the in-flight marker.
   * @param scheduledAt - Occurrence the run serves, or the armed target of a manual run.
   * @param manual - Whether a person triggered the run.
   * @returns The persisted in-flight run.
   */
  async startScript(task: ScriptScheduleTask, scheduledAt: string, manual: boolean): Promise<InFlightRun> {
    const inFlight: InFlightRun = {
      runId: `run-${randomUUID()}`, scheduledAt, startedAt: new Date(Date.now()).toISOString(),
      ...(manual ? { manual: true } : {}),
    }
    const started: ScriptScheduleTask = { ...task, inFlight }
    await this.commit(started)
    const controller = new AbortController()
    const id = started.record.id
    const done = this.execute(started, inFlight, controller.signal)
      .then(outcome => this.transact(async () => {
        // Inside the queue slot no successor run of this task can start yet.
        this.runs.delete(id)
        await this.finish(id, inFlight, outcome)
      }))
      .catch((error: unknown) => {
        this.ctx.logger.warn(`schedule: run ${inFlight.runId} of task ${id} was not recorded: ${String(error)}`)
      })
    this.runs.set(id, { controller, done })
    return inFlight
  }

  /**
   * Run one script once; every failure resolves as an outcome.
   * @param task - Script task whose binding and action the run uses.
   * @param inFlight - Persisted in-flight run.
   * @param signal - Cancellation for deletion and disposal.
   * @returns The terminal outcome to record.
   */
  private async execute(task: ScriptScheduleTask, inFlight: InFlightRun, signal: AbortSignal): Promise<RunOutcome> {
    const settle = (outcome: StoredRunRecord['outcome'], output: string, exitCode?: number | null, providerCut = false): RunOutcome =>
      this.outcome(inFlight, outcome, output, exitCode, providerCut)
    const provider = this.scripts.registry.get(task.action.kind)
    if (provider === undefined) return settle('unavailable', `No script action provider for kind "${task.action.kind}" is mounted.`)
    const policyService = this.ctx.get('sandboxPolicy')
    if (policyService === undefined) return settle('unavailable', 'The sandbox policy service is not mounted.')
    const timeoutMs = Math.min(task.action.timeoutMs ?? this.scripts.limits.defaultTimeoutMs, this.scripts.limits.maxTimeoutMs)
    using budget = deadline(signal, timeoutMs, 'SCHEDULE_RUN_TIMEOUT')
    const startedAt = performance.now()
    try {
      const spec = provider.decode(task.action.spec)
      const resolved = await this.resolveSession(task.sessionId, budget.signal)
      if ('error' in resolved) return settle('unavailable', `The bound Session could not be resolved: ${resolved.error.message}`)
      budget.signal.throwIfAborted()
      if (this.scripts.registry.get(task.action.kind) !== provider) {
        return settle('unavailable', 'The action provider changed while the Session was being restored.')
      }
      const policy = narrowSandboxPolicy(policyService.resolve({ session: resolved.agent.session }), task.binding.sandboxCeiling)
      const remainingMs = Math.max(1, Math.ceil(timeoutMs - (performance.now() - startedAt)))
      const result = await provider.run(spec, {
        sandboxPolicy: policy, cwd: task.binding.cwd, timeoutMs: remainingMs, signal: budget.signal,
      })
      return settle(result.outcome, result.output, result.exitCode, result.outputTruncated === true)
    } catch (error: unknown) {
      const classification = timeoutOf(budget.signal, 'SCHEDULE_RUN_TIMEOUT') !== undefined ? 'timeout'
        : budget.signal.aborted ? 'aborted' : 'failed'
      return settle(classification, `The ${task.action.kind} action failed to run: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Wait for Session restoration without holding cancellation behind an unresponsive resolver.
   * The Session controller retains ownership of restoration; an abandoned result never launches code.
   * @param sessionId - Bound Session to restore.
   * @param signal - Execution deadline or shutdown signal.
   * @returns Resolution result, or rejects when the wait is cancelled.
   */
  private async resolveSession(sessionId: ScheduleTask['sessionId'], signal: AbortSignal) {
    signal.throwIfAborted()
    const cancelled = Promise.withResolvers<never>()
    const listener = addAbortListener(signal, () => {
      const reason: unknown = signal.reason
      cancelled.reject(reason)
    })
    try {
      return await this.ctx.agents.withoutInitiator(() => Promise.race([
        this.ctx.sessionController.resolveAgent(sessionId),
        cancelled.promise,
      ]))
    } finally {
      listener[Symbol.dispose]()
    }
  }

  /**
   * Build a terminal outcome, applying the Host output budget.
   * @param inFlight - Run the outcome belongs to.
   * @param outcome - Classification.
   * @param output - Complete output.
   * @param exitCode - Exit code, when the action reports one.
   * @param providerCut - Whether the provider's own capture already dropped bytes.
   * @returns Outcome ready to deliver and record.
   */
  private outcome(
    inFlight: InFlightRun, outcome: StoredRunRecord['outcome'], output: string, exitCode: number | null | undefined, providerCut: boolean,
  ): RunOutcome {
    const cut = truncateOutput(output, this.scripts.limits.outputBytes)
    return {
      runId: inFlight.runId, scheduledAt: inFlight.scheduledAt, startedAt: inFlight.startedAt,
      finishedAt: new Date(Date.now()).toISOString(),
      ...(inFlight.manual === undefined ? {} : { manual: true }),
      outcome,
      ...(exitCode === undefined ? {} : { exitCode }),
      output: cut.output,
      outputTruncated: cut.truncated || providerCut,
    }
  }

  /**
   * Deliver a run result by the task's report policy and record the run, holding the queue.
   * A row that was deleted, or whose in-flight marker names another run, keeps no record.
   * @param id - Task identity.
   * @param inFlight - The run this outcome belongs to.
   * @param outcome - Terminal outcome.
   */
  private async finish(id: string, inFlight: InFlightRun, outcome: RunOutcome): Promise<void> {
    const current = this.tasks().find(task => task.record.id === id)
    if (current === undefined || !isScriptTask(current) || current.inFlight?.runId !== inFlight.runId) return
    let messageId: MessageId | undefined
    if (reports(current.report, outcome.outcome)) {
      try {
        using budget = deadline(this.shutdown.signal, this.scripts.limits.defaultTimeoutMs, 'SCHEDULE_REPORT_TIMEOUT')
        messageId = await this.ctx.agents.withoutInitiator(async () => {
          const resolved = await this.resolveSession(current.sessionId, budget.signal)
          if ('error' in resolved) throw resolved.error
          return (await this.deliver(resolved.agent, renderRunResultFraming(current.record, current.action.kind, outcome))).messageId
        })
      } catch (error: unknown) {
        // The run finished; a failed report is warned and the saved run names no message.
        this.ctx.logger.warn(`schedule: the result of run ${inFlight.runId} was not delivered: ${String(error)}`)
      }
    }
    const { inFlight: _recorded, ...rest } = current
    const run: StoredRunRecord = { ...outcome, ...(messageId === undefined ? {} : { messageId }) }
    await this.commit({ ...rest, runHistory: appendRun(current, run, this.retention) })
  }

  /**
   * Record runs a previous Host process left in flight as interrupted; they are never repeated.
   * Holds the queue.
   */
  private async recoverInterrupted(): Promise<void> {
    for (const task of this.tasks()) {
      if (!isScriptTask(task) || task.inFlight === undefined || this.runs.has(task.record.id)) continue
      const outcome = this.outcome(task.inFlight, 'interrupted', 'The Host stopped while this run was in flight; it is not repeated.', undefined, false)
      try {
        await this.finish(task.record.id, task.inFlight, outcome)
      } catch (error: unknown) {
        this.ctx.logger.warn(`schedule: interrupted run ${task.inFlight.runId} was not recorded: ${String(error)}`)
      }
    }
  }

  /**
   * Advance a due script task and start its run, or record a skipped run while the previous one is in flight.
   * Holds the queue.
   * @param task - Due active script task.
   * @param now - Decision time in epoch milliseconds.
   */
  private async dispatchScript(task: ScriptScheduleTask, now: number): Promise<void> {
    let scheduledAt = task.record.scheduledAt
    let advanced: ScriptScheduleTask = { ...task, status: 'inactive' }
    if (isRecurringScheduleRecord(task.record)) {
      const occurrence = resolveRecurringOccurrence(task.record, now)
      scheduledAt = occurrence.occurrenceAt
      advanced = { ...task, ...advancedPlan(task.record, occurrence) }
    }
    if (task.inFlight !== undefined) {
      const decidedAt = new Date(now).toISOString()
      await this.commit({
        ...advanced,
        runHistory: appendRun(task, {
          runId: `run-${randomUUID()}`, scheduledAt, startedAt: decidedAt, finishedAt: decidedAt,
          outcome: 'skipped', output: 'The previous run of this task was still in flight.', outputTruncated: false,
        }, this.retention),
      })
      return
    }
    await this.startScript(advanced, scheduledAt, false)
  }

  /**
   * Deliver one task's stored instruction now without advancing or retiring its rule.
   *
   * The message is framed and enqueued exactly as a scheduled delivery is, so the
   * Session reacts identically; only the caller's bookkeeping differs, because a
   * manual run is not an occurrence of the rule.
   * @param task - Active stored task the caller selected.
   * @returns The acknowledgment, or the stable reason nothing was delivered.
   */
  async deliverNow(task: ScheduleTask): Promise<ImmediateDelivery> {
    return this.ctx.agents.withoutInitiator(async (): Promise<ImmediateDelivery> => {
      const resolved = await this.ctx.sessionController.resolveAgent(task.sessionId)
      if ('error' in resolved) return { delivered: false, reason: 'session_unavailable' }
      const { messageId, deliveredAt } = await this.deliver(resolved.agent, manualReminderText(task))
      return { delivered: true, messageId, deliveredAt }
    })
  }

  /**
   * Append one reminder to a resolved Session's inbox and wait for persistence to accept it.
   * @param agent - Live Agent for the task's original Session.
   * @param text - Model-facing reminder framing.
   * @returns The message identity and the acknowledgment time.
   */
  private async deliver(agent: Agent, text: string): Promise<{ messageId: MessageId; deliveredAt: string }> {
    const message = createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'schedule' },
    })
    // followup synchronously appends the inbox splice before flush observes the Session.
    agent.followup(message)
    const flushed = await this.ctx.sessions.flush(agent.session)
    if (!flushed) throw new Error('Session persistence did not acknowledge the reminder')
    return { messageId: message.id, deliveredAt: new Date(Date.now()).toISOString() }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private async drive(): Promise<void> {
    this.clearTimer()
    const failed = new Set<string>()
    const handled = new Set<string>()
    const scanNow = Date.now()
    await this.recoverInterrupted()
    const allDue = this.tasks().filter(task => task.status === 'active' && Date.parse(task.record.scheduledAt) <= scanNow)
    for (const task of allDue.filter(isScriptTask)) {
      try {
        await this.dispatchScript(task, scanNow)
      } catch (error: unknown) {
        failed.add(task.record.id)
        this.ctx.logger.warn(`schedule: script task ${JSON.stringify(task.record.id)} was not started: ${String(error)}`)
      }
    }
    const due = allDue.filter(task => !isScriptTask(task))
    for (const task of due) {
      if (this.stopping) return
      if (handled.has(task.record.id)) continue
      const group = isRecurringScheduleRecord(task.record)
        ? due.filter(candidate => candidate.sessionId === task.sessionId && isRecurringScheduleRecord(candidate.record))
        : [task]
      for (const member of group) handled.add(member.record.id)
      let admitted = group
      const committed = new Set<ScheduleTask['record']['id']>()
      try {
        const resolved = await this.ctx.sessionController.resolveAgent(task.sessionId)
        if ('error' in resolved) throw resolved.error
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Disposal can run while Session restoration is awaited.
        if (this.stopping) return
        const now = Date.now()
        // Session restoration can span a wall-clock rollback; future members keep their timer obligation.
        admitted = group.filter(member => Date.parse(member.record.scheduledAt) <= now)
        if (admitted.length === 0) continue
        const recurring = admitted.filter((member): member is ScheduleTask & { record: RecurringScheduleRecord } =>
          isRecurringScheduleRecord(member.record))
        const occurrences = recurring.map(member => ({
          task: member, occurrence: resolveRecurringOccurrence(member.record, now),
        }))
        const text = isRecurringScheduleRecord(task.record)
          ? renderRecurringReminderBatchFraming(occurrences.map(({ task: member, occurrence }) => ({
            record: member.record, occurrenceAt: occurrence.occurrenceAt,
          })))
          : renderReminderFraming(task.record)
        const { messageId, deliveredAt } = await this.deliver(resolved.agent, text)
        if (!isRecurringScheduleRecord(task.record)) {
          await this.commit({
            ...task, status: 'inactive',
            ...appendDelivery(task, { scheduledAt: task.record.scheduledAt, deliveredAt, messageId }, this.retention),
          })
          committed.add(task.record.id)
        }
        for (const { task: member, occurrence } of occurrences) {
          await this.commit({
            ...member,
            ...advancedPlan(member.record, occurrence),
            ...appendDelivery(member, { scheduledAt: occurrence.occurrenceAt, deliveredAt, messageId }, this.retention),
          })
          committed.add(member.record.id)
        }
      } catch (error: unknown) {
        // Successful commits and targets made future by clock rollback keep their timer obligation.
        const pending = admitted.filter(member => !committed.has(member.record.id))
        const failedAt = Date.now()
        for (const member of pending) {
          if (Date.parse(member.record.scheduledAt) <= failedAt) failed.add(member.record.id)
        }
        const ids = pending.map(member => member.record.id)
        this.ctx.logger.warn(`schedule: reminders ${JSON.stringify(ids)} were not acknowledged: ${String(error)}`)
      }
    }
    if (this.stopping) return
    const next = this.tasks().filter(task => task.status === 'active' && !failed.has(task.record.id))
      .reduce<number | undefined>((at, task) => {
        const target = Date.parse(task.record.scheduledAt)
        return at === undefined ? target : Math.min(at, target)
      }, undefined)
    if (next !== undefined) {
      this.timer = setTimeout(() => { this.timer = undefined; this.requestDrive() },
        Math.max(0, Math.min(next - Date.now(), MAX_TIMER_DELAY_MS)))
      this.timer.unref()
    }
  }
}
