const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcherAPI', {
  loadLibrary: () => ipcRenderer.invoke('library:load'),
  refreshLibraryStatus: () => ipcRenderer.invoke('library:refresh-status'),
  saveLibrary: (games) => ipcRenderer.invoke('library:save', games),
  exportLibrary: () => ipcRenderer.invoke('library:export'),
  importLibrary: () => ipcRenderer.invoke('library:import'),
  pickExecutable: () => ipcRenderer.invoke('game:pick-exe'),
  pickImage: () => ipcRenderer.invoke('game:pick-image'),
  launchGame: (game) => ipcRenderer.invoke('game:launch', game),
  stopGame: (id) => ipcRenderer.invoke('game:stop', id),
  searchCovers: (query) => ipcRenderer.invoke('game:search-covers', query),
  downloadCover: (url) => ipcRenderer.invoke('game:download-cover', url),
  revealGame: (filePath) => ipcRenderer.invoke('game:reveal', filePath),
  openDataFolder: () => ipcRenderer.invoke('app:open-data'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  getRunningGames: () => ipcRenderer.invoke('game:running'),
  onProcessState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('game:process-state', listener);
    return () => ipcRenderer.removeListener('game:process-state', listener);
  },
});
