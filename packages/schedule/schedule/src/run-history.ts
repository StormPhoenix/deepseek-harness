/** Saved script-run retention and identity-based pagination without Session reads. */
import type { ScheduleTask, StoredRunRecord } from './storage.ts'
import type {
  DeliveryRetentionBounds, ScheduleRunHistoryRequest, ScheduleRunHistoryResult, ScheduleRunRecord,
} from './types.ts'

/** Milliseconds in one day, the unit the retention window is stated in. */
const DAY_MS = 86_400_000

/**
 * Project one stored run onto the browser-safe shape, omitting absent markers.
 * @param run - Run read from a stored task row.
 * @returns The run with optional members present only when stored.
 */
export function publicRun(run: StoredRunRecord): ScheduleRunRecord {
  return {
    runId: run.runId,
    scheduledAt: run.scheduledAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    outcome: run.outcome,
    output: run.output,
    outputTruncated: run.outputTruncated,
    ...(run.manual === undefined ? {} : { manual: true }),
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    ...(run.messageId === undefined ? {} : { messageId: run.messageId }),
  }
}

/**
 * Append one run and prune with the delivery-history bounds, on the only write path.
 * @param task - Task supplying retained runs.
 * @param run - Terminal run to save.
 * @param bounds - Configured retention window and record cap.
 * @returns Replacement run history for the same task write.
 */
export function appendRun(
  task: ScheduleTask, run: StoredRunRecord, bounds: DeliveryRetentionBounds,
): NonNullable<ScheduleTask['runHistory']> {
  const history = task.runHistory ?? { records: [], earlierRecordsPruned: false }
  const appended = [...history.records, run]
  const floor = Date.parse(run.finishedAt) - bounds.days * DAY_MS
  const retained = appended.filter(record => Date.parse(record.finishedAt) >= floor).slice(-bounds.records)
  return { records: retained, earlierRecordsPruned: history.earlierRecordsPruned || retained.length !== appended.length }
}

/**
 * Read one newest-first page in append order.
 * @param task - Task already checked against the requested Session binding.
 * @param request - Validated page size and optional exclusive run cursor.
 * @param retention - Current configured limits shared with the writer.
 * @returns Copied runs or a cursor-not-found result.
 */
export function runHistoryPage(
  task: ScheduleTask, request: ScheduleRunHistoryRequest, retention: DeliveryRetentionBounds,
): ScheduleRunHistoryResult {
  const records = task.runHistory?.records ?? []
  const end = request.before === undefined ? records.length : records.findIndex(record => record.runId === request.before)
  if (end === -1) return { id: request.id, code: 'run_cursor_not_found' }
  const start = Math.max(0, end - request.limit)
  const page = records.slice(start, end).reverse().map(publicRun)
  const oldest = page.at(-1)
  return {
    id: request.id, records: page, earlierRecordsPruned: task.runHistory?.earlierRecordsPruned === true,
    retention: { ...retention },
    ...(oldest !== undefined && start > 0 ? { nextBefore: oldest.runId } : {}),
  }
}
