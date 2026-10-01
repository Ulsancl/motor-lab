const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('motorDesktop', {
  isDesktop: true,
  openProject: () => ipcRenderer.invoke('motor:open-project'),
  saveProject: payload => ipcRenderer.invoke('motor:save-project', payload),
  setBusy: busy => ipcRenderer.send('motor:busy', busy === true),
  onCommand: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('motor:command', listener);
    return () => ipcRenderer.removeListener('motor:command', listener);
  },
});
