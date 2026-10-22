// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ScheduleRunHistoryResult, ScheduleRunRecord, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { RunHistory, type RunHistoryInjected } from '../src/client/RunHistory.tsx'
import { en } from '../src/client/task-manager-locales.ts'

afterEach(cleanup)
const id = 'script-task' as ScheduleId
const sessionId = 'script-session' as SessionId
const t = makeTranslate(en)
const base: ScheduleRunRecord = {
  runId: 'run-1', scheduledAt: '2026-10-20T00:00:00.000Z', startedAt: '2026-10-20T00:00:00.000Z',
  finishedAt: '2026-10-20T00:00:01.000Z', outcome: 'succeeded', output: 'hello', outputTruncated: false,
}
function page(records: ScheduleRunRecord[], nextBefore?: string): RemoteResult<ScheduleRunHistoryResult> {
  return { ok: true, value: {
    id, records, earlierRecordsPruned: false, retention: { days: 30, records: 200 },
    ...(nextBefore === undefined ? {} : { nextBefore }),
  } }
}
const props = { id, sessionId, t }

it('loads a bounded page and displays outcome, duration, exit code, report and output', async () => {
  const loadRuns = vi.fn<RunHistoryInjected['loadRuns']>(async () => page([{
    ...base, manual: true, exitCode: 1, outcome: 'failed', messageId: 'message' as MessageId, outputTruncated: true,
  }]))
  render(<RunHistory {...props} loadRuns={loadRuns} />)
  await screen.findByText(en['runs.outcome.failed'])
  expect(loadRuns).toHaveBeenCalledWith({ id, sessionId, limit: 20 })
  expect(screen.getByText(en['runs.reported'])).toBeTruthy()
  expect(screen.getByText(en['runs.truncated'])).toBeTruthy()
  expect(screen.getByText(/Manual run/)).toBeTruthy()
  expect(screen.getByText('hello')).toBeTruthy()
  expect(screen.getByText(/Duration 1000 ms/)).toBeTruthy()
  expect(screen.getByText(/Exit code 1/)).toBeTruthy()
})

it('shows an empty result separately from loading', async () => {
  const pending = Promise.withResolvers<RemoteResult<ScheduleRunHistoryResult>>()
  const loadRuns = vi.fn<RunHistoryInjected['loadRuns']>(() => pending.promise)
  render(<RunHistory {...props} loadRuns={loadRuns} />)
  expect(screen.getByRole('status', { name: en['runs.loading'] })).toBeTruthy()
  await act(async () => { pending.resolve(page([])) })
  expect(screen.getByText(en['runs.empty'])).toBeTruthy()
})

it('loads older records, removes duplicates, and states retention pruning', async () => {
  const older = { ...base, runId: 'run-older', output: '' }
  const loadRuns = vi.fn<RunHistoryInjected['loadRuns']>()
    .mockResolvedValueOnce(page([base], base.runId))
    .mockResolvedValueOnce({ ok: true, value: {
      id, records: [base, older], earlierRecordsPruned: true, retention: { days: 30, records: 200 },
    } })
  render(<RunHistory {...props} loadRuns={loadRuns} />)
  await screen.findByText(en['runs.output'])
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['runs.older'] })) })
  expect(loadRuns).toHaveBeenLastCalledWith({ id, sessionId, limit: 20, before: base.runId })
  expect(screen.getAllByText(en['runs.outcome.succeeded'])).toHaveLength(2)
  expect(screen.getByText(en['runs.pruned'])).toBeTruthy()
  expect(screen.queryByText(en['runs.older'])).toBeNull()
})

it('does not submit a second read while an older-page read is pending', async () => {
  const pending = Promise.withResolvers<RemoteResult<ScheduleRunHistoryResult>>()
  const loadRuns = vi.fn<RunHistoryInjected['loadRuns']>()
    .mockResolvedValueOnce(page([base], base.runId)).mockReturnValueOnce(pending.promise)
  render(<RunHistory {...props} loadRuns={loadRuns} />)
  await screen.findByText(en['runs.older'])
  const button = screen.getByRole('button', { name: en['runs.older'] })
  await act(async () => {
    fireEvent.click(button)
    fireEvent.click(button)
  })
  expect(loadRuns).toHaveBeenCalledTimes(2)
  await act(async () => { pending.resolve(page([])) })
})

it.each(['transport', 'missing', 'cursor', 'throw'] as const)('offers refresh after a %s failure', async (failure) => {
  const loadRuns = vi.fn<RunHistoryInjected['loadRuns']>()
  if (failure === 'throw') loadRuns.mockRejectedValueOnce(new Error('offline'))
  else if (failure === 'transport') loadRuns.mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'Offline' } } as never)
  else loadRuns.mockResolvedValueOnce({ ok: true, value: { id, code: failure === 'missing' ? 'schedule_not_found' : 'run_cursor_not_found' } })
  loadRuns.mockResolvedValueOnce(page([base]))
  render(<RunHistory {...props} loadRuns={loadRuns} />)
  await screen.findByRole('alert')
  expect(screen.queryByText(en['runs.empty'])).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['runs.retry'] })) })
  expect(screen.getByText(en['runs.outcome.succeeded'])).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('supersedes a late older-page response when a new run refreshes the page', async () => {
  const pending = Promise.withResolvers<RemoteResult<ScheduleRunHistoryResult>>()
  const loadRuns = vi.fn<RunHistoryInjected['loadRuns']>()
    .mockResolvedValueOnce(page([base], base.runId))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(page([{ ...base, runId: 'run-new', output: 'new result' }]))
  const view = render(<RunHistory {...props} loadRuns={loadRuns} />)
  await screen.findByText(en['runs.older'])
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['runs.older'] })) })
  view.rerender(<RunHistory {...props} loadRuns={loadRuns} latestRunId="run-new" />)
  await screen.findByText('new result')
  await act(async () => { pending.resolve(page([{ ...base, runId: 'stale', output: 'stale result' }])) })
  expect(screen.queryByText('stale result')).toBeNull()
  expect(screen.getByText('new result')).toBeTruthy()
})

it('ignores a rejected request after unmount', async () => {
  const pending = Promise.withResolvers<RemoteResult<ScheduleRunHistoryResult>>()
  const loadRuns = vi.fn<RunHistoryInjected['loadRuns']>(() => pending.promise)
  const view = render(<RunHistory {...props} loadRuns={loadRuns} />)
  view.unmount()
  await act(async () => { pending.reject(new Error('late failure')) })
  expect(screen.queryByRole('alert')).toBeNull()
})
