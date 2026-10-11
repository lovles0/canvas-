const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const clone = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const assignment = (id, extra = {}) => ({ id, title: `任务 ${id}`, item_type: 'assignment', completed: false, due_at: '2026-10-12T20:00:00+08:00', ...extra });
const snapshot = (time = '12:00', items = [assignment(1)]) => ({ generated_at: `2026-10-11T${time}:00+08:00`, courses: [{ id: 1, name: '测试课程', color: '#2563eb', assignments: items }] });

function app({ data = snapshot(), stored = {}, latest = () => data } = {}) {
  const storage = new Map(Object.entries(stored)), elements = new Map(), listeners = { document: {}, window: {} }, timers = new Map(), requests = [];
  let time = Date.parse('2026-10-11T12:00:00+08:00'), timerId = 0, renders = 0;
  const element = id => {
    if (!elements.has(id)) {
      let html = '';
      const item = { textContent: '', hidden: false, style: {}, dataset: {}, children: [], classList: { toggle() {} }, setAttribute() {}, appendChild(child) { this.children.push(child); }, querySelectorAll: () => [], showModal() { this.open = true; }, close() { this.open = false; } };
      Object.defineProperty(item, 'innerHTML', { get: () => html, set: value => { html = value; item.children = []; if (id === 'list') renders++; } });
      elements.set(id, item);
    }
    return elements.get(id);
  };
  element('data').textContent = JSON.stringify(data);
  element('sync-config').textContent = '{}';
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const add = (surface, name, fn) => { (listeners[surface][name] ||= []).push(fn); };
  const context = {
    console, Date: Clock, AbortController, navigator: { onLine: true }, crypto: { randomUUID: () => '9ed32369-5cae-4876-a2af-59c2b70d5104' },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    document: { visibilityState: 'visible', documentElement: { setAttribute() {} }, getElementById: element, createElement: () => element(`new-${elements.size}`), querySelectorAll: () => [], addEventListener: (name, fn) => add('document', name, fn) },
    window: { CanvasRefresh: require('../refresh.js'), scrollY: 240, scrollTo(_, y) { this.scrollY = y; }, matchMedia: () => ({ matches: false }), addEventListener: (name, fn) => add('window', name, fn) },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: time + ms }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: time + ms, interval: ms }); return id; },
    fetch: async (url, options = {}) => {
      if (String(url).startsWith('https://api.github.com/')) return { ok: true, json: async () => ({ workflow_runs: [] }) };
      requests.push({ url, options });
      if (!/^data\.json\?/.test(url)) throw new Error(`Unexpected endpoint ${url}`);
      const result = await latest(options);
      return result?.json ? result : { ok: true, json: async () => clone(result) };
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n').replace('  renderChips();\n  render();', '  globalThis.api = { applyLatestData, setStateValue };\n  renderChips();\n  render();');
  vm.runInNewContext(source, context, { filename: 'app.js' });
  return { ...context.api, context, element, storage, requests, renderCount: () => renders,
    event: (surface, name, event = {}) => (listeners[surface][name] || []).forEach(fn => fn(event)),
    advance: ms => { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { if (timer.interval) timer.at = time + timer.interval; else timers.delete(id); timer.fn(); } },
  };
}

test('打开旧页面时自动显示最新发布任务，不派发 Canvas 抓取', async () => {
  const a = app({ latest: () => snapshot('12:01', [assignment(2, { title: '最新任务' })]) }); await flush();
  assert.match(a.element('list').innerHTML, /最新任务/);
  assert.equal(a.requests.length, 1);
  assert.equal(a.requests[0].options.cache, 'no-store');
  assert.equal(a.requests[0].options.method, undefined);
});

test('后台恢复与 bfcache 同时触发时只读取一次最新快照', async () => {
  let next = snapshot();
  const a = app({ latest: () => next }); await flush(); a.advance(6000);
  next = snapshot('12:02', [assignment(2, { title: '恢复后的任务' })]);
  a.event('document', 'visibilitychange'); a.event('window', 'pageshow', { persisted: true }); await flush();
  assert.match(a.element('list').innerHTML, /恢复后的任务/);
  assert.equal(a.requests.length, 2);
});

test('相同或旧快照不重绘列表，也不倒退到旧任务', async () => {
  const a = app(); await flush(); const before = a.renderCount();
  assert.equal(a.applyLatestData(snapshot()), false);
  assert.equal(a.applyLatestData(snapshot('11:59', [assignment(2)])), false);
  assert.equal(a.renderCount(), before);
  assert.match(a.element('list').innerHTML, /任务 1/);
});

test('读取期间手动刷新得到更新快照，旧请求返回后不能覆盖它', async () => {
  let resolve;
  const a = app({ latest: () => new Promise(done => { resolve = done; }) }); await flush();
  assert.equal(a.requests.length, 1, '必须先开始读取已发布快照');
  a.applyLatestData(snapshot('12:03', [assignment(3)]));
  resolve(snapshot('12:02', [assignment(2)])); await flush();
  assert.match(a.element('list').innerHTML, /任务 3/);
  assert.doesNotMatch(a.element('list').innerHTML, /任务 2/);
});

