/** Script tasks run a registered action when due, record the run, and report it by policy. */
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAfterScheduleRecord, createEveryScheduleRecord, ScheduleId, ScheduleInputError } from '../src/domain.ts'
import { scheduleDomain, scheduleTaskSchema, type ScheduleTask } from '../src/storage.ts'
import type { ScheduleActionEnv, ScheduleActionProvider, ScheduleActionResult } from '../src/actions.ts'
import type { Config } from '../src/index.ts'
import type { ScheduleRecord } from '../src/types.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { agentFor, gatedScheduleBackend, harness } from './harness.ts'

const contexts: Context[] = []
const owner = SessionId('script-owner')
const NOW = Date.parse('2026-09-16T00:00:00.000Z')

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Let queued storage writes and run continuations settle under fake timers. */
async function drain(): Promise<void> {
  for (let step = 0; step < 20; step += 1) await vi.advanceTimersByTimeAsync(1)
}

/**
 * Narrow a fake specification.
 * @param spec - Untrusted input.
 * @returns The text the fake action echoes.
 */
function fakeText(spec: unknown): string {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec) || !('text' in spec) || typeof spec.text !== 'string') {
    throw new ScheduleInputError('invalid_action', 'fake action needs text.')
  }
  return spec.text
}

/**
 * Build a fake provider whose run is a spy.
 * @param run - Run behavior.
 * @returns Provider registering kind `fake`.
 */
function fakeProvider(
  run: (spec: JsonValue, env: ScheduleActionEnv) => Promise<ScheduleActionResult> = async spec => ({
    outcome: 'succeeded', exitCode: 0, output: `ran ${fakeText(spec)}`,
  }),
) {
  const spy = vi.fn(run)
  const provider: ScheduleActionProvider = {
    kind: 'fake',
    description: 'Echo text.',
    specSchema: { type: 'object', additionalProperties: false },
    decode: spec => ({ text: fakeText(spec) }),
    source: spec => fakeText(spec),
    run: spy,
  }
  return { provider, run: spy }
}

/**
 * One stored script task.
 * @param record - Schedule rule.
 * @param extra - Overrides of the script members.
 * @returns Row bound to the owner Session.
 */
function scriptRow(record: ScheduleRecord, extra: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    sessionId: owner, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false },
    action: { kind: 'fake', spec: { text: 'hello' } },
    report: 'always',
    binding: { cwd: '/work', sandboxCeiling: 'workspace-write' },
    ...extra,
  }
}

const policy: SandboxExecutionPolicy = { mode: 'danger-full-access', workspaceRoot: '/work', sessionId: owner }

/**
 * Start the service with seeded rows, a resolvable Agent, a sandbox policy, and the fake provider.
 * @param rows - Rows present before activation.
 * @param options - Provider behavior and service configuration.
 * @returns Harness, Agent, provider spy, and the task table.
 */
async function setup(rows: ScheduleTask[] = [], options: {
  run?: Parameters<typeof fakeProvider>[0]
  config?: Config
  provider?: false
  sandboxPolicy?: false
} = {}) {
  const test = await harness({
    beforeService: async (ctx, facility) => {
      if (options.sandboxPolicy !== false) ctx.provide('sandboxPolicy', { resolve: () => policy } as never)
      const domain = await facility.open(scheduleDomain)
      for (const row of rows) await domain.table('tasks').put(row.record.id, row)
      await domain.close()
    },
    onContext: ctx => contexts.push(ctx),
    ...(options.config === undefined ? {} : { config: options.config }),
  })
  const agent = agentFor(test.ctx, owner)
  test.resolve.mockResolvedValue({ agent })
  const fake = fakeProvider(options.run)
  if (options.provider !== false) test.ctx.effect(() => test.service.actions.register(fake.provider))
  const domain = test.ctx.storageDomain.get('schedule')
  if (domain === undefined) throw new Error('Schedule domain not initialized')
  const table = domain.table('tasks') as KvTable<ScheduleRecord['id'], ScheduleTask>
  return { ...test, agent, fake, table }
}

/** Text of one delivered message. */
function textOf(message: { content: readonly { type: string; text?: string }[] } | undefined): string {
  const block = message?.content[0]
  return block !== undefined && block.type === 'text' ? block.text ?? '' : ''
}

