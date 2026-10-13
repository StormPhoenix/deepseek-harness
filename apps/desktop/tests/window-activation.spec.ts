import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { confirmDesktopWindowActivation, DESKTOP_WINDOW_ACTIVATION_BUDGET_MS } from '../src/window-activation.ts'

class Window extends EventEmitter {
  destroyed = false
  visible = false
  minimized = true
  focused = false
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  isMinimized() { return this.minimized }
  isFocused() { return this.focused }
}

const events = ['focus', 'show', 'restore', 'hide', 'minimize', 'closed']
afterEach(() => { vi.useRealTimers() })

it('observes before activation and waits for visible, restored, focused state', async () => {
  const window = new Window()
  const result = confirmDesktopWindowActivation(() => window, () => {
    for (const event of events) expect(window.listenerCount(event)).toBe(1)
    window.focused = true
    window.emit('focus')
  }, () => true)
  let complete = false
  void result.then(() => { complete = true })
  await Promise.resolve()
  expect(complete).toBe(false)
  window.visible = true
  window.emit('show')
  await Promise.resolve()
  expect(complete).toBe(false)
  window.minimized = false
  window.emit('restore')
  await result
  for (const event of events) expect(window.listenerCount(event)).toBe(0)
})

it.each([false, true])('cleans timeout listeners and distinguishes denied focus from timeout: visible %s', async (visible) => {
  vi.useFakeTimers()
  const window = new Window()
  window.visible = visible
  window.minimized = false
  const activate = vi.fn()
  const result = confirmDesktopWindowActivation(() => window, activate, () => true)
  const rejected = expect(result).rejects.toMatchObject({ code: visible ? 'focus-denied' : 'activation-timeout' })
  await vi.advanceTimersByTimeAsync(DESKTOP_WINDOW_ACTIVATION_BUDGET_MS)
  await rejected
  expect(activate).toHaveBeenCalledOnce()
  for (const event of events) expect(window.listenerCount(event)).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  window.emit('focus')
  expect(activate).toHaveBeenCalledOnce()
})

it('uses one budget for preparation and focus without activating a late-created window', async () => {
  vi.useFakeTimers()
  let ready!: (window: Window) => void
  const preparation = new Promise<Window>((resolve) => { ready = resolve })
  const activate = vi.fn()
  const result = confirmDesktopWindowActivation(() => preparation, activate, () => true)
  const rejected = expect(result).rejects.toMatchObject({ code: 'activation-timeout' })
  await vi.advanceTimersByTimeAsync(DESKTOP_WINDOW_ACTIVATION_BUDGET_MS)
  await rejected
  const window = new Window()
  ready(window)
  await Promise.resolve()
  expect(activate).not.toHaveBeenCalled()
  for (const event of events) expect(window.listenerCount(event)).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not restart the budget after asynchronous preparation', async () => {
  vi.useFakeTimers()
  let ready!: (window: Window) => void
  const preparation = new Promise<Window>((resolve) => { ready = resolve })
  const window = new Window()
  const result = confirmDesktopWindowActivation(() => preparation, vi.fn(), () => true)
  const rejected = expect(result).rejects.toMatchObject({ code: 'activation-timeout' })
  await vi.advanceTimersByTimeAsync(900)
  ready(window)
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(100)
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})

it('cleans listeners immediately on close', async () => {
  vi.useFakeTimers()
  const window = new Window()
  const result = confirmDesktopWindowActivation(() => window, vi.fn(), () => true)
  const rejected = expect(result).rejects.toMatchObject({ code: 'unavailable' })
  window.destroyed = true
  window.emit('closed')
  await rejected
  for (const event of events) expect(window.listenerCount(event)).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('contains late preparation rejection after timeout', async () => {
  vi.useFakeTimers()
  let fail!: (error: Error) => void
  const result = confirmDesktopWindowActivation(() => new Promise<Window>((_resolve, reject) => { fail = reject }), vi.fn(), () => true)
  const rejected = expect(result).rejects.toMatchObject({ code: 'activation-timeout' })
  await vi.advanceTimersByTimeAsync(DESKTOP_WINDOW_ACTIVATION_BUDGET_MS)
  await rejected
  fail(new Error('load failed'))
  await Promise.resolve()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not report intermediate focused state as success when the activation attempt throws', async () => {
  const window = new Window()
  const result = confirmDesktopWindowActivation(() => window, () => {
    window.visible = true
    window.minimized = false
    window.focused = true
    window.emit('show')
    throw new Error('native focus failed')
  }, () => true)
  await expect(result).rejects.toMatchObject({ code: 'focus-denied', message: 'native focus failed' })
  for (const event of events) expect(window.listenerCount(event)).toBe(0)
})

it('does not activate preparation completed after the budget before timer dispatch', async () => {
  vi.useFakeTimers()
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  const window = new Window()
  const activate = vi.fn()
  const result = confirmDesktopWindowActivation(() => {
    clock.mockReturnValue(DESKTOP_WINDOW_ACTIVATION_BUDGET_MS)
    return window
  }, activate, () => true)
  try {
    await expect(result).rejects.toMatchObject({ code: 'activation-timeout' })
    expect(activate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally { clock.mockRestore() }
})

it('rejects changed lifecycle ownership instead of claiming focus success', async () => {
  const window = new Window()
  let available = true
  const result = confirmDesktopWindowActivation(() => window, () => {
    available = false
    window.visible = true
    window.minimized = false
    window.focused = true
    window.emit('focus')
  }, () => available)
  await expect(result).rejects.toMatchObject({ code: 'unavailable' })
  for (const event of events) expect(window.listenerCount(event)).toBe(0)
})