test('无效数据和断网保留列表、完成与忽略记录', async () => {
  const local = { version: 3, done: { keep: { value: true, updatedAt: 100 } }, hidden: { ignored: { value: true, updatedAt: 200 } } };
  let result = { generated_at: 'bad', courses: [] };
  const a = app({ stored: { canvas_state_v3: JSON.stringify(local) }, latest: () => { if (result instanceof Error) throw result; return result; } }); await flush();
  const before = a.element('list').innerHTML; result = new Error('offline'); a.advance(6000); a.event('window', 'online'); await flush();
  assert.equal(a.element('list').innerHTML, before);
  assert.deepEqual(JSON.parse(a.storage.get('canvas_state_v3')), local);
});

test('网络恢复会立即重新读取快照，即使距离上次尝试不足节流时间', async () => {
  let offline = true;
  const a = app({ latest: () => { if (offline) throw new Error('offline'); return snapshot('12:04', [assignment(4)]); } }); await flush();
  offline = false; a.event('window', 'online'); await flush();
  assert.match(a.element('list').innerHTML, /任务 4/);
});

test('前台每五分钟检查已发布数据，后台和离线不轮询', async () => {
  let next = snapshot(); const a = app({ latest: () => next }); await flush();
  a.advance(60000); await flush(); assert.equal(a.requests.length, 1);
  next = snapshot('12:05', [assignment(5)]); a.advance(240000); await flush();
  assert.match(a.element('list').innerHTML, /任务 5/);
  const count = a.requests.length; a.context.document.visibilityState = 'hidden'; a.advance(300000); await flush();
  a.context.document.visibilityState = 'visible'; a.context.navigator.onLine = false; a.advance(300000); await flush();
  assert.equal(a.requests.length, count);
});

test('JSON 响应挂起也能超时，后续恢复可以再次更新', async () => {
  let hang = true;
  const a = app({ latest: options => hang ? { ok: true, json: () => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) } : snapshot('12:06', [assignment(6)]) }); await flush();
  assert.equal(a.requests.length, 1); a.advance(21000); await flush();
  hang = false; a.event('window', 'online'); await flush();
  assert.match(a.element('list').innerHTML, /任务 6/);
});

test('自动更新保留按周视图、完成显示开关、课程筛选和滚动位置', async () => {
  const data = snapshot('12:00', [assignment(1, { completed: true, due_at: '2026-10-14T20:00:00+08:00' })]);
  data.courses.push({ id: 2, name: '不选课程', assignments: [assignment(2)] });
  const a = app({ data }); await flush();
  a.element('chips').children[2].onclick(); a.element('weekTab').onclick(); a.element('nextWk').onclick(); a.element('completedToggle').onclick();
  const next = clone(data); next.generated_at = '2026-10-11T12:07:00+08:00'; next.courses[0].assignments[0].title = '更新后的已完成任务';
  a.applyLatestData(next);
  assert.equal(a.element('weekbar').style.display, 'flex');
  assert.match(a.element('list').innerHTML, /更新后的已完成任务/);
  assert.doesNotMatch(a.element('list').innerHTML, /不选课程/);
  assert.equal(a.context.window.scrollY, 240);
});

test('首次访问仅建立基线，不把全部历史任务报告成新增', async () => {
  const a = app(); await flush();
  assert.equal(a.element('changesNotice').hidden, true);
  assert.ok(a.storage.has('canvas_seen_items_v1'));
});

test('新快照报告新增任务和截止变化，详情显示旧时间与新时间', async () => {
  const a = app(); await flush();
  a.applyLatestData(snapshot('12:01', [assignment(1, { due_at: '2026-10-13T18:00:00+08:00' }), assignment(2)]));
  assert.equal(a.element('changesNotice').hidden, false);
  assert.match(a.element('changesSummary').textContent, /新增 1 项/);
  assert.match(a.element('changesSummary').textContent, /截止时间变更 1 项/);
  a.element('viewChanges').onclick();
  assert.equal(a.element('changesDialog').open, true);
  assert.match(a.element('changesList').innerHTML, /任务 1/);
  assert.match(a.element('changesList').innerHTML, /10\/12/);
  assert.match(a.element('changesList').innerHTML, /10\/13/);
  assert.match(a.element('changesList').innerHTML, /任务 2/);
});

test('关掉摘要后相同快照或重新打开页面不会重复提示', async () => {
  const a = app(); await flush(); const next = snapshot('12:01', [assignment(1), assignment(2)]);
  a.applyLatestData(next); assert.match(a.element('changesSummary').textContent, /新增 1 项/); a.element('dismissChanges').onclick();
  assert.equal(a.element('changesNotice').hidden, true);
  a.applyLatestData(next); assert.equal(a.element('changesNotice').hidden, true);
  const b = app({ data: next, stored: Object.fromEntries(a.storage) }); await flush();
  assert.equal(b.element('changesNotice').hidden, true);
});