describe('startup composition', () => {
  it('waits for sibling action providers before executing a stored overdue task', async () => {
    const settled = Promise.withResolvers<undefined>()
    const record = createAfterScheduleRecord(ScheduleId('startup-script'), 'p', 1, NOW - 2_000, 't')
    const test = await harness({
      onContext: ctx => contexts.push(ctx),
      beforeService: async (ctx, facility) => {
        ctx.provide('loader', { await: () => settled.promise } as never)
        ctx.provide('sandboxPolicy', { resolve: () => policy } as never)
        const domain = await facility.open(scheduleDomain)
        await domain.table('tasks').put(record.id, scriptRow(record, { report: 'never' }))
        await domain.close()
      },
    })
    test.resolve.mockResolvedValue({ agent: agentFor(test.ctx, owner) })
    await drain()
    expect(test.resolve).not.toHaveBeenCalled()
    const fake = fakeProvider()
    test.ctx.effect(() => test.service.actions.register(fake.provider))
    settled.resolve(undefined)
    await drain()
    expect(fake.run).toHaveBeenCalledOnce()
    expect((await test.service.catalog())[0]?.lastRun?.outcome).toBe('succeeded')
  })

  it('does not start an obsolete runtime after its composition settles', async () => {
    const settled = Promise.withResolvers<undefined>()
    const test = await harness({
      onContext: ctx => contexts.push(ctx),
      beforeService: async (ctx) => { ctx.provide('loader', { await: () => settled.promise } as never) },
    })
    await test.fiber.dispose()
    settled.resolve(undefined)
    await drain()
    expect(test.resolve).not.toHaveBeenCalled()
  })

  it('reports a failed composition wait without scheduling tasks', async () => {
    const settled = Promise.withResolvers<undefined>()
    const test = await harness({
      onContext: ctx => contexts.push(ctx),
      beforeService: async (ctx) => { ctx.provide('loader', { await: () => settled.promise } as never) },
    })
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    settled.reject(new Error('composition failed'))
    await drain()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('initial dispatch could not start'))
  })
})

