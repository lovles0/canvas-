const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const keyA = '9ed32369-5cae-4876-a2af-59c2b70d5104';
const keyB = '625d0f54-19ea-4be4-ad56-681060e0e66e';
const empty = () => ({ version: 3, done: {}, hidden: {} });
const clone = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function app({ local = empty(), remote = empty(), key = keyA, read, apiKey = 'sb_publishable_test' } = {}) {
  const storage = new Map([['canvas_state_v3', JSON.stringify(local)]]);
  if (key) storage.set('canvas_sync_key_v1', key);
  const elements = new Map(), listeners = { document: {}, window: {} }, timers = new Map(), calls = [];
  let time = Date.parse('2026-10-11T12:00:00+08:00'), timerId = 0, renders = 0;
  const element = id => {
    if (!elements.has(id)) {
      let html = '';
      const item = { textContent: '', style: {}, dataset: {}, classList: { toggle() {} }, setAttribute() {}, appendChild() {}, querySelectorAll: () => [], showModal() {}, close() {} };
      Object.defineProperty(item, 'innerHTML', { get: () => html, set: value => { html = value; if (id === 'list') renders++; } });
      elements.set(id, item);
    }
    return elements.get(id);
  };
  element('data').textContent = JSON.stringify({ generated_at: '2026-10-11T12:00:00+08:00', courses: [] });
  element('sync-config').textContent = JSON.stringify({ supabase_url: 'https://project.supabase.co', supabase_anon_key: apiKey });
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const add = (surface, name, fn) => { (listeners[surface][name] ||= []).push(fn); };
  const context = {
    console, Date: Clock, AbortController, crypto: { randomUUID: () => keyA }, navigator: { onLine: true },
    localStorage: { getItem: name => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, String(value)) },
    document: { visibilityState: 'visible', documentElement: { setAttribute() {} }, getElementById: element, createElement: () => element(`new-${elements.size}`), querySelectorAll: () => [], addEventListener: (name, fn) => add('document', name, fn) },
    window: { CanvasRefresh: require('../refresh.js'), matchMedia: () => ({ matches: false }), addEventListener: (name, fn) => add('window', name, fn) },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: time + ms, interval: ms }); return id; },
    clearInterval: id => timers.delete(id),
    fetch: async (url, options = {}) => {
      if (String(url).startsWith('https://api.github.com/')) return { ok: true, json: async () => ({ workflow_runs: [] }) };
      if (String(url).startsWith('data.json?')) return { ok: true, json: async () => JSON.parse(element('data').textContent) };
      const body = JSON.parse(options.body);
      calls.push({ url, body, headers: options.headers });
      if (url.endsWith('/read_canvas_state')) {
        const data = read ? await read(body, options) : clone(remote);
        return { ok: true, json: async () => data };
      }
      if (url.endsWith('/merge_canvas_state')) return { ok: true, json: async () => clone(body.p_payload) };
      throw new Error(`Unexpected endpoint ${url}`);
    },
  };
  let source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  source = source.replace('  renderChips();\n  render();', '  globalThis.api = { state, syncCloud, setStateValue, apiHeaders };\n  renderChips();\n  render();');
  vm.runInNewContext(source, context, { filename: 'app.js' });
  return {
    ...context.api, context, storage, calls, element, listeners,
    renderCount: () => renders,
    event: (surface, name, event = {}) => (listeners[surface][name] || []).forEach(fn => fn(event)),
    advance: ms => {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time) {
        if (timer.interval) timer.at = time + timer.interval; else timers.delete(id);
        timer.fn();
      }
    },
  };
}

test('新版 publishable key 只放在 apikey，不作为 JWT', async () => {
  const a = app(); await flush();
  assert.equal(a.apiHeaders().apikey, 'sb_publishable_test');
  assert.equal(a.apiHeaders().Authorization, undefined);
});

test('旧 anon JWT key 仍保留兼容认证头', async () => {
  const a = app({ apiKey: 'legacy-anon-jwt' }); await flush();
  assert.equal(a.calls[0].headers.apikey, 'legacy-anon-jwt');
  assert.equal(a.calls[0].headers.Authorization, 'Bearer legacy-anon-jwt');
});

test('远端没有变化时只读取，不重复写入或重绘', async () => {
  const a = app(); await flush();
  assert.equal(a.calls.filter(x => x.url.endsWith('/merge_canvas_state')).length, 0);
  const renders = a.renderCount();
  await a.syncCloud(); await flush();
  assert.equal(a.renderCount(), renders);
});

test('只接收远端更新不会自动写回形成同步循环', async () => {
  const a = app({ remote: { version: 3, done: { remote: { value: true, updatedAt: 100 } }, hidden: {} } });
  await flush();
  assert.equal(a.state.done.remote.value, true);
  a.advance(60000); await flush();
  assert.equal(a.calls.filter(x => x.url.endsWith('/merge_canvas_state')).length, 0);
});

test('后台恢复和 bfcache 恢复合并为一次同步请求', async () => {
  const a = app(); await flush(); a.advance(6000);
  const before = a.calls.length;
  a.context.document.visibilityState = 'hidden'; a.event('document', 'visibilitychange'); await flush();
  assert.equal(a.calls.length, before);
  a.context.document.visibilityState = 'visible'; a.event('document', 'visibilitychange'); a.event('window', 'pageshow', { persisted: true }); await flush();
  assert.equal(a.calls.length, before + 1);
});

