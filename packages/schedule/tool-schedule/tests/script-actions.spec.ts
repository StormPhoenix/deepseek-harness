import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import { agentFor, harness, mountToolSchedule } from './harness.ts'
import { actionInput, actionParameters, approveScript, reportInput } from '../src/script-actions.ts'

const tests: Awaited<ReturnType<typeof harness>>[] = []
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
})

async function setup(mode: 'workspace-write' | 'danger-full-access' = 'danger-full-access') {
  const test = await harness()
  tests.push(test)
  const agent = agentFor(test.ctx)
  test.ctx.provide('sandboxPolicy', { resolve: () => ({ mode, workspaceRoot: '/workspace' }) } as never)
  test.ctx.provide('workingDirectory', { ensure: async () => '/workspace' } as never)
  test.ctx.effect(() => test.service.actions.register({
    kind: 'command', description: 'Execute a command.',
    specSchema: { type: 'object', additionalProperties: false, properties: { command: { type: 'string', required: true } } },
    decode: spec => spec as { command: string },
    source: spec => (spec as { command: string }).command,
    run: async () => ({ outcome: 'succeeded', output: 'ok' }),
  }))
  const scope = await mountToolSchedule(test.ctx, agent)
  test.resolve.mockResolvedValue({ agent })
  return { ...test, agent, scope }
}

async function execute(test: Awaited<ReturnType<typeof setup>>, name: string, args: unknown) {
  return test.ctx.tools.execute({
    callId: ToolCallId('script-call'), agent: test.agent, signal: new AbortController().signal, name, arguments: args,
  })
}

it('creates, lists, and replaces a command task through model tools without running it at creation', async () => {
  const test = await setup()
  const created = await execute(test, 'schedule_create', {
    title: 'Backup', prompt: 'Explain failures', after_seconds: 3600,
    action: { kind: 'command', spec: { command: 'printf backup' }, timeout_seconds: 3 }, report: 'never',
  })
  expect(created.isError).toBe(false)
  expect(created.value).toMatchObject({ action: { kind: 'command', source: 'printf backup', cwd: '/workspace', timeoutMs: 3000 }, report: 'never' })
  const [entry] = await test.service.catalog()
  if (entry === undefined) throw new Error('missing task')
  expect(test.resolve).not.toHaveBeenCalled()
  const listed = await execute(test, 'schedule_list', {})
  expect(listed.value).toEqual([created.value])
  const updated = await execute(test, 'schedule_update', {
    id: entry.id, action: { kind: 'command', spec: { command: 'printf new' } }, report: 'on-failure',
  })
  expect(updated.isError).toBe(false)
  expect(updated.value).toMatchObject({ action: { source: 'printf new' }, report: 'on-failure' })
  expect((await test.service.catalog())[0]?.id).toBe(entry.id)
  const next = await execute(test, 'schedule_update', {
    id: entry.id, action: { kind: 'command', spec: { command: 'printf third' } },
  })
  expect(next.value).toMatchObject({ action: { source: 'printf third' } })
})

it('refuses an unapproved script creation without writing a task', async () => {
  const test = await setup('workspace-write')
  const created = await execute(test, 'schedule_create', {
    title: 'Backup', prompt: 'Explain failures', after_seconds: 3600,
    action: { kind: 'command', spec: { command: 'printf backup' } },
  })
  expect(created.value).toMatchObject({ code: 'internal_error' })
  expect(await test.service.catalog()).toEqual([])
})

it.each(['rejected', 'cancelled', 'unavailable'])('does not store code when approval is %s', async (decision) => {
  const test = await setup('workspace-write')
  test.ctx.provide('approval', { request: async () => decision } as never)
  const result = await execute(test, 'schedule_create', {
    title: 'Backup', prompt: 'p', after_seconds: 3600, action: { kind: 'command', spec: { command: 'printf backup' } },
  })
  expect(result.value).toMatchObject({ code: 'internal_error' })
  expect(await test.service.catalog()).toEqual([])
})

it('asks for approval in a restricted Session and preserves its original sandbox ceiling', async () => {
  const test = await setup('workspace-write')
  const request = vi.fn(async () => 'allowed-once')
  test.ctx.provide('approval', { request } as never)
  const created = await execute(test, 'schedule_create', {
    title: 'Backup', prompt: 'Explain failures', after_seconds: 3600,
    action: { kind: 'command', spec: { command: 'printf backup' } },
  })
  expect(created.value).toMatchObject({ action: { sandboxCeiling: 'workspace-write' } })
  expect(request).toHaveBeenCalledOnce()
  expect(JSON.stringify(request.mock.calls)).toContain('printf backup')
  expect(JSON.stringify(request.mock.calls)).toContain('/workspace')
})

