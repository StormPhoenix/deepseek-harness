/** Main-window pin state; fullscreen temporarily suspends the native window level. */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { assertDesktopSender, DESKTOP_IPC, type DesktopPinState } from './ipc.ts'

const controllers = new WeakMap<BrowserWindow, DesktopWindowPin>()

export class DesktopWindowPin {
  private suspended: boolean | undefined
  private revision = 0

  constructor(private readonly window: BrowserWindow) {
    controllers.set(window, this)
    window.on('enter-full-screen', this.enterFullscreen)
    window.on('leave-full-screen', this.leaveFullscreen)
    window.on('always-on-top-changed', this.publish)
    window.webContents.on('did-finish-load', this.publish)
    window.once('closed', this.dispose)
  }

  state(): DesktopPinState {
    return { pinned: this.window.isAlwaysOnTop(), fullscreen: this.window.isFullScreen(), revision: this.revision }
  }

  /** Reject fullscreen edits; return the native result rather than an optimistic choice. */
  set(pinned: boolean): DesktopPinState {
    if (this.window.isFullScreen() || this.suspended !== undefined) throw new Error('dsh desktop: cannot pin a fullscreen window')
    this.window.setAlwaysOnTop(pinned)
    this.publish()
    return this.state()
  }

  private readonly publish = (): void => {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return
    this.revision++
    this.window.webContents.send(DESKTOP_IPC.windowPinChanged, this.state())
  }

  private readonly enterFullscreen = (): void => {
    if (this.window.isDestroyed() || this.suspended !== undefined) return
    this.suspended = this.window.isAlwaysOnTop()
    try { if (this.suspended) this.window.setAlwaysOnTop(false) }
    catch (error) { console.error('Desktop fullscreen pin suspension failed', error) }
    this.publish()
  }

  private readonly leaveFullscreen = (): void => {
    if (this.window.isDestroyed()) return
    const restore = this.suspended
    this.suspended = undefined
    try { if (restore === true) this.window.setAlwaysOnTop(true) }
    catch (error) { console.error('Desktop fullscreen pin restoration failed', error) }
    this.publish()
  }

  private readonly dispose = (): void => {
    controllers.delete(this.window)
    this.window.off('enter-full-screen', this.enterFullscreen)
    this.window.off('leave-full-screen', this.leaveFullscreen)
    this.window.off('always-on-top-changed', this.publish)
    this.window.webContents.off('did-finish-load', this.publish)
  }
}

/** Install private application-lifetime IPC; only the current main document can change its window. */
export function installDesktopWindowPin(getWindow: () => BrowserWindow | undefined): void {
  const owner = (event: IpcMainInvokeEvent): DesktopWindowPin => {
    const window = getWindow()
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('dsh desktop: rejected window pin from an unowned renderer')
    }
    assertDesktopSender(event, ['app'])
    const controller = controllers.get(window)
    if (controller === undefined) throw new Error('dsh desktop: window pin is unavailable on this platform')
    return controller
  }
  ipcMain.handle(DESKTOP_IPC.windowPinGet, event => owner(event).state())
  ipcMain.handle(DESKTOP_IPC.windowPinSet, (event, pinned: unknown) => {
    const controller = owner(event)
    if (typeof pinned !== 'boolean') throw new Error('dsh desktop: invalid window pin choice')
    return controller.set(pinned)
  })
}
