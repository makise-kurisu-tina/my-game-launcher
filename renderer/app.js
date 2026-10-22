const $ = (selector) => document.querySelector(selector);

const ICON_FOLDER =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M1.8 4.4A1.4 1.4 0 0 1 3.2 3h2.9l1.3 1.6h5.4a1.4 1.4 0 0 1 1.4 1.4v5.6a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4z"/></svg>';
const ICON_REMOVE =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 4.6h10M6.4 4.6V3.2h3.2v1.4M4.5 4.6l.6 7.9a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-7.9"/></svg>';

const state = {
  games: [],
  view: 'library',
  search: '',
  sort: 'added',
  editingId: null,
  draftCover: null,
  running: new Map(),
  saveQueue: Promise.resolve(),
  themeChoice: localStorage.getItem('my-game-launcher-theme') || localStorage.getItem('northstar-theme') || 'dark',
  contextMenuGameId: null,
};

const elements = {
  content: $('#libraryContent'),
  allCount: $('#allCount'),
  favoriteCount: $('#favoriteCount'),
  totalMetric: $('#totalMetric'),
  timeMetric: $('#timeMetric'),
  lastMetric: $('#lastMetric'),
  sectionTitle: $('#sectionTitle'),
  sectionSubtitle: $('#sectionSubtitle'),
  viewTitle: $('#viewTitle'),
  searchInput: $('#searchInput'),
  sortSelect: $('#sortSelect'),
  modalBackdrop: $('#modalBackdrop'),
  editModal: $('#editModal'),
  coverModal: $('#coverModal'),
  gameForm: $('#gameForm'),
  editModalTitle: $('#editModalTitle'),
  nameInput: $('#nameInput'),
  exeInput: $('#exeInput'),
  argsInput: $('#argsInput'),
  categoryInput: $('#categoryInput'),
  coverPreview: $('#coverPreview'),
  coverSearchInput: $('#coverSearchInput'),
  coverSearchButton: $('#coverSearchButton'),
  coverResults: $('#coverResults'),
  toastRegion: $('#toastRegion'),
  settingsButton: $('#settingsButton'),
  settingsModal: $('#settingsModal'),
  contextMenu: $('#gameContextMenu'),
};

/* ---------- Helpers ---------- */

function createId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function coverUrl(filePath) {
  if (!filePath) return '';
  return `cover://local/?p=${encodeURIComponent(filePath)}`;
}

function dirnameOf(filePath) {
  const value = String(filePath || '');
  const index = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
  return index > 0 ? value.slice(0, index) : value;
}

