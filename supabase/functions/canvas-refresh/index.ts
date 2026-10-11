import { createHandler } from './handler.mjs';

// 本函数自行验证专用刷新码；不将 GitHub / 数据库管理密钥发送到浏览器。
Deno.serve(createHandler({ getEnv: (name: string) => Deno.env.get(name) }));
