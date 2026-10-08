import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Api } from '../shared/api';

function on<T>(channel: string, cb: (p: T) => void): () => void {
  const fn = (_e: unknown, p: T) => cb(p);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

const api: Api = {
  platform: process.platform,
  testMode: process.env.UTS_TEST === '1',
  selftest: process.env.UTS_SELFTEST === '1',
  selftestMedia: () => ipcRenderer.invoke('selftest:media'),
  selftestDone: (r) => ipcRenderer.invoke('selftest:done', r),
  openFiles: (o) => ipcRenderer.invoke('dialog:open', o),
  saveFile: (o) => ipcRenderer.invoke('dialog:save', o),
  confirm: (o) => ipcRenderer.invoke('dialog:confirm', o),
  showInFolder: (p) => ipcRenderer.send('shell:showInFolder', p),
  openExternal: (u) => ipcRenderer.send('shell:openExternal', u),
  getPathForFile: (f) => webUtils.getPathForFile(f),
  probe: (paths) => ipcRenderer.invoke('media:probe', paths),
  mediaUrl: (p) => `media://f/${encodeURIComponent(p)}`,
  thumbnail: (p, kind, d) => ipcRenderer.invoke('media:thumb', p, kind, d),
  requestProxy: (m) => ipcRenderer.invoke('media:proxy', m),
  waveform: (p) => ipcRenderer.invoke('media:waveform', p),
  detectBeats: (p) => ipcRenderer.invoke('media:beats', p),
  makeDerived: (r) => ipcRenderer.invoke('media:derived', r),
  listFolder: (f, exts) => ipcRenderer.invoke('fs:listFolder', f, exts),
  readText: (p) => ipcRenderer.invoke('fs:readText', p),
  readBytes: (p) => ipcRenderer.invoke('fs:readBytes', p),
  exists: (paths) => ipcRenderer.invoke('fs:exists', paths),
  findInFolder: (f, n) => ipcRenderer.invoke('fs:findInFolder', f, n),
  allowPaths: (paths) => ipcRenderer.invoke('media:allow', paths),
  onProxyProgress: (cb) => on('media:proxy-progress', cb),
  saveProject: (p, f) => ipcRenderer.invoke('project:save', p, f),
  loadProject: (f) => ipcRenderer.invoke('project:load', f),
  autosave: (p, f) => ipcRenderer.invoke('project:autosave', p, f),
  listAutosaves: () => ipcRenderer.invoke('project:listAutosaves'),
  exportPrepare: (id) => ipcRenderer.invoke('export:prepare', id),
  writeJobFile: (d, n, data) => ipcRenderer.invoke('export:writeFile', d, n, data),
  exportRun: (j, p, t) => ipcRenderer.invoke('export:run', j, p, t),
  exportCancel: (id) => ipcRenderer.send('export:cancel', id),
  onExportProgress: (cb) => on('export:progress', cb),
  analyzeMedia: (m) => ipcRenderer.invoke('media:analyze', m),
  sampleFrames: (p, times, w) => ipcRenderer.invoke('media:sampleFrames', p, times, w),
  aiComplete: (r) => ipcRenderer.invoke('ai:complete', r),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (p) => ipcRenderer.invoke('settings:update', p),
  setApiKey: (k) => ipcRenderer.invoke('settings:setApiKey', k),
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  getUiZoom: () => ipcRenderer.invoke('ui:getZoom'),
  builtinSfx: () => ipcRenderer.invoke('sfx:builtin'),
  checkForUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  createProblemReport: (d, x) => ipcRenderer.invoke('app:problemReport', d, x),
  appInfo: () => ipcRenderer.invoke('app:info'),
  setUiZoom: (z) => ipcRenderer.invoke('ui:setZoom', z),
  writeUserFile: (p, d) => ipcRenderer.invoke('fs:writeUserFile', p, d),
  bundledFonts: () => ipcRenderer.invoke('fonts:bundled'),
  bundledFontBytes: (f) => ipcRenderer.invoke('fonts:bundledBytes', f),
  onMenu: (cb) => on('app:menu', cb),
  onCloseRequested: (cb) => on('app:close-requested', cb),
  confirmClose: () => ipcRenderer.send('app:confirm-close'),
  setTitle: (t) => ipcRenderer.send('app:setTitle', t),
};

contextBridge.exposeInMainWorld('api', api);
