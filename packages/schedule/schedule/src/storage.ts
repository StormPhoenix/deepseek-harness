/** Durable Host-wide Schedule tasks, independently of Session activation. */
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { decodeScheduleRecord } from './domain.ts'
import type { ScheduleId, ScheduleRecord } from './types.ts'

const recordSchema = z.unknown().transform((value, context): ScheduleRecord => {
  try {
    return decodeScheduleRecord(value)
  } catch (error: unknown) {
    context.addIssue({ code: 'custom', message: String(error) })
  }
  return z.NEVER
})

const instantSchema = z.iso.datetime({ precision: 3 }).refine(value => !value.startsWith('0000-'), {
  message: 'Expected a canonical four-digit-year UTC calendar instant',
})

const deliveryReceiptSchema = z.object({
  scheduledAt: instantSchema,
  deliveredAt: instantSchema,
  messageId: z.string().min(1).refine(value => value.trim() === value).transform(MessageId),
  // Absent means rule-driven delivery, so records written before manual runs
  // existed stay valid without a migration; the domain version therefore stays 1.
  manual: z.literal(true).optional(),
}).strict()

const deliveryHistorySchema = z.object({
  records: z.array(deliveryReceiptSchema.extend({ prompt: z.string().optional() }).strict()),
  earlierRecordsUnavailable: z.boolean(),
  earlierRecordsPruned: z.boolean().optional(),
}).strict().refine(history => new Set(history.records.map(record => record.messageId)).size === history.records.length, {
  message: 'Delivery history message identities must be unique within a task',
})

/**
 * Script action stored on a task row. The specification stays opaque JSON here:
 * the provider registered for `kind` owns its shape and re-validates it at run time.
 */
const actionSchema = z.object({
  kind: z.string().min(1),
  spec: z.json(),
  timeoutMs: z.number().int().positive().optional(),
}).strict()

const sandboxModeSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access'])

const runRecordSchema = z.object({
  runId: z.string().min(1),
  scheduledAt: instantSchema,
  startedAt: instantSchema,
  finishedAt: instantSchema,
  manual: z.literal(true).optional(),
  outcome: z.enum(['succeeded', 'failed', 'timeout', 'aborted', 'sandbox-denied', 'skipped', 'interrupted', 'unavailable']),
  exitCode: z.number().int().nullable().optional(),
  output: z.string(),
  outputTruncated: z.boolean(),
  messageId: z.string().min(1).transform(MessageId).optional(),
}).strict()

const runHistorySchema = z.object({
  records: z.array(runRecordSchema),
  earlierRecordsPruned: z.boolean(),
}).strict().refine(history => new Set(history.records.map(record => record.runId)).size === history.records.length, {
  message: 'Run history identities must be unique within a task',
})

/**
 * Stored task binds one schedule to its original Session; absent status decodes as active.
 *
 * Script-task members are all optional, so rows written before script actions
 * existed stay valid without a migration and the domain version stays 1. A
 * script task carries `action`, `report`, and `binding` together.
 */
export const scheduleTaskSchema = z.object({
  sessionId: z.string().min(1).transform(SessionId),
  record: recordSchema,
  status: z.enum(['active', 'inactive']).default('active'),
  lastDelivery: deliveryReceiptSchema.optional(),
  deliveryHistory: deliveryHistorySchema.optional(),
  action: actionSchema.optional(),
  report: z.enum(['always', 'on-failure', 'never']).optional(),
  binding: z.object({ cwd: z.string().min(1), sandboxCeiling: sandboxModeSchema }).strict().optional(),
  /** Run started but not yet recorded; a row that still carries it at startup was interrupted. */
  inFlight: z.object({
    runId: z.string().min(1),
    scheduledAt: instantSchema,
    startedAt: instantSchema,
    manual: z.literal(true).optional(),
  }).strict().optional(),
  runHistory: runHistorySchema.optional(),
}).strict().refine((task) => {
  if (task.deliveryHistory === undefined) return true
  const latest = task.deliveryHistory.records.at(-1)
  if (latest === undefined) return task.lastDelivery === undefined
  return task.lastDelivery !== undefined
    && latest.scheduledAt === task.lastDelivery.scheduledAt
    && latest.deliveredAt === task.lastDelivery.deliveredAt
    && latest.messageId === task.lastDelivery.messageId
    && latest.manual === task.lastDelivery.manual
}, { message: 'Last delivery must match the latest saved delivery receipt' })
  .refine(task => (task.action === undefined) === (task.binding === undefined)
    && (task.action === undefined) === (task.report === undefined), {
    message: 'A script task stores its action, report policy, and binding together',
  })
  .refine(task => task.action !== undefined || (task.inFlight === undefined && task.runHistory === undefined), {
    message: 'Only a script task stores runs',
  })

/** Persistent task value; absent history retains only its legacy last receipt without a read-time rewrite. */
export type ScheduleTask = z.infer<typeof scheduleTaskSchema>

/** Persistent script run record. */
export type StoredRunRecord = z.infer<typeof runRecordSchema>

/** Script task row whose action members are present together. */
export type ScriptScheduleTask = ScheduleTask & {
  readonly action: NonNullable<ScheduleTask['action']>
  readonly report: NonNullable<ScheduleTask['report']>
  readonly binding: NonNullable<ScheduleTask['binding']>
}

/**
 * Narrow a stored task to a script task.
 * @param task - Decoded task row.
 * @returns Whether the row runs a script action.
 */
export function isScriptTask(task: ScheduleTask): task is ScriptScheduleTask {
  return task.action !== undefined && task.report !== undefined && task.binding !== undefined
}

/** Authoritative Schedule storage; malformed tasks reject opening the domain. */
export const scheduleDomain = defineDomain({
  name: 'schedule', version: 1,
  tables: { tasks: domainTable<ScheduleId, ScheduleTask>(scheduleTaskSchema) },
})
