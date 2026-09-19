(function () {
  'use strict';

  const DATA = JSON.parse(document.getElementById('data').textContent);
  const SYNC = JSON.parse(document.getElementById('sync-config').textContent);
  const TZ = DATA.timezone_offset || '+08:00';
  const STATE_KEY = 'canvas_state_v3';
  const SYNC_KEY = 'canvas_sync_key_v1';
  let syncTimer = null;
  let syncInFlight = null;
  let syncQueued = false;

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
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
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
  function apiHeaders() { return { apikey: SYNC.supabase_anon_key, Authorization: `Bearer ${SYNC.supabase_anon_key}`, 'Content-Type': 'application/json' }; }
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
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return;
    state.done = mergeGroup(state.done, remote.done);
    state.hidden = mergeGroup(state.hidden, remote.hidden);
    state.version = 3;
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  }
  async function performCloudSync() {
    const key = localStorage.getItem(SYNC_KEY);
    if (!cloudReady() || !key) return;
    setSyncStatus('正在同步…');
    try {
      const read = await fetch(`${SYNC.supabase_url}/rest/v1/rpc/read_canvas_state`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ p_id: key }) });
      if (!read.ok) throw new Error(`读取失败 ${read.status}`);
      const remote = await read.json();
      mergeRemoteIntoLocal(remote);

      const merge = await fetch(`${SYNC.supabase_url}/rest/v1/rpc/merge_canvas_state`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ p_id: key, p_payload: state }) });
      if (merge.ok) {
        mergeRemoteIntoLocal(await merge.json());
      } else if (merge.status === 404) {
        // 兼容尚未重新执行新版 SQL 的现有部署；升级 schema 后会自动使用原子合并。
        const write = await fetch(`${SYNC.supabase_url}/rest/v1/rpc/write_canvas_state`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ p_id: key, p_payload: state }) });
        if (!write.ok) throw new Error(`写入失败 ${write.status}`);
      } else {
        throw new Error(`合并失败 ${merge.status}`);
      }
      setSyncStatus(`已同步 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
      render();
    } catch (error) {
      setSyncStatus(`同步失败：${error.message}`);
    }
  }
  function syncCloud() {
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

  const generatedAt = new Date(DATA.generated_at), staleAfter = Number(DATA.stale_after_hours || 36), staleEl = document.getElementById('stale');
  function updateStale(currentTime) {
    const ageHours = (currentTime - generatedAt) / 36e5;
    staleEl.style.display = !Number.isFinite(ageHours) || ageHours > staleAfter ? 'block' : 'none';
    staleEl.textContent = !Number.isFinite(ageHours) ? '无法确认数据更新时间，请以 Canvas 为准。' : (ageHours > staleAfter ? `数据已 ${Math.floor(ageHours)} 小时未更新，可能不是最新状态，请以 Canvas 为准。` : '');
  }
  document.getElementById('sub').textContent = `共 ${DATA.courses.length} 门课 · 更新于 ${generatedAt.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  document.getElementById('foot').innerHTML = `数据由 GitHub Actions 定时从 Canvas 同步 · 时区 ${escapeHtml(TZ)} · <a href="apple-reminders.html"> Apple 提醒事项设置</a>`;
  const themeBtn = document.getElementById('themeBtn'), savedTheme = localStorage.getItem('theme'), prefersDark = window.matchMedia('(prefers-color-scheme:dark)').matches;
  let theme = savedTheme || (prefersDark ? 'dark' : 'light');
  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); themeBtn.textContent = t === 'dark' ? '☀️' : '🌙'; }
  applyTheme(theme);
  themeBtn.onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('theme', theme); applyTheme(theme); };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') render();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) render();
  });

  renderChips();
  render();
  syncCloud();
})();
