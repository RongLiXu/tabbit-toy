// background.js — 抓取 web.tabbit.ai 的请求 header + body
// 分别保存：chat（聊天补全）和 session（会话操作）请求

const ALL_PATTERN = 'https://*.tabbit.ai/*';
const MAX_HISTORY = 20;

let chatCapture = null;       // 最近一条 chat/completion 请求
let sessionCapture = null;    // 最近一条 /session/ 请求
let recentRequests = [];
let tabbitVersion = '';       // 从 x-req-ctx header 自动解码的版本号

// 从 x-req-ctx header 解码 tabbitVersion（base64 编码）
function decodeVersion(headerValue) {
  try { return atob(headerValue); } catch { return ''; }
}

function classify(url) {
  const u = url.toLowerCase();
  if (u.includes('chat/completion') || u.includes('chat/send')) return 'chat';
  if (u.includes('/session/') || u.includes('/newtab')) return 'session';
  if (u.includes('sign-key')) return 'signkey';
  if (u.includes('model_config') || u.includes('/models')) return 'models';
  return 'other';
}

// onBeforeSendHeaders — 抓 header
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details.url.includes('tabbit.ai')) return;
    const kind = classify(details.url);

    // 从 x-req-ctx 解码版本号
    const reqCtx = (details.requestHeaders || []).find(h => h.name.toLowerCase() === 'x-req-ctx');
    if (reqCtx?.value) {
      const decoded = decodeVersion(reqCtx.value);
      if (decoded && decoded !== tabbitVersion) {
        tabbitVersion = decoded;
        chrome.storage.local.set({ tabbitVersion });
        console.log('[Tabbit抓取] 版本号:', tabbitVersion);
      }
    }

    const captured = {
      timestamp: new Date().toISOString(),
      method: details.method,
      url: details.url,
      kind,
      headers: (details.requestHeaders || []).map(h => ({ name: h.name, value: h.value })),
      requestId: details.requestId,
    };

    recentRequests.unshift(captured);
    if (recentRequests.length > MAX_HISTORY) recentRequests.pop();

    if (details.method === 'POST' && (kind === 'chat' || kind === 'session')) {
      const target = kind === 'chat' ? chatCapture : sessionCapture;
      // 合并已存的 body（onBeforeRequest 先触发）
      if (target && target.requestId === details.requestId) {
        captured.body = target.body;
      }
      if (kind === 'chat') chatCapture = captured;
      else sessionCapture = captured;
      chrome.storage.local.set({
        chatRequest: chatCapture,
        sessionRequest: sessionCapture,
        recentRequests,
      });
      console.log('[Tabbit抓取]', kind, '请求:', details.url, '头数:', captured.headers.length);
    } else {
      chrome.storage.local.set({ recentRequests });
    }
  },
  { urls: [ALL_PATTERN] },
  ['requestHeaders']
);

// onBeforeRequest — 抓 body
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!details.url.includes('tabbit.ai')) return;
    const kind = classify(details.url);
    if (kind !== 'chat' && kind !== 'session') return;
    if (details.method !== 'POST') return;

    let bodyText = null;
    if (details.requestBody && details.requestBody.raw) {
      try {
        const dec = new TextDecoder();
        bodyText = details.requestBody.raw.map(c => dec.decode(c.bytes)).join('');
      } catch (e) {
        bodyText = '[decode error: ' + e.message + ']';
      }
    }

    const existing = kind === 'chat' ? chatCapture : sessionCapture;
    const entry = existing && existing.requestId === details.requestId ? existing : {
      timestamp: new Date().toISOString(),
      method: details.method,
      url: details.url,
      kind,
      headers: [],
      body: bodyText,
      requestId: details.requestId,
    };
    entry.body = bodyText;
    if (kind === 'chat') chatCapture = entry;
    else sessionCapture = entry;
    chrome.storage.local.set({
      chatRequest: chatCapture,
      sessionRequest: sessionCapture,
    });
    console.log('[Tabbit抓取]', kind, '请求体:', (bodyText || '').slice(0, 120));
  },
  { urls: [ALL_PATTERN] },
  ['requestBody']
);

// popup 通信
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getCapture') {
    chrome.storage.local.get(['chatRequest', 'sessionRequest', 'recentRequests', 'tabbitVersion'], (res) => {
      sendResponse({
        chat: res.chatRequest || null,
        session: res.sessionRequest || null,
        recent: res.recentRequests || [],
        version: res.tabbitVersion || '',
      });
    });
    return true;
  }
  if (msg.type === 'clearCapture') {
    chatCapture = null;
    sessionCapture = null;
    recentRequests = [];
    tabbitVersion = '';
    chrome.storage.local.remove(['chatRequest', 'sessionRequest', 'recentRequests', 'tabbitVersion']);
    sendResponse({ ok: true });
  }
});