describe('action registry', () => {
  it('registers one provider per kind, announces changes, and unregisters through its disposer', async () => {
    const test = await setup([], { provider: false })
    const changed = vi.fn()
    test.ctx.on('schedule/actions-changed', changed)
    const { provider } = fakeProvider()

    const dispose = test.service.actions.register(provider)
    expect(test.service.actions.list()).toEqual([provider])
    expect(() => test.service.actions.register(provider)).toThrow('already registered')
    expect(() => test.service.actions.register({ ...provider, kind: ' fake' })).toThrow('non-empty')
    dispose()
    dispose()

    expect(test.service.actions.get('fake')).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('keeps a registration when a change observer throws', async () => {
    const test = await setup([], { provider: false })
    test.ctx.on('schedule/actions-changed', () => { throw new Error('observer failed') })
    const warn = vi.spyOn(test.ctx.logger, 'warn')

    test.service.actions.register(fakeProvider().provider)

    expect(test.service.actions.get('fake')).toBeDefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('observer failed'))
  })
})

describe('creation', () => {
  const binding = { cwd: '/work', sandboxCeiling: 'workspace-write' } as const

  it('stores the validated action, report policy, and binding, and lists it in the catalog', async () => {
    const test = await setup()

    const record = await test.service.create(owner, { prompt: 'Summarize', title: 'Echo', after_seconds: 60 }, undefined, {
      action: { kind: 'fake', spec: { text: 'hello', extra: true }, timeoutMs: 5_000 }, report: 'on-failure', binding,
    })

    expect(test.table.get(record.id)).toMatchObject({
      action: { kind: 'fake', spec: { text: 'hello' }, timeoutMs: 5_000 }, report: 'on-failure', binding,
    })
    const [entry] = await test.service.catalog()
    expect(entry).toMatchObject({
      action: {
        kind: 'fake', summary: 'hello', source: 'hello', timeoutMs: 5_000, cwd: '/work',
        sandboxCeiling: 'workspace-write', available: true,
      },
      report: 'on-failure',
    })
    expect(entry).not.toHaveProperty('running')
    expect(entry).not.toHaveProperty('lastRun')
  })

  it('defaults the report policy to always', async () => {
    const test = await setup()
    const record = await test.service.create(owner, { prompt: 'p', title: 't', after_seconds: 60 }, undefined, {
      action: { kind: 'fake', spec: { text: 'x' } }, binding,
    })
    expect(test.table.get(record.id)?.report).toBe('always')
  })

  it.each([
    ['an unmounted kind', { kind: 'other', spec: {} }, undefined, binding, 'action_unavailable'],
    ['a non-string kind', { kind: 7, spec: {} }, undefined, binding, 'invalid_action'],
    ['an invalid specification', { kind: 'fake', spec: { text: 1 } }, undefined, binding, 'invalid_action'],
    ['a fractional timeout', { kind: 'fake', spec: { text: 'x' }, timeoutMs: 1.5 }, undefined, binding, 'invalid_action'],
    ['a timeout above the cap', { kind: 'fake', spec: { text: 'x' }, timeoutMs: 600_001 }, undefined, binding, 'invalid_action'],
    ['an unknown report policy', { kind: 'fake', spec: { text: 'x' } }, 'sometimes', binding, 'invalid_action'],
    ['a relative directory', { kind: 'fake', spec: { text: 'x' } }, undefined, { ...binding, cwd: 'work' }, 'invalid_action'],
  ])('rejects %s without storing a row', async (_case, action, report, scriptBinding, code) => {
    const test = await setup()
    const request = { action, binding: scriptBinding, ...(report === undefined ? {} : { report }) } as never

    await expect(test.service.create(owner, { prompt: 'p', title: 't', after_seconds: 60 }, undefined, request))
      .rejects.toMatchObject({ code })
    expect(await test.service.catalog()).toEqual([])
  })

  it('refuses a default timeout above the configured cap at load', async () => {
    await expect(setup([], { config: { actionTimeoutMs: 10_000, maxActionTimeoutMs: 5_000 } })).rejects.toThrow('exceeds maxActionTimeoutMs')
  })
})

describe('due runs', () => {
  it('runs a due one-shot task once under the narrowed policy and delivers the result', async () => {
    const record = createAfterScheduleRecord(ScheduleId('once'), 'Explain failures', 60, NOW, 'Echo')
    const test = await setup([scriptRow(record, { action: { kind: 'fake', spec: { text: 'hello' }, timeoutMs: 9_000 } })])

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()

    expect(test.fake.run).toHaveBeenCalledTimes(1)
    const [spec, env] = test.fake.run.mock.calls[0]!
    expect(spec).toEqual({ text: 'hello' })
    expect(env).toMatchObject({ cwd: '/work', timeoutMs: 9_000, sandboxPolicy: { ...policy, mode: 'workspace-write' } })
    const row = test.table.get(record.id)
    expect(row?.status).toBe('inactive')
    expect(row?.inFlight).toBeUndefined()
    const message = test.agent.followup.mock.calls[0]?.[0]
    expect(textOf(message)).toContain('[SCHEDULE RUN RESULT]')
    expect(textOf(message)).toContain('outcome: succeeded')
    expect(textOf(message)).toContain('exit_code: 0')
    expect(textOf(message)).toContain('output_json: "ran hello"')
    expect(textOf(message)).toContain('reminder_prompt_json: "Explain failures"')
    expect(row?.runHistory?.records).toEqual([expect.objectContaining({
      scheduledAt: record.scheduledAt, outcome: 'succeeded', exitCode: 0, output: 'ran hello', outputTruncated: false,
      messageId: message?.id,
    })])
    // A script task never writes a reminder receipt.
    expect(row?.lastDelivery).toBeUndefined()
    expect((await test.service.catalog())[0]?.lastRun).toMatchObject({ outcome: 'succeeded' })
  })

  it('advances a recurring task and keeps a ceiling wider than the Session mode from widening it', async () => {
    const record = createEveryScheduleRecord(ScheduleId('every'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record, { binding: { cwd: '/work', sandboxCeiling: 'danger-full-access' } })])

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()

    expect(test.fake.run.mock.calls[0]?.[1].sandboxPolicy.mode).toBe('danger-full-access')
    expect(test.fake.run.mock.calls[0]?.[1].timeoutMs).toBe(120_000)
    const row = test.table.get(record.id)
    expect(row?.status).toBe('active')
    expect(row?.record.scheduledAt).toBe('2026-09-16T00:02:00.000Z')
  })

  it.each([
    ['on-failure', 'succeeded', false],
    ['on-failure', 'failed', true],
    ['never', 'failed', false],
  ] as const)('applies report %s to a %s run', async (report, outcome, delivered) => {
    const record = createAfterScheduleRecord(ScheduleId(`report-${report}-${outcome}`), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record, { report })], { run: async () => ({ outcome, exitCode: 1, output: 'x' }) })

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()

    expect(test.agent.followup).toHaveBeenCalledTimes(delivered ? 1 : 0)
    const [run] = test.table.get(record.id)?.runHistory?.records ?? []
    expect(run?.outcome).toBe(outcome)
    expect(run?.messageId === undefined).toBe(!delivered)
  })

  it('cuts output to the configured byte budget at a character boundary', async () => {
    const record = createAfterScheduleRecord(ScheduleId('long'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record)], {
      config: { runOutputBytes: 256 },
      run: async () => ({ outcome: 'succeeded', output: `${'a'.repeat(145)}é${'b'.repeat(255)}` }),
    })

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()

    const [run] = test.table.get(record.id)?.runHistory?.records ?? []
    expect(run?.outputTruncated).toBe(true)
    // The cut lands on the second byte of "é", so the kept tail starts at the next character.
    expect(run?.output).toBe('b'.repeat(255))
    expect(run).not.toHaveProperty('exitCode')
  })

  it('records a provider truncation and a provider that throws as failed', async () => {
    const cut = createAfterScheduleRecord(ScheduleId('cut'), 'p', 60, NOW, 't')
    const thrown = createAfterScheduleRecord(ScheduleId('thrown'), 'p', 60, NOW, 't')
    const raw = createAfterScheduleRecord(ScheduleId('raw'), 'p', 60, NOW, 't')
    const test = await setup([
      scriptRow(cut),
      scriptRow(thrown, { action: { kind: 'fake', spec: { text: 'boom' } } }),
      scriptRow(raw, { action: { kind: 'fake', spec: { text: 'raw' } } }),
    ], {
      run: async (spec) => {
        if (fakeText(spec) === 'boom') throw new Error('provider broke')
        if (fakeText(spec) === 'raw') throw 'bare failure'
        return { outcome: 'succeeded', output: 'tail', outputTruncated: true }
      },
    })

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()

    expect(test.table.get(cut.id)?.runHistory?.records[0]).toMatchObject({ outputTruncated: true, output: 'tail' })
    expect(test.table.get(thrown.id)?.runHistory?.records[0]).toMatchObject({
      outcome: 'failed', output: 'The fake action failed to run: provider broke',
    })
    expect(test.table.get(raw.id)?.runHistory?.records[0]).toMatchObject({
      outcome: 'failed', output: 'The fake action failed to run: bare failure',
    })
  })

  it.each<[string, { provider?: false; sandboxPolicy?: false }, string]>([
    ['no provider is mounted', { provider: false }, 'No script action provider for kind "fake" is mounted.'],
    ['no sandbox policy service is mounted', { sandboxPolicy: false }, 'The sandbox policy service is not mounted.'],
  ])('records an unavailable run when %s', async (_case, options, output) => {
    const record = createAfterScheduleRecord(ScheduleId('unavailable'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record)], options)

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()

    expect(test.table.get(record.id)?.runHistory?.records[0]).toMatchObject({ outcome: 'unavailable', output })
    if (options.provider === false) expect((await test.service.catalog())[0]?.action?.available).toBe(false)
  })

  it('records an unavailable run when the bound Session cannot be resolved', async () => {
    const record = createAfterScheduleRecord(ScheduleId('gone'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record, { report: 'never' })])
    test.resolve.mockResolvedValue({ error: new Error('Session unavailable') } as never)

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()

    expect(test.fake.run).not.toHaveBeenCalled()
    expect(test.table.get(record.id)?.runHistory?.records[0]).toMatchObject({
      outcome: 'unavailable', output: 'The bound Session could not be resolved: Session unavailable',
    })
  })

  it('records the run without a message when its report cannot be delivered', async () => {
    const record = createAfterScheduleRecord(ScheduleId('unreported'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record)])
    vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValue(false)
    const warn = vi.spyOn(test.ctx.logger, 'warn')

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()

    const [run] = test.table.get(record.id)?.runHistory?.records ?? []
    expect(run?.outcome).toBe('succeeded')
    expect(run?.messageId).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not delivered'))
  })

  it('records the run without a message when the Session to report to cannot be resolved', async () => {
    const record = createAfterScheduleRecord(ScheduleId('report-gone'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record)])
    const agent = test.agent
    test.resolve.mockReset()
    test.resolve.mockResolvedValueOnce({ agent }).mockResolvedValueOnce({ error: new Error('Session closed') } as never)
    const warn = vi.spyOn(test.ctx.logger, 'warn')

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()

    expect(test.table.get(record.id)?.runHistory?.records[0]).toMatchObject({ outcome: 'succeeded' })
    expect(test.table.get(record.id)?.runHistory?.records[0]?.messageId).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not delivered: Error: Session closed'))
  })

  it('records an aborted run when the task is cancelled while its Session resolves', async () => {
    const record = createAfterScheduleRecord(ScheduleId('abort-early'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record, { report: 'never' })])
    const pending = Promise.withResolvers<{ agent: typeof test.agent }>()
    test.resolve.mockReturnValueOnce(pending.promise)

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()
    await test.service.delete({ sessionId: owner, id: record.id })
    pending.resolve({ agent: test.agent })
    await drain()

    expect(test.fake.run).not.toHaveBeenCalled()
    expect(test.table.get(record.id)).toBeUndefined()
  })

  it('times out while restoring a Session and never launches code from its late result', async () => {
    const record = createAfterScheduleRecord(ScheduleId('resolve-timeout'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record, { report: 'never', action: { kind: 'fake', spec: { text: 'x' }, timeoutMs: 1000 } })])
    const pending = Promise.withResolvers<{ agent: typeof test.agent }>()
    test.resolve.mockReturnValueOnce(pending.promise)
    await vi.advanceTimersByTimeAsync(61_100)
    await drain()
    expect(test.table.get(record.id)?.runHistory?.records[0]?.outcome).toBe('timeout')
    pending.resolve({ agent: test.agent })
    await drain()
    expect(test.fake.run).not.toHaveBeenCalled()
  })

  it('finishes shutdown even when a Session restoration never settles', async () => {
    const record = createAfterScheduleRecord(ScheduleId('resolve-shutdown'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record, { report: 'never' })])
    test.resolve.mockReturnValueOnce(new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(60_000)
    await drain()
    await test.fiber.dispose()
    expect(test.fake.run).not.toHaveBeenCalled()
  })

  it('does not use a provider removed while the bound Session was being restored', async () => {
    const record = createAfterScheduleRecord(ScheduleId('provider-removed'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record, { report: 'never' })], { provider: false })
    const remove = test.service.actions.register(test.fake.provider)
    const pending = Promise.withResolvers<{ agent: typeof test.agent }>()
    test.resolve.mockReturnValueOnce(pending.promise)
    await vi.advanceTimersByTimeAsync(60_000)
    await drain()
    remove()
    pending.resolve({ agent: test.agent })
    await drain()
    expect(test.fake.run).not.toHaveBeenCalled()
    expect(test.table.get(record.id)?.runHistory?.records[0]?.outcome).toBe('unavailable')
  })

  it('fails a stored specification its provider no longer accepts', async () => {
    const record = createAfterScheduleRecord(ScheduleId('stale-spec'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record, { action: { kind: 'fake', spec: { other: true } } })])

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()

    expect(test.fake.run).not.toHaveBeenCalled()
    expect(test.table.get(record.id)?.runHistory?.records[0]).toMatchObject({
      outcome: 'failed', output: 'The fake action failed to run: fake action needs text.',
    })
  })
})

