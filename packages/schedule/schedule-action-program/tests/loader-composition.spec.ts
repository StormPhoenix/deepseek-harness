import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import { afterEach, expect, it, vi } from 'vitest'
import { agentFor, harness } from '../../schedule/tests/harness.ts'
import * as Program from '../src/index.ts'

const tests: Awaited<ReturnType<typeof harness>>[] = []
const roots: string[] = []
afterEach(async () => {
  for (const test of tests.splice(0)) await test.ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('loads Schedule and its program action from Cordis rows and saves a result without calling a model', async () => {
  const test = await harness()
  tests.push(test)
  await test.fiber.dispose()
  const ctx = test.ctx
  const agent = agentFor(ctx, 'loader-program')
  test.resolve.mockResolvedValue({ agent })
  ctx.provide('sandboxPolicy', {
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/workspace', sessionId: agent.session.id }),
  } as never)
  const run = vi.fn(async (_spec: PtcRunRequest) => ({ logs: ['loader-program-log'], value: 42 }))
  ctx.provide('ptcRuntime', {
    language: 'typescript', programFormat: 'function-body', executionInstructions: 'Use await and return.',
    sandboxMode: 'workspace-write', resolve: (spec: PtcRunRequest) => spec, run,
  } as never)

  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-program-loader-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-schedule'",
    "- name: '@deepseek-ai/dsh-schedule-action-program'",
    '',
  ].join('\n'))
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === '@deepseek-ai/dsh-schedule') return ScheduleService
      if (specifier === '@deepseek-ai/dsh-schedule-action-program') return Program
      throw new Error(`Unexpected module ${specifier}`)
    },
  } as never
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  const task = await ctx.schedule.create(agent.session.id, { title: 'Program', prompt: 'Inspect failures', after_seconds: 3_600 }, undefined, {
    action: { kind: 'program', spec: { source: 'return 42' } },
    report: 'never', binding: { cwd: '/workspace', sandboxCeiling: 'workspace-write' },
  })
  await ctx.schedule.run({ sessionId: agent.session.id, id: task.id })
  await expect.poll(async () => {
    const page = await ctx.schedule.runs({ sessionId: agent.session.id, id: task.id, limit: 1 })
    return 'records' in page ? page.records[0]?.output : undefined
  }).toBe('loader-program-log\n42')
  expect(run).toHaveBeenCalledWith(expect.objectContaining({
    program: 'return 42', cwd: '/workspace', bindings: [],
  }))
  expect(agent.followup).not.toHaveBeenCalled()
  const service = ctx.schedule
  await ctx.fiber.dispose()
  expect(service.actions.list()).toEqual([])
})
