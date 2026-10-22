/** Schedule action provider executing a program without model or tool bindings. */
import type { Context } from '@deepseek-ai/cordis'
import type { PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { ScheduleInputError } from '@deepseek-ai/dsh-schedule'
import type { ScheduleActionResult } from '@deepseek-ai/dsh-schedule'
import { z } from 'zod'

export const name = 'schedule-action-program'
export const inject = ['schedule', 'ptcRuntime']

const programSchema = z.object({
  source: z.string().refine(value => value.trim().length > 0),
  language: z.string().min(1).optional(),
}).strict()

type ProgramSpec = {
  source: string
  language: string
}

/**
 * Project captured logs, completion, and orthogonal runtime failure onto a saved result.
 * @param result - Runtime result.
 * @returns Outcome and captured program output.
 */
function outcome(result: PtcRunResult): ScheduleActionResult {
  const value = result.value === undefined ? []
    : [typeof result.value === 'string' ? result.value : JSON.stringify(result.value)]
  const diagnostic = result.error === undefined ? [] : [result.error.message]
  const classification = result.error?.kind === 'abort' ? 'aborted'
    : result.error?.kind === 'timeout' ? 'timeout'
      : result.error?.kind === 'sandbox-unavailable' || result.sandbox?.denied === true ? 'sandbox-denied'
        : result.error === undefined ? 'succeeded' : 'failed'
  return {
    outcome: classification,
    output: [...result.logs, ...value, ...diagnostic].join('\n'),
    outputTruncated: result.error?.kind === 'output-limit',
  }
}

/**
 * Mount the program provider; disposal cancels and waits for its active executions.
 * @param ctx - Scope supplying Schedule and the program runtime.
 */
export function apply(ctx: Context): void {
  if (ctx.ptcRuntime.programFormat !== 'function-body') {
    throw new Error('schedule-action-program: a fresh function-body runtime is required; a persistent REPL is not supported.')
  }
  const active = new Map<AbortController, Promise<void>>()
  let stopped = false
  ctx.effect(() => {
    const unregister = ctx.schedule.actions.register({
      kind: 'program',
      description: `${ctx.ptcRuntime.executionInstructions} No host functions, tools, or callLLM are provided.`,
      specSchema: {
        type: 'object', additionalProperties: false,
        properties: { source: { type: 'string', required: true, description: 'Program source to execute.' } },
      },
      decode(input: unknown): ProgramSpec {
        const parsed = programSchema.safeParse(input)
        if (!parsed.success) throw new ScheduleInputError('invalid_action', 'program spec needs non-empty source and an optional language.')
        return { source: parsed.data.source, language: parsed.data.language ?? ctx.ptcRuntime.language }
      },
      source: spec => (spec as ProgramSpec).source,
      async run(spec, env): Promise<ScheduleActionResult> {
        if (stopped) return { outcome: 'unavailable', output: 'The program action provider was unloaded.' }
        const program = spec as ProgramSpec
        if (program.language !== ctx.ptcRuntime.language) {
          return { outcome: 'unavailable', output: `The program requires ${program.language}, but the mounted runtime uses ${ctx.ptcRuntime.language}.` }
        }
        if (ctx.ptcRuntime.sandboxMode === undefined) {
          return { outcome: 'sandbox-denied', output: 'The mounted program runtime cannot enforce the Session sandbox policy.' }
        }
        const controller = new AbortController()
        const completed = Promise.withResolvers<void>()
        active.set(controller, completed.promise)
        const signal = AbortSignal.any([env.signal, controller.signal])
        try {
          const request = ctx.ptcRuntime.resolve({
            program: program.source,
            bindings: [],
            cwd: env.cwd,
            timeoutMs: env.timeoutMs,
            sandboxPolicy: env.sandboxPolicy,
            signal,
          })
          return outcome(await ctx.ptcRuntime.run(request))
        } catch (error: unknown) {
          return { outcome: signal.aborted ? 'aborted' : 'failed', output: error instanceof Error ? error.message : String(error) }
        } finally {
          active.delete(controller)
          completed.resolve()
        }
      },
    })
    return async () => {
      stopped = true
      unregister()
      for (const controller of active.keys()) controller.abort(new Error('The program action provider was unloaded.'))
      await Promise.all(active.values())
    }
  })
}