function initialOf(name) {
  const text = String(name || '').trim();
  return text ? text.slice(0, 1).toUpperCase() : '?';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeGame(game) {
  return {
    id: game.id || createId(),
    name: game.name || '未命名游戏',
    exePath: game.exePath || '',
    workingDirectory: game.workingDirectory || '',
    launchArgs: game.launchArgs || '',
    // coverFile 是持久化字段；coverPath 由主进程派生（绝对路径），仅用于渲染。
    coverFile: game.coverFile || '',
    coverPath: game.coverPath || '',
    hasCover: Boolean(game.hasCover),
    category: game.category || '未分类',
    favorite: Boolean(game.favorite),
    createdAt: Number(game.createdAt) || Date.now(),
    lastPlayedAt: Number(game.lastPlayedAt) || 0,
    totalPlaySeconds: Number(game.totalPlaySeconds) || 0,
    launchCount: Number(game.launchCount) || 0,
    fileExists: game.fileExists !== false,
  };
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours} 小时${minutes ? ` ${minutes} 分` : ''}`;
  if (minutes > 0) return `${minutes} 分钟`;
  if (total > 0) return `${total} 秒`;
  return '不足 1 秒';
}

function formatTotalDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '0h';
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return '从未启动';
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

/* ---------- Theme ---------- */

function resolveTheme(choice) {
  if (choice === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return choice === 'light' ? 'light' : 'dark';
}

function applyTheme(choice = state.themeChoice) {
  state.themeChoice = choice;
  localStorage.setItem('my-game-launcher-theme', choice);
  document.documentElement.dataset.theme = resolveTheme(choice);
  document.querySelectorAll('[data-theme-choice]').forEach((option) => {
    option.classList.toggle('active', option.dataset.themeChoice === choice);
  });
}

/* ---------- Filtering & rendering ---------- */

function getFilteredGames() {
  const query = state.search.trim().toLowerCase();
  const games = state.games.filter((game) => {
    if (state.view === 'favorites' && !game.favorite) return false;
    if (state.view === 'recent' && !game.lastPlayedAt) return false;
    if (!query) return true;
    return `${game.name} ${game.category} ${game.exePath}`.toLowerCase().includes(query);
  });

  games.sort((a, b) => {
    if (state.sort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    if (state.sort === 'played') return (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0);
    if (state.sort === 'time') return (b.totalPlaySeconds || 0) - (a.totalPlaySeconds || 0);
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  return games;
}

function renderCard(game) {
  const isRunning = state.running.has(game.id);
  const missing = !game.fileExists;
  const cover = game.hasCover
    ? `<img class="card-cover" src="${escapeHtml(coverUrl(game.coverPath))}" alt="" loading="lazy" />`
    : `<div class="card-cover-fallback">${escapeHtml(initialOf(game.name))}</div>`;
  const statusLabel = missing
    ? '文件不存在'
    : isRunning
      ? '运行中'
      : game.totalPlaySeconds > 0
        ? `已游玩 ${formatDuration(game.totalPlaySeconds)}`
        : '尚未游玩';

  return `
    <article class="game-card${missing ? ' is-missing' : ''}" data-id="${escapeHtml(game.id)}">
      <div class="card-cover-wrap">
        ${cover}
        ${isRunning ? '<span class="card-badge is-running">运行中</span>' : `<span class="card-badge">${escapeHtml(game.category || '未分类')}</span>`}
        <button class="favorite-button${game.favorite ? ' is-active' : ''}" data-action="favorite" data-id="${escapeHtml(game.id)}" title="${game.favorite ? '取消收藏' : '收藏'}">${game.favorite ? '★' : '☆'}</button>
      </div>
      <div class="card-body">
        <button class="card-open" data-action="edit" data-id="${escapeHtml(game.id)}">
          <span class="card-name">${escapeHtml(game.name)}</span>
          <span class="card-meta">${escapeHtml(formatRelativeTime(game.lastPlayedAt))} · 启动 ${game.launchCount || 0} 次</span>
        </button>
        <div class="card-footer">
          <span class="${missing ? 'card-missing' : 'card-time'}">${escapeHtml(statusLabel)}</span>
          <div class="card-tools">
            <button class="icon-action" data-action="reveal" data-id="${escapeHtml(game.id)}" title="打开所在文件夹" aria-label="打开所在文件夹">${ICON_FOLDER}</button>
            <button class="icon-action is-danger" data-action="delete" data-id="${escapeHtml(game.id)}" title="移出游戏库" aria-label="移出游戏库">${ICON_REMOVE}</button>
            <button class="play-button${isRunning ? ' is-running' : ''}" data-action="${isRunning ? 'stop' : 'play'}" data-id="${escapeHtml(game.id)}">${isRunning ? '停止' : '启动'}</button>
          </div>
        </div>
      </div>
    </article>`;
}

function renderEmpty(view, query) {
  let title = '游戏库还是空的';
  let text = '选择一个 .exe 文件导入，之后就能在这里统一启动并统计时长。';
  if (query) {
    title = '没有匹配的游戏';
    text = '换个关键词，或者清空搜索框重试。';
  } else if (view === 'favorites') {
    title = '还没有收藏';
    text = '在游戏卡片上点击星标，收藏的游戏会集中显示在这里。';
  } else if (view === 'recent') {
    title = '还没有启动记录';
    text = '启动一次游戏之后，最近玩过的内容会出现在这里。';
  }
  const action = !query && view === 'library' ? '<button class="primary-button" data-action="import">导入游戏</button>' : '';
  return `<div class="empty-state"><div><h3 class="empty-title">${escapeHtml(title)}</h3><p class="empty-text">${escapeHtml(text)}</p>${action}</div></div>`;
}

function updateMetrics() {
  const totalSeconds = state.games.reduce((sum, game) => sum + (game.totalPlaySeconds || 0), 0);
  const latest = state.games.reduce((newest, game) => ((game.lastPlayedAt || 0) > (newest?.lastPlayedAt || 0) ? game : newest), null);
  elements.allCount.textContent = state.games.length;
  elements.favoriteCount.textContent = state.games.filter((game) => game.favorite).length;
  elements.totalMetric.textContent = state.games.length;
  elements.timeMetric.textContent = formatTotalDuration(totalSeconds);
  elements.lastMetric.textContent = latest?.lastPlayedAt ? formatRelativeTime(latest.lastPlayedAt) : '暂无';
}

function updateViewCopy() {
  const copy = {
    library: ['游戏库', '全部游戏', '按最近添加排序'],
    recent: ['最近启动', '最近启动', '按最近启动排序'],
    favorites: ['收藏', '收藏的游戏', '只显示已收藏的游戏'],
  }[state.view];
  elements.viewTitle.textContent = copy[0];
  elements.sectionTitle.textContent = copy[1];
  elements.sectionSubtitle.textContent = state.search ? `搜索：${state.search}` : copy[2];
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === state.view));
}

function render() {
  updateMetrics();
  updateViewCopy();
  const filteredGames = getFilteredGames();
  elements.content.innerHTML = filteredGames.length
    ? `<div class="game-grid">${filteredGames.map((game) => renderCard(game)).join('')}</div>`
    : renderEmpty(state.view, state.search);
}

/* ---------- Modals ---------- */

function showModal() {
  elements.modalBackdrop.classList.remove('hidden');
  elements.editModal.classList.remove('hidden');
  elements.coverModal.classList.add('hidden');
  elements.settingsModal.classList.add('hidden');
  setTimeout(() => elements.nameInput.focus(), 60);
}

function closeModal() {
  elements.modalBackdrop.classList.add('hidden');
  elements.editModal.classList.add('hidden');
  elements.coverModal.classList.add('hidden');
  elements.settingsModal.classList.add('hidden');
  state.editingId = null;
  state.draftCover = null;
}

function openSettingsModal() {
  elements.modalBackdrop.classList.remove('hidden');
  elements.editModal.classList.add('hidden');
  elements.coverModal.classList.add('hidden');
  elements.settingsModal.classList.remove('hidden');
  applyTheme(state.themeChoice);
}

function showCoverModal() {
  elements.editModal.classList.add('hidden');
  elements.coverModal.classList.remove('hidden');
  elements.coverSearchInput.value = elements.nameInput.value;
  elements.coverSearchInput.focus();
  searchForCovers();
}

function closeCoverModal() {
  elements.coverModal.classList.add('hidden');
  elements.editModal.classList.remove('hidden');
  elements.nameInput.focus();
}

function updateCoverPreview(filePath) {
  elements.coverPreview.innerHTML = filePath
    ? `<img src="${escapeHtml(coverUrl(filePath))}" alt="当前封面" />`
    : '<span class="cover-preview-empty">暂无封面</span>';
}

function openEditModal(id = null) {
  state.editingId = id;
  state.draftCover = null;
  const game = id ? state.games.find((item) => item.id === id) : null;
  elements.editModalTitle.textContent = game ? '编辑游戏' : '导入游戏';
  elements.nameInput.value = game?.name || '';
  elements.exeInput.value = game?.exePath || '';
  elements.argsInput.value = game?.launchArgs || '';
  elements.categoryInput.value = game?.category === '未分类' ? '' : (game?.category || '');
  updateCoverPreview(game?.hasCover ? game.coverPath : '');
  showModal();
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast${type === 'error' ? ' is-error' : ''}`;
  item.textContent = message;
  elements.toastRegion.appendChild(item);
  setTimeout(() => item.remove(), 3200);
}

