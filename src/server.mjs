// src/server.mjs — OpenAI 兼容代理服务（原生 http，零依赖）
//
// 端点：
//   GET  /v1/models            模型列表（OpenAI 格式）
//   POST /v1/chat/completions  聊天补全（支持 stream / 非 stream）
//   GET  /v1/usage             使用量查询
//   GET  /healthz              健康检查
//
// 用法：
//   node src/server.mjs
//   curl http://localhost:8787/v1/chat/completions -d '{"model":"Default","messages":[{"role":"user","content":"你好"}],"stream":true}'
//
// 多 Cookie 负载：
//   在 .env 中配置多个 TABBIT_COOKIE_1, TABBIT_COOKIE_2, ...
//   调度器按轮询（Round-Robin）分发负载到各个 cookie slot

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { CookieScheduler } from './scheduler.mjs';
import {
  getModels, fetchSessionList, fetchUsage, chat, TabbitError,
} from '../scripts/lib/tabbit.mjs';

// ─── 调度器初始化 ─────────────────────────────────────────
const scheduler = new CookieScheduler(config.cookies);

// ─── 工具函数 ─────────────────────────────────────────────
function log(...a) { console.log('[server]', ...a); }

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!config.apiKey) return true;
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${config.apiKey}`;
}

// OpenAI messages 数组 → Tabbit content 字符串
function messagesToContent(messages) {
  const valid = messages.filter(m => m && m.content != null);
  if (valid.length === 0) throw new Error('messages 为空');
  if (valid.length === 1) return String(valid[0].content);
  const roleLabel = { assistant: 'Assistant', system: 'System', user: 'User' };
  return valid.map(m => `[${roleLabel[m.role] || 'User'}]\n${m.content}`).join('\n\n');
}

// 提取原始 messages 拼接文本（用于更准确的 prompt token 估算，不含 Tabbit 格式化标记）
function messagesRawText(messages) {
  return messages
    .filter(m => m && m.content != null)
    .map(m => String(m.content))
    .join('\n');
}

// 粗略估算 token 数（作为 fallback，Tabbit 不返回 usage 事件时使用）
// 中文约 1 token ≈ 1.3 个汉字，英文约 1 token ≈ 4 个字符（与 OpenAI tiktoken 大致对齐）
function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const ascii = text.length - cjk;
  return Math.ceil(cjk / 1.3 + ascii / 4);
}

// 从 SSE 事件流提取 usage 信息（输出 OpenAI 完整格式）
// Tabbit 上游不返回 usage event，全部基于文本估算；cached_tokens 固定为 0，
// 因为上游不提供缓存命中信息，不应本地虚假估算。
function extractUsage(events, promptContent, fullContent) {
  // 优先用 Tabbit 返回的 usage 事件（预留，目前 Tabbit 不返回）
  const usageEv = events.find(e => e.event === 'usage' && e.data);
  if (usageEv?.data) {
    const d = usageEv.data;
    const pt = d.prompt_tokens || d.input_tokens || 0;
    const ct = d.completion_tokens || d.output_tokens || 0;
    if (pt || ct) {
      return {
        prompt_tokens: pt,
        completion_tokens: ct,
        total_tokens: pt + ct,
        prompt_tokens_details: {
          cached_tokens: d.prompt_tokens_details?.cached_tokens || d.cached_tokens || 0,
        },
        completion_tokens_details: {
          reasoning_tokens: d.completion_tokens_details?.reasoning_tokens || 0,
        },
      };
    }
  }
  // fallback：基于原始文本估算 prompt 和 completion token 数
  const promptTokens = estimateTokens(promptContent);
  const completionTokens = estimateTokens(fullContent);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
}

// ─── 路由处理 ─────────────────────────────────────────────

// GET /v1/models — 用第一个 slot 拉取（模型列表与账号无关）
async function handleModels(res) {
  const slot = scheduler.slots[0];
  const key = await slot.ensureSignKey(config.version, config.signKey);
  const models = await getModels(slot.cookie, config.version, key);
  sendJson(res, 200, {
    object: 'list',
    data: models.map(m => ({
      id: m.display_name,
      object: 'model',
      owned_by: 'tabbit',
    })),
  });
}

// GET /healthz — 返回所有 slot 的健康状态
async function handleHealth(res) {
  try {
    const slot = scheduler.slots[0];
    const key = await slot.ensureSignKey(config.version, config.signKey);
    const sessions = await fetchSessionList(slot.cookie);
    sendJson(res, 200, {
      ok: true,
      version: config.version,
      signKey: key.slice(0, 8) + '…',
      sessions: sessions.length,
      slots: scheduler.status(),
    });
  } catch (e) {
    sendJson(res, 503, { ok: false, error: e.message, slots: scheduler.status() });
  }
}

// GET /v1/usage — 查询当前用户使用量
async function handleUsage(req, res) {
  const slot = scheduler.next();
  try {
    const usage = await fetchUsage(slot.cookie, config.version);
    sendJson(res, 200, usage);
  } catch (e) {
    sendJson(res, 502, { error: { message: e.message } });
  }
}

// POST /v1/chat/completions
async function handleChat(req, res, rawBody) {
  let body;
  try { body = JSON.parse(rawBody); }
  catch { return sendJson(res, 400, { error: { message: 'invalid JSON body' } }); }

  const { model = 'Default', messages, stream = false } = body;
  if (!Array.isArray(messages) || !messages.length) {
    return sendJson(res, 400, { error: { message: 'messages is required and must be non-empty array' } });
  }

  // 用于 token 估算的原始 prompt 文本（不含 Tabbit 格式化标记）
  const promptText = messagesRawText(messages);

  // 轮询选择 Cookie slot（负载均衡）
  const slot = scheduler.next();

  let ctx, content;
  try {
    ctx = await scheduler.prepare(slot, config.version, config.signKey);
    content = messagesToContent(messages);
  } catch (e) {
    return sendJson(res, 502, { error: { message: 'prepare failed: ' + e.message } });
  }

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  // ─── 非流式：聚合所有 chunk ───
  if (!stream) {
    let full = '';
    /** @type {Array<{event:string,data:any}>} 记录所有事件用于提取 usage */
    const events = [];
    try {
      for await (const ev of chat({ cookie: ctx.cookie, version: config.version, signKey: ctx.signKey, sessionId: ctx.sessionId, model, content })) {
        events.push(ev);
        if (ev.event === 'message_chunk' && ev.data?.content) {
          full += ev.data.content;
        } else if (ev.event === 'error') {
          slot.invalidateSession();
          slot.markFailed();
          return sendJson(res, 502, { error: { message: ev.data?.message || 'Tabbit error', code: ev.data?.code } });
        }
      }
      slot.markHealthy();
    } catch (e) {
      if (e instanceof TabbitError) {
        slot.invalidateSession();
        slot.markFailed();
      }
      return sendJson(res, 502, { error: { message: e.message } });
    }
    const usage = extractUsage(events, promptText, full);
    return sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: full },
        finish_reason: 'stop',
      }],
      usage,
    });
  }

  // ─── 流式：SSE 转 OpenAI chunk ───
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // 客户端断开时中止上游请求
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const sendChunk = (delta, finishReason = null) =>
    res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);

  // 首块：role
  sendChunk({ role: 'assistant' });

  /** @type {string} */
  let fullContent = '';
  /** @type {Array<{event:string,data:any}>} */
  const events = [];

  try {
    for await (const ev of chat({ cookie: ctx.cookie, version: config.version, signKey: ctx.signKey, sessionId: ctx.sessionId, model, content, signal: ac.signal })) {
      events.push(ev);
      if (ev.event === 'message_chunk' && ev.data?.content) {
        fullContent += ev.data.content;
        sendChunk({ content: ev.data.content });
      } else if (ev.event === 'error') {
        slot.invalidateSession();
        slot.markFailed();
        res.write(`data: ${JSON.stringify({ error: { message: ev.data?.message || 'Tabbit error', code: ev.data?.code } })}\n\n`);
        break;
      } else if (ev.event === 'finish') {
        sendChunk({}, 'stop');
      }
    }
    slot.markHealthy();
  } catch (e) {
    if (e.name !== 'AbortError') {
      if (e instanceof TabbitError) {
        slot.invalidateSession();
        slot.markFailed();
      }
      res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
    }
  }

  // 追加 usage 宣告块（sub2api 等代理依赖此字段计费）
  const usage = extractUsage(events, promptText, fullContent);
  res.write(`data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [],
    usage,
  })}\n\n`);

  res.write('data: [DONE]\n\n');
  res.end();
}

// ─── HTTP 服务 ────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (!checkAuth(req)) {
    return sendJson(res, 401, { error: { message: 'invalid API key', type: 'invalid_request_error' } });
  }

  try {
    if (path === '/v1/models' && req.method === 'GET') return await handleModels(res);
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      const raw = await readBody(req);
      return await handleChat(req, res, raw);
    }
    if (path === '/v1/usage' && req.method === 'GET') return await handleUsage(req, res);
    if (path === '/healthz' && req.method === 'GET') return await handleHealth(res);
    sendJson(res, 404, { error: { message: `not found: ${req.method} ${path}` } });
  } catch (e) {
    log('error:', e);
    if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } });
    else res.end();
  }
});

server.listen(config.port, () => {
  const slotCount = scheduler.size;
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Tabbit2API · OpenAI 兼容代理');
  console.log(`  端口: ${config.port}`);
  console.log(`  鉴权: ${config.apiKey ? '已开启 (Bearer ' + config.apiKey.slice(0, 4) + '…)' : '未开启'}`);
  console.log(`  版本: ${config.version}`);
  console.log(`  Cookie: ${slotCount} 个 slot${slotCount > 1 ? '（轮询分发）' : ''}`);
  console.log('───────────────────────────────────────────────────────────');
  console.log('  GET  /v1/models             模型列表');
  console.log('  POST /v1/chat/completions   聊天补全 (stream / 非 stream)');
  console.log('  GET  /v1/usage              使用量查询');
  console.log('  GET  /healthz               健康检查');
  console.log('═══════════════════════════════════════════════════════════\n');
});
