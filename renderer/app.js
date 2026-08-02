const $ = (selector) => document.querySelector(selector);

const state = {
  games: [],
  view: 'library',
  search: '',
  sort: 'added',
  editingId: null,
  draftCover: null,
  running: new Map(),
  saveQueue: Promise.resolve(),
  themeChoice: localStorage.getItem('northstar-theme') || 'dark',
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
  viewKicker: $('#viewKicker'),
  searchInput: $('#searchInput'),
  sortSelect: $('#sortSelect'),
  modalBackdrop: $('#modalBackdrop'),
  editModal: $('#editModal'),
  coverModal: $('#coverModal'),
  gameForm: $('#gameForm'),
  editModalTitle: $('#editModalTitle'),
  editModalKicker: $('#editModalKicker'),
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

function resolveTheme(choice) {
  if (choice === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return choice === 'light' ? 'light' : 'dark';
}

function applyTheme(choice = state.themeChoice) {
  state.themeChoice = choice;
  localStorage.setItem('northstar-theme', choice);
  document.documentElement.dataset.theme = resolveTheme(choice);
  document.querySelectorAll('[data-theme-choice]').forEach((option) => {
    option.classList.toggle('active', option.dataset.themeChoice === choice);
  });
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
    id: game.id || crypto.randomUUID(),
    name: game.name || '未命名游戏',
    exePath: game.exePath || '',
    workingDirectory: game.workingDirectory || '',
    launchArgs: game.launchArgs || '',
    coverPath: game.coverPath || '',
    coverDataUrl: game.coverDataUrl || '',
    category: game.category || '未分类',
    favorite: Boolean(game.favorite),
    createdAt: game.createdAt || Date.now(),
    lastPlayedAt: game.lastPlayedAt || 0,
    totalPlaySeconds: Number(game.totalPlaySeconds) || 0,
    launchCount: Number(game.launchCount) || 0,
    fileExists: game.fileExists !== false,
  };
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes ? ` ${minutes}m` : ''}`;
  if (minutes > 0) return `${minutes}m`;
  return total > 0 ? `${total}s` : '未启动';
}

function formatTotalDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes ? ` ${minutes}m` : ''}`;
  return minutes > 0 ? `${minutes}m` : '0h';
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return '暂无';
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

function getFilteredGames() {
  const query = state.search.trim().toLowerCase();
  let games = state.games.filter((game) => {
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

function renderCover(game, compact = false) {
  if (game.coverDataUrl) {
    return `<img class="${compact ? 'cover-preview-image' : 'game-cover'}" src="${escapeHtml(game.coverDataUrl)}" alt="${escapeHtml(game.name)} 封面" />`;
  }
  return `<div class="cover-placeholder"><span class="placeholder-glyph">✦</span><span class="placeholder-label">${escapeHtml(game.name)}</span></div>`;
}

function renderCard(game) {
  const isRunning = state.running.has(game.id);
  const missing = !game.fileExists;
  const runtimeLabel = isRunning ? '正在运行' : formatDuration(game.totalPlaySeconds);
  return `
    <article class="game-card ${missing ? 'missing' : ''}" data-id="${escapeHtml(game.id)}">
      <div class="game-cover-wrap">
        ${renderCover(game)}
        <span class="cover-badge">${escapeHtml(game.category || '未分类')}</span>
        ${isRunning ? '<span class="cover-running">RUNNING</span>' : ''}
        <button class="favorite-button ${game.favorite ? 'active' : ''}" data-action="favorite" data-id="${escapeHtml(game.id)}" title="${game.favorite ? '取消收藏' : '收藏'}">${game.favorite ? '★' : '☆'}</button>
      </div>
      <div class="card-body">
        <button class="card-main" data-action="edit" data-id="${escapeHtml(game.id)}"><span class="game-name">${escapeHtml(game.name)}</span><span class="game-category">${escapeHtml(formatRelativeTime(game.lastPlayedAt))} · ${game.launchCount || 0} 次启动</span></button>
        <div class="card-footer">
          ${missing ? '<span class="missing-label">文件不存在</span>' : `<span class="game-time">${isRunning ? '运行中' : `游玩 ${runtimeLabel}`}</span>`}
          <div class="card-tools">
            <button class="mini-action" data-action="reveal" data-id="${escapeHtml(game.id)}" title="在文件夹中显示">⌁</button>
            <button class="mini-action" data-action="delete" data-id="${escapeHtml(game.id)}" data-tooltip="删除游戏" title="删除游戏">×</button>
            <button class="play-button ${isRunning ? 'running' : ''}" data-action="${isRunning ? 'stop' : 'play'}" data-id="${escapeHtml(game.id)}" title="${isRunning ? '停止游戏' : '启动游戏'}"><span>${isRunning ? '■' : '▶'}</span>${isRunning ? '停止' : '启动'}</button>
          </div>
        </div>
      </div>
    </article>`;
}

function renderEmpty(view, query) {
  let title = '游戏库还是空的';
  let copy = '导入一个游戏，开始建立你的本地收藏。';
  if (query) {
    title = '没有找到匹配的游戏';
    copy = '换个关键词，或者检查游戏名称。';
  } else if (view === 'favorites') {
    title = '还没有收藏';
    copy = '把常玩的游戏标记为收藏，它们会出现在这里。';
  } else if (view === 'recent') {
    title = '还没有启动记录';
    copy = '启动一次游戏后，最近启动列表会显示在这里。';
  }
  return `<div class="empty-state"><div><div class="empty-visual"><span>✦</span></div><h3>${title}</h3><p>${copy}</p>${!query && view === 'library' ? '<button class="primary-button" data-action="import"><span>＋</span> 导入第一个游戏</button>' : ''}</div></div>`;
}

function updateMetrics() {
  const totalSeconds = state.games.reduce((sum, game) => sum + (game.totalPlaySeconds || 0), 0);
  const latest = state.games.slice().sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))[0];
  elements.allCount.textContent = state.games.length;
  elements.favoriteCount.textContent = state.games.filter((game) => game.favorite).length;
  elements.totalMetric.textContent = state.games.length;
  elements.timeMetric.textContent = formatTotalDuration(totalSeconds);
  elements.lastMetric.textContent = latest?.lastPlayedAt ? formatRelativeTime(latest.lastPlayedAt) : '暂无';
}

function updateViewCopy() {
  const copy = {
    library: ['YOUR COLLECTION', '游戏库', '全部游戏', '按最近添加排序'],
    recent: ['PLAY HISTORY', '最近启动', '最近启动', '按最近启动排序'],
    favorites: ['YOUR SHORTLIST', '我的收藏', '收藏游戏', '只显示已收藏游戏'],
  }[state.view];
  elements.viewKicker.textContent = copy[0];
  elements.viewTitle.textContent = copy[1];
  elements.sectionTitle.textContent = copy[2];
  elements.sectionSubtitle.textContent = state.search ? `搜索：${state.search}` : copy[3];
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

function showModal() {
  elements.modalBackdrop.classList.remove('hidden');
  elements.editModal.classList.remove('hidden');
  elements.coverModal.classList.add('hidden');
  setTimeout(() => elements.nameInput.focus(), 60);
}

function closeModal() {
  elements.modalBackdrop.classList.add('hidden');
  elements.editModal.classList.remove('hidden');
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

function closeSettingsModal() {
  elements.modalBackdrop.classList.add('hidden');
  elements.settingsModal.classList.add('hidden');
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

function openEditModal(id = null) {
  state.editingId = id;
  state.draftCover = null;
  const game = id ? state.games.find((item) => item.id === id) : null;
  elements.editModalKicker.textContent = game ? 'GAME PROFILE' : 'NEW ENTRY';
  elements.editModalTitle.textContent = game ? '编辑游戏' : '导入游戏';
  elements.nameInput.value = game?.name || '';
  elements.exeInput.value = game?.exePath || '';
  elements.argsInput.value = game?.launchArgs || '';
  elements.categoryInput.value = game?.category === '未分类' ? '' : (game?.category || '');
  updateCoverPreview(game?.coverDataUrl || '');
  showModal();
}

function updateCoverPreview(dataUrl) {
  elements.coverPreview.innerHTML = dataUrl
    ? `<img src="${escapeHtml(dataUrl)}" alt="当前封面" />`
    : '<span class="cover-placeholder-mark">✦</span><span>暂无封面</span>';
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.innerHTML = `<span class="toast-icon">${type === 'error' ? '!' : '✓'}</span><span>${escapeHtml(message)}</span>`;
  elements.toastRegion.appendChild(item);
  setTimeout(() => item.remove(), 3300);
}

function queueSave() {
  state.saveQueue = state.saveQueue.then(async () => {
    state.games = await window.launcherAPI.saveLibrary(state.games);
    render();
  }).catch((error) => toast(error.message || '保存失败', 'error'));
  return state.saveQueue;
}

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
  if (!elements.nameInput.value) {
    const fileName = filePath.split(/[\\/]/).pop() || '';
    elements.nameInput.value = fileName.replace(/\.exe$/i, '');
  }
  elements.nameInput.focus();
}

async function chooseExecutableForForm() {
  const filePath = await window.launcherAPI.pickExecutable();
  if (!filePath) return;
  elements.exeInput.value = filePath;
  if (!elements.nameInput.value) {
    const fileName = filePath.split(/[\\/]/).pop() || '';
    elements.nameInput.value = fileName.replace(/\.exe$/i, '');
  }
}

async function chooseLocalCover() {
  try {
    const result = await window.launcherAPI.pickImage();
    if (!result) return;
    state.draftCover = result;
    updateCoverPreview(result.dataUrl);
    toast('本地封面已选择');
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
    id: existing?.id || crypto.randomUUID(),
    name,
    exePath,
    workingDirectory: exePath.replace(/[\\/][^\\/]*$/, ''),
    launchArgs: elements.argsInput.value.trim(),
    category: elements.categoryInput.value.trim() || '未分类',
    coverPath: state.draftCover?.path || existing?.coverPath || '',
    coverDataUrl: state.draftCover?.dataUrl || existing?.coverDataUrl || '',
    createdAt: existing?.createdAt || Date.now(),
    fileExists: true,
  });
  if (existing) {
    state.games = state.games.map((game) => game.id === existing.id ? nextGame : game);
  } else {
    state.games = [nextGame, ...state.games];
  }
  await queueSave();
  closeModal();
  render();
  toast(existing ? '游戏信息已更新' : '游戏已加入游戏库');
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
  if (!window.confirm(`确定要从游戏库移出“${game.name}”吗？\n\n这不会删除你的本地游戏。`)) return;
  state.games = state.games.filter((item) => item.id !== id);
  await queueSave();
  render();
  toast('游戏已从库中移除');
}

function closeContextMenu() {
  state.contextMenuGameId = null;
  elements.contextMenu.classList.add('hidden');
}

function openContextMenu(gameId, clientX, clientY) {
  state.contextMenuGameId = gameId;
  elements.contextMenu.classList.remove('hidden');
  const menuWidth = elements.contextMenu.offsetWidth;
  const menuHeight = elements.contextMenu.offsetHeight;
  const edgePadding = 10;
  const left = Math.min(clientX, window.innerWidth - menuWidth - edgePadding);
  const top = Math.min(clientY, window.innerHeight - menuHeight - edgePadding);
  elements.contextMenu.style.left = `${Math.max(edgePadding, left)}px`;
  elements.contextMenu.style.top = `${Math.max(edgePadding, top)}px`;
  elements.contextMenu.querySelector('.context-menu-item')?.focus();
}

async function handleContextAction(action) {
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

async function searchForCovers() {
  const query = elements.coverSearchInput.value.trim() || elements.nameInput.value.trim();
  if (!query) {
    elements.coverResults.innerHTML = '<div class="cover-search-empty">先输入游戏名称</div>';
    return;
  }
  elements.coverSearchButton.disabled = true;
  elements.coverSearchButton.innerHTML = '<span>…</span> 搜索中';
  elements.coverResults.innerHTML = '<div class="cover-search-empty">正在搜索 Steam 封面…</div>';
  try {
    const results = await window.launcherAPI.searchCovers(query);
    elements.coverResults.innerHTML = results.length
      ? results.map((item) => `<button class="cover-result" data-cover-url="${escapeHtml(item.imageUrl)}" title="选择 ${escapeHtml(item.name)}"><img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}" /><span class="cover-result-copy"><span class="cover-result-name">${escapeHtml(item.name)}</span><span class="cover-result-subtitle">${escapeHtml(item.subtitle)}</span></span></button>`).join('')
      : '<div class="cover-search-empty">没有找到封面，可以尝试英文名称</div>';
  } catch {
    elements.coverResults.innerHTML = '<div class="cover-search-empty">封面搜索暂时不可用，请检查网络后重试</div>';
  } finally {
    elements.coverSearchButton.disabled = false;
    elements.coverSearchButton.innerHTML = '<span>⌕</span> 搜索';
  }
}

async function selectCover(url) {
  try {
    const result = await window.launcherAPI.downloadCover(url);
    state.draftCover = result;
    updateCoverPreview(result.dataUrl);
    closeCoverModal();
    toast('封面已加入本地缓存');
  } catch (error) {
    toast(error.message || '下载封面失败', 'error');
  }
}

async function loadLibrary() {
  try {
    state.games = (await window.launcherAPI.loadLibrary()).map(normalizeGame);
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
    toast('游戏路径状态已更新');
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
    toast('没有发现失效游戏记录');
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

async function handleSettingsAction(action) {
  if (action === 'scan') return refreshLibraryStatus();
  if (action === 'remove-missing') return removeMissingGames();
  if (action === 'export') return exportLibrary();
  if (action === 'import') return importLibrary();
  if (action === 'open-data') return window.launcherAPI.openDataFolder();
}

document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => {
  state.view = item.dataset.view;
  render();
}));

elements.searchInput.addEventListener('input', (event) => {
  state.search = event.target.value;
  render();
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

elements.content.addEventListener('click', async (event) => {
  closeContextMenu();
  const actionTarget = event.target.closest('[data-action]');
  if (!actionTarget) return;
  const action = actionTarget.dataset.action;
  const id = actionTarget.dataset.id;
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
  const actionTarget = event.target.closest('[data-context-action]');
  if (actionTarget) handleContextAction(actionTarget.dataset.contextAction);
});

elements.coverResults.addEventListener('click', (event) => {
  const target = event.target.closest('[data-cover-url]');
  if (target) selectCover(target.dataset.coverUrl);
});

document.querySelectorAll('[data-close-modal]').forEach((item) => item.addEventListener('click', closeModal));
document.querySelectorAll('[data-close-cover]').forEach((item) => item.addEventListener('click', closeCoverModal));
document.querySelectorAll('[data-close-settings]').forEach((item) => item.addEventListener('click', closeSettingsModal));
document.querySelectorAll('[data-theme-choice]').forEach((item) => item.addEventListener('click', () => applyTheme(item.dataset.themeChoice)));
document.querySelectorAll('[data-settings-action]').forEach((item) => item.addEventListener('click', () => handleSettingsAction(item.dataset.settingsAction)));
elements.modalBackdrop.addEventListener('click', (event) => {
  if (event.target !== elements.modalBackdrop) return;
  if (!elements.settingsModal.classList.contains('hidden')) closeSettingsModal();
  else closeModal();
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
window.launcherAPI.getVersion().then((version) => { $('#versionLabel').textContent = `v${version}`; });
applyTheme(state.themeChoice);
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (state.themeChoice === 'system') applyTheme('system');
});
loadLibrary();
