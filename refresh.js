(function (root) {
  'use strict';

  function validSnapshot(data) {
    return Boolean(data && typeof data.generated_at === 'string' && Number.isFinite(Date.parse(data.generated_at))
      && Array.isArray(data.courses) && data.courses.every(c => c && c.id != null && typeof c.name === 'string'
        && Array.isArray(c.assignments) && c.assignments.every(a => a && a.id != null && typeof a.title === 'string'
          && (!a.due_at || Number.isFinite(Date.parse(a.due_at))))));
  }

  function createRefresher({ endpoint, applyData, onProgress = () => {}, fetchImpl = (...args) => fetch(...args),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now(), requestId = () => crypto.randomUUID() }) {
    let inFlight = null;

    async function request(url, options = {}) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
      try { return await fetchImpl(url, { ...options, signal: controller.signal, cache: 'no-store' }); }
      finally { clearTimeout(timer); }
    }

    async function run(key) {
      onProgress('requesting');
      try {
        const id = requestId();
        const response = await request(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-canvas-refresh-key': key },
          body: JSON.stringify({ request_id: id }),
        });
        const accepted = await response.json();
        if (!response.ok) {
          const error = new Error(accepted.error || `刷新请求失败（${response.status}），请稍后重试`);
          error.status = response.status;
          throw error;
        }
        if (accepted.request_id !== id) throw new Error('刷新服务响应无效，请稍后重试');
        const runId = Number(accepted.run_id), deadline = now() + 10 * 60 * 1000;
        onProgress('waiting');
        while (now() < deadline) {
          await sleep(10000);
          let snapshot = null, run = null;
          try {
            const latest = await request(`data.json?refresh=${encodeURIComponent(id)}&t=${now()}`);
            if (latest.ok) snapshot = await latest.json();
          } catch (_) {} // 发布尚未完成或短暂断网时继续等待，保留当前页面。
          if (validSnapshot(snapshot) && snapshot.refresh_request_id === id) {
            applyData(snapshot); onProgress('success'); return snapshot;
          }
          if (Number.isSafeInteger(runId) && runId > 0) {
            try {
              const status = await request(`https://api.github.com/repos/lovles0/canvas-/actions/runs/${runId}`);
              if (status.ok) run = await status.json();
            } catch (_) {}
          }
          if (run?.status === 'completed') {
            if (run.conclusion !== 'success') throw new Error('Canvas 抓取或发布失败，已保留旧任务；请稍后重试或查看 Actions');
            // 随后的定时构建可能已覆盖本次请求标识；只接受不早于本次工作流的新快照。
            if (validSnapshot(snapshot) && Number(snapshot.workflow_run_id) >= runId) {
              applyData(snapshot); onProgress('success'); return snapshot;
            }
          }
        }
        throw new Error('等待发布超时，已保留旧任务；任务可能仍在运行，请稍后重新打开网页');
      } catch (error) {
        onProgress('error', error);
        throw error;
      }
    }

    return {
      refresh(key) {
        if (!inFlight) inFlight = run(key).finally(() => { inFlight = null; });
        return inFlight;
      },
    };
  }

  const api = { createRefresher, validSnapshot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CanvasRefresh = api;
})(typeof window !== 'undefined' ? window : globalThis);
