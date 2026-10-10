// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installDesktopPin, syncDesktopPin } from '../src/preload-pin.ts'
import { DESKTOP_IPC, type DesktopPinState } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), off: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: electron }))
let control: ReturnType<typeof installDesktopPin> | undefined
const initial: DesktopPinState = { pinned: false, fullscreen: false, revision: 0 }
const roots = new WeakMap<Element, ShadowRoot>()
let trustedClick: ((event: Pick<MouseEvent, 'isTrusted'>) => void) | undefined
const host = (): HTMLElement => document.querySelector<HTMLElement>('[data-desktop-pin]')!
const root = (): ShadowRoot => roots.get(host())!
const button = (): HTMLButtonElement => root().querySelector('button')!
// jsdom cannot create trusted input; exercise the captured native-input boundary explicitly.
const click = (): void => { trustedClick!({ isTrusted: true }) }
const publish = (state: DesktopPinState): void => {
  const listener = electron.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.windowPinChanged)?.[1] as
    (event: unknown, state: DesktopPinState) => void
  listener({}, state)
}
const ready = async (): Promise<void> => { await vi.waitFor(() => { expect(button().disabled).toBe(false) }) }

beforeEach(() => {
  trustedClick = undefined
  const attach = Element.prototype.attachShadow
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
    const shadow = attach.call(this, init)
    roots.set(this, shadow)
    return shadow
  })
  const listen = HTMLButtonElement.prototype.addEventListener
  vi.spyOn(HTMLButtonElement.prototype, 'addEventListener').mockImplementation(function (this: HTMLButtonElement, type, listener, options) {
    if (type === 'click' && typeof listener === 'function') trustedClick = (event) => {
      (listener as (event: Pick<Event, 'isTrusted'>) => void).call(this, event)
    }
    listen.call(this, type, listener, options)
  })
  document.body.innerHTML = '<div data-shell-overlay></div>'
  document.documentElement.lang = 'en'
  electron.invoke.mockReset()
  electron.invoke.mockResolvedValue(initial)
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
})
afterEach(() => {
  control?.dispose()
  control = undefined
  document.body.replaceChildren()
  document.documentElement.lang = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it.each(['win32', 'darwin'] as const)('keeps a localized, accessible titlebar toggle outside sidebar on %s', async (platform) => {
  control = installDesktopPin(platform)
  await ready()
  expect(host().parentElement).toBe(document.body)
  expect(host().shadowRoot).toBeNull()
  const beforeSynthetic = electron.invoke.mock.calls.length
  button().click()
  expect(electron.invoke).toHaveBeenCalledTimes(beforeSynthetic)
  expect(button().getAttribute('aria-label')).toBe('Keep window on top')
  expect(button().getAttribute('aria-pressed')).toBe('false')
  const css = root().querySelector('style')!.textContent!
  expect(css).toContain(platform === 'win32' ? 'env(titlebar-area-width' : 'right: 12px')
  // Shadow roots do not inherit the application's universal box-sizing rule.
  expect(css).toContain('button { box-sizing: border-box; width: 28px; height: 28px;')
  const sidebar = document.createElement('aside')
  document.body.append(sidebar)
  sidebar.hidden = true
  sidebar.remove()
  expect(host().isConnected).toBe(true)
  expect(host().hidden).toBe(false)
  const pointer = new MouseEvent('pointerdown', { cancelable: true })
  button().dispatchEvent(pointer)
  expect(pointer.defaultPrevented).toBe(true)
  electron.invoke.mockResolvedValueOnce({ ...initial, pinned: true, revision: 1 })
  click()
  expect(button().disabled).toBe(true)
  expect(button().getAttribute('aria-pressed')).toBe('false')
  await ready()
  expect(electron.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.windowPinSet, true)
  expect(button().getAttribute('aria-pressed')).toBe('true')
  expect(button().getAttribute('aria-label')).toBe('Stop keeping window on top')
  document.documentElement.lang = 'zh-CN'
  await vi.waitFor(() => { expect(button().title).toBe('取消窗口置顶') })
  publish({ ...initial, revision: 2 })
  expect(button().title).toBe('保持窗口置顶')
})

it('hides when returning to Welcome and reappears with the workspace', async () => {
  control = installDesktopPin('win32')
  await ready()
  document.querySelector('[data-shell-overlay]')!.remove()
  await vi.waitFor(() => { expect(host().hidden).toBe(true) })
  const seat = document.createElement('div')
  seat.dataset.shellOverlay = ''
  document.body.append(seat)
  await vi.waitFor(() => { expect(host().hidden).toBe(false) })
})

it('hides in fullscreen, rejects stale initial replies and resumes authoritative state', async () => {
  let resolve!: (state: DesktopPinState) => void
  electron.invoke.mockImplementationOnce(() => new Promise<DesktopPinState>((done) => { resolve = done }))
  control = installDesktopPin('win32')
  publish({ pinned: true, fullscreen: false, revision: 4 })
  resolve(initial)
  await ready()
  expect(button().getAttribute('aria-pressed')).toBe('true')
  publish({ pinned: false, fullscreen: true, revision: 5 })
  expect(host().hidden).toBe(true)
  expect(button().disabled).toBe(true)
  const calls = electron.invoke.mock.calls.length
  click()
  expect(electron.invoke).toHaveBeenCalledTimes(calls)
  publish({ pinned: true, fullscreen: false, revision: 6 })
  expect(host().hidden).toBe(false)
  expect(button().disabled).toBe(false)
})

it('reports native rejection without displaying optimistic state and allows retry', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  control = installDesktopPin('win32')
  await ready()
  electron.invoke.mockRejectedValueOnce(new Error('native rejected')).mockResolvedValueOnce({ ...initial, revision: 1 })
  click()
  await ready()
  expect(log).toHaveBeenCalled()
  expect(button().getAttribute('aria-pressed')).toBe('false')
  expect(root().querySelector('[role=status]')!.textContent).toBe('Could not change window pin. Try again.')
  electron.invoke.mockResolvedValueOnce({ ...initial, pinned: true, revision: 2 })
  click()
  await ready()
  expect(button().getAttribute('aria-pressed')).toBe('true')
  expect(root().querySelector('[role=status]')!.textContent).toBe('')
})

it('does not rewrite unchanged failure feedback after unrelated DOM mutations', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  control = installDesktopPin('win32')
  await ready()
  electron.invoke.mockRejectedValueOnce(new Error('native rejected')).mockResolvedValueOnce(initial)
  click()
  await ready()
  const status = root().querySelector('[role=status]')!
  expect(status.textContent).toBe('Could not change window pin. Try again.')
  const mutations = vi.fn()
  const observer = new MutationObserver(mutations)
  observer.observe(status, { childList: true })
  try {
    document.body.append(document.createElement('aside'))
    await Promise.resolve()
    await Promise.resolve()
    expect(mutations).not.toHaveBeenCalled()
  } finally { observer.disconnect() }
})

