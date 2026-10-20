/** Host-wide immediate runs deliver the stored rule without touching the armed plan. */
import type { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CreateSessionOptions } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAfterScheduleRecord, createEveryScheduleRecord, ScheduleId } from '../src/domain.ts'
import { scheduleDomain, type ScheduleTask } from '../src/storage.ts'
import type { ScheduleRecord } from '../src/types.ts'
import { agentFor, harness } from './harness.ts'

const contexts: Context[] = []

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z')) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const owner = SessionId('manual-owner')

/**
 * Start the service over one stored task and one resolvable Agent.
 * @param stored - Task row present before activation, or none.
 * @param meta - Session metadata the fixture Agent's Session carries.
 * @returns The isolated harness plus the Agent a delivery reaches.
 */
async function setup(stored?: ScheduleTask, meta?: CreateSessionOptions['meta']) {
  const test = await harness({
    ...stored === undefined ? {} : { beforeService: async (_ctx, facility) => {
      const domain = await facility.open(scheduleDomain)
      await domain.table('tasks').put(stored.record.id, stored)
      await domain.close()
    } },
    onContext: ctx => contexts.push(ctx),
  })
  const agent = agentFor(test.ctx, stored?.sessionId ?? owner, meta)
  test.resolve.mockResolvedValue({ agent })
  return { ...test, agent }
}

/**
 * The Schedule table the service writes.
 * @param test - Harness whose domain is open.
 * @returns The task table handle.
 */
function table(test: Awaited<ReturnType<typeof setup>>) {
  const domain = test.ctx.storageDomain.get('schedule')
  if (domain === undefined) throw new Error('Schedule domain not initialized')
  return domain.table('tasks') as KvTable<ScheduleRecord['id'], ScheduleTask>
}

/**
 * One recurring task bound to the fixture Session.
 * @param id - Stable task identity for the case.
 * @param prompt - Stored instruction the delivery carries.
 * @returns A task row armed one minute from the pinned clock.
 */
function recurring(id: string, prompt = 'Archive the feed'): ScheduleTask {
  const record = createEveryScheduleRecord(ScheduleId(id), prompt, 60, Date.now(), prompt)
  return { sessionId: owner, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false } }
}

it('delivers the stored instruction now and saves a manual receipt without moving the plan', async () => {
  const stored = recurring('manual-every')
  const test = await setup(stored)
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)

  const result = await test.service.run({ sessionId: owner, id: stored.record.id })

  expect(result).toEqual({ id: stored.record.id, ran: true, deliveredAt: '2026-09-16T00:00:00.000Z' })
  expect(test.resolve).toHaveBeenCalledWith(owner)
  expect(test.flush).toHaveBeenCalledTimes(1)
  const message = test.agent.followup.mock.calls[0]![0]
  expect(message.source).toEqual({ kind: 'schedule' })
  const [block] = message.content
  const text = block !== undefined && block.type === 'text' ? block.text : ''
  expect(text).toContain('[SCHEDULE REMINDER BATCH]')
  // The run consumes no occurrence, so the framing names the target that stays armed.
  expect(text).toContain(stored.record.scheduledAt)
  expect(text).toContain('Archive the feed')

  const after = table(test).get(stored.record.id)
  expect(after?.record).toEqual(stored.record)
  expect(after?.status).toBe('active')
  expect(after?.lastDelivery).toEqual({
    scheduledAt: stored.record.scheduledAt, deliveredAt: '2026-09-16T00:00:00.000Z', messageId: message.id, manual: true,
  })
  expect(after?.deliveryHistory?.records).toEqual([{
    scheduledAt: stored.record.scheduledAt, deliveredAt: '2026-09-16T00:00:00.000Z', messageId: message.id,
    prompt: 'Archive the feed', manual: true,
  }])
  expect(changed).toHaveBeenCalledTimes(1)

  // The catalog and the saved records both state the marker a scheduled delivery omits.
  expect((await test.service.catalog())[0]?.lastDelivery?.manual).toBe(true)
  expect(await test.service.history({ sessionId: owner, id: stored.record.id, limit: 10 }))
    .toMatchObject({ records: [{ manual: true, prompt: 'Archive the feed' }] })
})

it('delivers a one-shot rule without ending it', async () => {
  const record = createAfterScheduleRecord(ScheduleId('manual-once'), 'Ship the release', 3_600, Date.now(), 'Ship')
  const stored: ScheduleTask = {
    sessionId: owner, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false },
  }
  const test = await setup(stored)

  await expect(test.service.run({ sessionId: owner, id: record.id })).resolves.toMatchObject({ ran: true })

  const message = test.agent.followup.mock.calls[0]![0]
  const [block] = message.content
  const text = block !== undefined && block.type === 'text' ? block.text : ''
  expect(text).toContain('[SCHEDULE REMINDER]')
  expect(text).toContain(`occurrence_at: ${record.scheduledAt}`)
  // A manual run is not the occurrence the rule counts, so the one-shot plan stays armed.
  expect(table(test).get(record.id)?.status).toBe('active')
})

