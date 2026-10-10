/** Desktop-owned titlebar control, outside sidebar and product component lifetimes. */
import { ipcRenderer } from 'electron'
import { DESKTOP_IPC, type DesktopPinState } from './ipc.ts'
import { resolveDesktopLocale } from './locale.ts'

/** Mount after AppFrame exists; dispose listeners and pending replies with the document. */
export function installDesktopPin(platform: 'win32' | 'darwin'): { dispose(): void } {
  let disposed = false
  let pending = false
  let failed = false
  let state: DesktopPinState | undefined
  const host = document.createElement('div')
  host.dataset.desktopPin = ''
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    :host { position: fixed; z-index: 1100; top: ${platform === 'darwin' ? '11px' : 'calc((env(titlebar-area-height, 40px) - 28px) / 2)'};
      ${platform === 'darwin' ? 'right: 12px;' : 'left: calc(env(titlebar-area-x, 0px) + env(titlebar-area-width, 0px) - 36px);'}
      -webkit-app-region: no-drag; font-family: var(--dsw-font-family); }
    :host([hidden]) { display: none; }
    button { box-sizing: border-box; width: 28px; height: 28px; padding: 6px; border: 0; border-radius: 6px;
      display: flex; background: transparent; color: var(--dsw-alias-label-secondary); cursor: default; }
    button:hover, button[aria-pressed=true] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
    button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
    [role=status] { position: absolute; right: 0; top: 36px; min-width: 180px; padding: 8px;
      border-radius: 6px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
    [role=status]:empty { display: none; }
  `
  const button = document.createElement('button')
  button.type = 'button'
  button.disabled = true
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const [key, value] of Object.entries({ width: '16', height: '16', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', 'stroke-width': '1' })) svg.setAttribute(key, value)
  // Reuses IconPinOutlineRegular/IconPinFillRegular artwork without loading React into a sandbox preload.
  const head = document.createElementNS(svg.namespaceURI, 'path')
  head.setAttribute('d', 'M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z')
  head.setAttribute('stroke', 'currentColor')
  head.setAttribute('stroke-linejoin', 'round')
  const stem = document.createElementNS(svg.namespaceURI, 'path')
  stem.setAttribute('d', 'M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z')
  stem.setAttribute('fill', 'currentColor')
  svg.append(head, stem)
  button.append(svg)
  const status = document.createElement('span')
  status.setAttribute('role', 'status')
  shadow.append(style, button, status)
  const clearanceStyle = document.createElement('style')
  clearanceStyle.textContent = '[data-desktop-pin-clearance] { padding-right: calc(var(--dsh-pin-row-padding) + 44px) !important; }'
  const rows = new Set<HTMLElement>()
  const resize = new ResizeObserver(() => { layout() })
  const layout = (): void => {
    if (disposed || platform !== 'darwin' || !host.isConnected) return
    const pin = host.getBoundingClientRect()
    for (const row of rows) {
      row.removeAttribute('data-desktop-pin-clearance')
      row.style.removeProperty('--dsh-pin-row-padding')
      if (!row.isConnected) { resize.unobserve(row); rows.delete(row) }
    }
    for (const row of document.querySelectorAll<HTMLElement>('[data-window-drag], [data-dockkit-strip]')) {
      if (!rows.has(row)) { rows.add(row); resize.observe(row) }
      if (host.hidden) continue
      const box = row.getBoundingClientRect()
      if (box.top < pin.bottom && box.bottom > pin.top && box.right > pin.left && box.left < pin.right) {
        row.style.setProperty('--dsh-pin-row-padding', getComputedStyle(row).paddingRight)
        row.dataset.desktopPinClearance = ''
      }
    }
  }
  const render = (): void => {
    if (disposed) return
    const { messages } = resolveDesktopLocale(document.documentElement.lang)
    const label = state?.pinned === true ? messages.windowUnpin : messages.windowPin
    button.setAttribute('aria-label', label)
    button.title = label
    button.setAttribute('aria-pressed', String(state?.pinned === true))
    button.disabled = pending || state === undefined || state.fullscreen
    head.setAttribute('fill', state?.pinned === true ? 'currentColor' : 'none')
    const hidden = state === undefined || state.fullscreen || document.querySelector('[data-shell-overlay]') === null
    if (host.hidden !== hidden) host.hidden = hidden
    const feedback = failed ? messages.windowPinFailed : ''
    if (status.textContent !== feedback) status.textContent = feedback
    layout()
  }
  const accept = (next: DesktopPinState): void => {
    if (disposed || (state !== undefined && next.revision < state.revision)) return
    state = next
    render()
  }
  const receive = (_event: Electron.IpcRendererEvent, next: DesktopPinState): void => { accept(next) }
  ipcRenderer.on(DESKTOP_IPC.windowPinChanged, receive)
  button.addEventListener('pointerdown', (event) => { event.preventDefault() })
  button.addEventListener('mousedown', (event) => { event.preventDefault() })
  button.addEventListener('click', (event) => {
    if (!event.isTrusted) return
    if (pending || state === undefined || state.fullscreen || disposed) return
    pending = true
    failed = false
    render()
    void (ipcRenderer.invoke(DESKTOP_IPC.windowPinSet, !state.pinned) as Promise<DesktopPinState>).then(accept, (error: unknown) => {
      if (disposed) return
      failed = true
      console.error('Desktop window pin failed', error)
      return (ipcRenderer.invoke(DESKTOP_IPC.windowPinGet) as Promise<DesktopPinState>).then(accept, (refreshError: unknown) => {
        if (!disposed) console.error('Desktop window pin refresh failed', refreshError)
      })
    }).finally(() => { if (!disposed) { pending = false; render() } })
  })
  const mount = (): void => {
    if (disposed) return
    if (!host.isConnected && document.querySelector('[data-shell-overlay]') !== null) {
      document.body.append(host)
      document.head.append(clearanceStyle)
      void (ipcRenderer.invoke(DESKTOP_IPC.windowPinGet) as Promise<DesktopPinState>).then(accept, (error: unknown) => {
        if (!disposed) console.error('Desktop window pin state failed', error)
      })
    }
    render()
  }
  const observer = new MutationObserver(mount)
  observer.observe(document.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'hidden', 'data-window-drag', 'data-dockkit-strip', 'data-sidebar-right-open', 'data-sidebar-right-panel'],
  })
  const localeObserver = new MutationObserver(render)
  localeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  window.addEventListener('resize', layout)
  document.addEventListener('transitionend', layout, true)
  render()
  mount()
  return { dispose: () => {
    if (disposed) return
    disposed = true
    observer.disconnect()
    localeObserver.disconnect()
    resize.disconnect()
    ipcRenderer.off(DESKTOP_IPC.windowPinChanged, receive)
    window.removeEventListener('resize', layout)
    document.removeEventListener('transitionend', layout, true)
    for (const row of rows) {
      row.removeAttribute('data-desktop-pin-clearance')
      row.style.removeProperty('--dsh-pin-row-padding')
    }
    rows.clear()
    clearanceStyle.remove()
    host.remove()
  } }
}

/** Main-frame application documents only; no Web, Welcome, or auxiliary-window control. */
export function syncDesktopPin(): void {
  if (!process.isMainFrame || (process.platform !== 'win32' && process.platform !== 'darwin')) return
  const platform = process.platform
  let control: ReturnType<typeof installDesktopPin> | undefined
  const load = (): void => { control = installDesktopPin(platform) }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', load, { once: true })
  else load()
  window.addEventListener('pagehide', () => {
    window.removeEventListener('DOMContentLoaded', load)
    control?.dispose()
  }, { once: true })
}
