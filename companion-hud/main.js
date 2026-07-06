const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const BRIDGE_FILE = join(homedir(), '.akira-companion', 'bridge.json');
const BRIDGE_POLL_MS = 1000;

function readBridge() {
  try {
    const { port, token } = JSON.parse(readFileSync(BRIDGE_FILE, 'utf8'));
    if (typeof port === 'number' && typeof token === 'string') return { port, token };
    return null;
  } catch {
    return null;
  }
}

// Poll bridge.json and push {port, token} to the renderer whenever it first
// appears or changes. The Companion writes fresh creds on every startup, so
// this lets the HUD self-heal regardless of start order or across Companion
// restarts. The retry has to live here because the renderer has no node
// integration and cannot read the file itself.
function watchBridge(win) {
  let last = '';
  const push = (force) => {
    if (win.isDestroyed()) return;
    const bridge = readBridge();
    const sig = bridge ? `${bridge.port}:${bridge.token}` : '';
    if (!force && sig === last) return;
    last = sig;
    win.webContents.send('hud:bridge', bridge);
  };
  const timer = setInterval(() => push(false), BRIDGE_POLL_MS);
  win.on('closed', () => clearInterval(timer));
  // Always (re)send once the page is ready, so a reload re-primes the creds.
  win.webContents.on('did-finish-load', () => push(true));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 360,
    height: 580,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(join(__dirname, 'renderer', 'index.html'));
  watchBridge(win);
  return win;
}

// Registered once at module scope (not per-window) so repeated window
// recreation on macOS cannot stack duplicate listeners.
ipcMain.on('hud:resize', (e, { width, height }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setBounds({ x, y, width, height });
});

ipcMain.handle('hud:pick-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
