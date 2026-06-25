// scripts/check-deepseek-events.mjs — 3次 DeepSeek-V4-Flash 请求，检查上游是否有缓存 token
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
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
const MODEL = 'DeepSeek-V4-Flash';
const BASE = 'https://web.tabbit.ai';

const MESSAGES = [
  '用一句话介绍量子计算',
  '它和传统计算机有什么主要区别？',
  '那量子纠错为什么这么难？',
];

async function doChat(sessionId, userMsg, round) {
  const content = userMsg;
  const bodyStr = JSON.stringify({
    chat_session_id: sessionId,
    message_id: null,
    content,
    selected_model: MODEL,
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

  console.log(`\n═══ Round ${round}: "${userMsg.slice(0, 20)}..." ═══`);
  console.log(`HTTP ${res.status}`);

  if (!res.ok || !res.headers.get('content-type')?.includes('event-stream')) {
    const text = await res.text().catch(() => '');
    console.log(`非 SSE: ${text.slice(0, 300)}`);
    return null;
  }

  const events = [];
  for await (const ev of parseSSE(res.body)) {
    let parsed = null;
    try { parsed = JSON.parse(ev.data); } catch {}
    events.push({ event: ev.event, parsed, raw: ev.data });
  }

  console.log(`共 ${events.length} 个事件`);
  
  // 输出每个事件的 event 类型 + 完整字段
  for (const ev of events) {
    const p = ev.parsed;
    if (p && typeof p === 'object' && Object.keys(p).length) {
      const keys = Object.keys(p);
      // 检查是否有缓存/token相关字段
      const suspicious = keys.filter(k => /cache|token|usage|prompt|completion|input|output/i.test(k));
      console.log(`  [${ev.event}] keys: ${keys}${suspicious.length ? ' ⚠️ FOUND: ' + suspicious.map(k => `${k}=${JSON.stringify(p[k])}`).join(', ') : ''}`);
    } else {
      console.log(`  [${ev.event}] ${JSON.stringify(p)}`);
    }
  }

  return events;
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` 模型: ${MODEL}  | 版本: ${VERSION}`);
  console.log('═══════════════════════════════════════════════════════════');

  const sessions = await fetchSessionList(COOKIE);
  const sessionId = sessions[0];
  console.log(`\nSession: ${sessionId}`);

  const allRounds = {};
  for (let i = 0; i < 3; i++) {
    const events = await doChat(sessionId, MESSAGES[i], i + 1);
    allRounds[`round${i+1}`] = events;
  }
  
  writeFileSync('logs/deepseek-v4-flash-sse.json', JSON.stringify(allRounds, null, 2));
  console.log('\n日志已保存到 logs/deepseek-v4-flash-sse.json');
  console.log('═══════════════════════════════════════════════════════════');
})();
