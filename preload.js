'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  repos: {
    list: () => invoke('repos:list'),
    pick: () => invoke('repos:pick'),
    remove: (p) => invoke('repos:remove', p),
    setActive: (p) => invoke('repos:setActive', p),
    reveal: (p) => invoke('repos:reveal', p),
    refreshOne: (p) => invoke('repos:refreshOne', p),
  },
  git: (repo, action, payload) => invoke('git:call', { repo, action, payload }),
  app: {
    info: () => invoke('app:info'),
  },
  on: (event, cb) => {
    const ch = 'menu:' + event;
    const handler = () => cb();
    ipcRenderer.on(ch, handler);
    return () => ipcRenderer.removeListener(ch, handler);
  },
});
