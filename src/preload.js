const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentAPI', {
  navigate: (url) => ipcRenderer.invoke('agent:navigate', url),
  start: (params) => ipcRenderer.invoke('agent:start', params),
  pause: () => ipcRenderer.invoke('agent:pause'),
  step: (goal) => ipcRenderer.invoke('agent:step', goal),
  resume: () => ipcRenderer.invoke('agent:resume'),
  handOff: (reason) => ipcRenderer.invoke('agent:handOff', reason),
  clearSession: () => ipcRenderer.invoke('agent:clearSession'),
  goBack: () => ipcRenderer.invoke('agent:goBack'),
  goForward: () => ipcRenderer.invoke('agent:goForward'),
  reload: () => ipcRenderer.invoke('agent:reload'),
  goHome: () => ipcRenderer.invoke('agent:goHome'),
  getLogs: () => ipcRenderer.invoke('agent:getLogs'),
  clearLogs: () => ipcRenderer.invoke('agent:clearLogs'),
  stop: () => ipcRenderer.invoke('agent:stop'),
  setDrawerOpen: (isOpen) => ipcRenderer.invoke('agent:setDrawerOpen', isOpen),
  resultsCsv: (taskId) => ipcRenderer.invoke('agent:resultsCsv', taskId),
  exportResults: (taskId) => ipcRenderer.invoke('agent:exportResults', taskId),
  getStatus: () => ipcRenderer.invoke('agent:status'),
  getSettings: () => ipcRenderer.invoke('agent:getSettings'),
  saveSettings: (settings) => ipcRenderer.invoke('agent:saveSettings', settings),
  testConnection: (type, config) => ipcRenderer.invoke('agent:testConnection', { type, config }),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('agent:state', listener);
    return () => ipcRenderer.removeListener('agent:state', listener);
  },
  onError: (callback) => {
    const listener = (_event, err) => callback(err);
    ipcRenderer.on('agent:error', listener);
    return () => ipcRenderer.removeListener('agent:error', listener);
  },
  onLog: (callback) => {
    const listener = (_event, log) => callback(log);
    ipcRenderer.on('agent:log', listener);
    return () => ipcRenderer.removeListener('agent:log', listener);
  },
  onClearLogs: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('agent:clearLogs', listener);
    return () => ipcRenderer.removeListener('agent:clearLogs', listener);
  },
});
