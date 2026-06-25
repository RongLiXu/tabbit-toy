// src/config.mjs — 配置加载（.env + 环境变量）

import { readFileSync, existsSync } from 'node:fs';

function loadEnvFile() {
  const env = {};
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}

const ENV = loadEnvFile();

// ─── Cookie 解析 ──────────────────────────────────────────
// 支持多 Cookie 的三种方式（优先级从高到低）：
//   1. TABBIT_COOKIE_1, TABBIT_COOKIE_2, ... 序号变量（推荐，清晰可维护）
//   2. TABBIT_COOKIE 中用 ||| 分隔多个 cookie（向后兼容）
//   3. TABBIT_COOKIE 单独一个 cookie（单账号场景）
//
// 示例 .env：
//   TABBIT_COOKIE_1=_fbp=fb.1.xxx;token=abc...
//   TABBIT_COOKIE_2=_fbp=fb.1.yyy;token=def...
function loadCookies() {
  // 优先检查序号变量 TABBIT_COOKIE_1, _2, _3 ...
  const indexed = [];
  for (let i = 1; ; i++) {
    const v = ENV[`TABBIT_COOKIE_${i}`] || process.env[`TABBIT_COOKIE_${i}`];
    if (!v) break;
    indexed.push(v);
  }
  if (indexed.length > 0) return indexed;

  // 降级：单 TABBIT_COOKIE（支持 ||| 向后兼容）
  const raw = ENV.TABBIT_COOKIE || process.env.TABBIT_COOKIE || '';
  if (raw.includes('|||')) {
    return raw.split('|||').map(c => c.trim()).filter(Boolean);
  }
  if (raw) return [raw];

  return [];
}

const cookies = loadCookies();

export const config = {
  /** Tabbit 登录态 Cookie 列表（支持多账号负载） */
  cookies,
  /** 向后兼容：单 cookie 场景下等同于 cookies[0] */
  cookie: cookies[0] || '',
  /** Tabbit 版本号，用于 x-req-ctx 头 */
  version: ENV.TABBIT_VERSION || process.env.TABBIT_VERSION || '1.1.39(10101039)',
  /** 签名 key（留空则自动从 /chat/sign-key 拉取并定期刷新） */
  signKey: ENV.TABBIT_SIGN_KEY || process.env.TABBIT_SIGN_KEY || '',
  /** HTTP 服务端口 */
  port: Number(ENV.PORT || process.env.PORT || 8787),
  /** 可选：保护代理端点的 API Key */
  apiKey: ENV.API_KEY || process.env.API_KEY || '',
};

if (cookies.length === 0) {
  console.error('✗ 缺少 TABBIT_COOKIE，请在 .env 中填入 web.tabbit.ai 的 Cookie');
  console.error('  支持多 Cookie：');
  console.error('    TABBIT_COOKIE_1=......（推荐，每行一个 cookie）');
  console.error('    TABBIT_COOKIE=cookie1|||cookie2（||| 分隔，向后兼容）');
  process.exit(1);
}
