# Tabbit2API

> 把 **Tabbit 浏览器**内置的 AI 聊天功能,变成一个**标准 OpenAI API**,让你不用开浏览器就能调用里面的 Claude、GPT、Gemini 等模型。

## 这是什么

[Tabbit](https://tabbit.ai) 是一款基于 Chromium 的国产 AI 浏览器,内置了 21 个 AI 模型(Claude-Opus-4.8、GPT-5.5、Gemini-3.5-Flash、DeepSeek-V4-Pro 等)。正常情况下你必须**打开 Tabbit 浏览器**才能用这些模型。

**本项目做的事**:逆向了 Tabbit 浏览器和它后端(`web.tabbit.ai`)的通信协议,在本地起一个服务,把"标准 OpenAI 格式的请求"翻译成"Tabbit 能懂的请求"再转发,这样你就能:

- ✅ 不开浏览器,命令行 / 代码直接调用
- ✅ 接入任何 OpenAI 兼容客户端(Cherry Studio / NextChat / LangChain / OpenAI SDK)
- ✅ 像用 OpenAI 官方 API 一样用 Tabbit 的模型

```
你的客户端 ──OpenAI格式──▶ Tabbit2API(本地服务) ──翻译+签名──▶ web.tabbit.ai
    ▲                                                                    │
    └────────────── OpenAI 格式回复 ◀─────────── SSE 流 ◀────────────────┘
```

## 前置条件

1. **装了 Tabbit 浏览器**并能登录账号([tabbit.ai](https://tabbit.ai) 下载)
2. **Pro 会员**:在 Tabbit 设置里"设为默认浏览器"可解锁(免费),premium 模型(Claude/GPT/Gemini)必需
3. **Node.js 18+**(本项目零依赖,无需 `npm install`)

## 快速开始

### 第 1 步:导出 Cookie

Tabbit 的登录态存在 Cookie 里(含一个 HttpOnly 的 JWT token),需要从浏览器导出一次。

**用本项目自带的 Chrome 扩展(推荐)**:

1. 打开 Chrome 或 Tabbit 浏览器,地址栏输入 `chrome://extensions/`
2. 右上角打开**「开发者模式」**
3. 点**「加载已解压的扩展程序」**,选 `D:\toy\tabbit2api\cookie-helper-extension` 文件夹
4. 访问 `https://web.tabbit.ai/` 并登录
5. 点浏览器工具栏上的扩展图标 → 点**「复制 Cookie」**
6. 准备粘贴(下一步用)

> 也可以手动:F12 → Application → Cookies → `https://web.tabbit.ai` → 把每条 `name=value` 用 `; ` 拼起来

### 第 2 步:获取真实版本号

在 Tabbit 浏览器的 `web.tabbit.ai` 页面按 F12,Console 里执行:

```js
chrome.tabInstance.getDeviceInfo().then(d => console.log(d.tabbitVersion))
```

会输出类似 `1.1.39(10101039)`,记下这个值。

### 第 3 步:配置 .env

复制配置模板:

```bash
cp .env.example .env
```

用记事本打开 `.env`,填两个字段:

```env
TABBIT_COOKIE=粘贴第1步复制的整串 Cookie
TABBIT_VERSION=1.1.39(10101039)   # 填第2步拿到的值
```

### 第 4 步:启动服务

```bash
node src/server.mjs
```

看到下面的输出就说明启动成功:

```
═══════════════════════════════════════════════════════════
 Tabbit2API · OpenAI 兼容代理
  端口: 8787
  鉴权: 未开启
  版本: 1.1.39(10101039)
═══════════════════════════════════════════════════════════
```

### 第 5 步:调用

**命令行测试**:

```bash
# 非流式
curl http://localhost:8787/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"Default\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"

# 流式
curl http://localhost:8787/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"Claude-Opus-4.8\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}],\"stream\":true}"
```

**接入 Cherry Studio / NextChat 等客户端**:

| 设置项 | 填什么 |
|--------|--------|
| API 地址 (baseURL) | `http://localhost:8787/v1` |
| API Key | 随便填(如 `sk-anything`),不校验 |
| 模型名 | `Default` / `Claude-Opus-4.8` / `GPT-5.5` 等(见下方列表) |

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/models` | 模型列表(OpenAI 格式) |
| `POST` | `/v1/chat/completions` | 聊天补全(支持 `stream: true/false`) |
| `GET` | `/healthz` | 健康检查(Cookie 是否有效 + 会话数) |

## 可用模型

| 模型 | 类型 |
|------|------|
| `Default` | 免费无限 |
| `GLM-5.2` `GLM-5.1` | 免费计量 |
| `DeepSeek-V4-Pro` `DeepSeek-V4-Flash` `DeepSeek-V3.2` | 免费计量 |
| `Kimi-K2.6` `Kimi-K2.5` | 免费计量 |
| `MiniMax-M3` `MiniMax-M2.7` | 免费计量 |
| `Claude-Haiku-4.5` | 免费计量 |
| `GPT-5.2-Chat` | 免费计量 |
| `Qwen3.5-Plus` `Doubao-Seed-1.8` | 免费计量 |
| `Claude-Opus-4.8` `Claude-Opus-4.7` `Claude-Sonnet-4.6` | ⭐ Pro 会员 |
| `GPT-5.5` `GPT-5.4` | ⭐ Pro 会员 |
| `Gemini-3.5-Flash` `Gemini-3.1-Pro` | ⭐ Pro 会员 |

> ⭐ Pro 会员模型需要:① 账号设过默认浏览器 ② 请求头 `unique-uuid` 标记位 = 1(本项目已自动处理)

## 配置项(.env)

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `TABBIT_COOKIE` | ✅ 是 | — | web.tabbit.ai 域下完整 Cookie |
| `TABBIT_VERSION` | ✅ 是 | `1.1.39(10101039)` | 真实版本号(来自 getDeviceInfo) |
| `TABBIT_SIGN_KEY` | ❌ 否 | 自动拉取 | HMAC 签名 key |
| `PORT` | ❌ 否 | `8787` | 服务端口 |
| `API_KEY` | ❌ 否 | 空(不校验) | 代理鉴权 key |

## 项目结构

```
tabbit2api/
├── src/
│   ├── server.mjs              # OpenAI 兼容 HTTP 服务(原生 http,零依赖)
│   └── config.mjs              # 配置加载
├── scripts/
│   ├── probe.mjs               # 探测脚本(验证 Cookie/签名/聊天是否通)
│   └── lib/
│       └── tabbit.mjs          # ★ 逆向核心:签名/指纹/SSE/会话/聊天
├── cookie-helper-extension/    # Chrome 扩展:导出 Cookie + 抓请求
├── docs/                       # 协议文档 + 实现路线图
├── .env.example                # 配置模板
└── package.json
```

## 常见问题

<details>
<summary><b>Cookie 过期了怎么办?</b></summary>

JWT token 有效期约 7 天。过期后用扩展重新导出一次 Cookie,更新 `.env` 里的 `TABBIT_COOKIE` 重启服务即可。
</details>

<details>
<summary><b>报错 "premium users only"?</b></summary>

premium 模型(Claude/GPT/Gemini)需要 Pro 会员:在 Tabbit 浏览器设置里"设为默认浏览器"解锁。本项目的 `unique-uuid` 标记位已自动设为 1。
</details>

<details>
<summary><b>报错 "AI service temporarily unavailable"?</b></summary>

通常是 `chat_session_id` 失效。服务会自动从 `/newtab` 拉取会话列表,如果账号下没有会话,先在 Tabbit 浏览器里随便发一条消息创建一个对话即可。
</details>

<details>
<summary><b>报错 493 "update_version"?</b></summary>

`TABBIT_VERSION` 格式不对。必须是真实格式(如 `1.1.39(10101039)`),用第 2 步的方法从 `getDeviceInfo()` 获取。
</details>

## 文档

- [docs/逆向流程与协议.md](docs/逆向流程与协议.md) — 协议细节(端点/签名/SSE/Pro 机制)
- [docs/实现路线图.md](docs/实现路线图.md) — 项目结构与技术栈

## 注意事项

- ⚠️ Cookie 等同账号控制权,`.env` 已加入 `.gitignore`,切勿提交到 git
- ⚠️ 仅供个人学习研究,不要商用、高并发滥用、二次分发账号
- 本项目基于逆向分析,Tabbit 更新后协议可能变化,需要重新适配
