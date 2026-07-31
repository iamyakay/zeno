const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zeno", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (partial) => ipcRenderer.invoke("config:set", partial),
  chat: (payload) => ipcRenderer.invoke("ai:chat", payload),
  listen: () => ipcRenderer.invoke("os:listen"),
  cancelListen: () => ipcRenderer.invoke("os:listen-cancel"),
  genImage: (prompt) => ipcRenderer.invoke("ai:image", prompt),
  runAction: (action) => ipcRenderer.invoke("os:action", action),
  getStats: () => ipcRenderer.invoke("os:stats"),
  memList: () => ipcRenderer.invoke("mem:list"),
  memAdd: (fact) => ipcRenderer.invoke("mem:add", fact),
  memClear: () => ipcRenderer.invoke("mem:clear"),
  onWake: (callback) => ipcRenderer.on("zeno:wake", callback),
  listModels: () => ipcRenderer.invoke("ai:models"),
  getCredits: () => ipcRenderer.invoke("ai:credits"),
  openExternal: (url) => ipcRenderer.invoke("open:external", url)
});
