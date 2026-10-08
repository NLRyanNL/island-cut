import { app, BrowserWindow, Menu, MenuItemConstructorOptions, ipcMain, screen, shell } from 'electron';
import path from 'node:path';
import { registerSchemePrivileges, handleMediaProtocol } from './mediaProtocol';
import { registerIpc, isAllowedPath } from './ipc';
import { pingStats } from './stats';
import { getSettings, updateSettings } from './settings';

/** Automatic interface zoom from the primary screen's size (in Windows-scaled pixels). */
function autoZoom(): number {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  if (width >= 3400) return 1.5;
  if (width >= 2400) return 1.25;
  if (width >= 1900) return 1.1;
  return 1;
}

function effectiveZoom(): number {
  const z = getSettings().uiZoom;
  return z && z >= 0.7 && z <= 2 ? z : autoZoom();
}
import { setCacheRoot } from './paths';
import { killAll } from './ffmpeg/run';
import { attachLogging, logLine, registerSelftest } from './selftest';

registerSchemePrivileges();
app.setName('IslandCut');
if (process.platform === 'win32') app.setAppUserModelId('com.islandcut.app');

function iconPath(): string {
  // dev: <project>/resources/icon.png · packaged: <install>/resources/icon.png
  const name = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const dev = path.join(__dirname, '..', '..', 'resources', name);
  return app.isPackaged ? path.join(process.resourcesPath, name) : dev;
}

let win: BrowserWindow | null = null;
let allowClose = false;

const isDev = !!process.env.VITE_DEV_SERVER_URL;

function menuCmd(cmd: string) {
  return () => win?.webContents.send('app:menu', cmd);
}

function buildMenu(): void {
  // Shortcuts are handled by the renderer (so they work the same everywhere);
  // menu items only display them (registerAccelerator: false).
  const item = (label: string, cmd: string, accel?: string): MenuItemConstructorOptions => ({
    label,
    click: menuCmd(cmd),
    accelerator: accel,
    registerAccelerator: false,
  });
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        item('New Project…', 'new', 'Ctrl+N'),
        item('Open Project…', 'open', 'Ctrl+O'),
        item('Save', 'save', 'Ctrl+S'),
        item('Save As…', 'saveAs', 'Ctrl+Shift+S'),
        { type: 'separator' },
        item('Import Media…', 'import', 'Ctrl+I'),
        item('Set Sound Effects Folder…', 'sfxFolder'),
        { type: 'separator' },
        item('Export Video…', 'export', 'Ctrl+E'),
        item('Export Audio Only…', 'exportAudio'),
        item('Export Frame as PNG', 'exportFrame', 'Ctrl+Shift+E'),
        item('Render Queue', 'renderQueue'),
        { type: 'separator' },
        item('Recover Autosave…', 'recover'),
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item('Undo', 'undo', 'Ctrl+Z'),
        item('Redo', 'redo', 'Ctrl+Y'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('Split at Playhead', 'split', 'Ctrl+B'),
        item('Delete', 'delete', 'Delete'),
        item('Ripple Delete', 'rippleDelete', 'Shift+Delete'),
        item('Add Marker', 'marker', 'M'),
        { type: 'separator' },
        item('Settings…', 'settings'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Zoom In Timeline', 'zoomIn', '='),
        item('Zoom Out Timeline', 'zoomOut', '-'),
        item('Zoom to Fit', 'zoomFit', 'Shift+Z'),
        { type: 'separator' },
        item('Safe-Area Guides', 'toggleSafe'),
        item('2.39:1 Letterbox Guide', 'toggleLetterboxGuide'),
        { type: 'separator' },
        { role: 'reload', visible: isDev },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tools',
      submenu: [item('Auto Trailer…', 'autoTrailer'), item('Logo Maker…', 'logoMaker'), item('Remove Image Background…', 'removeBg')],
    },
    {
      label: 'Help',
      submenu: [
        item('Keyboard Shortcuts', 'shortcuts', 'F1'),
        item('Check for Updates', 'checkUpdates'),
        item('Report a Problem…', 'reportProblem'),
        { type: 'separator' },
        { label: 'FFmpeg Documentation', click: () => shell.openExternal('https://ffmpeg.org/documentation.html') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#111216',
    title: 'IslandCut',
    icon: iconPath(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  // interface size: the saved choice, or automatic for big screens (text stays readable on 1440p/4K)
  win.webContents.on('did-finish-load', () => win?.webContents.setZoomFactor(effectiveZoom()));
  win.once('ready-to-show', () => {
    win?.maximize();
    win?.show();
  });
  win.on('close', (e) => {
    if (allowClose || process.env.UTS_SELFTEST === '1') return;
    e.preventDefault();
    win?.webContents.send('app:close-requested');
  });
  win.on('closed', () => {
    win = null;
  });
  // Never navigate away from the app; open links externally.
  // (a file dropped outside a drop zone must never replace the app: allow only reloads of the app itself)
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env.VITE_DEV_SERVER_URL;
    if (dev && url.startsWith(dev)) return;
    e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  attachLogging(win);
  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  setCacheRoot(path.join(app.getPath('userData'), 'cache'));
  handleMediaProtocol(isAllowedPath);
  registerIpc(() => win);
  registerSelftest();
  logLine(`started (${isDev ? 'dev' : 'production'})`);
  ipcMain.handle('ui:getZoom', () => ({ setting: getSettings().uiZoom ?? null, auto: autoZoom(), effective: effectiveZoom() }));
  ipcMain.handle('ui:setZoom', (_e, z: number | null) => {
    updateSettings({ uiZoom: z && z >= 0.7 && z <= 2 ? z : undefined });
    win?.webContents.setZoomFactor(effectiveZoom());
    return { setting: getSettings().uiZoom ?? null, auto: autoZoom(), effective: effectiveZoom() };
  });
  ipcMain.on('app:confirm-close', () => {
    allowClose = true;
    win?.close();
  });
  buildMenu();
  createWindow();
  // anonymous install count (only if this build has a counter configured; off-switch in Settings)
  setTimeout(() => void pingStats(), 5000);
});

app.on('window-all-closed', () => {
  killAll();
  app.quit();
});

app.on('before-quit', () => killAll());
