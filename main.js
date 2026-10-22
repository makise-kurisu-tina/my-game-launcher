const { app, BrowserWindow, dialog, ipcMain, shell, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const APP_ID = 'com.mygamelauncher.app';
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const RUNNING_WATCHDOG_MS = 15000;

// Migrate the data directory from the old product name without losing local data.
(function migrateUserData() {
  const appData = app.getPath('appData');
  const target = path.join(appData, 'my-game-launcher');
  const legacy = path.join(appData, 'northstar-game-launcher');
  try {
    if (!fs.existsSync(target) && fs.existsSync(legacy)) fs.renameSync(legacy, target);
  } catch {
    // If the migration fails we simply start with a fresh directory.
  }
  app.setPath('userData', target);
})();

app.setAppUserModelId(APP_ID);

protocol.registerSchemesAsPrivileged([
  { scheme: 'cover', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow;
let windowStateTimer = null;
/** @type {Map<string, { pid: number, startedAt: number, child: import('node:child_process').ChildProcess | null }>} */
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

function getRunningFile() {
  return path.join(app.getPath('userData'), 'running.json');
}

/* ---------- Window state ---------- */

function readWindowState() {
  try {
    const saved = JSON.parse(fs.readFileSync(getWindowStateFile(), 'utf8'));
    if (saved && saved.width >= 1100 && saved.height >= 720) return saved;
  } catch {
    // No saved state yet, fall back to the default size.
  }
  return { width: 1440, height: 920 };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { width, height } = mainWindow.getBounds();
  try {
    fs.writeFileSync(getWindowStateFile(), JSON.stringify({ width, height }));
  } catch {
    // Ignore write failures, the window size is not critical data.
  }
}

function scheduleSaveWindowState() {
  clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(saveWindowState, 400);
}

/* ---------- Storage helpers ---------- */

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

function stripTransientFields(game) {
  const { fileExists, isRunning, hasCover, coverPath, ...storedGame } = game;
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

async function writeLibraryFile(games) {
  await ensureStorage();
  const cleanGames = Array.isArray(games) ? games.map(stripTransientFields) : [];
  await fsp.writeFile(getLibraryFile(), JSON.stringify(cleanGames, null, 2), 'utf8');
  return cleanGames;
}

function hydrateGames(games) {
  return games.map((game) => {
    const coverPath = game.coverFile ? path.join(getCoversDirectory(), game.coverFile) : '';
    return {
      ...game,
      coverPath,
      hasCover: Boolean(coverPath && fs.existsSync(coverPath)),
      fileExists: Boolean(game.exePath && fs.existsSync(game.exePath)),
      isRunning: runningGames.has(game.id),
    };
  });
}

async function writeLibrary(games) {
  return hydrateGames(await writeLibraryFile(games));
}

/* ---------- One-time migration ---------- */

/**
 * 旧版本把封面的绝对路径写进了库文件，数据目录一旦变动封面就会失效。
 * 这里统一迁移为只存文件名，并在必要时把旧位置的文件搬进封面目录。
 */
async function migrateCoverPaths() {
  const games = await readLibrary();
  let dirty = false;

  for (const game of games) {
    if (game.coverPath === undefined) continue;
    const previous = typeof game.coverPath === 'string' ? game.coverPath : '';
    delete game.coverPath;
    dirty = true;
    if (!previous) continue;

    const fileName = path.basename(previous);
    const target = path.join(getCoversDirectory(), fileName);
    try {
      await ensureStorage();
      if (!fs.existsSync(target) && fs.existsSync(previous)) {
        await fsp.copyFile(previous, target);
      }
      if (fs.existsSync(target)) game.coverFile = fileName;
    } catch {
      // 封面文件已经丢失，保持无封面状态即可。
    }
  }

  if (dirty) await writeLibraryFile(games);
}

/* ---------- Running process tracking ---------- */

function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readRunningRecords() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getRunningFile(), 'utf8'));
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function writeRunningRecords() {
  try {
    const items = Array.from(runningGames, ([id, value]) => ({
      id,
      pid: value.pid,
      startedAt: value.startedAt,
      lastSeen: Date.now(),
    }));
    fs.writeFileSync(getRunningFile(), JSON.stringify({ items }, null, 2), 'utf8');
  } catch {
    // Losing the running snapshot is not fatal.
  }
}

async function reconcileRunningGames() {
  const records = readRunningRecords();
  if (!records.length) return;

  const games = await readLibrary();
  let dirty = false;

  for (const record of records) {
    if (!record?.id) continue;
    if (isProcessAlive(record.pid)) {
      runningGames.set(record.id, { pid: record.pid, startedAt: record.startedAt, child: null });
      continue;
    }
    const game = games.find((item) => item.id === record.id);
    if (!game) continue;
    const endedAt = Math.min(Math.max(record.lastSeen || Date.now(), record.startedAt), Date.now());
    game.totalPlaySeconds = (Number(game.totalPlaySeconds) || 0) + Math.max(0, Math.round((endedAt - record.startedAt) / 1000));
    dirty = true;
  }

  if (dirty) await writeLibraryFile(games);
  writeRunningRecords();
}

function startRunningWatchdog() {
  const timer = setInterval(() => {
    let changed = false;
    for (const [id, value] of runningGames) {
      // Processes we spawned are handled by their own exit event.
      if (value.child || isProcessAlive(value.pid)) continue;
      const endedAt = Date.now();
      runningGames.delete(id);
      sendProcessState({
        id,
        status: 'stopped',
        endedAt,
        durationSeconds: Math.max(0, Math.round((endedAt - value.startedAt) / 1000)),
      });
      changed = true;
    }
    if (changed) writeRunningRecords();
  }, RUNNING_WATCHDOG_MS);
  timer.unref?.();
  return timer;
}

/* ---------- Cover protocol ---------- */

function registerCoverProtocol() {
  protocol.handle('cover', async (request) => {
    try {
      // URLSearchParams already decodes the value, do not decode it twice.
      const target = new URL(request.url).searchParams.get('p') || '';
      if (!target) return new Response('missing path', { status: 400 });

      const resolved = path.resolve(target);
      const coversDir = path.resolve(getCoversDirectory());
      if (resolved !== coversDir && !resolved.startsWith(coversDir + path.sep)) {
        return new Response('forbidden', { status: 403 });
      }

      const data = await fsp.readFile(resolved);
      return new Response(new Uint8Array(data), {
        headers: { 'content-type': imageMimeForPath(resolved), 'cache-control': 'no-cache' },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

/* ---------- Dialogs & fetching ---------- */

async function pickExecutable() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择游戏启动文件',
    properties: ['openFile'],
    filters: [{ name: 'Windows 游戏程序', extensions: ['exe'] }],
  });
  return result.canceled ? '' : result.filePaths[0];
}

function newCoverFileName(extension) {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extension}`;
}

async function pickImage() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择游戏封面',
    properties: ['openFile'],
    filters: [{ name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const sourcePath = result.filePaths[0];
  const fileName = newCoverFileName(path.extname(sourcePath).toLowerCase() || '.jpg');
  await ensureStorage();
  const targetPath = path.join(getCoversDirectory(), fileName);
  await fsp.copyFile(sourcePath, targetPath);
  return { file: fileName, path: targetPath };
}

function ensureHttpsUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function fetchWithTimeout(url) {
  return fetch(url, {
    headers: { 'User-Agent': 'MyGameLauncher/0.5' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function searchCovers(query) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];
  const endpoint = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(cleanQuery)}&l=schinese&cc=cn`;
  const response = await fetchWithTimeout(endpoint);
  if (!response.ok) throw new Error(`Steam 搜索失败: ${response.status}`);
  const data = await response.json();
  return (data.items || [])
    .slice(0, 8)
    .map((item) => ({
      appId: item.id,
      name: item.name,
      imageUrl: item.large_capsule || item.header_image || item.small_capsule || item.tiny_image,
      subtitle: item.type === 'dlc' ? 'DLC' : 'Steam 游戏',
    }))
    .filter((item) => item.imageUrl);
}

async function downloadCover(url) {
  const parsedUrl = ensureHttpsUrl(url);
  if (!parsedUrl) throw new Error('封面地址无效');
  const response = await fetchWithTimeout(parsedUrl);
  if (!response.ok) throw new Error(`封面下载失败: ${response.status}`);

  const declaredSize = Number(response.headers.get('content-length')) || 0;
  if (declaredSize > MAX_COVER_BYTES) throw new Error('封面图片过大，请选择其他图片');

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_COVER_BYTES) throw new Error('封面图片过大，请选择其他图片');

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const extension = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
  const fileName = newCoverFileName(extension);
  await ensureStorage();
  const targetPath = path.join(getCoversDirectory(), fileName);
  await fsp.writeFile(targetPath, buffer);
  return { file: fileName, path: targetPath };
}

/* ---------- Library import / export ---------- */

async function exportLibrary() {
  const games = await readLibrary();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出游戏库',
    defaultPath: path.join(app.getPath('documents'), 'my-game-launcher-library.json'),
    filters: [{ name: '游戏库备份', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fsp.writeFile(result.filePath, JSON.stringify(games.map(stripTransientFields), null, 2), 'utf8');
  return { canceled: false, filePath: result.filePath };
}

async function importLibrary() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入游戏库',
    properties: ['openFile'],
    filters: [{ name: '游戏库备份', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };

  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(result.filePaths[0], 'utf8'));
  } catch {
    throw new Error('无法解析备份文件，请确认它是有效的 JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('备份文件格式不正确');

  const games = parsed.filter((game) => game && typeof game === 'object' && typeof game.exePath === 'string' && game.exePath);
  return { canceled: false, games: await writeLibrary(games), count: games.length };
}

/* ---------- Launch & stop ---------- */

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

function sanitizeGameInput(input) {
  if (!input || typeof input !== 'object') throw new Error('游戏数据无效');
  const id = typeof input.id === 'string' ? input.id : '';
  const exePath = typeof input.exePath === 'string' ? input.exePath : '';
  if (!id) throw new Error('缺少游戏 ID');
  if (!exePath) throw new Error('缺少启动文件路径');
  return {
    id,
    exePath,
    name: typeof input.name === 'string' ? input.name : '',
    launchArgs: typeof input.launchArgs === 'string' ? input.launchArgs : '',
    workingDirectory: typeof input.workingDirectory === 'string' ? input.workingDirectory : '',
  };
}

function launchGame(rawGame) {
  const game = sanitizeGameInput(rawGame);
  if (!fs.existsSync(game.exePath)) throw new Error('游戏文件不存在，请重新选择 exe');
  if (runningGames.has(game.id)) throw new Error('该游戏已经在运行');

  const child = spawn(game.exePath, parseArguments(game.launchArgs), {
    cwd: game.workingDirectory || path.dirname(game.exePath),
    detached: false,
    windowsHide: false,
    stdio: 'ignore',
  });

  const startedAt = Date.now();
  runningGames.set(game.id, { pid: child.pid, startedAt, child });
  writeRunningRecords();
  sendProcessState({ id: game.id, status: 'running', startedAt });

  child.once('error', (error) => {
    runningGames.delete(game.id);
    writeRunningRecords();
    sendProcessState({ id: game.id, status: 'error', message: error.message });
  });

  child.once('exit', (code, signal) => {
    const current = runningGames.get(game.id);
    const endedAt = Date.now();
    const durationSeconds = current ? Math.max(0, Math.round((endedAt - current.startedAt) / 1000)) : 0;
    runningGames.delete(game.id);
    writeRunningRecords();
    sendProcessState({ id: game.id, status: 'stopped', endedAt, durationSeconds, code, signal });
  });

  return { id: game.id, startedAt };
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/t', '/f'], () => {});
    return;
  }
  try {
    process.kill(pid);
  } catch {
    // The process already exited.
  }
}

function stopGame(id) {
  const current = runningGames.get(id);
  if (!current) return { stopped: false };

  killProcessTree(current.pid);

  // Processes we spawned settle through their own exit event.
  if (current.child) return { stopped: true };

  // Restored from a previous session: settle immediately.
  const endedAt = Date.now();
  runningGames.delete(id);
  writeRunningRecords();
  sendProcessState({
    id,
    status: 'stopped',
    endedAt,
    durationSeconds: Math.max(0, Math.round((endedAt - current.startedAt) / 1000)),
  });
  return { stopped: true };
}

/* ---------- Window ---------- */

function createWindow() {
  const windowState = readWindowState();
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0b0d10',
    title: 'My Game Launcher',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('resize', scheduleSaveWindowState);
  mainWindow.on('close', () => {
    clearTimeout(windowStateTimer);
    saveWindowState();
  });
}

/* ---------- Lifecycle ---------- */

app.whenReady().then(async () => {
  registerCoverProtocol();
  await migrateCoverPaths();
  await reconcileRunningGames();
  startRunningWatchdog();

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
    if (typeof filePath === 'string' && filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
  });
  ipcMain.handle('app:open-data', () => shell.openPath(getDataDirectory()));
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('game:running', () =>
    Array.from(runningGames, ([id, value]) => ({ id, startedAt: value.startedAt })),
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  clearTimeout(windowStateTimer);
  saveWindowState();
  // Persist which games are still running so the next session can pick them up.
  writeRunningRecords();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
