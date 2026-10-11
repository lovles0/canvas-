# 网站一键更新

网站继续使用 GitHub Pages。点击“从 Canvas 更新”后，Supabase Edge Function 触发现有 `sync.yml`，GitHub Actions 从 Canvas 抓取并发布；浏览器等到对应发布快照才替换任务，不是只刷新旧网页。

## 云端配置

1. 在 Supabase 执行 `supabase_refresh.sql`，部署 `supabase/functions/canvas-refresh/`。本函数关闭平台 JWT 校验，是因为 `handler.mjs` 会自行验证专用刷新码；**不能删除这项验证**。
2. 在 GitHub 创建 fine-grained Token：只选 `lovles0/canvas-`，授予 **Actions: Read and write**，设置合理有效期。Token 到期后需重新配置。
3. 在 Supabase **Edge Functions → Secrets** 保存：
   - `GITHUB_ACTIONS_TOKEN`：上述 GitHub Token。
   - `CANVAS_REFRESH_KEY`：密码管理器生成的至少 32 位随机字母数字，作为专用刷新码。
4. 修改 `public-config.json` 的 `refresh_url` 为部署后的公开函数 URL（也可以用构建环境变量 `CANVAS_REFRESH_URL` 覆盖）。不要在此文件填写密钥。
5. 推送到 `main`，让 Pages 部署包含新的 workflow inputs 和前端代码。

Canvas Token 保持在 GitHub Actions 原有 Secrets 内，无需移到 Supabase；GitHub Token 和数据库管理密钥不进入网页、仓库、响应或日志。刷新码仅保存在用户自己的浏览器，能力仅限触发这一个工作流。

## 使用

首次点击“从 Canvas 更新”，输入自己保存的 `CANVAS_REFRESH_KEY`。之后每次只需点击更新。需要改码时点击“刷新设置”。跨设备同步码是另一份配置，不能代替刷新码。

界面显示请求、等待发布、成功或错误；等待期间仍可操作任务，完成和忽略记录不被清空。每 10 秒检查发布，最多等待 10 分钟，单次网络请求有超时。多次点击共用同一任务；数据库行锁保证多台设备合计每两分钟最多触发一次。

如果刷新失败，检查 GitHub Token 有效期/权限、Supabase Secrets 和 [Actions](https://github.com/lovles0/canvas-/actions/workflows/sync.yml)。网络中断时触发结果可能不确定：先查看 Actions，两分钟后再重试。后台浏览器可能暂停轮询，恢复后继续检查；超时并不取消云端任务。

## 验证

```text
python -m unittest discover -s tests -v
node tests/test_app_sync.js
node --test tests/test_refresh_client.js tests/test_refresh_gateway.mjs
node --check app.js
node --check refresh.js
```

上线后用正确刷新码进行一次端到端验证：按钮等待结束、Actions 成功部署、`data.json` 的 `refresh_request_id` 与请求一致、网页更新时间变化。无授权请求应返回 401；预检只允许网站来源；匿名角色不能调用限流 RPC 或读取私有表。
