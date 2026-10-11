import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
const moduleUrl = new URL('../supabase/functions/canvas-refresh/handler.mjs', import.meta.url);
const { createHandler } = existsSync(moduleUrl) ? await import(moduleUrl) : {};
const key = 'TestOnlyKey0123456789abcdefghijklm';
const id = 'c1541234-1234-4123-8123-123456789abc';
const env = { CANVAS_REFRESH_KEY: key, GITHUB_ACTIONS_TOKEN: 'server-only-test-token', SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEYS: '{"default":"server-only-db-key"}' };
function setup(replies, overrides = {}) {
  assert.equal(typeof createHandler, 'function', '必须实现受保护的刷新入口');
  const requests = [];
  const handler = createHandler({
    getEnv: name => ({ ...env, ...overrides })[name],
    fetchImpl: async (url, options) => { requests.push({ url, options }); const reply = replies.shift(); if (reply instanceof Error) throw reply; return reply; },
  });
  return { handler, requests };
}
function request(headers = {}, body = { request_id: id }) {
  return new Request('https://project.supabase.co/functions/v1/canvas-refresh', { method: 'POST', headers: { Origin: 'https://lovles0.github.io', 'Content-Type': 'application/json', 'x-canvas-refresh-key': key, ...headers }, body: JSON.stringify(body) });
}
test('认证后只派发指定仓库的工作流，不接受用户指定目标', async () => {
  const ctx = setup([Response.json({ allowed: true }), Response.json({ workflow_run_id: 42 }, { status: 200 })]);
  const response = await ctx.handler(request({}, { request_id: id, ref: 'evil', repo: 'evil' }));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { request_id: id, run_id: 42 });
  assert.equal(ctx.requests[1].url, 'https://api.github.com/repos/lovles0/canvas-/actions/workflows/sync.yml/dispatches');
  assert.deepEqual(JSON.parse(ctx.requests[1].options.body), { ref: 'main', inputs: { refresh_request_id: id } });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://lovles0.github.io');
});
test('错误刷新码不访问数据库或 GitHub', async () => {
  const ctx = setup([]);
  assert.equal((await ctx.handler(request({ 'x-canvas-refresh-key': 'wrong' }))).status, 401);
  assert.equal(ctx.requests.length, 0);
});
test('不受信任来源不派发任务', async () => {
  const ctx = setup([]);
  assert.equal((await ctx.handler(request({ Origin: 'https://evil.example' }))).status, 403);
  assert.equal(ctx.requests.length, 0);
});
test('同时请求受数据库冷却时间保护', async () => {
  const ctx = setup([Response.json({ allowed: false, retry_after: 91 })]);
  const response = await ctx.handler(request());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '91');
  assert.equal(ctx.requests.length, 1);
});
test('缺少云端配置时拒绝触发且不泄漏密钥', async () => {
  const ctx = setup([], { GITHUB_ACTIONS_TOKEN: '' });
  const response = await ctx.handler(request());
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes(key));
  assert.equal(ctx.requests.length, 0);
});
test('GitHub 拒绝或网络失败返回可恢复错误而不泄漏上游响应', async () => {
  for (const failure of [Response.json({ message: 'server-only-test-token' }, { status: 403 }), new Error('server-only-test-token')]) {
    const ctx = setup([Response.json({ allowed: true }), failure]);
    const response = await ctx.handler(request());
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('server-only-test-token'));
  }
});
test('无效请求标识不会触发 GitHub', async () => {
  const ctx = setup([]);
  assert.equal((await ctx.handler(request({}, { request_id: 'not-a-uuid' }))).status, 400);
  assert.equal(ctx.requests.length, 0);
});
test('浏览器预检允许专用认证头，不执行数据库操作', async () => {
  const ctx = setup([]);
  const response = await ctx.handler(new Request('https://project.supabase.co/functions/v1/canvas-refresh', { method: 'OPTIONS', headers: { Origin: 'https://lovles0.github.io' } }));
  assert.equal(response.status, 204);
  assert.ok(response.headers.get('Access-Control-Allow-Headers').includes('x-canvas-refresh-key'));
  assert.equal(ctx.requests.length, 0);
});
test('配置检查只返回是否配置，不返回任何密钥', async () => {
  const ctx = setup([]);
  const response = await ctx.handler(new Request('https://project.supabase.co/functions/v1/canvas-refresh'));
  assert.deepEqual(await response.json(), { configured: true });
  assert.equal(ctx.requests.length, 0);
});
