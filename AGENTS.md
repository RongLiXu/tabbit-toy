# Tabbit2API

将 Tabbit AI 浏览器后端逆向为 OpenAI 兼容 API 的本地代理服务。零依赖，纯 Node.js 原生实现。

## Project

- **用途**: 代理 `web.tabbit.ai` 的 AI 聊天接口，暴露 OpenAI 格式 API（`/v1/chat/completions`, `/v1/models`）
- **技术栈**: Node.js 18+，ESM（`.mjs`），零 npm 依赖，纯原生 API（`http`, `crypto`, `fetch`, `ReadableStream`）
- **入口**: `node src/server.mjs`（HTTP 服务，默认端口 8787）

## Commands

```bash
node src/server.mjs              # 启动代理服务
node scripts/probe.mjs           # 全流程探测（sign-key → 模型 → 聊天）
node scripts/probe.mjs --step=models   # 只探测模型列表
node scripts/probe.mjs --no-pro  # Pro 标记位=0 对比测试
```

无 build、无 test、无 lint 命令。

## Architecture

| 文件 | 职责 |
|------|------|
| `src/server.mjs` | HTTP 服务入口，路由分发（/v1/models, /v1/chat/completions, /healthz），流式/非流式 SSE→OpenAI 格式转换，signKey/session 缓存与刷新 |
| `src/config.mjs` | 从 `.env` 文件 + 环境变量加载配置（cookie, version, signKey, port, apiKey），缺少 TABBIT_COOKIE 时 exit(1) |
| `scripts/lib/tabbit.mjs` | **逆向核心模块**：HMAC 签名（`signHeaders`）、Pro UUID 生成（`makeProUuid`）、指纹头（`fingerprintHeaders`）、SSE 解析（`parseSSE`）、会话列表拉取（`fetchSessionList`）、签名 key 获取（`fetchSignKey`）、模型列表（`getModels`）、聊天补全（`chat`）、错误类型（`TabbitError`） |
| `scripts/probe.mjs` | 诊断探测脚本，依次验证 Cookie→签名→模型→聊天是否通畅，日志输出到 `logs/` |
| `cookie-helper-extension/` | Chrome 扩展：一键导出 `web.tabbit.ai` Cookie（含 HttpOnly） |

**数据流**: 客户端 → `server.mjs`（OpenAI 格式）→ `tabbit.mjs`（签名+指纹）→ `web.tabbit.ai` → SSE 流回 → 格式转换 → 客户端

## Conventions

- **ESM only**: 全部使用 `import/export`，文件扩展名 `.mjs`
- **零依赖**: 不 `npm install`，所有功能用 Node.js 内置 API
- **中文注释**: 代码和文档均用中文
- **配置**: `.env` 文件（不提交 git），`.env.example` 为模板
- **签名逻辑不可修改**: `signHeaders` 的 header 命名是反直觉的（`x-signature`=UUID, `x-nonce`=HMAC），这是逆向结果，不要"修正"
- **Pro 标记位**: `makeProUuid` 的 UUID 第 5 位为 `'1'` 表示已设默认浏览器，premium 模型必需
- **会话缓存**: signKey 10 分钟 TTL，session 5 分钟 TTL，TabbitError 时 invalidate session
- **错误处理**: `TabbitError` 类携带 status/body/code/action，SSE error 事件触发 session 刷新

## Notes

- 文档：`docs/逆向流程与协议.md`（协议细节）、`docs/实现路线图.md`（技术方案）
- 路由当前用 `/api/v1/chat/completion`（旧版），文档建议 v2（带 `client_turn_id` + `stream_mode`）
- Agent WebSocket 路径（`/api/agent/v2/ws`）未实现
- Cookie 有效期约 7 天，需定期更新 `.env` 中的 `TABBIT_COOKIE`