test('网络恢复后自动重试且保留本地未上传记录', async () => {
  let offline = true;
  const a = app({ local: { version: 3, done: { local: { value: true, updatedAt: 200 } }, hidden: {} }, read: async () => {
    if (offline) throw new Error('offline');
    return { version: 3, done: { remote: { value: true, updatedAt: 100 } }, hidden: {} };
  } });
  await flush(); assert.equal(a.state.done.local.value, true);
  offline = false; a.advance(6000); a.event('window', 'online'); await flush();
  assert.equal(a.state.done.remote?.value, true);
  assert.equal(a.state.done.local.value, true);
});

test('多标签页存储事件逐项目合并，并保留较新的本地状态', async () => {
  const a = app({ key: null, local: { version: 3, done: { local: { value: true, updatedAt: 200 } }, hidden: {} } }); await flush();
  const incoming = JSON.stringify({ version: 3, done: { local: { value: false, updatedAt: 100 }, other: { value: true, updatedAt: 300 } }, hidden: { hidden: { value: true, updatedAt: 400 } } });
  a.storage.set('canvas_state_v3', incoming); a.event('window', 'storage', { key: 'canvas_state_v3', newValue: incoming });
  assert.equal(a.state.done.local.value, true);
  assert.equal(a.state.done.other?.value, true);
  assert.equal(a.state.hidden.hidden?.value, true);
  assert.equal(a.calls.length, 0);
});

test('本地写入前读取最新共享存储，避免覆盖尚未收到事件的另一标签页', async () => {
  const a = app({ key: null }); await flush();
  a.storage.set('canvas_state_v3', JSON.stringify({ version: 3, done: { other: { value: true, updatedAt: 100 } }, hidden: {} }));
  a.setStateValue('done', 'local', true);
  const saved = JSON.parse(a.storage.get('canvas_state_v3'));
  assert.equal(saved.done.local.value, true);
  assert.equal(saved.done.other?.value, true);
});

test('云端读取期间的其他标签页修改也必须保留', async () => {
  let resolveRead;
  const a = app({ read: async () => await new Promise(resolve => { resolveRead = resolve; }) });
  await flush();
  a.storage.set('canvas_state_v3', JSON.stringify({ version: 3, done: { other: { value: true, updatedAt: 100 } }, hidden: {} }));
  resolveRead(empty()); await flush();
  assert.equal(a.state.done.other?.value, true);
  assert.equal(JSON.parse(a.storage.get('canvas_state_v3')).done.other?.value, true);
});

test('延迟到达的旧 storage 事件不能覆盖共享存储中的最新项目', async () => {
  const a = app({ key: null }); await flush();
  a.storage.set('canvas_state_v3', JSON.stringify({ version: 3, done: { latest: { value: true, updatedAt: 200 } }, hidden: {} }));
  a.event('window', 'storage', { key: 'canvas_state_v3', newValue: JSON.stringify({ version: 3, done: { old: { value: true, updatedAt: 100 } }, hidden: {} }) });
  assert.equal(a.state.done.latest?.value, true);
  assert.equal(a.state.done.old?.value, true);
});

test('同步码切换期间的旧请求不能污染新同步空间', async () => {
  let resolveOld;
  const a = app({ read: async body => body.p_id === keyA ? await new Promise(resolve => { resolveOld = resolve; }) : { version: 3, done: { newSpace: { value: true, updatedAt: 200 } }, hidden: {} } });
  await flush(); a.storage.set('canvas_sync_key_v1', keyB); a.event('window', 'storage', { key: 'canvas_sync_key_v1', newValue: keyB });
  resolveOld({ version: 3, done: { oldSpace: { value: true, updatedAt: 300 } }, hidden: {} }); await flush();
  assert.equal(a.state.done.oldSpace, undefined);
  assert.equal(a.state.done.newSpace?.value, true);
  assert.equal(a.calls.filter(x => x.url.endsWith('/merge_canvas_state') && x.body.p_id === keyA).length, 0);
});

test('挂起的网络请求会超时，不会永久卡在正在同步', async () => {
  const a = app({ read: async (_, options) => await new Promise((resolve, reject) => { options.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true }); }) });
  await flush(); a.advance(16000); await flush();
  assert.match(a.element('syncStatus').textContent, /同步失败/);
  assert.deepEqual(JSON.parse(a.storage.get('canvas_state_v3')), empty());
});

test('前台定期读取远端变化，后台不轮询', async () => {
  const remote = empty(), a = app({ remote }); await flush();
  remote.hidden.remote = { value: true, updatedAt: 500 };
  a.advance(60000); await flush(); assert.equal(a.state.hidden.remote?.value, true);
  const before = a.calls.length; a.context.document.visibilityState = 'hidden';
  a.advance(60000); await flush(); assert.equal(a.calls.length, before);
});

test('保留 500ms debounce，连续操作只上传一次', async () => {
  const a = app(); await flush(); const before = a.calls.length;
  a.setStateValue('done', 'one', true); a.setStateValue('hidden', 'two', true);
  a.advance(499); await flush(); assert.equal(a.calls.length, before);
  a.advance(1); await flush();
  const writes = a.calls.slice(before).filter(x => x.url.endsWith('/merge_canvas_state'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.p_payload.done.one.value, true);
  assert.equal(writes[0].body.p_payload.hidden.two.value, true);
});
