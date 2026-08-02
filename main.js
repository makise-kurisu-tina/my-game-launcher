const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

app.setPath('userData', path.join(app.getPath('appData'), 'northstar-game-launcher'));

let mainWindow;
const runningGames = new Map();

function getDataDirectory() {
  return path.join(app.getPath('userData'), 'library');
}

function getLibraryFile() {
  return path.join(getDataDirectory(), 'games.json');
}

function getCoversDirectory() {
  return path.join(getDataDirectory(), 'covers');
}

function getWindowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState() {
  try {
    const saved = JSON.parse(fs.readFileSync(getWindowStateFile(), 'utf8'));
    if (saved && saved.width >= 1100 && saved.height >= 720) return saved;
  } catch {
    // Use the default window size when no state has been saved yet.
  }
  return { width: 1440, height: 920 };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  fs.writeFileSync(getWindowStateFile(), JSON.stringify({ width: bounds.width, height: bounds.height }));
}

async function ensureStorage() {
  await fsp.mkdir(getCoversDirectory(), { recursive: true });
}

function imageMimeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  return 'image/jpeg';
}

async function fileToDataUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  try {
    const buffer = await fsp.readFile(filePath);
    return `data:${imageMimeForPath(filePath)};base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
}

async function hydrateGames(games) {
  return Promise.all(games.map(async (game) => ({
    ...game,
    coverDataUrl: await fileToDataUrl(game.coverPath),
    fileExists: Boolean(game.exePath && fs.existsSync(game.exePath)),
    isRunning: runningGames.has(game.id),
  })));
}

function stripTransientFields(game) {
  const { coverDataUrl, fileExists, isRunning, ...storedGame } = game;
  return storedGame;
}

async function readLibrary() {
  await ensureStorage();
  try {
    const content = await fsp.readFile(getLibraryFile(), 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeLibrary(games) {
  await ensureStorage();
  const cleanGames = Array.isArray(games) ? games.map(stripTransientFields) : [];
  await fsp.writeFile(getLibraryFile(), JSON.stringify(cleanGames, null, 2), 'utf8');
  return hydrateGames(cleanGames);
}

async function exportLibrary() {
  const games = await readLibrary();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出 Northstar 游戏库',
    defaultPath: path.join(app.getPath('documents'), 'northstar-library.json'),
    filters: [{ name: 'Northstar 游戏库', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fsp.writeFile(result.filePath, JSON.stringify(games, null, 2), 'utf8');
  return { canceled: false, filePath: result.filePath };
}

async function importLibrary() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入 Northstar 游戏库',
    properties: ['openFile'],
    filters: [{ name: 'Northstar 游戏库', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const content = await fsp.readFile(result.filePaths[0], 'utf8');
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) throw new Error('导入文件格式不正确');
  const games = parsed.filter((game) => game && typeof game === 'object' && game.exePath);
  return { canceled: false, games: await writeLibrary(games), count: games.length };
}

function sendProcessState(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('game:process-state', payload);
  }
}

function parseArguments(input) {
  const value = String(input || '').trim();
  if (!value) return [];
  const matches = value.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return matches.map((argument) => argument.replace(/^"|"$/g, ''));
}

function createWindow() {
  const windowState = readWindowState();
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0b0d11',
    title: 'My Game Launcher',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('resize', saveWindowState);
  mainWindow.on('close', saveWindowState);
}

async function pickExecutable() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择游戏启动文件',
    properties: ['openFile'],
    filters: [{ name: 'Windows 游戏程序', extensions: ['exe'] }],
  });
  return result.canceled ? '' : result.filePaths[0];
}

async function pickImage() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择游戏封面',
    properties: ['openFile'],
    filters: [{ name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const sourcePath = result.filePaths[0];
  const extension = path.extname(sourcePath).toLowerCase() || '.jpg';
  const targetPath = path.join(getCoversDirectory(), `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extension}`);
  await ensureStorage();
  await fsp.copyFile(sourcePath, targetPath);
  return { path: targetPath, dataUrl: await fileToDataUrl(targetPath) };
}

function ensureHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

async function searchCovers(query) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];
  const endpoint = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(cleanQuery)}&l=schinese&cc=cn`;
  const response = await fetch(endpoint, {
    headers: { 'User-Agent': 'NorthstarLauncher/0.1' },
  });
  if (!response.ok) throw new Error(`Steam search failed: ${response.status}`);
  const data = await response.json();
  return (data.items || []).slice(0, 8).map((item) => ({
    appId: item.id,
    name: item.name,
    imageUrl: item.large_capsule || item.header_image || item.small_capsule || item.tiny_image,
    subtitle: item.type === 'dlc' ? 'DLC' : 'Steam 游戏',
  })).filter((item) => item.imageUrl);
}

