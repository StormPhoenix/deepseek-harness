import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { ScheduleActionRegistry } from '@deepseek-ai/dsh-schedule'
import type { ScheduleActionEnv } from '@deepseek-ai/dsh-schedule'
import type { ShellExecRequest, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { afterEach, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

const env: ScheduleActionEnv = {
  cwd: '/workspace', timeoutMs: 2_000,
  sandboxPolicy: { mode: 'workspace-write', workspaceRoot: '/workspace' },
  signal: new AbortController().signal,
}

const result: ShellRunResult = {
  exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 2_000,
  stdout: { text: 'out', truncated: false }, stderr: { text: 'err', truncated: false },
  sandbox: { mode: 'workspace-write', denied: false },
}

async function setup(options: { result?: ShellRunResult; sandboxed?: boolean; error?: unknown } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const actions = new ScheduleActionRegistry(() => {})
  const resolve = vi.fn((request: ShellExecRequest) => request)
  const execute = vi.fn(async (_request: ShellExecRequest) => {
    if (options.error !== undefined) throw options.error
    return { result: async () => options.result ?? result }
  })
  ctx.provide('schedule', { actions } as never)
  ctx.provide('shell', { sandboxMode: options.sandboxed === false ? undefined : 'workspace-write', resolve, execute } as never)
  const fiber = await ctx.plugin(plugin)
  const provider = actions.require('command')
  return { ctx, actions, resolve, execute, fiber, provider }
}

it('registers the command provider and removes it when its fiber is disposed', async () => {
  const test = await setup()
  expect(test.provider.decode({ command: '  printf "a b"\n' })).toEqual({ command: '  printf "a b"\n' })
  expect(test.provider.source({ command: 'printf test' })).toBe('printf test')
  expect(test.provider.specSchema).toMatchObject({ additionalProperties: false, properties: { command: { required: true } } })
  await test.fiber.dispose()
  expect(test.actions.list()).toEqual([])
  expect(await test.provider.run({ command: 'printf late' }, env)).toMatchObject({ outcome: 'unavailable' })
  expect(test.execute).not.toHaveBeenCalled()
})

it.each([null, [], {}, { command: '' }, { command: '  ' }, { command: 42 }, { command: 'true', env: {} }])(
  'rejects invalid command specification %j', async (spec) => {
    const test = await setup()
    expect(() => test.provider.decode(spec)).toThrow(expect.objectContaining({ code: 'invalid_action' }))
  },
)

it('forwards explicit policy, cwd, cancellation, and kill deadline without injecting environment variables', async () => {
  const test = await setup()
  expect(await test.provider.run(test.provider.decode({ command: 'printf test' }), env)).toEqual({
    outcome: 'succeeded', exitCode: 0, output: 'out\nerr', outputTruncated: false,
  })
  expect(test.resolve).toHaveBeenCalledWith({
    command: 'printf test', workdir: env.cwd, timeoutMs: env.timeoutMs,
    onExpiry: 'kill', sandboxPolicy: env.sandboxPolicy, signal: test.resolve.mock.calls[0]?.[0].signal,
  })
  expect(test.resolve.mock.calls[0]?.[0]).not.toHaveProperty('env')
  expect(test.resolve.mock.calls[0]?.[0]).not.toHaveProperty('dshEnv')
})

it.each([
  [{ ...result, exitCode: 7 }, 'failed'],
  [{ ...result, exitCode: null, aborted: true }, 'aborted'],
  [{ ...result, exitCode: null, timedOut: true }, 'timeout'],
  [{ ...result, sandbox: { mode: 'workspace-write', denied: true } }, 'sandbox-denied'],
  [{ ...result, sandbox: { mode: 'workspace-write', denied: false, runnerFailed: true } }, 'sandbox-denied'],
  [{ ...result, sandbox: undefined }, 'succeeded'],
] as const)('classifies shell result %j as %s', async (shellResult, classification) => {
  const test = await setup({ result: shellResult as ShellRunResult })
  expect(await test.provider.run({ command: 'true' }, env)).toMatchObject({ outcome: classification })
})

it('preserves stream truncation and handles empty output', async () => {
  const test = await setup({ result: { ...result, stdout: { text: '', truncated: true }, stderr: { text: '', truncated: false } } })
  expect(await test.provider.run({ command: 'true' }, env)).toMatchObject({ output: '', outputTruncated: true })
})

it('refuses a non-confining executor under a restricted policy but permits full access', async () => {
  const test = await setup({ sandboxed: false })
  expect(await test.provider.run({ command: 'true' }, env)).toMatchObject({ outcome: 'sandbox-denied' })
  expect(test.execute).not.toHaveBeenCalled()
  expect(await test.provider.run({ command: 'true' }, { ...env, sandboxPolicy: { ...env.sandboxPolicy, mode: 'danger-full-access' } }))
    .toMatchObject({ outcome: 'succeeded' })
})

it.each([
  [new Error('spawn failed'), 'failed', 'spawn failed'],
  [new SandboxUnavailableError('workspace-write'), 'sandbox-denied', 'no sandbox backend'],
  ['bare failure', 'failed', 'bare failure'],
])('contains executor failure %s', async (error, classification, output) => {
  const test = await setup({ error })
  const run = await test.provider.run({ command: 'true' }, env)
  expect(run.outcome).toBe(classification)
  expect(run.output).toContain(output)
})

it('classifies an already-cancelled execution failure as aborted', async () => {
  const test = await setup({ error: new Error('cancelled') })
  expect(await test.provider.run({ command: 'true' }, { ...env, signal: AbortSignal.abort() })).toMatchObject({ outcome: 'aborted' })
})

it('cancels and waits for an in-flight command when the provider is unloaded', async () => {
  const test = await setup()
  const entered = Promise.withResolvers<undefined>()
  test.execute.mockImplementationOnce(async (request) => {
    entered.resolve(undefined)
    return { result: () => new Promise((resolve) => {
      request.signal?.addEventListener('abort', () => { resolve({ ...result, aborted: true }) }, { once: true })
    }) }
  })
  const running = test.provider.run({ command: 'sleep 100' }, env)
  await entered.promise
  await test.fiber.dispose()
  expect(await running).toMatchObject({ outcome: 'aborted' })
  expect(test.actions.get('command')).toBeUndefined()
})