describe('in-flight runs', () => {
  /** Provider whose runs wait for an explicit release or their cancellation. */
  function heldRun() {
    const releases: (() => void)[] = []
    const run = async (_spec: JsonValue, env: ScheduleActionEnv): Promise<ScheduleActionResult> => new Promise((resolve) => {
      env.signal.addEventListener('abort', () => { resolve({ outcome: 'aborted', output: 'cancelled' }) }, { once: true })
      releases.push(() => { resolve({ outcome: 'succeeded', output: 'done' }) })
    })
    return { run, release: () => { releases.shift()?.() } }
  }

  it('keeps an in-flight one-shot task in archive admission and cancels it on a Session stop', async () => {
    const held = heldRun()
    const record = createAfterScheduleRecord(ScheduleId('archive-running'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record)], { run: held.run })
    await vi.advanceTimersByTimeAsync(60_000)
    await drain()
    expect(test.table.get(record.id)?.status).toBe('inactive')
    expect(await test.ctx.waterfall('workspace/session-activity', { sessionId: owner }, async () => []))
      .toEqual([{ kind: 'schedule', items: [{ id: record.id, label: 't' }] }])
    await test.ctx.parallel('workspace/session-stop', { sessionId: owner })
    await drain()
    expect(test.fake.run.mock.calls[0]?.[1].signal.aborted).toBe(true)
    expect(test.table.get(record.id)).toBeUndefined()
  })

  it('records a skipped occurrence while the previous run is in flight and never runs concurrently', async () => {
    const held = heldRun()
    const record = createEveryScheduleRecord(ScheduleId('slow'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record, { report: 'never' })], { run: held.run })

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()
    expect((await test.service.catalog())[0]?.running).toMatchObject({ startedAt: '2026-09-16T00:01:00.000Z' })
    const runningRecord = test.table.get(record.id)?.record
    if (runningRecord === undefined) throw new Error('Missing running task')
    await expect(test.service.update({ sessionId: owner, id: record.id, expected: runningRecord, report: 'always' }))
      .resolves.toMatchObject({ code: 'schedule_conflict' })
    expect(test.table.get(record.id)?.report).toBe('never')
    await vi.advanceTimersByTimeAsync(60_000)
    await drain()

    expect(test.fake.run).toHaveBeenCalledTimes(1)
    expect(test.table.get(record.id)?.runHistory?.records).toEqual([
      expect.objectContaining({ outcome: 'skipped', scheduledAt: '2026-09-16T00:02:00.000Z' }),
    ])
    held.release()
    await drain()
    expect(test.table.get(record.id)?.runHistory?.records.map(run => run.outcome)).toEqual(['skipped', 'succeeded'])
    expect(test.table.get(record.id)?.inFlight).toBeUndefined()
  })

  it('cancels the run of a deleted task and records nothing', async () => {
    const held = heldRun()
    const record = createAfterScheduleRecord(ScheduleId('deleted'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record)], { run: held.run })

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()
    await expect(test.service.delete({ sessionId: owner, id: record.id })).resolves.toEqual({ id: record.id, deleted: true })
    await drain()

    expect(test.fake.run.mock.calls[0]?.[1].signal.aborted).toBe(true)
    expect(test.table.get(record.id)).toBeUndefined()
    expect(test.agent.followup).not.toHaveBeenCalled()
  })

  it('records a run a previous Host left in flight as interrupted without repeating it', async () => {
    const record = createAfterScheduleRecord(ScheduleId('interrupted'), 'p', 60, NOW - 120_000, 't')
    const inFlight = { runId: 'run-stale', scheduledAt: record.scheduledAt, startedAt: '2026-09-15T23:59:00.000Z' }
    const test = await setup([scriptRow(record, { status: 'inactive', inFlight })])

    await drain()

    expect(test.fake.run).not.toHaveBeenCalled()
    const row = test.table.get(record.id)
    expect(row?.inFlight).toBeUndefined()
    expect(row?.runHistory?.records).toEqual([expect.objectContaining({ runId: 'run-stale', outcome: 'interrupted' })])
    // Recovery runs at startup, before this fixture resolves the Session, so its report was attempted and warned.
    expect(test.resolve).toHaveBeenCalledWith(owner)
    expect(row?.runHistory?.records[0]?.messageId).toBeUndefined()
  })

  it('leaves the in-flight marker for the next startup when the Host stops mid-run', async () => {
    const held = heldRun()
    const record = createAfterScheduleRecord(ScheduleId('stopped'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record)], { run: held.run })

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()
    const pool = test.pool
    await test.fiber.dispose()

    const reopened = await harness({ pool, onContext: ctx => contexts.push(ctx) })
    await drain()
    const rows = reopened.ctx.storageDomain.get('schedule')?.table('tasks') as KvTable<ScheduleRecord['id'], ScheduleTask> | undefined
    expect(rows?.get(record.id)?.runHistory?.records[0]?.outcome).toBe('interrupted')
  })
})

