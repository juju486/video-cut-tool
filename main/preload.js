const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDirectories: () => ipcRenderer.invoke('get-directories'),
  getDirectoryContent: (dirPath) => ipcRenderer.invoke('get-directory-content', dirPath),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', callback),
  onLogMessage: (callback) => ipcRenderer.on('log-message', callback),
  onUpdateProgressMessage: (callback) => ipcRenderer.on('update-progress-message', callback),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  editConfigFile: () => ipcRenderer.invoke('read-config-file'),
  saveConfig: (configData) => ipcRenderer.invoke('save-config', configData),
  readConfigFile: () => ipcRenderer.invoke('read-config-file'),
  readConfig: () => ipcRenderer.invoke('read-config'),
  saveConfigFile: (configContent) => ipcRenderer.invoke('save-config-file', configContent),
  runVideoSplit: () => ipcRenderer.invoke('run-video-split'),
  runVideoConcat: () => ipcRenderer.invoke('run-video-concat'),
  stopCurrentTask: () => ipcRenderer.invoke('stop-current-task'),
  openDirectory: (dirPath) => ipcRenderer.invoke('open-directory', dirPath),
  playSound: (type) => ipcRenderer.invoke('play-sound', type) // 添加播放提示音的API
});