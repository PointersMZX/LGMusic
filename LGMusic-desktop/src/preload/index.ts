import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  send: (channel: string, data: unknown): void => {
    ipcRenderer.send(channel, data)
  },
  invoke: (channel: string, data?: unknown): Promise<unknown> => ipcRenderer.invoke(channel, data),
  on: (channel: string, listener: (...args: unknown[]) => void): void => {
    const sub = (_event: unknown, ...args: unknown[]): void => listener(...args)
    ipcRenderer.on(channel, sub)
  },
  off: (channel: string, listener: (...args: unknown[]) => void): void => {
    ipcRenderer.removeListener(channel, listener as never)
  }
})