it('waits for authoritative refresh before allowing a failed toggle to retry', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  control = installDesktopPin('win32')
  await ready()
  let refresh!: (state: DesktopPinState) => void
  electron.invoke.mockRejectedValueOnce(new Error('native rejected'))
    .mockImplementationOnce(() => new Promise<DesktopPinState>((resolve) => { refresh = resolve }))
  click()
  await vi.waitFor(() => { expect(refresh).toBeTypeOf('function') })
  expect(button().disabled).toBe(true)
  const calls = electron.invoke.mock.calls.length
  click()
  expect(electron.invoke).toHaveBeenCalledTimes(calls)
  refresh({ ...initial, pinned: true, revision: 1 })
  await ready()
  expect(button().getAttribute('aria-pressed')).toBe('true')
  electron.invoke.mockResolvedValueOnce({ ...initial, revision: 2 })
  click()
  await ready()
  expect(electron.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.windowPinSet, false)
})

it('waits for AppFrame and releases listeners and late replies on disposal', async () => {
  document.body.replaceChildren()
  control = installDesktopPin('win32')
  expect(document.querySelector('[data-desktop-pin]')).toBeNull()
  expect(electron.invoke).not.toHaveBeenCalled()
  let resolve!: (state: DesktopPinState) => void
  electron.invoke.mockImplementationOnce(() => new Promise<DesktopPinState>((done) => { resolve = done }))
  document.body.innerHTML = '<div data-shell-overlay></div>'
  await vi.waitFor(() => { expect(document.querySelector('[data-desktop-pin]')).not.toBeNull() })
  const detached = button()
  control.dispose()
  control.dispose()
  expect(electron.off).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.windowPinChanged, expect.any(Function))
  control = undefined
  resolve({ ...initial, pinned: true, revision: 1 })
  await new Promise<void>((done) => { queueMicrotask(done) })
  expect(detached.getAttribute('aria-pressed')).toBe('false')
  expect(electron.off).toHaveBeenCalledWith(DESKTOP_IPC.windowPinChanged, expect.any(Function))
  expect(document.querySelector('[data-desktop-pin]')).toBeNull()
})

