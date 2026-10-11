(function () {
  'use strict';

  let DATA = JSON.parse(document.getElementById('data').textContent);
  const SYNC = JSON.parse(document.getElementById('sync-config').textContent);
  const TZ = DATA.timezone_offset || '+08:00';
  const STATE_KEY = 'canvas_state_v3';
  const SYNC_KEY = 'canvas_sync_key_v1';
  const REFRESH_KEY = 'canvas_refresh_key_v1';
  let syncTimer = null;
  let syncInFlight = null;
  let syncQueued = false;
  let lastSyncAttempt = 0;
  let lastWorkflowCheck = 0;
  let latestFailedRunAt = null;

  function startOfWeek(d) { const x = new Date(d), day = (x.getDay() + 6) % 7; x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - day); return x; }
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function fmt(d) { return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }); }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
  function safeColor(s) { return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s || '') ? s : '#888888'; }
  function itemKey(c, a) { return `canvas:${c.id}:${a.item_type || 'assignment'}:${a.source_id || a.id}`; }
  function migrateLegacyKey(key) {
    const parts = String(key).split('|');
    if (parts.length !== 2) return key;
    const course = DATA.courses.find(c => String(c.id) === parts[0]);
    const assignment = course?.assignments?.find(a => String(a.id) === parts[1]);
    return course && assignment ? itemKey(course, assignment) : key;
  }
  function emptyState() { return { version: 3, done: {}, hidden: {} }; }

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
      if (parsed && parsed.version === 3) {
        return { ...parsed, version: 3, done: normalizeGroup(parsed.done), hidden: normalizeGroup(parsed.hidden) };
      }
    } catch (_) {}
    const migrated = emptyState();
    try {
      const oldDone = JSON.parse(localStorage.getItem('done_v1') || '[]');
      const timestamp = Date.now();
      oldDone.forEach(key => { migrated.done[migrateLegacyKey(key)] = { value: true, updatedAt: timestamp }; });
    } catch (_) {}
    localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
    return migrated;
  }

  const state = loadState();
  const genWeek = startOfWeek(new Date(DATA.generated_at));
  let curWeek = new Date(genWeek);
  let viewMode = localStorage.getItem('view_mode_v2') || 'todo';
  let activeCourses = new Set(DATA.courses.map(c => String(c.id)));
  let showCompleted = false;

  function saveState() {
    mergeStoredIntoLocal();
    persistState();
    scheduleCloudWrite();
  }
  function stateValue(group, key) { return Boolean(state[group]?.[key]?.value); }
  function setStateValue(group, key, value) {
    state[group][key] = { value: Boolean(value), updatedAt: Date.now() };
    saveState();
  }
  function isDone(c, a) { return Boolean(a.completed ?? a.submitted) || stateValue('done', itemKey(c, a)); }
  function isHidden(c, a) { return stateValue('hidden', itemKey(c, a)); }
  function typeLabel(a) { return a.type_label || '作业'; }
  function dueBadge(a, completed, currentTime) {
    if (completed) return { cls: 'ok', txt: a.completed ? 'Canvas 已完成' : '已完成' };
    if (!a.due_at) return { cls: 'none', txt: '无截止' };
    const hours = (new Date(a.due_at) - currentTime) / 36e5;
    if (hours < 0) return { cls: 'late', txt: '已逾期' };
    if (hours < 24) return { cls: 'warn', txt: '24 小时内' };
    return { cls: 'ok', txt: `还剩 ${Math.ceil(hours / 24)} 天` };
  }
  function dueText(a) { return a.due_at ? new Date(a.due_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未设置截止时间'; }

  function cardHtml(c, a, currentTime) {
    const completed = isDone(c, a), badge = dueBadge(a, completed, currentTime), key = itemKey(c, a), remote = Boolean(a.completed);
    return `<article class="card${completed ? ' done' : ''}" data-key="${escapeHtml(key)}" data-remote="${remote ? '1' : '0'}"><button class="check${completed ? ' done' : ''}" aria-label="${remote ? 'Canvas 已完成' : (completed ? '取消完成' : '标记完成')}"${remote ? ' disabled' : ''}>✓</button><a class="body" href="${escapeHtml(a.html_url || '#')}" target="_blank" rel="noopener noreferrer"><div class="title">${escapeHtml(a.title)}</div><div class="meta"><span class="course-meta"><i class="course-dot" style="background:${safeColor(c.color)}"></i>${escapeHtml(c.name)}</span><span>${escapeHtml(typeLabel(a))}</span><span>${dueText(a)}</span><span class="badge ${badge.cls}">${badge.txt}</span></div></a><button class="ignore" title="永久忽略" aria-label="永久忽略">🗑</button></article>`;
  }

  function bindCards() {
    document.querySelectorAll('.check').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const card = btn.closest('.card');
        if (card.dataset.remote === '1') return;
        setStateValue('done', card.dataset.key, !stateValue('done', card.dataset.key));
        render();
      };
    });
    document.querySelectorAll('.ignore').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const card = btn.closest('.card');
        if (!confirm('永久忽略这项作业？之后可以在“已忽略”中恢复。')) return;
        setStateValue('hidden', card.dataset.key, true);
        render();
      };
    });
  }

  function allItems() {
    const rows = [];
    DATA.courses.forEach(c => (c.assignments || []).forEach(a => rows.push({ c, a })));
    return rows;
  }
  function selectedItems() {
    return allItems().filter(({ c, a }) => activeCourses.has(String(c.id)) && !isHidden(c, a));
  }
  function renderSection(title, rows, currentTime, cls = '') {
    if (!rows.length) return '';
    return `<section class="section"><div class="sectionhead ${cls}">${title}<span class="cnt">${rows.length} 项</span></div><div class="grid">${rows.map(x => cardHtml(x.c, x.a, currentTime)).join('')}</div></section>`;
  }
  function todoGroup(a, currentTime) {
    if (!a.due_at) return 'undated';
    const due = new Date(a.due_at), today = startOfDay(currentTime), tomorrow = addDays(today, 1), afterTomorrow = addDays(today, 2), weekEnd = addDays(startOfWeek(currentTime), 7);
    if (due < currentTime) return 'overdue';
    if (due < tomorrow) return 'today';
    if (due < afterTomorrow) return 'tomorrow';
    if (due < weekEnd) return 'week';
    return 'later';
  }
  function renderTodo(currentTime) {
    const groups = { overdue: [], today: [], tomorrow: [], week: [], later: [], undated: [] }, rows = selectedItems(), completed = rows.filter(x => isDone(x.c, x.a));
    rows.filter(x => !isDone(x.c, x.a)).sort((x, y) => !x.a.due_at ? 1 : (!y.a.due_at ? -1 : new Date(x.a.due_at) - new Date(y.a.due_at))).forEach(x => groups[todoGroup(x.a, currentTime)].push(x));
    let html = renderSection('已逾期', groups.overdue, currentTime, 'late') + renderSection('今天', groups.today, currentTime, 'warn') + renderSection('明天', groups.tomorrow, currentTime) + renderSection('本周', groups.week, currentTime) + renderSection('之后', groups.later, currentTime) + renderSection('无截止时间', groups.undated, currentTime);
    if (showCompleted) html += renderSection('已完成', completed, currentTime);
    listEl.innerHTML = html || '<div class="empty">待办已经清空 🎉</div>';
    return completed.length;
  }
  function renderWeek(currentTime) {
    const ws = new Date(curWeek), we = addDays(ws, 6), wsTs = ws.getTime(), weTs = addDays(we, 1).getTime();
    rangeEl.textContent = `${fmt(ws)} – ${fmt(we)}`;
    const diff = Math.round((ws - startOfWeek(currentTime)) / (7 * 864e5));
    weekTagEl.textContent = diff === 0 ? '本周' : (diff < 0 ? `${-diff} 周前` : `未来 ${diff} 周`);
    let html = '', completedCount = 0;
    DATA.courses.forEach(c => {
      if (!activeCourses.has(String(c.id))) return;
      const inWeek = (c.assignments || []).filter(a => !isHidden(c, a) && (!a.due_at ? diff === 0 : new Date(a.due_at).getTime() >= wsTs && new Date(a.due_at).getTime() < weTs));
      completedCount += inWeek.filter(a => isDone(c, a)).length;
      const rows = inWeek.filter(a => showCompleted || !isDone(c, a)).sort((a, b) => !a.due_at ? 1 : (!b.due_at ? -1 : new Date(a.due_at) - new Date(b.due_at))).map(a => ({ c, a }));
      html += renderSection(escapeHtml(c.name), rows, currentTime);
    });
    listEl.innerHTML = html || '<div class="empty">这一周没有未完成项目 🎉</div>';
    return completedCount;
  }
  function hiddenCount() { return allItems().filter(({ c, a }) => isHidden(c, a)).length; }
  function render() {
    const currentTime = new Date();
    todoTab.classList.toggle('on', viewMode === 'todo');
    weekTab.classList.toggle('on', viewMode === 'week');
    todoTab.setAttribute('aria-selected', viewMode === 'todo');
    weekTab.setAttribute('aria-selected', viewMode === 'week');
    weekbar.style.display = viewMode === 'week' ? 'flex' : 'none';
    const completedCount = viewMode === 'todo' ? renderTodo(currentTime) : renderWeek(currentTime);
    completedToggle.hidden = completedCount === 0;
    completedToggle.classList.toggle('on', showCompleted);
    completedToggle.textContent = `${showCompleted ? '隐藏' : '显示'}已完成（${completedCount}）`;
    const ignored = hiddenCount();
    ignoredToggle.hidden = ignored === 0;
    ignoredToggle.textContent = `已忽略（${ignored}）`;
    updateStale(currentTime);
    bindCards();
  }
  function renderChips() {
    chipsEl.innerHTML = '';
    const all = document.createElement('button');
    all.className = 'chip' + (activeCourses.size === DATA.courses.length ? ' on' : '');
    all.textContent = '全部';
    all.onclick = () => { activeCourses = new Set(DATA.courses.map(c => String(c.id))); renderChips(); render(); };
    chipsEl.appendChild(all);
    DATA.courses.forEach(c => {
      const id = String(c.id), b = document.createElement('button');
      b.className = 'chip' + (activeCourses.has(id) ? ' on' : '');
      b.innerHTML = `<span class="dot" style="background:${safeColor(c.color)}"></span>${escapeHtml(c.name)}`;
      b.onclick = () => { activeCourses.has(id) ? activeCourses.delete(id) : activeCourses.add(id); renderChips(); render(); };
      chipsEl.appendChild(b);
    });
  }

  function renderIgnored() {
    const rows = allItems().filter(({ c, a }) => isHidden(c, a));
    ignoredList.innerHTML = rows.length ? rows.map(({ c, a }) => `<div class="ignored-row" data-key="${escapeHtml(itemKey(c, a))}"><div class="ignored-title"><div>${escapeHtml(a.title)}</div><small>${escapeHtml(c.name)}</small></div><button class="btn restore">恢复</button></div>`).join('') : '<div class="empty">没有已忽略的作业</div>';
    ignoredList.querySelectorAll('.restore').forEach(btn => {
      btn.onclick = () => { setStateValue('hidden', btn.closest('.ignored-row').dataset.key, false); renderIgnored(); render(); };
    });
  }

  function cloudReady() { return Boolean(SYNC.supabase_url && SYNC.supabase_anon_key); }
  function apiHeaders() {
    const headers = { apikey: SYNC.supabase_anon_key, 'Content-Type': 'application/json' };
    if (!SYNC.supabase_anon_key.startsWith('sb_publishable_')) headers.Authorization = `Bearer ${SYNC.supabase_anon_key}`;
    return headers;
  }
  function normalizeUpdatedAt(value) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0;
  }
  function normalizeEvent(event) {
    if (typeof event === 'boolean') return { value: event, updatedAt: 0 };
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
    return { ...event, value: Boolean(event.value), updatedAt: normalizeUpdatedAt(event.updatedAt) };
  }
  function normalizeGroup(group) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) return {};
    const normalized = {};
    Object.entries(group).forEach(([key, event]) => {
      const validEvent = normalizeEvent(event);
      if (validEvent) normalized[key] = validEvent;
    });
    return normalized;
  }
  function mergeGroup(local, remote) {
    const result = normalizeGroup(local);
    Object.entries(normalizeGroup(remote)).forEach(([key, event]) => {
      if (!result[key] || event.updatedAt > result[key].updatedAt) result[key] = event;
    });
    return result;
  }
  function mergeRemoteIntoLocal(remote) {
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return false;
    const before = stateJSON();
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (_) {}
    state.done = mergeGroup(mergeGroup(state.done, stored?.done), remote.done);
    state.hidden = mergeGroup(mergeGroup(state.hidden, stored?.hidden), remote.hidden);
    state.version = 3;
    persistState();
    return before !== stateJSON();
  }
  function stateJSON() {
    // 固定键顺序，避免标签页之间因 JSON 顺序不同反复触发 storage 事件。
    return JSON.stringify(state, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  }
  function persistState() {
    const serialized = stateJSON();
    if (localStorage.getItem(STATE_KEY) !== serialized) localStorage.setItem(STATE_KEY, serialized);
  }
  function mergeStoredIntoLocal() {
    try { return mergeRemoteIntoLocal(JSON.parse(localStorage.getItem(STATE_KEY) || 'null')); }
    catch (_) { return false; }
  }
  function needsCloudWrite(remote) {
    return ['done', 'hidden'].some(group => {
      const remoteGroup = normalizeGroup(remote?.[group]);
      return Object.entries(state[group]).some(([key, event]) => !remoteGroup[key] || event.updatedAt > remoteGroup[key].updatedAt);
    });
  }
  async function syncRequest(name, body) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${SYNC.supabase_url}/rest/v1/rpc/${name}`, {
        method: 'POST', headers: apiHeaders(), body: JSON.stringify(body), signal: controller.signal,
      });
      return { ok: response.ok, status: response.status, data: response.ok && name !== 'write_canvas_state' ? await response.json() : null };
    } finally { clearTimeout(timeout); }
  }
  async function performCloudSync() {
    const key = localStorage.getItem(SYNC_KEY);
    if (!cloudReady() || !key) return;
    lastSyncAttempt = Date.now();
    setSyncStatus('正在同步…');
    let changed = mergeStoredIntoLocal();
    try {
      const read = await syncRequest('read_canvas_state', { p_id: key });
      if (localStorage.getItem(SYNC_KEY) !== key) return;
      if (!read.ok) throw new Error(`读取失败 ${read.status}`);
      const remote = read.data;
      if (remote !== null && (typeof remote !== 'object' || Array.isArray(remote))) throw new Error('读取状态格式无效');
      changed = mergeRemoteIntoLocal(remote) || changed;

      if (needsCloudWrite(remote)) {
        const merge = await syncRequest('merge_canvas_state', { p_id: key, p_payload: state });
        if (localStorage.getItem(SYNC_KEY) !== key) return;
        if (merge.ok) {
          changed = mergeRemoteIntoLocal(merge.data) || changed;
        } else if (merge.status === 404) {
          // 兼容尚未升级 SQL 的旧部署；新版 write RPC 同样执行原子合并。
          const write = await syncRequest('write_canvas_state', { p_id: key, p_payload: state });
          if (localStorage.getItem(SYNC_KEY) !== key) return;
          if (!write.ok) throw new Error(`写入失败 ${write.status}`);
        } else {
          throw new Error(`合并失败 ${merge.status}`);
        }
      }
      setSyncStatus(`已同步 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
      if (changed) { render(); if (ignoredDialog.open) renderIgnored(); }
    } catch (error) {
      if (localStorage.getItem(SYNC_KEY) !== key) return;
      if (changed) { render(); if (ignoredDialog.open) renderIgnored(); }
      setSyncStatus(`同步失败：${error.message}；本地记录已保留，恢复联网后重试`);
    }
  }
  function syncCloud() {
    clearTimeout(syncTimer); syncTimer = null;
    if (syncInFlight) {
      syncQueued = true;
      return syncInFlight;
    }
    syncInFlight = performCloudSync().finally(() => {
      syncInFlight = null;
      if (syncQueued) {
        syncQueued = false;
        syncCloud();
      }
    });
    return syncInFlight;
  }
  function scheduleCloudWrite() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncCloud, 500);
  }
  function resumeCloudSync(force = false) {
    if (document.visibilityState !== 'visible' || navigator.onLine === false || syncInFlight || syncTimer) return;
    if (!force && Date.now() - lastSyncAttempt < 5000) return;
    syncCloud();
  }
  function setSyncStatus(text) { syncStatus.textContent = text; syncBtn.textContent = text.startsWith('同步失败') ? '⚠️' : '☁️'; }

  const listEl = document.getElementById('list'), chipsEl = document.getElementById('chips'), rangeEl = document.getElementById('range'), weekTagEl = document.getElementById('weekTag'), weekbar = document.getElementById('weekbar'), todoTab = document.getElementById('todoTab'), weekTab = document.getElementById('weekTab'), completedToggle = document.getElementById('completedToggle'), ignoredToggle = document.getElementById('ignoredToggle'), ignoredDialog = document.getElementById('ignoredDialog'), ignoredList = document.getElementById('ignoredList'), syncDialog = document.getElementById('syncDialog'), syncBtn = document.getElementById('syncBtn'), syncKeyInput = document.getElementById('syncKeyInput'), syncStatus = document.getElementById('syncStatus');
  todoTab.onclick = () => { viewMode = 'todo'; showCompleted = false; localStorage.setItem('view_mode_v2', viewMode); render(); };
  weekTab.onclick = () => { viewMode = 'week'; showCompleted = false; localStorage.setItem('view_mode_v2', viewMode); render(); };
  completedToggle.onclick = () => { showCompleted = !showCompleted; render(); };
  ignoredToggle.onclick = () => { renderIgnored(); ignoredDialog.showModal(); };
  document.getElementById('prevWk').onclick = () => { curWeek = addDays(curWeek, -7); showCompleted = false; render(); };
  document.getElementById('nextWk').onclick = () => { curWeek = addDays(curWeek, 7); showCompleted = false; render(); };
  document.querySelectorAll('[data-close]').forEach(btn => { btn.onclick = () => document.getElementById(btn.dataset.close).close(); });
  syncBtn.onclick = () => { syncKeyInput.value = localStorage.getItem(SYNC_KEY) || ''; setSyncStatus(cloudReady() ? (syncKeyInput.value ? '已配置同步码' : '请生成或输入同步码') : '云端服务尚未配置'); syncDialog.showModal(); };
  document.getElementById('generateSyncKey').onclick = () => { syncKeyInput.value = crypto.randomUUID(); };
  document.getElementById('saveSyncKey').onclick = async () => {
    const key = syncKeyInput.value.trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)) { setSyncStatus('同步码格式不正确，请点击“生成同步码”'); return; }
    localStorage.setItem(SYNC_KEY, key);
    await syncCloud();
  };

  let generatedAt = new Date(DATA.generated_at), staleAfter = Number(DATA.stale_after_hours || 16), lastSuccessText;
  const staleEl = document.getElementById('stale');
  function updateSnapshotLabel() {
    lastSuccessText = Number.isFinite(generatedAt.getTime())
      ? generatedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
      : '时间未知';
    document.getElementById('sub').textContent = `共 ${DATA.courses.length} 门课 · 上次成功更新：${lastSuccessText}（北京时间）`;
  }
  function applyLatestData(latest) {
    if (!window.CanvasRefresh.validSnapshot(latest)) throw new Error('新数据格式无效，已保留旧任务');
    const allSelected = activeCourses.size === DATA.courses.length, scrollTop = window.scrollY;
    DATA = latest;
    activeCourses = new Set(latest.courses.filter(c => allSelected || activeCourses.has(String(c.id))).map(c => String(c.id)));
    generatedAt = new Date(latest.generated_at);
    staleAfter = Number(latest.stale_after_hours || 16);
    updateSnapshotLabel();
    renderChips(); render();
    if (ignoredDialog.open) renderIgnored();
    if (typeof window.scrollTo === 'function') window.scrollTo(0, scrollTop);
  }

  const refreshBtn = document.getElementById('refreshBtn'), refreshStatus = document.getElementById('refreshStatus'), refreshDialog = document.getElementById('refreshDialog'), refreshKeyInput = document.getElementById('refreshKeyInput'), refreshKeyStatus = document.getElementById('refreshKeyStatus');
  function setRefreshProgress(phase, error) {
    const busy = phase === 'requesting' || phase === 'waiting';
    refreshBtn.disabled = busy;
    refreshBtn.setAttribute('aria-busy', String(busy));
    refreshBtn.textContent = busy ? '更新中…' : '从 Canvas 更新';
    refreshStatus.textContent = phase === 'requesting' ? '正在请求更新…' : phase === 'waiting' ? '正在从 Canvas 抓取并发布，可能需要几分钟；可以继续查看任务。' : phase === 'success' ? '已更新为最新任务' : `更新未完成：${error?.message || '网络连接失败，请稍后重试'}。当前任务已保留。`;
  }
  const canvasRefresher = SYNC.refresh_url && window.CanvasRefresh
    ? window.CanvasRefresh.createRefresher({ endpoint: SYNC.refresh_url, applyData: applyLatestData, onProgress: setRefreshProgress }) : null;
  function openRefreshSettings() {
    refreshKeyInput.value = localStorage.getItem(REFRESH_KEY) || '';
    refreshKeyStatus.textContent = '';
    refreshDialog.showModal();
  }
  async function refreshCanvas() {
    if (!canvasRefresher) { refreshStatus.textContent = '云端刷新入口尚未配置'; return; }
    const key = localStorage.getItem(REFRESH_KEY);
    if (!key) { openRefreshSettings(); return; }
    try { await canvasRefresher.refresh(key); }
    catch (error) {
      if (error.status === 401) {
        openRefreshSettings();
        refreshKeyStatus.textContent = '刷新码不正确，请填写 Supabase 中 CANVAS_REFRESH_KEY 的值。';
      }
    }
  }
  refreshBtn.onclick = refreshCanvas;
  document.getElementById('refreshSettings').onclick = openRefreshSettings;
  document.getElementById('saveRefreshKey').onclick = async () => {
    const key = refreshKeyInput.value.trim();
    if (!/^[\x21-\x7e]{32,256}$/.test(key)) {
      refreshKeyStatus.textContent = '请填写至少 32 位的刷新码（不含空格或中文），不是 GitHub Token。';
      refreshKeyInput.focus(); return;
    }
    try { localStorage.setItem(REFRESH_KEY, key); }
    catch (_) { refreshKeyStatus.textContent = '无法在此浏览器保存刷新码，请检查隐私设置。'; return; }
    refreshDialog.close();
    await refreshCanvas();
  };
  function updateStale(currentTime) {
    const ageHours = (currentTime - generatedAt) / 36e5;
    const failedAfterSuccess = latestFailedRunAt && latestFailedRunAt > generatedAt;
    staleEl.style.display = failedAfterSuccess || !Number.isFinite(ageHours) || ageHours > staleAfter ? 'block' : 'none';
    staleEl.textContent = failedAfterSuccess
      ? `最近一次自动更新失败；上次成功更新：${lastSuccessText}（北京时间）。当前显示的仍是上次成功获取的数据，请以 Canvas 为准。`
      : !Number.isFinite(ageHours)
      ? '无法确认上次成功更新时间，请以 Canvas 为准。'
      : (ageHours > staleAfter ? `距上次成功更新已 ${Math.floor(ageHours)} 小时（${lastSuccessText}，北京时间）。自动更新可能延迟或失败，请以 Canvas 为准。` : '');
  }
  async function checkWorkflowStatus() {
    if (Date.now() - lastWorkflowCheck < 15 * 60 * 1000) return;
    lastWorkflowCheck = Date.now();
    try {
      const response = await fetch('https://api.github.com/repos/lovles0/canvas-/actions/workflows/sync.yml/runs?per_page=5', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      const run = (Array.isArray(data.workflow_runs) ? data.workflow_runs : []).find(item => item.status === 'completed');
      latestFailedRunAt = run?.conclusion === 'failure' ? new Date(run.created_at) : null;
      updateStale(new Date());
    } catch (_) {} // 无法读取运行状态时，仍按生成时间提示数据是否过期。
  }
  updateSnapshotLabel();
  document.getElementById('foot').innerHTML = `数据由 GitHub Actions 定时从 Canvas 同步 · 时区 ${escapeHtml(TZ)} · <a href="apple-reminders.html"> Apple 提醒事项设置</a>`;
  const themeBtn = document.getElementById('themeBtn'), savedTheme = localStorage.getItem('theme'), prefersDark = window.matchMedia('(prefers-color-scheme:dark)').matches;
  let theme = savedTheme || (prefersDark ? 'dark' : 'light');
  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); themeBtn.textContent = t === 'dark' ? '☀️' : '🌙'; }
  applyTheme(theme);
  themeBtn.onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('theme', theme); applyTheme(theme); };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { render(); checkWorkflowStatus(); resumeCloudSync(); }
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { render(); checkWorkflowStatus(); resumeCloudSync(); }
  });
  window.addEventListener('online', () => resumeCloudSync(true));
  window.addEventListener('storage', event => {
    if (event.key === STATE_KEY && event.newValue) {
      try {
        const changed = mergeRemoteIntoLocal(JSON.parse(event.newValue));
        if (changed) { render(); if (ignoredDialog.open) renderIgnored(); }
      } catch (_) {} // 无效或被清除的存储不删除当前页面已有记录。
    } else if (event.key === SYNC_KEY && event.newValue) {
      syncCloud();
    }
  });
  setInterval(resumeCloudSync, 60000);

  renderChips();
  render();
  syncCloud();
  checkWorkflowStatus();
})();