describe('manual runs', () => {
  it('starts a manual run without moving the plan and refuses a second one while it is in flight', async () => {
    let finish: (() => void) | undefined
    const record = createEveryScheduleRecord(ScheduleId('manual'), 'p', 3_600, NOW, 't')
    const test = await setup([scriptRow(record, { report: 'never' })], {
      run: async () => new Promise((resolve) => { finish = () => { resolve({ outcome: 'succeeded', output: 'ok' }) } }),
    })

    const started = await test.service.run({ sessionId: owner, id: record.id })
    expect(started).toMatchObject({ id: record.id, ran: true, startedAt: '2026-09-16T00:00:00.000Z' })
    await drain()
    await expect(test.service.run({ sessionId: owner, id: record.id }))
      .resolves.toEqual({ id: record.id, ran: false, code: 'schedule_running' })
    finish?.()
    await drain()

    const row = test.table.get(record.id)
    expect(row?.record).toEqual(record)
    expect(row?.status).toBe('active')
    expect(row?.runHistory?.records).toEqual([expect.objectContaining({
      runId: 'runId' in started ? started.runId : '', manual: true, scheduledAt: record.scheduledAt,
    })])
    const page = await test.service.runs({ sessionId: owner, id: record.id, limit: 10 })
    expect('records' in page && page.records[0]).toMatchObject({ manual: true })
  })
})

