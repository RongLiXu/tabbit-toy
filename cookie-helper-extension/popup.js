// popup.js
const DOMAIN = 'tabbit.ai';

// ─── ① Cookie ─────────────────────────────────
const cookieStatus = document.getElementById('cookieStatus');
const cookieNames = document.getElementById('cookieNames');
const cookieEl = document.getElementById('cookie');
const copyCookieBtn = document.getElementById('copyCookie');

chrome.cookies.getAll({ domain: DOMAIN }, (cookies) => {
  if (chrome.runtime.lastError) {
    cookieStatus.textContent = '✗ 读取失败：' + chrome.runtime.lastError.message;
    cookieStatus.className = 'status err';
    return;
  }
  if (!cookies || cookies.length === 0) {
    cookieStatus.textContent = '⚠ 没抓到 tabbit.ai Cookie，先登录 web.tabbit.ai。';
    cookieStatus.className = 'status err';
    return;
  }
  const sorted = [...cookies].sort((a, b) => a.name.localeCompare(b.name));
  const str = sorted.map(c => `${c.name}=${c.value}`).join('; ');
  cookieEl.value = str;
  const httpOnlyCount = cookies.filter(c => c.httpOnly).length;
  cookieStatus.textContent = `✓ ${cookies.length} 个 Cookie（${httpOnlyCount} HttpOnly），${str.length} 字符`;
  cookieNames.innerHTML = sorted.map(c =>
    `<span style="display:inline-block;background:#eee;border-radius:3px;padding:1px 5px;margin:2px;">${c.name}${c.httpOnly ? '🔒' : ''}</span>`
  ).join('');
});

async function copyText(text, btn, originalText) {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); }
  catch { /* fallback */ }
  btn.textContent = '✓ 已复制';
  btn.classList.add('done');
  setTimeout(() => { btn.textContent = originalText; btn.classList.remove('done'); }, 2000);
}

copyCookieBtn.addEventListener('click', () => copyText(cookieEl.value, copyCookieBtn, '复制 Cookie'));

// ─── ② Session / ③ Chat 请求 ──────────────────
const sessStatus = document.getElementById('sessStatus');
const sessBox = document.getElementById('sessBox');
const copySessBtn = document.getElementById('copySess');
const hdrStatus = document.getElementById('hdrStatus');
const headerBox = document.getElementById('headerBox');
const copyHdrBtn = document.getElementById('copyHdr');
const refreshHdrBtn = document.getElementById('refreshHdr');
const clearHdrBtn = document.getElementById('clearHdr');
const recentList = document.getElementById('recentList');

function formatCapture(cap) {
  if (!cap) return null;
  const hdrLines = cap.headers.map(h => `${h.name}: ${h.value}`).join('\n');
  return `=== 抓取时间 ===\n${cap.timestamp}\n\n` +
    `=== 请求 URL ===\n${cap.method} ${cap.url}\n\n` +
    `=== 请求头 (${cap.headers.length} 个) ===\n${hdrLines}\n\n` +
    `=== 请求体 ===\n${cap.body || '(空)'}\n`;
}

function renderCapture(data) {
  const sess = data?.session;
  const chat = data?.chat;
  const recent = data?.recent || [];

  // 最近请求
  if (recent.length > 0) {
    recentList.innerHTML = recent.slice(0, 15).map(r => {
      const short = r.url.replace('https://web.tabbit.ai', '');
      const colors = { chat: '#059669', session: '#7c3aed', signkey: '#d97706', models: '#2563eb' };
      const c = colors[r.kind] || '#999';
      return `<div style="color:${c};font-weight:${r.kind==='chat'||r.kind==='session'?'bold':'normal'};padding:2px 0;border-bottom:1px solid #f0f0f0;">${r.method} ${short} <span style="color:#aaa">(${r.headers.length}头)</span></div>`;
    }).join('');
  } else {
    recentList.innerHTML = '<div style="color:#aaa;padding:4px;">还没有请求</div>';
  }

  // session
  if (sess) {
    sessBox.textContent = formatCapture(sess);
    sessStatus.textContent = `✓ 已抓取（${sess.headers.length} 个头）· ${sess.timestamp.slice(11, 19)}`;
    copySessBtn.disabled = false;
  } else {
    sessBox.innerHTML = '<span class="empty">尚未抓到。新建/打开聊天时会触发。</span>';
    sessStatus.textContent = '等待中…';
    copySessBtn.disabled = true;
  }

  // chat
  if (chat) {
    headerBox.textContent = formatCapture(chat);
    hdrStatus.textContent = `✓ 已抓取（${chat.headers.length} 个头）· ${chat.timestamp.slice(11, 19)}`;
    copyHdrBtn.disabled = false;
  } else {
    headerBox.innerHTML = '<span class="empty">尚未抓到。发消息时会触发。</span>';
    hdrStatus.textContent = '等待中…';
    copyHdrBtn.disabled = true;
  }
}

function loadCapture() {
  chrome.runtime.sendMessage({ type: 'getCapture' }, (data) => {
    if (chrome.runtime.lastError) {
      hdrStatus.textContent = '✗ 扩展未就绪：' + chrome.runtime.lastError.message;
      return;
    }
    renderCapture(data);
  });
}

refreshHdrBtn.addEventListener('click', loadCapture);
clearHdrBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'clearCapture' }, () => loadCapture());
});
copyHdrBtn.addEventListener('click', () => copyText(headerBox.textContent, copyHdrBtn, '复制 Chat Header+Body'));
copySessBtn.addEventListener('click', () => copyText(sessBox.textContent, copySessBtn, '复制 Session Header+Body'));

loadCapture();
setInterval(loadCapture, 1500);
