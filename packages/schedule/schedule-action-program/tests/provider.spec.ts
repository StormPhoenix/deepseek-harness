import { Context } from '@deepseek-ai/cordis'
import type { PtcRunRequest, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { ScheduleActionRegistry } from '@deepseek-ai/dsh-schedule'
import type { ScheduleActionEnv } from '@deepseek-ai/dsh-schedule'
import { afterEach, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
const env: ScheduleActionEnv = {
  cwd: '/workspace', timeoutMs: 2_000,
  sandboxPolicy: { mode: 'workspace-write', workspaceRoot: '/workspace' },
  signal: new AbortController().signal,
}

async function setup(options: {
  result?: PtcRunResult
  error?: unknown
  sandboxed?: boolean
  format?: 'function-body' | 'repl'
} = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const actions = new ScheduleActionRegistry(() => {})
  const resolve = vi.fn((request: PtcRunRequest) => request)
  const run = vi.fn(async (_request: PtcRunRequest): Promise<PtcRunResult> => {
    if (options.error !== undefined) throw options.error
    return options.result ?? { logs: ['printed'], value: { answer: 42 } }
  })
  ctx.provide('schedule', { actions } as never)
  ctx.provide('ptcRuntime', {
    language: 'typescript', programFormat: options.format ?? 'function-body', executionInstructions: 'Use await and return.',
    sandboxMode: options.sandboxed === false ? undefined : 'workspace-write', resolve, run,
  } as never)
  const fiber = await ctx.plugin(plugin)
  return { ctx, actions, resolve, run, fiber, provider: actions.require('program') }
}

it('stores the runtime language, preserves source text, and removes registration on disposal', async () => {
  const test = await setup()
  expect(test.provider.decode({ source: ' return 42\n' })).toEqual({ source: ' return 42\n', language: 'typescript' })
  expect(test.provider.decode({ source: 'return 42', language: 'python' })).toEqual({ source: 'return 42', language: 'python' })
  expect(test.provider.source({ source: 'return 42', language: 'typescript' })).toBe('return 42')
  expect(test.provider.description).toContain('Use await and return.')
  expect(test.provider.specSchema).toMatchObject({ additionalProperties: false, properties: { source: { required: true } } })
  await test.fiber.dispose()
  expect(test.actions.list()).toEqual([])
  expect(await test.provider.run({ source: 'return 42', language: 'typescript' }, env)).toMatchObject({ outcome: 'unavailable' })
  expect(test.run).not.toHaveBeenCalled()
})

it.each([null, [], {}, { source: '' }, { source: ' ' }, { source: 42 }, { source: 'return 1', language: '' }, { source: 'x', callLLM: true }])(
  'rejects invalid program specification %j', async (spec) => {
    const test = await setup()
    expect(() => test.provider.decode(spec)).toThrow(expect.objectContaining({ code: 'invalid_action' }))
  },
)

it('forwards a fresh program, explicit policy, directory and timeout with no model or tool bindings', async () => {
  const test = await setup()
  expect(await test.provider.run(test.provider.decode({ source: 'return 42' }), env)).toEqual({
    outcome: 'succeeded', output: 'printed\n{"answer":42}', outputTruncated: false,
  })
  expect(test.resolve).toHaveBeenCalledWith({
    program: 'return 42', bindings: [], cwd: env.cwd, timeoutMs: env.timeoutMs,
    sandboxPolicy: env.sandboxPolicy, signal: test.resolve.mock.calls[0]?.[0].signal,
  })
  expect(test.resolve.mock.calls[0]?.[0]).not.toHaveProperty('stateOwner')
})

it('refuses execution under a different runtime language', async () => {
  const test = await setup()
  expect(await test.provider.run({ source: 'return 42', language: 'python' }, env)).toMatchObject({ outcome: 'unavailable' })
  expect(test.run).not.toHaveBeenCalled()
})

it('refuses a runtime without sandbox support', async () => {
  const test = await setup({ sandboxed: false })
  expect(await test.provider.run({ source: 'return 42', language: 'typescript' }, env)).toMatchObject({ outcome: 'sandbox-denied' })
  expect(test.run).not.toHaveBeenCalled()
})

it('refuses a persistent REPL at plugin activation', async () => {
  await expect(setup({ format: 'repl' })).rejects.toThrow('a fresh function-body runtime is required')
})

it.each([
  [{ logs: [] }, 'succeeded', ''],
  [{ logs: [], value: 'text' }, 'succeeded', 'text'],
  [{ logs: ['log'], value: null }, 'succeeded', 'log\nnull'],
  [{ logs: [], error: { kind: 'exception', message: 'thrown' } }, 'failed', 'thrown'],
  [{ logs: [], error: { kind: 'timeout', message: 'deadline' } }, 'timeout', 'deadline'],
  [{ logs: [], error: { kind: 'abort', message: 'cancelled' } }, 'aborted', 'cancelled'],
  [{ logs: [], error: { kind: 'sandbox-unavailable', message: 'no sandbox' } }, 'sandbox-denied', 'no sandbox'],
  [{ logs: [], sandbox: { mode: 'workspace-write', denied: true } }, 'sandbox-denied', ''],
  [{ logs: ['prefix'], error: { kind: 'output-limit', message: 'too much' } }, 'failed', 'prefix\ntoo much'],
] as const)('projects result %j', async (result, classification, output) => {
  const test = await setup({ result: { ...result, logs: [...result.logs] } })
  const projected = await test.provider.run({ source: 'return 42', language: 'typescript' }, env)
  expect(projected).toMatchObject({ outcome: classification, output })
  expect(projected.outputTruncated).toBe('error' in result && result.error.kind === 'output-limit')
})

it.each([new Error('runtime failed'), 'bare failure'])('contains runtime failure %s', async (error) => {
  const test = await setup({ error })
  expect(await test.provider.run({ source: 'x', language: 'typescript' }, env)).toMatchObject({
    outcome: 'failed', output: error instanceof Error ? error.message : error,
  })
})

it('classifies a cancelled runtime failure as aborted', async () => {
  const test = await setup({ error: new Error('cancelled') })
  expect(await test.provider.run({ source: 'x', language: 'typescript' }, { ...env, signal: AbortSignal.abort() }))
    .toMatchObject({ outcome: 'aborted' })
})

it('cancels and waits for an in-flight program when its provider is unloaded', async () => {
  const test = await setup()
  const entered = Promise.withResolvers<undefined>()
  test.run.mockImplementationOnce(request => new Promise((resolve) => {
    entered.resolve(undefined)
    request.signal?.addEventListener('abort', () => { resolve({ logs: [], error: { kind: 'abort', message: 'unloaded' } }) }, { once: true })
  }))
  const running = test.provider.run({ source: 'await forever()', language: 'typescript' }, env)
  await entered.promise
  await test.fiber.dispose()
  expect(await running).toMatchObject({ outcome: 'aborted' })
  expect(test.actions.get('program')).toBeUndefined()
})