it('reads a stored manual receipt back when the domain opens', async () => {
  const receipt: NonNullable<ScheduleTask['lastDelivery']> = {
    scheduledAt: '2026-09-15T23:00:00.000Z', deliveredAt: '2026-09-15T23:30:00.000Z',
    messageId: MessageId('stored-manual-message'), manual: true,
  }
  const stored: ScheduleTask = {
    ...recurring('manual-stored'),
    lastDelivery: receipt,
    deliveryHistory: { records: [{ ...receipt, prompt: 'Archive the feed' }], earlierRecordsUnavailable: false },
  }
  const test = await setup(stored)

  expect((await test.service.catalog())[0]?.lastDelivery).toEqual(receipt)
})

it('projects a scheduled receipt without a manual marker', async () => {
  const receipt = {
    scheduledAt: '2026-09-15T23:00:00.000Z', deliveredAt: '2026-09-15T23:00:01.000Z',
    messageId: MessageId('scheduled-message'),
  }
  const stored: ScheduleTask = {
    ...recurring('manual-scheduled'),
    lastDelivery: receipt,
    deliveryHistory: { records: [{ ...receipt, prompt: 'Archive the feed' }], earlierRecordsUnavailable: false },
  }
  const test = await setup(stored)

  const [entry] = await test.service.catalog()
  expect(entry?.lastDelivery).toEqual(receipt)
  expect(entry?.lastDelivery).not.toHaveProperty('manual')
})

it('accepts a cancellation signal that has not been aborted', async () => {
  const stored = recurring('manual-signal')
  const test = await setup(stored)

  await expect(test.service.run({ sessionId: owner, id: stored.record.id }, new AbortController().signal))
    .resolves.toMatchObject({ ran: true })
})

it('reports a task another binding owns without delivering', async () => {
  const stored = recurring('manual-foreign')
  const test = await setup(stored)

  await expect(test.service.run({ sessionId: SessionId('other'), id: stored.record.id }))
    .resolves.toEqual({ id: stored.record.id, ran: false, code: 'schedule_not_found' })
  await expect(test.service.run({ sessionId: owner, id: ScheduleId('absent') }))
    .resolves.toEqual({ id: ScheduleId('absent'), ran: false, code: 'schedule_not_found' })

  expect(test.resolve).not.toHaveBeenCalled()
  expect(table(test).get(stored.record.id)).toEqual(stored)
})

it('reports an ended task without delivering', async () => {
  const stored: ScheduleTask = { ...recurring('manual-ended'), status: 'inactive' }
  const test = await setup(stored)
  const put = vi.spyOn(table(test), 'put')

  await expect(test.service.run({ sessionId: owner, id: stored.record.id }))
    .resolves.toEqual({ id: stored.record.id, ran: false, code: 'schedule_ended' })

  expect(put).not.toHaveBeenCalled()
  expect(test.resolve).not.toHaveBeenCalled()
})

it('reports an original Session that cannot be resolved and saves nothing', async () => {
  const stored = recurring('manual-gone')
  const test = await setup(stored)
  test.resolve.mockResolvedValueOnce({
    error: new RemoteError('session/not-found', 'Session unavailable', { sessionId: owner }),
  })
  const put = vi.spyOn(table(test), 'put')

  await expect(test.service.run({ sessionId: owner, id: stored.record.id }))
    .resolves.toEqual({ id: stored.record.id, ran: false, code: 'session_unavailable' })

  expect(put).not.toHaveBeenCalled()
  expect(test.agent.followup).not.toHaveBeenCalled()
})

it('refuses a Session a delegated child owns', async () => {
  const stored = recurring('manual-child')
  const test = await setup(stored, { delegationDepth: 1 })
  await test.ctx.agents.register(test.agent)

  await expect(test.service.run({ sessionId: owner, id: stored.record.id })).resolves.toEqual({
    code: 'subagent_session',
    message: 'This Session belongs to subagent routing, which never receives reminder delivery.',
  })

  expect(test.resolve).not.toHaveBeenCalled()
  expect(table(test).get(stored.record.id)).toEqual(stored)
})

it('reports a delivery the Session persistence did not acknowledge and saves no receipt', async () => {
  const stored = recurring('manual-unflushed')
  const test = await setup(stored)
  vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)

  await expect(test.service.run({ sessionId: owner, id: stored.record.id }))
    .rejects.toThrow('Session persistence did not acknowledge the reminder')

  // The inbox splice happened, so the row must not claim a saved delivery.
  expect(table(test).get(stored.record.id)).toEqual(stored)
})