test('下次打开可对比上次浏览的任务，发现离开期间的新任务', async () => {
  const a = app(); await flush();
  const b = app({ data: snapshot('12:01', [assignment(1), assignment(2)]), stored: Object.fromEntries(a.storage) }); await flush();
  assert.match(b.element('changesSummary').textContent, /新增 1 项/);
});

test('忽略或已完成任务不进入变更提示，通知后打钩也即时去除', async () => {
  const a = app(); await flush();
  a.setStateValue('hidden', 'canvas:1:assignment:2', true);
  a.setStateValue('done', 'canvas:1:assignment:3', true);
  a.applyLatestData(snapshot('12:01', [assignment(1), assignment(2), assignment(3), assignment(4, { completed: true }), assignment(5)]));
  assert.match(a.element('changesSummary').textContent, /新增 1 项/);
  a.setStateValue('done', 'canvas:1:assignment:5', true); a.event('document', 'visibilitychange');
  assert.equal(a.element('changesNotice').hidden, true);
});

test('同一截止时间的不同格式不误报，窗口中移除的任务不报告删除', async () => {
  const a = app({ data: snapshot('12:00', [assignment(1), assignment(2)]) }); await flush();
  a.applyLatestData(snapshot('12:01', [assignment(1, { due_at: '2026-10-12T12:00:00Z' })]));
  assert.equal(a.element('changesNotice').hidden, true);
});

test('重复更新聚合同一任务，截止时间恢复原值后撤掉变更提示', async () => {
  const a = app(); await flush();
  a.applyLatestData(snapshot('12:01', [assignment(1, { due_at: null }), assignment(2)]));
  a.applyLatestData(snapshot('12:02', [assignment(1), assignment(2, { due_at: null })]));
  assert.match(a.element('changesSummary').textContent, /新增 1 项/);
  assert.doesNotMatch(a.element('changesSummary').textContent, /截止时间变更/);
});

test('变更详情转义 Canvas 标题，不执行 HTML，损坏的基线不影响页面', async () => {
  const a = app({ stored: { canvas_seen_items_v1: '{invalid' } }); await flush();
  a.applyLatestData(snapshot('12:01', [assignment(1), assignment(2, { title: '<img src=x onerror=alert(1)>' })]));
  assert.match(a.element('changesSummary').textContent, /新增 1 项/); a.element('viewChanges').onclick();
  assert.match(a.element('changesList').innerHTML, /&lt;img/);
  assert.doesNotMatch(a.element('changesList').innerHTML, /<img/);
});

test('同一生成时间只接受较新的工作流，缺失或无效运行号不反复重绘', async () => {
  const data = { ...snapshot(), workflow_run_id: '42' }, a = app({ data }); await flush();
  a.applyLatestData({ ...snapshot('12:00', [assignment(2)]), workflow_run_id: '43' });
  assert.match(a.element('list').innerHTML, /任务 2/);
  assert.match(a.element('changesSummary').textContent, /新增 1 项/);
  const renders = a.renderCount();
  a.applyLatestData({ ...snapshot('12:00', [assignment(3)]), workflow_run_id: 'invalid' });
  a.applyLatestData(snapshot());
  assert.equal(a.renderCount(), renders);
});

test('旧缓存页面不覆盖另一个标签页已经保存的新基线', async () => {
  const a = app(); await flush(); a.applyLatestData(snapshot('12:05', [assignment(1), assignment(2)]));
  const saved = a.storage.get('canvas_seen_items_v1');
  const b = app({ stored: Object.fromEntries(a.storage) }); await flush();
  assert.equal(b.storage.get('canvas_seen_items_v1'), saved);
  assert.equal(b.element('changesNotice').hidden, true);
});

test('存储配额不足时，仍能更新任务并在当前页面显示变更', async () => {
  const a = app(); await flush(); const original = a.context.localStorage.setItem;
  a.context.localStorage.setItem = (key, value) => { if (key === 'canvas_seen_items_v1') throw new Error('quota'); original(key, value); };
  a.applyLatestData(snapshot('12:01', [assignment(1), assignment(2)]));
  assert.match(a.element('list').innerHTML, /任务 2/);
  assert.match(a.element('changesSummary').textContent, /新增 1 项/);
});

test('请求仍在进行时重复恢复事件不会发出第二个快照请求', async () => {
  let resolve;
  const a = app({ latest: () => new Promise(done => { resolve = done; }) }); await flush();
  assert.equal(a.requests.length, 1); a.advance(6000);
  a.event('window', 'online'); a.event('document', 'visibilitychange'); a.event('window', 'pageshow', { persisted: true }); await flush();
  assert.equal(a.requests.length, 1);
  resolve(snapshot('12:02', [assignment(2)])); await flush();
  assert.match(a.element('list').innerHTML, /任务 2/);
});
