/** Model-facing script selection, persistent authorization, and task-view projection. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { approveEscalation } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-user-approval'
import { ScheduleInputError, scheduleView } from '@deepseek-ai/dsh-schedule'
import type {
  ScheduleActionInput, ScheduleCatalogEntry, ScheduleCreateActionRequest, ScheduleCreateRequest, ScheduleReportPolicy, ScheduleView,
} from '@deepseek-ai/dsh-schedule'
import type { ParameterPropertySpec, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/**
 * Build the action selector only from currently mounted providers.
 * @param ctx - Scope with the Schedule service.
 * @returns An optional parameter root with no script fields when no providers are mounted.
 */
export function actionParameters(ctx: Context): { action?: ParameterPropertySpec; report?: ParameterPropertySpec } {
  const variants: ValueSchemaSpec[] = ctx.schedule.actions.list().map(provider => ({
    type: 'object', additionalProperties: false, description: provider.description,
    properties: {
      kind: { type: 'string', required: true, const: provider.kind },
      spec: { ...provider.specSchema, required: true },
      timeout_seconds: { type: 'integer', description: 'Optional positive elapsed deadline in whole seconds.' },
    },
  }))
  const [first, second, ...rest] = variants
  if (first === undefined) return {}
  return {
    action: second === undefined ? first : { oneOf: [first, second, ...rest] },
    report: {
      type: 'string', enum: ['always', 'on-failure', 'never'],
      description: 'Script result reporting: always (default), only on failure, or never. Reported output enters the Session log and is sent to the model.',
    },
  }
}

/**
 * Validate a tool action envelope and its provider-owned specification.
 * @param ctx - Scope with the Schedule service.
 * @param value - Untrusted model action.
 * @returns Canonical action input with a millisecond deadline.
 */
export function actionInput(ctx: Context, value: unknown): ScheduleActionInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('kind' in value) || typeof value.kind !== 'string' || !('spec' in value)
    || Object.keys(value).some(key => key !== 'kind' && key !== 'spec' && key !== 'timeout_seconds')) {
    throw new ScheduleInputError('invalid_action', 'action must contain kind, spec, and optionally timeout_seconds.')
  }
  const seconds = 'timeout_seconds' in value ? value.timeout_seconds : undefined
  if (seconds !== undefined && (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0
    || !Number.isSafeInteger(seconds * 1000))) {
    throw new ScheduleInputError('invalid_action', 'timeout_seconds must be a positive safe integer.')
  }
  const provider = ctx.schedule.actions.require(value.kind)
  return {
    kind: value.kind, spec: provider.decode(value.spec),
    ...(seconds === undefined ? {} : { timeoutMs: seconds * 1000 }),
  }
}

/**
 * Validate a model report selection.
 * @param value - Untrusted report value.
 * @returns The requested policy or undefined when omitted.
 */
export function reportInput(value: unknown): ScheduleReportPolicy | undefined {
  if (value === undefined || value === 'always' || value === 'on-failure' || value === 'never') return value
  throw new ScheduleInputError('invalid_action', 'report must be always, on-failure, or never.')
}

/**
 * Authorize creating or replacing code that will execute later without a user turn.
 * Permission is per-call and never widens the stored runtime policy.
 * @param ctx - Scope with the Schedule service and optional approval/working-directory services.
 * @param agent - Calling Agent owning the task.
 * @param exec - Current tool call, for approval and cancellation.
 * @param action - Validated action.
 * @param details - Scheduling and reporting details displayed in the approval.
 * @param storedBinding - Existing task binding when replacing code; creation captures the calling Session directory.
 * @returns Captured working directory and the Session's standing sandbox ceiling.
 */
export async function approveScript(
  ctx: Context, agent: Agent, exec: ToolRunContext, action: ScheduleActionInput, details: unknown,
  storedBinding?: ScheduleCreateActionRequest['binding'],
): Promise<ScheduleCreateActionRequest['binding']> {
  const policyService = ctx.get('sandboxPolicy')
  const directories = ctx.get('workingDirectory')
  if (policyService === undefined || directories === undefined) {
    throw new ScheduleInputError('action_unavailable', 'Script tasks require sandbox policy and working-directory services.')
  }
  const cwd = storedBinding === undefined ? await directories.ensure(agent, exec.signal) : storedBinding.cwd
  const policy = policyService.resolve({ session: agent.session })
  await approveEscalation({
    requestedMode: 'danger-full-access', effectiveMode: policy.mode, subject: 'scheduled script creation or replacement',
    justification: JSON.stringify({ action, cwd, sandboxCeiling: storedBinding?.sandboxCeiling ?? policy.mode, details })
      + '\nThis code will execute on future scheduled occasions. Approval does not widen its Session sandbox policy.',
  }, { approver: ctx.get('approval'), agent, callId: exec.callId, toolName: exec.name, signal: exec.signal })
  exec.signal.throwIfAborted()
  return { cwd, sandboxCeiling: policy.mode }
}

/**
 * Project a catalog entry into the tool's view without Session/running metadata.
 * @param entry - Current persisted entry.
 * @returns Model-facing schedule view with optional action details.
 */
export function modelView(entry: ScheduleCatalogEntry): ScheduleView {
  const {
    sessionId: _sessionId, status: _status, action, report, running: _running, lastRun: _lastRun, lastDelivery: _delivery, ...record
  } = entry
  return {
    ...scheduleView(record, Date.now()),
    ...(action === undefined ? {} : { action }),
    ...(report === undefined ? {} : { report }),
  }
}

/**
 * Capture the script creation request after approval.
 * @param ctx - Scope with the Schedule service.
 * @param agent - Calling Agent.
 * @param exec - Current tool call.
 * @param args - Timing, instruction, and script selection.
 * @returns The authorized script part, or undefined for a prompt reminder.
 */
export async function creationScript(
  ctx: Context, agent: Agent, exec: ToolRunContext, args: ScheduleCreateRequest & { action?: unknown; report?: unknown },
): Promise<ScheduleCreateActionRequest | undefined> {
  const report = reportInput(args.report)
  if (args.action === undefined) {
    if (report !== undefined) throw new ScheduleInputError('invalid_action', 'report is only valid for a script task.')
    return undefined
  }
  const action = actionInput(ctx, args.action)
  const binding = await approveScript(ctx, agent, exec, action, args)
  return { action, binding, ...(report === undefined ? {} : { report }) }
}