async function downloadCover(url) {
  const parsedUrl = ensureHttpUrl(url);
  if (!parsedUrl) throw new Error('封面地址无效');
  const response = await fetch(parsedUrl, {
    headers: { 'User-Agent': 'NorthstarLauncher/0.1' },
  });
  if (!response.ok) throw new Error(`封面下载失败: ${response.status}`);
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const extension = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
  const targetPath = path.join(getCoversDirectory(), `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extension}`);
  await ensureStorage();
  await fsp.writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
  return { path: targetPath, dataUrl: await fileToDataUrl(targetPath) };
}

function launchGame(game) {
  if (!game || !game.id || !game.exePath) throw new Error('游戏信息不完整');
  if (!fs.existsSync(game.exePath)) throw new Error('游戏文件不存在，请重新选择 exe');
  if (runningGames.has(game.id)) throw new Error('该游戏已经在运行');

  const child = spawn(game.exePath, parseArguments(game.launchArgs), {
    cwd: game.workingDirectory || path.dirname(game.exePath),
    detached: false,
    windowsHide: false,
    stdio: 'ignore',
  });
  const startedAt = Date.now();
  runningGames.set(game.id, { child, startedAt });
  sendProcessState({ id: game.id, status: 'running', startedAt });

  child.once('error', (error) => {
    runningGames.delete(game.id);
    sendProcessState({ id: game.id, status: 'error', message: error.message });
  });
  child.once('exit', (code, signal) => {
    const current = runningGames.get(game.id);
    const endTime = Date.now();
    const durationSeconds = current ? Math.max(0, Math.round((endTime - current.startedAt) / 1000)) : 0;
    runningGames.delete(game.id);
    sendProcessState({ id: game.id, status: 'stopped', endedAt: endTime, durationSeconds, code, signal });
  });
  return { id: game.id, startedAt };
}

function stopGame(id) {
  const current = runningGames.get(id);
  if (!current) return false;
  if (process.platform === 'win32' && current.child.pid) {
    execFile('taskkill', ['/pid', String(current.child.pid), '/t', '/f'], () => {});
  } else {
    current.child.kill();
  }
  return true;
}

app.whenReady().then(() => {
  ipcMain.handle('library:load', async () => hydrateGames(await readLibrary()));
  ipcMain.handle('library:refresh-status', async () => hydrateGames(await readLibrary()));
  ipcMain.handle('library:save', async (_event, games) => writeLibrary(games));
  ipcMain.handle('library:export', exportLibrary);
  ipcMain.handle('library:import', importLibrary);
  ipcMain.handle('game:pick-exe', pickExecutable);
  ipcMain.handle('game:pick-image', pickImage);
  ipcMain.handle('game:launch', (_event, game) => launchGame(game));
  ipcMain.handle('game:stop', (_event, id) => stopGame(id));
  ipcMain.handle('game:search-covers', (_event, query) => searchCovers(query));
  ipcMain.handle('game:download-cover', (_event, url) => downloadCover(url));
  ipcMain.handle('game:reveal', (_event, filePath) => {
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
  });
  ipcMain.handle('app:open-data', () => shell.openPath(getDataDirectory()));
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('game:running', () => Array.from(runningGames, ([id, value]) => ({ id, startedAt: value.startedAt })));

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