/* ---------- Persistence ---------- */

function queueSave() {
  state.saveQueue = state.saveQueue
    .then(async () => {
      state.games = (await window.launcherAPI.saveLibrary(state.games)).map(normalizeGame);
      render();
    })
    .catch((error) => toast(error.message || '保存失败', 'error'));
  return state.saveQueue;
}

/* ---------- Game actions ---------- */

async function importExecutable() {
  const filePath = await window.launcherAPI.pickExecutable();
  if (!filePath) return;
  const duplicate = state.games.find((game) => game.exePath.toLowerCase() === filePath.toLowerCase());
  if (duplicate) {
    toast('这个游戏已经在游戏库中了', 'error');
    openEditModal(duplicate.id);
    return;
  }
  openEditModal();
  elements.exeInput.value = filePath;
  if (!elements.nameInput.value) elements.nameInput.value = defaultNameFromPath(filePath);
  elements.nameInput.focus();
}

function defaultNameFromPath(filePath) {
  const fileName = String(filePath).split(/[\\/]/).pop() || '';
  return fileName.replace(/\.exe$/i, '');
}

async function chooseExecutableForForm() {
  const filePath = await window.launcherAPI.pickExecutable();
  if (!filePath) return;
  elements.exeInput.value = filePath;
  if (!elements.nameInput.value) elements.nameInput.value = defaultNameFromPath(filePath);
}