it('refuses a report policy on a prompt task and script updates to a prompt reminder', async () => {
  const test = await setup()
  expect((await execute(test, 'schedule_create', { title: 'Reminder', prompt: 'p', after_seconds: 3600, report: 'never' })).value)
    .toMatchObject({ code: 'invalid_action' })
  const reminder = await test.service.create(test.agent.session.id, { title: 'Reminder', prompt: 'p', after_seconds: 3600 })
  expect((await execute(test, 'schedule_update', { id: reminder.id, report: 'never' })).value)
    .toMatchObject({ code: 'not_script_task' })
})

it('refreshes tool schemas when providers change and removes registrations with the scope', async () => {
  const test = await setup()
  const remove = test.service.actions.register({
    kind: 'other', description: 'Other.', specSchema: { type: 'object', additionalProperties: true },
    decode: () => ({}), source: () => 'other', run: async () => ({ outcome: 'succeeded', output: '' }),
  })
  expect(JSON.stringify(test.ctx.tools.get('schedule_create', test.agent)?.parameters)).toContain('other')
  remove()
  expect(JSON.stringify(test.ctx.tools.get('schedule_create', test.agent)?.parameters)).not.toContain('Other.')
  await test.scope.dispose()
  expect(test.ctx.tools.get('schedule_create', test.agent)).toBeUndefined()
})

it.each([null, [], {}, { kind: 1, spec: {} }, { kind: 'command' }, { kind: 'command', spec: {}, env: {} },
  { kind: 'command', spec: {}, timeout_seconds: -1 }, { kind: 'command', spec: {}, timeout_seconds: '3' },
  { kind: 'command', spec: {}, timeout_seconds: 0.5 }, { kind: 'command', spec: {}, timeout_seconds: Number.MAX_SAFE_INTEGER }])(
  'rejects invalid action envelope %j', async (input) => {
    const test = await setup()
    expect(() => actionInput(test.ctx, input)).toThrow(expect.objectContaining({ code: 'invalid_action' }))
  },
)

it('rejects unavailable kinds and invalid reports', async () => {
  const test = await setup()
  expect(() => actionInput(test.ctx, { kind: 'absent', spec: {} })).toThrow(expect.objectContaining({ code: 'action_unavailable' }))
  expect(reportInput(undefined)).toBeUndefined()
  expect(reportInput('always')).toBe('always')
  expect(reportInput('on-failure')).toBe('on-failure')
  expect(reportInput('never')).toBe('never')
  expect(() => reportInput('bad')).toThrow(expect.objectContaining({ code: 'invalid_action' }))
})

it('omits script fields without action providers', async () => {
  const test = await harness()
  tests.push(test)
  expect(actionParameters(test.ctx)).toEqual({})
})

it('fails explicitly when script authorization lacks the policy services', async () => {
  const test = await harness()
  tests.push(test)
  const agent = agentFor(test.ctx)
  await expect(approveScript(test.ctx, agent, {} as ToolRunContext, { kind: 'command', spec: {} }, {}))
    .rejects.toMatchObject({ code: 'action_unavailable' })
})

it('contains a task removed before the creation response is projected', async () => {
  const test = await setup()
  vi.spyOn(test.service, 'catalog').mockResolvedValue([])
  const created = await execute(test, 'schedule_create', {
    title: 'Backup', prompt: 'p', after_seconds: 3600, action: { kind: 'command', spec: { command: 'printf backup' } },
  })
  expect(created.value).toMatchObject({ code: 'internal_error' })
})

it('keeps ordinary update and list behavior when the task is absent from the catalog snapshot', async () => {
  const test = await setup()
  const record = await test.service.create(test.agent.session.id, { title: 'Reminder', prompt: 'p', after_seconds: 3600 })
  vi.spyOn(test.service, 'catalog').mockResolvedValue([])
  expect((await execute(test, 'schedule_list', {})).value).toMatchObject([{ id: record.id }])
  expect((await execute(test, 'schedule_update', { id: record.id, title: 'Changed' })).value).toMatchObject({ title: 'Changed' })
  expect(await test.service.delete({ sessionId: test.agent.session.id, id: ScheduleId(record.id) })).toMatchObject({ deleted: true })
})