describe('run history', () => {
  it('pages newest first, prunes with the delivery bounds, and validates the cursor and limit', async () => {
    const record = createEveryScheduleRecord(ScheduleId('paged'), 'p', 60, NOW, 't')
    const test = await setup([scriptRow(record, { report: 'never' })], { config: { deliveryHistoryRecords: 2 } })

    for (let tick = 0; tick < 3; tick += 1) {
      await vi.advanceTimersByTimeAsync(60_000)
      await drain()
    }

    const first = await test.service.runs({ sessionId: owner, id: record.id, limit: 1 })
    expect(first).toMatchObject({ earlierRecordsPruned: true, retention: { days: 30, records: 2 } })
    if (!('records' in first)) throw new Error('expected a page')
    expect(first.records.map(run => run.scheduledAt)).toEqual(['2026-09-16T00:03:00.000Z'])
    const second = await test.service.runs({ sessionId: owner, id: record.id, limit: 5, before: first.nextBefore! })
    expect('records' in second && second.records.map(run => run.scheduledAt)).toEqual(['2026-09-16T00:02:00.000Z'])
    expect(second).not.toHaveProperty('nextBefore')
    await expect(test.service.runs({ sessionId: owner, id: record.id, limit: 1, before: 'run-missing' }))
      .resolves.toEqual({ id: record.id, code: 'run_cursor_not_found' })
    await expect(test.service.runs({ sessionId: SessionId('other'), id: record.id, limit: 1 }))
      .resolves.toEqual({ id: record.id, code: 'schedule_not_found' })
    await expect(test.service.runs({ sessionId: owner, id: record.id, limit: 0 })).rejects.toMatchObject({ code: 'invalid_rule' })
  })
})

