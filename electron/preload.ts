import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ipc', {
  invoke: (channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args),
  send: (channel: string, ...args: unknown[]) =>
    ipcRenderer.send(channel, ...args),

  // Returns a dispose function. contextBridge gives us a fresh proxy for `cb` on
  // each cross-boundary call, so matching by reference (WeakMap key) is unreliable
  // and listeners leak. Closing over the wrapper here avoids the lookup entirely.
  on: (channel: string, cb: (...args: unknown[]) => void): (() => void) => {
    const wrapper = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...args)
    ipcRenderer.on(channel, wrapper)
    return () => ipcRenderer.removeListener(channel, wrapper)
  }
})
