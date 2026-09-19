# Canvas 待办云同步设置

网站仍托管在 GitHub Pages；Supabase 只保存手动完成和永久忽略状态，不保存 Canvas Token 或作业正文。

## 1. 创建 Supabase 项目

1. 登录 [Supabase Dashboard](https://supabase.com/dashboard)。
2. 创建一个免费项目，例如 `canvas-state`。
3. 打开 **SQL Editor**，执行仓库根目录的 `supabase_schema.sql`。

## 2. 获取浏览器公开配置

在 **Project Settings → API** 中复制：

- Project URL
- `anon` / publishable key

不要复制或公开 `service_role` / secret key。

## 3. 配置 GitHub Actions

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 新增：

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

重新运行 `Sync Canvas Assignments` 工作流。构建脚本会把这两个浏览器公开值写入页面配置。

## 4. 启用同步

1. 打开网站右上角云朵按钮。
2. 第一台设备点击“生成同步码”，保存并同步。
3. 在其他设备输入同一个同步码。

同步码相当于这份状态数据的密码。请保存在密码管理器中，不要公开分享。

