/** Request-scoped native window activation with bounded state confirmation. */

/** Stable failure identity sent alongside the Desktop activation error message. */
export type DesktopWindowActivationErrorCode = 'unavailable' | 'focus-denied' | 'activation-timeout'

/** Activation failed; window visibility or foreground ownership is not guaranteed. */
export class DesktopWindowActivationError extends Error {
  /**
   * @param code - Machine-readable activation failure.
   * @param message - Diagnostic retained in the private IPC response.
   */
  constructor(readonly code: DesktopWindowActivationErrorCode, message: string) { super(message) }
}

/** Total request budget, including asynchronous window preparation. */
export const DESKTOP_WINDOW_ACTIVATION_BUDGET_MS = 1_000

/** Native state and events needed to confirm one selected window. */
export interface DesktopActivationWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  isFocused(): boolean
  on(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
}

/**
 * Prepare and activate one selected window; observe native state before any activation effects.
 * Late preparation is ignored, and every completion removes its timer and window listeners.
 * @param prepare - Resolve the selected window without showing or focusing it.
 * @param activate - Perform a single restore/show/focus attempt on the observed window.
 * @param available - Whether shell lifecycle and selection still permit this request.
 * @returns Confirmed visible, nonminimized, focused state; rejects with a stable failure code.
 */
export function confirmDesktopWindowActivation<W extends DesktopActivationWindow>(
  prepare: () => W | Promise<W>,
  activate: (window: W) => void,
  available: () => boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = performance.now() + DESKTOP_WINDOW_ACTIVATION_BUDGET_MS
    let settled = false
    let attempting = false
    let window: W | undefined
    const events = ['focus', 'show', 'restore', 'hide', 'minimize', 'closed']
    const finish = (error?: DesktopWindowActivationError): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (window !== undefined) for (const event of events) window.removeListener(event, check)
      if (error === undefined) resolve()
      else reject(error)
    }
    const unavailable = (): DesktopWindowActivationError => new DesktopWindowActivationError('unavailable', 'desktop window activation is unavailable')
    const expire = (): void => {
      if (!available() || window?.isDestroyed()) { finish(unavailable()); return }
      const focusDenied = window !== undefined && window.isVisible() && !window.isMinimized() && !window.isFocused()
      finish(new DesktopWindowActivationError(focusDenied ? 'focus-denied' : 'activation-timeout',
        focusDenied ? 'desktop window foreground focus was denied' : 'desktop window activation timed out'))
    }
    const check = (): void => {
      if (!available() || window?.isDestroyed()) { finish(unavailable()); return }
      if (performance.now() >= deadline) { expire(); return }
      if (!attempting && window?.isVisible() && !window.isMinimized() && window.isFocused()) finish()
    }
    const timer = setTimeout(expire, DESKTOP_WINDOW_ACTIVATION_BUDGET_MS)
    const observe = (selected: W): void => {
      if (settled) return
      if (performance.now() >= deadline) { expire(); return }
      window = selected
      if (!available() || window.isDestroyed()) { finish(unavailable()); return }
      for (const event of events) window.on(event, check)
      attempting = true
      try { activate(window) } catch (error) {
        finish(error instanceof DesktopWindowActivationError ? error
          : new DesktopWindowActivationError('focus-denied', error instanceof Error ? error.message : String(error)))
        return
      } finally { attempting = false }
      check()
    }
    try {
      const prepared = prepare()
      if (prepared instanceof Promise) void prepared.then(observe, (error: unknown) => {
        finish(error instanceof DesktopWindowActivationError ? error
          : new DesktopWindowActivationError('unavailable', error instanceof Error ? error.message : String(error)))
      })
      else observe(prepared)
    } catch (error) {
      finish(error instanceof DesktopWindowActivationError ? error
        : new DesktopWindowActivationError('unavailable', error instanceof Error ? error.message : String(error)))
    }
  })
}