async function chooseLocalCover() {
  try {
    const result = await window.launcherAPI.pickImage();
    if (!result) return;
    state.draftCover = result;
    updateCoverPreview(result.path);
    toast('已选择本地封面');
  } catch (error) {
    toast(error.message || '读取封面失败', 'error');
  }
}

async function saveGame(event) {
  event.preventDefault();
  const name = elements.nameInput.value.trim();
  const exePath = elements.exeInput.value.trim();
  if (!name || !exePath) {
    toast('请填写游戏名称并选择 exe 文件', 'error');
    return;
  }
  const duplicate = state.games.find((game) => game.exePath.toLowerCase() === exePath.toLowerCase() && game.id !== state.editingId);
  if (duplicate) {
    toast('这个 exe 已经被导入过了', 'error');
    return;
  }

  const existing = state.editingId ? state.games.find((game) => game.id === state.editingId) : null;
  const nextGame = normalizeGame({
    ...existing,
    id: existing?.id || createId(),
    name,
    exePath,
    workingDirectory: dirnameOf(exePath),
    launchArgs: elements.argsInput.value.trim(),
    category: elements.categoryInput.value.trim() || '未分类',
    coverFile: state.draftCover?.file || existing?.coverFile || '',
    hasCover: state.draftCover ? true : Boolean(existing?.hasCover),
    createdAt: existing?.createdAt || Date.now(),
    fileExists: true,
  });

  if (existing) {
    state.games = state.games.map((game) => (game.id === existing.id ? nextGame : game));
  } else {
    state.games = [nextGame, ...state.games];
  }
  await queueSave();
  closeModal();
  render();
  toast(existing ? '游戏信息已更新' : '已加入游戏库');
}

async function playGame(id) {
  const game = state.games.find((item) => item.id === id);
  if (!game) return;
  if (state.running.has(id)) {
    await window.launcherAPI.stopGame(id);
    return;
  }
  if (!game.fileExists) {
    toast('找不到游戏文件，请重新选择 exe', 'error');
    openEditModal(id);
    return;
  }
  try {
    const result = await window.launcherAPI.launchGame(game);
    state.running.set(id, { startedAt: result.startedAt });
    game.lastPlayedAt = Date.now();
    game.launchCount = (game.launchCount || 0) + 1;
    await queueSave();
    render();
    toast(`正在启动 ${game.name}`);
  } catch (error) {
    toast(error.message || '启动失败，请检查游戏路径', 'error');
  }
}

async function toggleFavorite(id) {
  const game = state.games.find((item) => item.id === id);
  if (!game) return;
  game.favorite = !game.favorite;
  await queueSave();
  render();
}

async function deleteGame(id) {
  const game = state.games.find((item) => item.id === id);
  if (!game) return;
  if (state.running.has(id)) {
    toast('请先停止正在运行的游戏', 'error');
    return;
  }
  if (!window.confirm(`确定要把“${game.name}”移出游戏库吗？\n\n这不会删除本地的游戏文件。`)) return;
  state.games = state.games.filter((item) => item.id !== id);
  await queueSave();
  render();
  toast('已从游戏库移除');
}

/* ---------- Context menu ---------- */

function closeContextMenu() {
  state.contextMenuGameId = null;
  elements.contextMenu.classList.add('hidden');
}

function openContextMenu(gameId, clientX, clientY) {
  state.contextMenuGameId = gameId;
  elements.contextMenu.classList.remove('hidden');
  const { offsetWidth: menuWidth, offsetHeight: menuHeight } = elements.contextMenu;
  const edge = 10;
  const left = Math.min(clientX, window.innerWidth - menuWidth - edge);
  const top = Math.min(clientY, window.innerHeight - menuHeight - edge);
  elements.contextMenu.style.left = `${Math.max(edge, left)}px`;
  elements.contextMenu.style.top = `${Math.max(edge, top)}px`;
  elements.contextMenu.querySelector('.context-menu-item')?.focus();
}

