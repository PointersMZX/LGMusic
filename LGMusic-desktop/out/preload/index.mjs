import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("electronAPI", {
  send: (channel, data) => {
    ipcRenderer.send(channel, data);
  },
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
  on: (channel, listener) => {
    const sub = (_event, ...args) => listener(...args);
    ipcRenderer.on(channel, sub);
  },
  off: (channel, listener) => {
    ipcRenderer.removeListener(channel, listener);
  }
});