it.each(['windowDrag', 'dockkitStrip'] as const)('reserves an overlapping macOS %s row and releases it in fullscreen', async (marker) => {
  const row = document.createElement('div')
  row.dataset[marker] = ''
  row.style.paddingRight = '20px'
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 48))
  document.body.append(row)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-desktop-pin') ? new DOMRect(960, 11, 28, 28) : new DOMRect()
  })
  control = installDesktopPin('darwin')
  await ready()
  expect(row.hasAttribute('data-desktop-pin-clearance')).toBe(true)
  expect(row.style.getPropertyValue('--dsh-pin-row-padding')).toBe('20px')
  publish({ pinned: false, fullscreen: true, revision: 1 })
  expect(row.hasAttribute('data-desktop-pin-clearance')).toBe(false)
  publish({ ...initial, revision: 2 })
  expect(row.hasAttribute('data-desktop-pin-clearance')).toBe(true)
  control.dispose()
  control = undefined
  expect(row.hasAttribute('data-desktop-pin-clearance')).toBe(false)
  expect(row.style.getPropertyValue('--dsh-pin-row-padding')).toBe('')
})

it.each(['win32', 'darwin'] as const)('installs the native main-frame control and disposes it on pagehide on %s', async (platform) => {
  vi.stubGlobal('process', { ...process, platform, isMainFrame: true })
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  syncDesktopPin()
  try {
    await ready()
    expect(host().isConnected).toBe(true)
  } finally { window.dispatchEvent(new Event('pagehide')) }
  expect(document.querySelector('[data-desktop-pin]')).toBeNull()
  expect(electron.off).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.windowPinChanged, expect.any(Function))
})

it('cancels deferred native installation when the document unloads before DOMContentLoaded', () => {
  vi.stubGlobal('process', { ...process, platform: 'win32', isMainFrame: true })
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading')
  syncDesktopPin()
  window.dispatchEvent(new Event('pagehide'))
  window.dispatchEvent(new Event('DOMContentLoaded'))
  expect(document.querySelector('[data-desktop-pin]')).toBeNull()
  expect(electron.on).not.toHaveBeenCalled()
  expect(electron.invoke).not.toHaveBeenCalled()
})

it.each([{ platform: 'linux', isMainFrame: true }, { platform: 'win32', isMainFrame: false }])(
  'does not install for unsupported carriers: %j', (processFields) => {
    vi.stubGlobal('process', { ...process, ...processFields })
    syncDesktopPin()
    expect(electron.on).not.toHaveBeenCalled()
    expect(document.querySelector('[data-desktop-pin]')).toBeNull()
  },
)