function handleContextAction(action) {
  const gameId = state.contextMenuGameId;
  closeContextMenu();
  if (!gameId) return;
  if (action === 'remove') return deleteGame(gameId);
  if (action === 'edit') return openEditModal(gameId);
  if (action === 'reveal') {
    const game = state.games.find((item) => item.id === gameId);
    if (game?.exePath) window.launcherAPI.revealGame(game.exePath);
  }
}

/* ---------- Process state ---------- */

async function handleProcessState(payload) {
  const game = state.games.find((item) => item.id === payload.id);
  if (!game) return;
  if (payload.status === 'running') {
    state.running.set(payload.id, { startedAt: payload.startedAt });
    render();
    return;
  }
  state.running.delete(payload.id);
  if (payload.status === 'stopped') {
    game.totalPlaySeconds = (game.totalPlaySeconds || 0) + (payload.durationSeconds || 0);
    await queueSave();
    toast(`${game.name} 已结束，本次游玩 ${formatDuration(payload.durationSeconds)}`);
  } else if (payload.status === 'error') {
    toast(payload.message || '游戏启动失败', 'error');
  }
  render();
}

/* ---------- Covers ---------- */

async function searchForCovers() {
  const query = elements.coverSearchInput.value.trim() || elements.nameInput.value.trim();
  if (!query) {
    elements.coverResults.innerHTML = '<div class="cover-results-empty">先输入游戏名称</div>';
    return;
  }
  elements.coverSearchButton.disabled = true;
  elements.coverSearchButton.textContent = '搜索中';
  elements.coverResults.innerHTML = '<div class="cover-results-empty">正在搜索 Steam 封面…</div>';
  try {
    const results = await window.launcherAPI.searchCovers(query);
    elements.coverResults.innerHTML = results.length
      ? results
          .map(
            (item) =>
              `<button class="cover-result" data-cover-url="${escapeHtml(item.imageUrl)}" title="选择 ${escapeHtml(item.name)}"><img class="cover-result-thumb" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" /><span class="cover-result-name">${escapeHtml(item.name)}</span><span class="cover-result-sub">${escapeHtml(item.subtitle)}</span></button>`,
          )
          .join('')
      : '<div class="cover-results-empty">没有找到封面，可以试试英文名</div>';
  } catch {
    elements.coverResults.innerHTML = '<div class="cover-results-empty">封面搜索暂时不可用，请检查网络后重试</div>';
  } finally {
    elements.coverSearchButton.disabled = false;
    elements.coverSearchButton.textContent = '搜索';
  }
}

async function selectCover(url) {
  try {
    const result = await window.launcherAPI.downloadCover(url);
    state.draftCover = result;
    updateCoverPreview(result.path);
    closeCoverModal();
    toast('封面已保存到本地缓存');
  } catch (error) {
    toast(error.message || '下载封面失败', 'error');
  }
}

/* ---------- Library ---------- */

async function loadLibrary() {
  try {
    state.games = (await window.launcherAPI.loadLibrary()).map(normalizeGame);
    state.running.clear();
    const running = await window.launcherAPI.getRunningGames();
    running.forEach((item) => state.running.set(item.id, { startedAt: item.startedAt }));
    render();
  } catch (error) {
    toast(error.message || '读取游戏库失败', 'error');
  }
}

async function refreshLibraryStatus() {
  try {
    state.games = (await window.launcherAPI.refreshLibraryStatus()).map(normalizeGame);
    render();
    toast('已重新检查游戏文件');
  } catch (error) {
    toast(error.message || '扫描失败', 'error');
  }
}

async function removeMissingGames() {
  const refreshed = (await window.launcherAPI.refreshLibraryStatus()).map(normalizeGame);
  const missingCount = refreshed.filter((game) => !game.fileExists).length;
  if (!missingCount) {
    state.games = refreshed;
    render();
    toast('没有发现失效记录');
    return;
  }
  if (!window.confirm(`发现 ${missingCount} 个失效记录，确定移除吗？\n不会删除任何游戏文件。`)) return;
  state.games = refreshed.filter((game) => game.fileExists);
  await queueSave();
  render();
  toast(`已移除 ${missingCount} 个失效记录`);
}

async function exportLibrary() {
  try {
    const result = await window.launcherAPI.exportLibrary();
    if (!result.canceled) toast('游戏库备份已导出');
  } catch (error) {
    toast(error.message || '导出失败', 'error');
  }
}