describe('updates', () => {
  it('replaces the action and report policy against the observed action', async () => {
    const record = createAfterScheduleRecord(ScheduleId('edit'), 'p', 3_600, NOW, 't')
    const test = await setup([scriptRow(record)])
    const base = { sessionId: owner, id: record.id, expected: record }

    await expect(test.service.update({
      ...base, action: { kind: 'fake', spec: { text: 'new' } }, expectedAction: { kind: 'fake', source: 'stale' },
    })).resolves.toEqual({ id: record.id, updated: false, code: 'schedule_conflict' })
    await expect(test.service.update({ ...base, action: { kind: 'fake', spec: { text: 'new' } } }))
      .resolves.toEqual({ id: record.id, updated: false, code: 'schedule_conflict' })
    await expect(test.service.update({
      ...base, action: { kind: 'fake', spec: {} }, expectedAction: { kind: 'fake', source: 'hello' },
    })).resolves.toMatchObject({ code: 'invalid_action' })

    await expect(test.service.update({
      ...base, action: { kind: 'fake', spec: { text: 'new' }, timeoutMs: 1_000 },
      expectedAction: { kind: 'fake', source: 'hello' }, report: 'never',
    })).resolves.toMatchObject({ updated: true, record })

    expect(test.table.get(record.id)).toMatchObject({
      action: { kind: 'fake', spec: { text: 'new' }, timeoutMs: 1_000 }, report: 'never', record,
    })
    await expect(test.service.update({ ...base, report: 'never' })).resolves.toMatchObject({ updated: false })
    await expect(test.service.update({
      ...base, action: { kind: 'fake', spec: { text: 'newer' } }, expectedAction: { kind: 'fake', source: 'new', timeoutMs: 1_000 },
    })).resolves.toMatchObject({ updated: true })
    expect(test.table.get(record.id)).toMatchObject({ action: { kind: 'fake', spec: { text: 'newer' } }, report: 'never' })
  })

  it('refuses script members on a prompt reminder', async () => {
    const record = createAfterScheduleRecord(ScheduleId('prompt'), 'p', 3_600, NOW, 't')
    const test = await setup([{ sessionId: owner, record, status: 'active' }])

    await expect(test.service.update({ sessionId: owner, id: record.id, expected: record, report: 'always' }))
      .resolves.toEqual({ id: record.id, updated: false, code: 'not_script_task' })
  })

  it('rejects a provider failure that is not an input error', async () => {
    const record = createAfterScheduleRecord(ScheduleId('broken-decode'), 'p', 3_600, NOW, 't')
    const test = await setup([scriptRow(record)])
    test.ctx.effect(() => test.service.actions.register({
      ...fakeProvider().provider, kind: 'broken', decode: () => { throw new Error('decoder crashed') },
    }))

    await expect(test.service.update({
      sessionId: owner, id: record.id, expected: record,
      action: { kind: 'broken', spec: {} }, expectedAction: { kind: 'fake', source: 'hello' },
    })).rejects.toThrow('decoder crashed')
  })
})

