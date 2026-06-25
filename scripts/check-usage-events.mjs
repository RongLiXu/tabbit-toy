// scripts/check-usage-events.mjs — 抓取 Tabbit SSE 所有事件，检查是否有缓存 / token 字段
// 直接输出原始 data，不丢失任何字段
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { signHeaders, baseHeaders, parseSSE, fetchSessionList, DEFAULT_SIGN_KEY } from './lib/tabbit.mjs';

function loadEnv() {
  const env = {};
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}

const ENV = loadEnv();
const COOKIE = ENV.TABBIT_COOKIE || process.env.TABBIT_COOKIE;
const VERSION = ENV.TABBIT_VERSION || process.env.TABBIT_VERSION || '1.1.39(10101039)';
const SIGN_KEY = ENV.TABBIT_SIGN_KEY || DEFAULT_SIGN_KEY;

const BASE = 'https://web.tabbit.ai';

async function checkEventFields(rawLog) {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 检查 Tabbit SSE 事件字段');
  console.log(` 版本: ${VERSION}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // 1. 获取 session
  const sessions = await fetchSessionList(COOKIE);
  const sessionId = sessions[0];
  console.log(`使用 session: ${sessionId}\n`);

  // 2. 发第一轮请求
  console.log('─── 第一轮（首次对话）─────────────────────────────────');
  await doChat(sessionId, '介绍一下机器学习', rawLog, 'round1');

  // 3. 发第二轮请求（同一 session，有上下文）
  console.log('\n─── 第二轮（同一 session，有上下文）────────────────────');
  await doChat(sessionId, '刚刚说的深度学习具体有哪些应用？', rawLog, 'round2');

  console.log('\n────────────────────────────────────────────────────────');
  console.log('完成。原始日志已保存到 logs/ 目录。');
}

async function doChat(sessionId, userMsg, rawLog, roundKey) {
  const content = userMsg;
  const bodyStr = JSON.stringify({
    chat_session_id: sessionId,
    message_id: null,
    content,
    selected_model: 'Default',
    parallel_group_id: null,
    task_name: 'chat',
    agent_mode: false,
    metadatas: { html_content: `<p>${content}</p>` },
    references: [],
    entity: { key: 'd41d8cd98f00b204e9800998ecf8427e', extras: { type: 'tab', url: '' } },
  });

  const headers = {
    ...baseHeaders(COOKIE, VERSION, true),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
    ...signHeaders(bodyStr, SIGN_KEY),
  };

  const res = await fetch(`${BASE}/api/v1/chat/completion`, {
    method: 'POST', headers, body: bodyStr,
  });

  console.log(`HTTP ${res.status} ${res.statusText}`);

  if (!res.ok || !res.headers.get('content-type')?.includes('event-stream')) {
    console.log(`非 SSE 响应: ${await res.text().catch(() => '')}`);
    return;
  }

  const events = [];
  for await (const ev of parseSSE(res.body)) {
    // 输出每个事件的原始信息
    let parsed = null;
    try { parsed = JSON.parse(ev.data); } catch {}
    events.push({ event: ev.event, raw: ev.data, parsed });

    // 打印事件概要 + 完整字段
    console.log(`\n  [${ev.event}]`);
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        const val = typeof v === 'string' ? (v.length > 100 ? v.slice(0, 100) + '…' : v) : JSON.stringify(v).slice(0, 100);
        console.log(`    ${k}: ${val}`);
        // 检查是否有缓存/token相关字段
        if (/cache|token|usage|prompt|completion|reasoning/i.test(k)) {
          console.log(`    ⚠️  疑似缓存/计费字段: ${k}=${JSON.stringify(v)}`);
        }
      }
    } else {
      console.log(`    data: ${ev.data.slice(0, 200)}`);
    }
  }

  // 保存原始日志
  rawLog[roundKey] = events;
  console.log(`\n  → 共 ${events.length} 个事件`);
}

(async () => {
  const rawLog = {};
  try {
    await checkEventFields(rawLog);
    // 保存到文件
    const { writeFileSync } = await import('node:fs');
    writeFileSync('logs/raw-sse-events.json', JSON.stringify(rawLog, (k, v) =>
      typeof v === 'string' ? v : v, 2));
    console.log('\n原始 SSE 已保存到 logs/raw-sse-events.json');
  } catch (e) {
    console.error('错误:', e);
    process.exit(1);
  }
})();