async function importLibrary() {
  try {
    const result = await window.launcherAPI.importLibrary();
    if (result.canceled) return;
    state.games = result.games.map(normalizeGame);
    render();
    toast(`已导入 ${result.count} 个游戏记录`);
  } catch (error) {
    toast(error.message || '导入失败，请选择有效的 JSON 备份', 'error');
  }
}

function handleSettingsAction(action) {
  if (action === 'scan') return refreshLibraryStatus();
  if (action === 'remove-missing') return removeMissingGames();
  if (action === 'export') return exportLibrary();
  if (action === 'import') return importLibrary();
  if (action === 'open-data') return window.launcherAPI.openDataFolder();
}

/* ---------- Events ---------- */

let searchTimer = null;

document.querySelectorAll('.nav-item').forEach((item) =>
  item.addEventListener('click', () => {
    state.view = item.dataset.view;
    render();
  }),
);

elements.searchInput.addEventListener('input', (event) => {
  state.search = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 140);
});

elements.sortSelect.addEventListener('change', (event) => {
  state.sort = event.target.value;
  render();
});

$('#importButton').addEventListener('click', importExecutable);
$('#sidebarImport').addEventListener('click', importExecutable);
$('#sidebarData').addEventListener('click', () => window.launcherAPI.openDataFolder());
elements.settingsButton.addEventListener('click', openSettingsModal);
$('#refreshButton').addEventListener('click', loadLibrary);
$('#browseExeButton').addEventListener('click', chooseExecutableForForm);
$('#localCoverButton').addEventListener('click', chooseLocalCover);
$('#findCoverButton').addEventListener('click', showCoverModal);
elements.coverSearchButton.addEventListener('click', searchForCovers);
elements.coverSearchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') searchForCovers();
});
elements.gameForm.addEventListener('submit', saveGame);

elements.content.addEventListener('click', (event) => {
  closeContextMenu();
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action, id } = target.dataset;
  if (action === 'import') return importExecutable();
  if (action === 'edit') return openEditModal(id);
  if (action === 'play' || action === 'stop') return playGame(id);
  if (action === 'favorite') return toggleFavorite(id);
  if (action === 'delete') return deleteGame(id);
  if (action === 'reveal') {
    const game = state.games.find((item) => item.id === id);
    if (game?.exePath) window.launcherAPI.revealGame(game.exePath);
  }
});

elements.content.addEventListener('contextmenu', (event) => {
  const card = event.target.closest('.game-card');
  if (!card) return;
  event.preventDefault();
  openContextMenu(card.dataset.id, event.clientX, event.clientY);
});

elements.contextMenu.addEventListener('click', (event) => {
  const target = event.target.closest('[data-context-action]');
  if (target) handleContextAction(target.dataset.contextAction);
});

elements.coverResults.addEventListener('click', (event) => {
  const target = event.target.closest('[data-cover-url]');
  if (target) selectCover(target.dataset.coverUrl);
});

document.querySelectorAll('[data-close-modal]').forEach((item) => item.addEventListener('click', closeModal));
document.querySelectorAll('[data-close-cover]').forEach((item) => item.addEventListener('click', closeCoverModal));
document.querySelectorAll('[data-close-settings]').forEach((item) => item.addEventListener('click', closeModal));
document.querySelectorAll('[data-theme-choice]').forEach((item) => item.addEventListener('click', () => applyTheme(item.dataset.themeChoice)));
document.querySelectorAll('[data-settings-action]').forEach((item) => item.addEventListener('click', () => handleSettingsAction(item.dataset.settingsAction)));

elements.modalBackdrop.addEventListener('click', (event) => {
  if (event.target !== elements.modalBackdrop) return;
  closeModal();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.contextMenu.classList.contains('hidden')) {
    closeContextMenu();
    return;
  }
  if (event.key === '/' && document.activeElement?.tagName !== 'INPUT') {
    event.preventDefault();
    elements.searchInput.focus();
  }
  if (event.key === 'Escape' && !elements.modalBackdrop.classList.contains('hidden')) {
    if (!elements.coverModal.classList.contains('hidden')) closeCoverModal();
    else closeModal();
  }
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('#gameContextMenu')) closeContextMenu();
});

window.addEventListener('blur', closeContextMenu);
window.addEventListener('resize', closeContextMenu);

window.launcherAPI.onProcessState(handleProcessState);
window.launcherAPI.getVersion().then((version) => {
  $('#versionLabel').textContent = `v${version}`;
});
applyTheme(state.themeChoice);
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (state.themeChoice === 'system') applyTheme('system');
});
loadLibrary();
