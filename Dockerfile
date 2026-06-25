# Tabbit2API — Docker 镜像
# 多阶段构建，最终镜像仅含运行时最小文件

# ── 构建阶段 ──
FROM node:18-alpine AS builder
WORKDIR /app
COPY package.json ./
COPY src/ src/
COPY scripts/ scripts/

# ── 运行阶段 ──
FROM node:18-alpine
LABEL maintainer="tabbit2api"
LABEL description="Tabbit AI → OpenAI 兼容 API 代理"

WORKDIR /app

# 非 root 用户运行
RUN addgroup -S app && adduser -S app -G app

COPY --from=builder /app/src/ src/
COPY --from=builder /app/scripts/ scripts/
COPY --from=builder /app/package.json .

USER app

EXPOSE 8787

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8787/v1/models || exit 1

CMD ["node", "src/server.mjs"]
