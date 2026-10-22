import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import type { ShellExecRequest } from '@deepseek-ai/dsh-shell'
import { afterEach, expect, it, vi } from 'vitest'
import { agentFor, harness } from '../../schedule/tests/harness.ts'
import * as Command from '../src/index.ts'

const tests: Awaited<ReturnType<typeof harness>>[] = []
const roots: string[] = []
afterEach(async () => {
  for (const test of tests.splice(0)) await test.ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('loads Schedule and its command action from Cordis rows and saves an execution result', async () => {
  const test = await harness()
  tests.push(test)
  await test.fiber.dispose()
  const ctx = test.ctx
  const agent = agentFor(ctx, 'loader-command')
  test.resolve.mockResolvedValue({ agent })
  ctx.provide('sandboxPolicy', {
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/workspace', sessionId: agent.session.id }),
  } as never)
  const execute = vi.fn(async (_spec: ShellExecRequest) => ({
    result: async () => ({
      exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 2_000,
      stdout: { text: 'loader-command-result', truncated: false }, stderr: { text: '', truncated: false },
    }),
  }))
  ctx.provide('shell', { sandboxMode: 'workspace-write', resolve: (spec: ShellExecRequest) => spec, execute } as never)

  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-command-loader-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-schedule'",
    "- name: '@deepseek-ai/dsh-schedule-action-command'",
    '',
  ].join('\n'))
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === '@deepseek-ai/dsh-schedule') return ScheduleService
      if (specifier === '@deepseek-ai/dsh-schedule-action-command') return Command
      throw new Error(`Unexpected module ${specifier}`)
    },
  } as never
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  const task = await ctx.schedule.create(agent.session.id, { title: 'Command', prompt: 'Inspect failures', after_seconds: 3_600 }, undefined, {
    action: { kind: 'command', spec: { command: 'printf loader-command-result' } },
    report: 'never', binding: { cwd: '/workspace', sandboxCeiling: 'workspace-write' },
  })
  await ctx.schedule.run({ sessionId: agent.session.id, id: task.id })
  await expect.poll(async () => {
    const page = await ctx.schedule.runs({ sessionId: agent.session.id, id: task.id, limit: 1 })
    return 'records' in page ? page.records[0]?.output : undefined
  }).toBe('loader-command-result')
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({
    command: 'printf loader-command-result', workdir: '/workspace',
  }))
  expect(agent.followup).not.toHaveBeenCalled()
  const service = ctx.schedule
  await ctx.fiber.dispose()
  expect(service.actions.list()).toEqual([])
})
