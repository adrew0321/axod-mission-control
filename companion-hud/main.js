const { app, BrowserWindow, ipcMain } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const BRIDGE_FILE = join(homedir(), '.akira-companion', 'bridge.json');

function readBridge() {
  try {
    return JSON.parse(readFileSync(BRIDGE_FILE, 'utf8'));
  } catch {
    return null;
  }
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

  const b = readBridge();
  const search = b ? `port=${b.port}&token=${encodeURIComponent(b.token)}` : '';
  win.loadFile(join(__dirname, 'renderer', 'index.html'), { search });

  ipcMain.on('hud:resize', (_e, { width, height }) => {
    const [x, y] = win.getPosition();
    win.setBounds({ x, y, width, height });
  });

  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
