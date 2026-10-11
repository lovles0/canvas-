const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const data = {
  generated_at: '2026-09-19T12:00:00+08:00',
  stale_after_hours: 16,
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
const workflowRuns = {
  workflow_runs: [{
    status: 'completed',
    conclusion: 'failure',
    created_at: '2026-09-19T05:00:00Z',
  }],
};

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
  fetch: async url => {
    fetchCount += 1;
    if (String(url).startsWith('https://api.github.com/repos/lovles0/canvas-/actions/workflows/sync.yml/runs')) {
      return { ok: true, json: async () => workflowRuns };
    }
    throw new Error('offline');
  },
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
    CanvasRefresh: require('../refresh.js'),
    matchMedia: () => ({ matches: false }),
    addEventListener: (name, handler) => { windowListeners[name] = handler; },
  },
  setTimeout,
  clearTimeout,
  Date,
  AbortController,
  navigator: { onLine: true },
  setInterval: () => 0,
};
context.globalThis = context;

let source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
source = source.replace(
  '  renderChips();\n  render();',
  '  globalThis.__testApi = { mergeGroup, mergeRemoteIntoLocal, performCloudSync, dueBadge, todoGroup, updateStale, state, syncConfig: SYNC, applyLatestData: typeof applyLatestData === "function" ? applyLatestData : null };\n  renderChips();\n  render();',
);
vm.runInNewContext(source, context, { filename: 'app.js' });

const { mergeGroup, mergeRemoteIntoLocal, performCloudSync, dueBadge, todoGroup, updateStale, state, syncConfig, applyLatestData } = context.__testApi;

const lastSuccessLabel = '2026/9/19 12:00';
assert.ok(fakeElement('sub').textContent.includes('上次成功更新'));
assert.ok(fakeElement('sub').textContent.includes(lastSuccessLabel));
updateStale(new Date('2026-09-20T06:00:00+08:00'));
assert.strictEqual(fakeElement('stale').style.display, 'block');
assert.ok(fakeElement('stale').textContent.includes(lastSuccessLabel));
assert.ok(fakeElement('stale').textContent.includes('可能延迟或失败'));
updateStale(new Date('2026-09-19T13:00:00+08:00'));
assert.strictEqual(fakeElement('stale').style.display, 'none');

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

const assignment = { due_at: new Date(2026, 8, 20, 0, 30).toISOString() };
const beforeMidnight = new Date(2026, 8, 19, 23, 45);
const afterDeadline = new Date(2026, 8, 20, 0, 31);
assert.strictEqual(todoGroup(assignment, beforeMidnight), 'tomorrow');
assert.strictEqual(todoGroup(assignment, afterDeadline), 'overdue');
assert.strictEqual(dueBadge(assignment, false, beforeMidnight).cls, 'warn');
assert.strictEqual(dueBadge(assignment, false, afterDeadline).cls, 'late');

const beforeVisibility = listRenderCount;
documentListeners.visibilitychange();
assert.strictEqual(listRenderCount, beforeVisibility + 1);
windowListeners.pageshow({ persisted: true });
assert.strictEqual(listRenderCount, beforeVisibility + 2);

state.done.keep = { value: true, updatedAt: 300 };
context.localStorage.setItem('canvas_state_v3', JSON.stringify(state));
mergeRemoteIntoLocal(null);
assert.strictEqual(state.done.keep.value, true);

assert.strictEqual(typeof applyLatestData, 'function', '刷新后必须能在原页面显示新快照');
applyLatestData({ ...data, generated_at: '2026-09-20T12:00:00+08:00', courses: [{
  ...data.courses[0], assignments: [{ ...data.courses[0].assignments[0], title: '刚刚从 Canvas 更新的作业' }],
}] });
assert.ok(fakeElement('list').innerHTML.includes('刚刚从 Canvas 更新的作业'));
assert.ok(fakeElement('sub').textContent.includes('2026/9/20 12:00'));
assert.strictEqual(state.done.keep.value, true);
const listBeforeBadData = fakeElement('list').innerHTML;
assert.throws(() => applyLatestData({ generated_at: 'invalid', courses: [] }));
assert.strictEqual(fakeElement('list').innerHTML, listBeforeBadData);

// Canvas 互评完成状态沿用现有已完成视图，不丢弃仍待完成的互评。
applyLatestData({ ...data, courses: [{ ...data.courses[0], assignments: [{
  id: 'assessment_request:542480', source_id: 542480, title: '已完成的互评',
  item_type: 'assessment_request', type_label: '互评', completed: true,
  completion_state: 'peer_review_completed', due_at: '2026-10-12T20:00:00+08:00',
}, {
  id: 'assessment_request:546066', source_id: 546066, title: '待完成的互评',
  item_type: 'assessment_request', type_label: '互评', completed: false,
  due_at: '2026-10-13T20:00:00+08:00',
}] }] });
assert.ok(!fakeElement('list').innerHTML.includes('已完成的互评'));
assert.ok(fakeElement('list').innerHTML.includes('待完成的互评'));
assert.strictEqual(fakeElement('completedToggle').hidden, false);
fakeElement('completedToggle').onclick();
assert.ok(fakeElement('list').innerHTML.includes('已完成的互评'));
assert.ok(fakeElement('list').innerHTML.includes('Canvas 已完成'));
assert.ok(fakeElement('list').innerHTML.includes('aria-label="Canvas 已完成" disabled'));
fakeElement('completedToggle').onclick();
// 恢复原快照，让既有更新失败提示测试继续使用原来的时间。
applyLatestData(data);

syncConfig.supabase_url = 'https://supabase.example';
syncConfig.supabase_anon_key = 'test-key';
context.localStorage.setItem('canvas_sync_key_v1', '00000000-0000-4000-8000-000000000000');
const stateBeforeNetworkFailure = context.localStorage.getItem('canvas_state_v3');
new Promise(resolve => setImmediate(resolve)).then(async () => {
  assert.ok(fakeElement('stale').textContent.includes('最近一次自动更新失败'));
  assert.ok(fakeElement('stale').textContent.includes(lastSuccessLabel));
  assert.strictEqual(fetchCount, 1);
  await performCloudSync();
  assert.strictEqual(fetchCount, 2);
  assert.deepStrictEqual(JSON.parse(context.localStorage.getItem('canvas_state_v3')), JSON.parse(stateBeforeNetworkFailure));
  console.log('app state/time tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
