# Canvas 待办云同步设置

网站仍托管在 GitHub Pages；Supabase 只保存手动完成和永久忽略状态，不保存 Canvas Token 或作业正文。当前部署已配置 `canvas-state` 项目，可以直接跳到第 4 步。

## 1. 创建 Supabase 项目

1. 登录 [Supabase Dashboard](https://supabase.com/dashboard)。
2. 创建一个免费项目，例如 `canvas-state`。
3. 打开 **SQL Editor**，执行仓库根目录的 `supabase_schema.sql`。已有项目也应重新执行该文件，以启用逐项目原子合并。

## 2. 获取浏览器公开配置

在 **Project Settings → API Keys** 或项目 **Connect** 对话框中复制：

- Project URL
- publishable key（推荐，`sb_publishable_` 开头）；也兼容旧 `anon` key

不要复制或公开 `service_role` / secret key。

## 3. 配置 GitHub Actions

可以把这两个**浏览器公开值**成对配置在 `public-config.json` 的 `supabase_url`、`supabase_anon_key` 中；现有字段名保留，支持新旧 key。

也可以在 GitHub 仓库 **Settings → Secrets and variables → Actions** 成对新增以下值，覆盖文件配置：

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

重新运行 `Sync Canvas Assignments` 工作流。构建脚本会把这两个浏览器公开值写入页面配置。不要只覆盖其中一个，否则同步保持未配置状态，避免混用不同项目的 URL 和 key。

## 4. 启用同步

1. 打开网站右上角云朵按钮。
2. 第一台设备点击“生成同步码”，保存并同步。
3. 在其他设备输入同一个同步码。

同步码相当于这份状态数据的密码。请保存在密码管理器中，不要公开分享。

## 同步行为与边界

- 本地修改保留 500ms debounce；重新回到前台、从 bfcache 恢复、网络恢复时自动同步。前台每 60 秒检查远端变化，后台不轮询。
- 未发生本地新修改时只读取，不重复写回或重绘；失败保留本地状态，请求 15 秒超时后可以重试。
- 同浏览器标签页使用 `storage` 事件及写入前合并共享存储；序列化键顺序固定，避免标签页反复写回。
- 不同作业的修改取并集；同一作业以较新 `updatedAt` 为准。数据库用行锁及事务原子合并，旧 `write_canvas_state` 接口同样合并，不整份覆盖。
- 状态表开启 RLS，禁止 `anon` / `authenticated` 直接读写和列举。公开 RPC 为 `SECURITY INVOKER` 包装；有权限的核心函数位于非 API `private` schema，限定完整 UUID 同步码和单次输入大小。
- 这是持有随机同步码即可访问的模式，不是账号登录或 `auth.uid()` 隔离。知道同步码的人能读写该份状态；不要把它放进网址、公开文件或聊天。
- `updatedAt` 仍来自设备时钟：时钟偏差或完全相同的时间戳无法可靠判断真实先后。浏览器存储也不是事务数据库，极端同时写入仍有边界；保留云端原子合并及前台重试以降低风险。

## 验证

`python -m unittest discover -s tests -v`、`node tests/test_app_sync.js`、`node --test tests/test_sync_lifecycle.js` 覆盖构建配置及前端同步生命周期。

`tests/test_sync_database.sql` 在 SQL Editor / MCP 中执行，使用事务回滚测试权限隔离、不同项目合并、新旧冲突与旧接口兼容，不保留测试记录。
