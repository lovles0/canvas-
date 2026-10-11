const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const modulePath = require('node:path').join(__dirname, '..', 'refresh.js');
const { createRefresher } = fs.existsSync(modulePath) ? require(modulePath) : {};
const requestId = 'c1541234-1234-4123-8123-123456789abc';
const key = 'TestOnlyKey0123456789abcdefghijklm';
const oldData = { generated_at: '2026-10-11T10:00:00+08:00', courses: [] };
const newData = { generated_at: '2026-10-11T10:01:00+08:00', refresh_request_id: requestId, workflow_run_id: '42', courses: [{ id: 1, name: '新课程', assignments: [] }] };

function setup(replies) {
  assert.equal(typeof createRefresher, 'function', '必须实现真正的 Canvas 刷新流程');
  let currentTime = 0;
  let displayed = oldData;
  const requests = [], phases = [];
  const refresher = createRefresher({
    endpoint: 'https://project.supabase.co/functions/v1/canvas-refresh',
    requestId: () => requestId,
    now: () => currentTime,
    sleep: async ms => { currentTime += ms; },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const response = replies.shift();
      if (response instanceof Error) throw response;
      return response || Response.json(oldData);
    },
    onProgress: phase => phases.push(phase),
    applyData: data => { displayed = data; },
  });
  return { refresher, requests, phases, displayed: () => displayed };
}

test('一次点击触发抓取，等到对应的已发布快照才替换旧数据', async () => {
  const ctx = setup([
    Response.json({ request_id: requestId, run_id: 42 }, { status: 202 }),
    Response.json(oldData), Response.json({ status: 'in_progress', conclusion: null }),
    Response.json(newData),
  ]);
  await ctx.refresher.refresh(key);
  assert.deepEqual(ctx.displayed(), newData);
  assert.deepEqual(ctx.phases, ['requesting', 'waiting', 'success']);
  assert.equal(ctx.requests[0].options.method, 'POST');
  assert.equal(ctx.requests[0].options.headers['x-canvas-refresh-key'], key);
  assert.deepEqual(JSON.parse(ctx.requests[0].options.body), { request_id: requestId });
  assert.ok(ctx.requests.slice(1).every(x => !x.options.headers?.['x-canvas-refresh-key']));
});

test('重复点击共用同一任务，不再派发另一条工作流', async () => {
  const ctx = setup([Response.json({ request_id: requestId, run_id: 42 }, { status: 202 }), Response.json(newData)]);
  const first = ctx.refresher.refresh(key), second = ctx.refresher.refresh(key);
  assert.strictEqual(first, second);
  await first;
  assert.equal(ctx.requests.filter(x => x.options.method === 'POST').length, 1);
});

test('认证失败保留旧任务，并允许修正刷新码后重试', async () => {
  const ctx = setup([Response.json({ error: '刷新码不正确' }, { status: 401 })]);
  await assert.rejects(ctx.refresher.refresh(key), error => error.status === 401);
  assert.deepEqual(ctx.displayed(), oldData);
  assert.deepEqual(ctx.phases, ['requesting', 'error']);
});

test('工作流失败不把旧快照误报为刷新成功', async () => {
  const ctx = setup([
    Response.json({ request_id: requestId, run_id: 42 }, { status: 202 }),
    Response.json(oldData), Response.json({ status: 'completed', conclusion: 'failure' }),
  ]);
  await assert.rejects(ctx.refresher.refresh(key), /抓取或发布失败/);
  assert.deepEqual(ctx.displayed(), oldData);
});

test('短暂断网会继续等待，但超时不会覆盖旧数据', async () => {
  const ctx = setup([Response.json({ request_id: requestId, run_id: 42 }, { status: 202 }), new Error('offline')]);
  await assert.rejects(ctx.refresher.refresh(key), /等待.*超时/);
  assert.deepEqual(ctx.displayed(), oldData);
});

test('无效快照不会替换数据，随后有效快照可以恢复', async () => {
  const ctx = setup([
    Response.json({ request_id: requestId, run_id: 42 }, { status: 202 }),
    Response.json({ ...newData, courses: null }), Response.json({ status: 'in_progress' }),
    Response.json(newData),
  ]);
  await ctx.refresher.refresh(key);
  assert.deepEqual(ctx.displayed(), newData);
});

test('已成功发布后被更新的定时快照替换时，也能显示更新数据', async () => {
  const scheduled = { ...newData, refresh_request_id: '', workflow_run_id: '43' };
  const ctx = setup([
    Response.json({ request_id: requestId, run_id: 42 }, { status: 202 }),
    Response.json(scheduled), Response.json({ status: 'completed', conclusion: 'success' }),
  ]);
  await ctx.refresher.refresh(key);
  assert.deepEqual(ctx.displayed(), scheduled);
});
