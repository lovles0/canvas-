const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const data = {
  generated_at: '2026-09-19T12:00:00+08:00',
  stale_after_hours: 36,
  timezone_offset: '+08:00',
  courses: [{
    id: 1,
    name: '测试课程',
    color: '#2563eb',
    assignments: [{
      id: 2,
      title: '跨午夜作业',
      due_at: '2026-09-20T00:30:00+08:00',
      completed: false,
      item_type: 'assignment',
    }],
  }],
};

let listRenderCount = 0;
const documentListeners = {};
const windowListeners = {};
const elements = new Map();

function fakeElement(id) {
  if (elements.has(id)) return elements.get(id);
  let innerHTML = '';
  const element = {
    id,
    style: {},
    classList: { toggle() {} },
    dataset: {},
    hidden: false,
    textContent: '',
    setAttribute() {},
    appendChild() {},
    querySelectorAll() { return []; },
    showModal() {},
    close() {},
  };
  Object.defineProperty(element, 'innerHTML', {
    get() { return innerHTML; },
    set(value) { innerHTML = value; if (id === 'list') listRenderCount += 1; },
  });
  elements.set(id, element);
  return element;
}

fakeElement('data').textContent = JSON.stringify(data);
fakeElement('sync-config').textContent = JSON.stringify({ supabase_url: '', supabase_anon_key: '' });

const storage = new Map();
let fetchCount = 0;
const context = {
  console,
  confirm: () => true,
  crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
  fetch: async () => { fetchCount += 1; throw new Error('unexpected network request'); },
  localStorage: {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
  },
  document: {
    visibilityState: 'visible',
    documentElement: { setAttribute() {} },
    getElementById: fakeElement,
    createElement: () => fakeElement(`created-${elements.size}`),
    querySelectorAll: () => [],
    addEventListener: (name, handler) => { documentListeners[name] = handler; },
  },
  window: {
    matchMedia: () => ({ matches: false }),
    addEventListener: (name, handler) => { windowListeners[name] = handler; },
  },
  setTimeout,
  clearTimeout,
  Date,
};
context.globalThis = context;

let source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
source = source.replace(
  '  renderChips();\n  render();',
  '  globalThis.__testApi = { mergeGroup, mergeRemoteIntoLocal, performCloudSync, dueBadge, todoGroup, state, syncConfig: SYNC };\n  renderChips();\n  render();',
);
vm.runInNewContext(source, context, { filename: 'app.js' });

const { mergeGroup, mergeRemoteIntoLocal, performCloudSync, dueBadge, todoGroup, state, syncConfig } = context.__testApi;

const mergedDifferent = mergeGroup(
  { a: { value: true, updatedAt: 100 } },
  { b: { value: true, updatedAt: 200 } },
);
assert.deepStrictEqual(JSON.parse(JSON.stringify(mergedDifferent)), {
  a: { value: true, updatedAt: 100 },
  b: { value: true, updatedAt: 200 },
});

const mergedConflict = mergeGroup(
  { a: { value: true, updatedAt: 100 } },
  { a: { value: false, updatedAt: 200 } },
);
assert.strictEqual(mergedConflict.a.value, false);
assert.strictEqual(mergedConflict.a.updatedAt, 200);

const mergedInvalidTimestamp = mergeGroup(
  { a: { value: true, updatedAt: 100 } },
  { a: { value: false, updatedAt: 'invalid' }, b: true },
);
assert.strictEqual(mergedInvalidTimestamp.a.value, true);
assert.deepStrictEqual(JSON.parse(JSON.stringify(mergedInvalidTimestamp.b)), { value: true, updatedAt: 0 });

const assignment = data.courses[0].assignments[0];
assert.strictEqual(todoGroup(assignment, new Date('2026-09-19T23:45:00+08:00')), 'tomorrow');
assert.strictEqual(todoGroup(assignment, new Date('2026-09-20T00:31:00+08:00')), 'overdue');
assert.strictEqual(dueBadge(assignment, false, new Date('2026-09-19T23:45:00+08:00')).cls, 'warn');
assert.strictEqual(dueBadge(assignment, false, new Date('2026-09-20T00:31:00+08:00')).cls, 'late');

const beforeVisibility = listRenderCount;
documentListeners.visibilitychange();
assert.strictEqual(listRenderCount, beforeVisibility + 1);
windowListeners.pageshow({ persisted: true });
assert.strictEqual(listRenderCount, beforeVisibility + 2);
assert.strictEqual(fetchCount, 0);

state.done.keep = { value: true, updatedAt: 300 };
context.localStorage.setItem('canvas_state_v3', JSON.stringify(state));
mergeRemoteIntoLocal(null);
assert.strictEqual(state.done.keep.value, true);

syncConfig.supabase_url = 'https://supabase.example';
syncConfig.supabase_anon_key = 'test-key';
context.localStorage.setItem('canvas_sync_key_v1', '00000000-0000-4000-8000-000000000000');
const stateBeforeNetworkFailure = context.localStorage.getItem('canvas_state_v3');
performCloudSync().then(() => {
  assert.strictEqual(fetchCount, 1);
  assert.strictEqual(context.localStorage.getItem('canvas_state_v3'), stateBeforeNetworkFailure);
  console.log('app state/time tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
