const ALLOWED_ORIGIN = 'https://lovles0.github.io';
const WORKFLOW_URL = 'https://api.github.com/repos/lovles0/canvas-/actions/workflows/sync.yml/dispatches';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function sameKey(left, right) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([left, right].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const first = new Uint8Array(a), second = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < first.length; i += 1) difference |= first[i] ^ second[i];
  return difference === 0;
}

export function createHandler({ getEnv, fetchImpl = (...args) => fetch(...args) }) {
  async function request(url, options) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try { return await fetchImpl(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }
  return async req => {
    const headers = {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, apikey, x-canvas-refresh-key',
    };
    const reply = (status, value, extra = {}) => new Response(value == null ? null : JSON.stringify(value), { status, headers: { ...headers, ...extra } });
    const origin = req.headers.get('origin');
    if (origin && origin !== ALLOWED_ORIGIN) return reply(403, { error: '不支持此网站来源' });
    if (req.method === 'OPTIONS') return reply(204, null);
    const refreshKey = getEnv('CANVAS_REFRESH_KEY') || '', githubToken = getEnv('GITHUB_ACTIONS_TOKEN') || '';
    let databaseKey = '';
    try { databaseKey = JSON.parse(getEnv('SUPABASE_SECRET_KEYS') || '{}').default || ''; } catch (_) {}
    // 兼容现有项目；新项目优先使用独立可轮换的 secret key。
    databaseKey ||= getEnv('SUPABASE_SERVICE_ROLE_KEY') || '';
    const url = (getEnv('SUPABASE_URL') || '').replace(/\/$/, '');
    const configured = Boolean(/^[\x21-\x7e]{32,256}$/.test(refreshKey) && githubToken && databaseKey && url);
    if (req.method === 'GET') return reply(200, { configured });
    if (req.method !== 'POST') return reply(405, { error: '只支持 POST 请求' });
    if (!configured) return reply(503, { error: '云端刷新尚未配置完成，请检查两个自定义 Secrets' });
    const providedKey = req.headers.get('x-canvas-refresh-key') || '';
    if (providedKey.length > 256 || !await sameKey(providedKey, refreshKey)) return reply(401, { error: '刷新码不正确，请重新输入' });
    let body;
    try {
      if (Number(req.headers.get('content-length')) > 512) return reply(413, { error: '请求过大' });
      const text = await req.text();
      if (text.length > 512) return reply(413, { error: '请求过大' });
      body = JSON.parse(text);
    } catch (_) { return reply(400, { error: '请求格式不正确' }); }
    if (!UUID.test(body?.request_id || '')) return reply(400, { error: '请求标识不正确' });
    try {
      const claimResponse = await request(`${url}/rest/v1/rpc/claim_canvas_refresh`, {
        method: 'POST', headers: { apikey: databaseKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_request_id: body.request_id }),
      });
      if (!claimResponse.ok) return reply(503, { error: '刷新限流服务暂不可用，请稍后重试' });
      const claim = await claimResponse.json();
      if (!claim.allowed) {
        const retry = Math.max(1, Math.min(120, Number(claim.retry_after) || 120));
        return reply(429, { error: `刚刚已请求更新，请 ${retry} 秒后重试` }, { 'Retry-After': String(retry) });
      }
      const dispatch = await request(WORKFLOW_URL, {
        method: 'POST', headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs: { refresh_request_id: body.request_id } }),
      });
      if (!dispatch.ok) return reply(502, { error: 'GitHub 未接受刷新请求，请检查 Token 的仓库权限与有效期；两分钟后可重试' });
      const dispatched = dispatch.status === 204 ? {} : await dispatch.json();
      const runId = Number(dispatched.workflow_run_id);
      return reply(202, { request_id: body.request_id, run_id: Number.isSafeInteger(runId) && runId > 0 ? runId : null });
    } catch (_) { return reply(502, { error: '云端网络请求失败，任务可能已开始；两分钟后可重试，旧任务不会被清空' }); }
  };
}