describe('catalog summaries and empty history', () => {
  it('summarizes the first non-empty line, cuts a long line, and reads a task without runs', async () => {
    const long = createAfterScheduleRecord(ScheduleId('a-long'), 'p', 3_600, NOW, 't')
    const blank = createAfterScheduleRecord(ScheduleId('b-blank'), 'p', 3_600, NOW, 't')
    const test = await setup([
      scriptRow(long, { action: { kind: 'fake', spec: { text: `\n  ${'x'.repeat(200)}\nsecond` } } }),
      scriptRow(blank, { action: { kind: 'fake', spec: { text: '   ' } } }),
    ])

    const [first, second] = await test.service.catalog()
    expect(first?.action?.summary).toBe(`${'x'.repeat(119)}…`)
    expect(second?.action?.summary).toBe('')
    await expect(test.service.runs({ sessionId: owner, id: long.id, limit: 5 })).resolves.toMatchObject({
      records: [], earlierRecordsPruned: false,
    })
  })
})

describe('manual result framing', () => {
  it('marks a delivered manual run', async () => {
    const record = createEveryScheduleRecord(ScheduleId('manual-report'), 'p', 3_600, NOW, 't')
    const test = await setup([scriptRow(record)])

    await test.service.run({ sessionId: owner, id: record.id })
    await drain()

    expect(textOf(test.agent.followup.mock.calls[0]?.[0])).toContain('manual_run: true')
  })
})

describe('storage failures', () => {
  it('warns and retries a due task whose start was not persisted, and warns an interrupted run it cannot record', async () => {
    const due = createAfterScheduleRecord(ScheduleId('unstarted'), 'p', 60, NOW, 't')
    const stale = createAfterScheduleRecord(ScheduleId('unrecorded'), 'p', 60, NOW - 120_000, 't')
    const pool = new MemoryMediaPool()
    let refuse = false
    const test = await harness({
      pool,
      backend: gatedScheduleBackend(pool, { putRecord: async () => { if (refuse) throw new Error('disk full') } }),
      beforeService: async (ctx, facility) => {
        ctx.provide('sandboxPolicy', { resolve: () => policy } as never)
        const domain = await facility.open(scheduleDomain)
        await domain.table('tasks').put(due.id, scriptRow(due))
        await domain.table('tasks').put(stale.id, scriptRow(stale, {
          status: 'inactive', inFlight: { runId: 'run-unrecorded', scheduledAt: stale.scheduledAt, startedAt: stale.scheduledAt },
        }))
        await domain.close()
        refuse = true
      },
      onContext: ctx => contexts.push(ctx),
    })
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    const fake = fakeProvider()
    test.ctx.effect(() => test.service.actions.register(fake.provider))
    test.resolve.mockResolvedValue({ agent: agentFor(test.ctx, owner) })

    await vi.advanceTimersByTimeAsync(60_000)
    await drain()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('interrupted run run-unrecorded was not recorded: Error: disk full'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('script task "unstarted" was not started: Error: disk full'))
    expect(fake.run).not.toHaveBeenCalled()
    refuse = false
    // A later management write re-drives the queue; the failed task is retried then.
    await test.service.create(owner, { prompt: 'p', title: 't', after_seconds: 3_600 })
    await drain()
    expect(fake.run).toHaveBeenCalledTimes(1)
  })
})

describe('storage invariants', () => {
  it('accepts saved runs and refuses duplicate run identities', () => {
    const record = createAfterScheduleRecord(ScheduleId('runs-row'), 'p', 3_600, NOW, 't')
    const run = {
      runId: 'run-1', scheduledAt: record.scheduledAt, startedAt: record.scheduledAt, finishedAt: record.scheduledAt,
      outcome: 'succeeded', output: '', outputTruncated: false,
    }
    const row = (records: unknown[]) => ({ ...scriptRow(record), runHistory: { records, earlierRecordsPruned: false } })
    expect(scheduleTaskSchema.safeParse(row([run])).success).toBe(true)
    expect(scheduleTaskSchema.safeParse(row([run, run])).success).toBe(false)
  })
  it.each([
    ['an action without a binding', { action: { kind: 'fake', spec: {} }, report: 'always' }],
    ['runs on a prompt reminder', { runHistory: { records: [], earlierRecordsPruned: false } }],
  ])('refuses %s', async (_case, extra) => {
    const record = createAfterScheduleRecord(ScheduleId('invalid-row'), 'p', 3_600, NOW, 't')
    const row = { sessionId: owner, record, status: 'active', ...extra }
    expect(scheduleTaskSchema.safeParse(row).success).toBe(false)
  })
})
