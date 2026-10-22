/** Lazy script-run pages owned by the selected task's records view. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScheduleRunHistoryRequest, ScheduleRunHistoryResult } from '@deepseek-ai/dsh-schedule/client'
import { formatScheduleNextRun } from './schedule-format.ts'
import css from './TaskManagerPage.module.css'

/** Read script runs without opening the original Session. */
export interface RunHistoryInjected {
  /**
   * Read a newest-first run page for the exact task and Session.
   * @param request - Task binding, page size, and optional exclusive cursor.
   * @returns Remote success or failure; transport exceptions may reject.
   */
  readonly loadRuns: (request: ScheduleRunHistoryRequest) => Promise<RemoteResult<ScheduleRunHistoryResult>>
}

type Page = Extract<ScheduleRunHistoryResult, { records: unknown }>
type Props = RunHistoryInjected & PropsLocale<'schedule.manager'> & {
  id: ScheduleRunHistoryRequest['id']
  sessionId: ScheduleRunHistoryRequest['sessionId']
  latestRunId?: string | undefined
}

/**
 * Render execution outcomes and captured output, separately from reminder deliveries.
 * @param props - Task binding, latest run identity, remote query, and locale.
 * @returns Saved runs with loading, failure, and older-page controls.
 */
export function RunHistory({ id, sessionId, latestRunId, loadRuns, t }: Props) {
  const [page, setPage] = useState<Page>()
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<'runs.error' | 'runs.notFound' | 'runs.cursorError'>()
  const request = useRef({ epoch: 0, pending: false })
  const load = useCallback(async (before?: string): Promise<void> => {
    if (request.current.pending) return
    const epoch = ++request.current.epoch
    request.current.pending = true
    setLoading(true)
    setFailure(undefined)
    try {
      const result = await loadRuns({ id, sessionId, limit: 20, ...(before === undefined ? {} : { before }) })
      if (epoch !== request.current.epoch) return
      if (!result.ok) setFailure('runs.error')
      else if ('code' in result.value) setFailure(result.value.code === 'schedule_not_found' ? 'runs.notFound' : 'runs.cursorError')
      else {
        const next = result.value
        setPage(previous => before === undefined || previous === undefined ? next : {
          ...next,
          records: [...previous.records, ...next.records.filter(run => !previous.records.some(saved => saved.runId === run.runId))],
        })
      }
    } catch (_error: unknown) {
      // Transport failure retains previously loaded rows and offers a fresh read.
      if (epoch === request.current.epoch) setFailure('runs.error')
    } finally {
      if (epoch === request.current.epoch) {
        request.current.pending = false
        setLoading(false)
      }
    }
  }, [id, sessionId, loadRuns])

  useEffect(() => {
    void load()
    return () => { request.current.epoch++; request.current.pending = false }
  }, [load, latestRunId])

  return <div className={css.deliveryHistory} aria-busy={loading}>
    <div className={css.detailScroll}>
      {loading && page === undefined && <div className={css.empty} role="status" aria-label={t('runs.loading')}>
        <StateDot state="ongoing" />
      </div>}
      {failure !== undefined && <div className={css.notice}>
        <p role="alert">{t(failure)}</p>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => { void load() }}>{t('runs.retry')}</Button>
      </div>}
      {!loading && failure === undefined && page?.records.length === 0 && <p className={css.empty} role="status">{t('runs.empty')}</p>}
      {page !== undefined && <>
        <ol className={css.scriptRuns} aria-label={t('runs.label')}>
          {page.records.map(run => <li key={run.runId} className={css.scriptRun}>
            <div className={css.scriptRunHeader}>
              <time dateTime={run.startedAt}>{formatScheduleNextRun(run.startedAt, t('time.locale'))}</time>
              <strong>{t(`runs.outcome.${run.outcome}`)}</strong>
            </div>
            <p className={css.metadata}>
              {run.manual === true && <span>{t('delivery.manual')}{' · '}</span>}
              {t('runs.duration', { milliseconds: Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) })}
              {run.exitCode !== undefined && <span>{' · '}{t('runs.exitCode', { code: String(run.exitCode) })}</span>}
            </p>
            {run.messageId !== undefined && <p className={css.metadata}>{t('runs.reported')}</p>}
            {run.outputTruncated && <p role="note" className={css.metadata}>{t('runs.truncated')}</p>}
            {run.output.length > 0 && <details><summary>{t('runs.output')}</summary><pre className={css.scriptSource}>{run.output}</pre></details>}
          </li>)}
        </ol>
        {page.earlierRecordsPruned && <p className={css.metadata}>{t('runs.pruned')}</p>}
        {page.nextBefore !== undefined && <Button variant="outline" size="sm" disabled={loading}
          onClick={() => { void load(page.nextBefore) }}>{t('runs.older')}</Button>}
      </>}
    </div>
  </div>
}
