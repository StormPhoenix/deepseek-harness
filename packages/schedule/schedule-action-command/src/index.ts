/** Schedule action provider executing a command through the mounted shell service. */
import type { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { ScheduleInputError } from '@deepseek-ai/dsh-schedule'
import type { ScheduleActionResult } from '@deepseek-ai/dsh-schedule'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { z } from 'zod'

export const name = 'schedule-action-command'
export const inject = ['schedule', 'shell']

const commandSchema = z.object({ command: z.string().refine(value => value.trim().length > 0) }).strict()

/**
 * Validate command input without changing shell quoting or whitespace.
 * @param input - Specification received from a model or durable task.
 * @returns The validated command specification.
 */
function decode(input: unknown): { command: string } {
  const result = commandSchema.safeParse(input)
  if (!result.success) throw new ScheduleInputError('invalid_action', 'command spec must contain only a non-empty command string.')
  return result.data
}

/**
 * Project independent process and sandbox facts onto a saved action result.
 * @param result - Shell execution's terminal result.
 * @returns Outcome, exit code, captured streams, and truncation evidence.
 */
function outcome(result: ShellRunResult): ScheduleActionResult {
  const output = [result.stdout.text, result.stderr.text].filter(text => text.length > 0).join('\n')
  const classification = result.aborted ? 'aborted'
    : result.timedOut ? 'timeout'
      : result.sandbox?.denied === true || result.sandbox?.runnerFailed === true ? 'sandbox-denied'
        : result.exitCode === 0 ? 'succeeded' : 'failed'
  return {
    outcome: classification,
    exitCode: result.exitCode,
    output,
    outputTruncated: result.stdout.truncated || result.stderr.truncated,
  }
}

/**
 * Mount the command provider; disposal cancels and waits for its active executions.
 * @param ctx - Scope supplying Schedule and the shell executor.
 */
export function apply(ctx: Context): void {
  const active = new Map<AbortController, Promise<void>>()
  let stopped = false
  ctx.effect(() => {
    const unregister = ctx.schedule.actions.register({
      kind: 'command',
      description: 'Run a shell command in the saved working directory under the Session sandbox policy. No model is called.',
      specSchema: {
        type: 'object', additionalProperties: false,
        properties: { command: { type: 'string', required: true, description: 'Shell command to execute.' } },
      },
      decode,
      source: spec => (spec as { command: string }).command,
      async run(spec, env): Promise<ScheduleActionResult> {
        if (stopped) return { outcome: 'unavailable', output: 'The command action provider was unloaded.' }
        if (ctx.shell.sandboxMode === undefined && env.sandboxPolicy.mode !== 'danger-full-access') {
          return { outcome: 'sandbox-denied', output: 'The mounted shell executor cannot enforce the Session sandbox policy.' }
        }
        const controller = new AbortController()
        const completed = Promise.withResolvers<void>()
        active.set(controller, completed.promise)
        const signal = AbortSignal.any([env.signal, controller.signal])
        try {
          const request = ctx.shell.resolve({
            command: (spec as { command: string }).command,
            workdir: env.cwd,
            timeoutMs: env.timeoutMs,
            onExpiry: 'kill',
            sandboxPolicy: env.sandboxPolicy,
            signal,
          })
          const execution = await ctx.shell.execute(request)
          return outcome(await execution.result())
        } catch (error: unknown) {
          return {
            outcome: signal.aborted ? 'aborted' : error instanceof SandboxUnavailableError ? 'sandbox-denied' : 'failed',
            output: error instanceof Error ? error.message : String(error),
          }
        } finally {
          active.delete(controller)
          completed.resolve()
        }
      },
    })
    return async () => {
      stopped = true
      unregister()
      for (const controller of active.keys()) controller.abort(new Error('The command action provider was unloaded.'))
      await Promise.all(active.values())
    }
  })
}
