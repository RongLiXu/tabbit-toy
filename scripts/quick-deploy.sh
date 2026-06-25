#!/usr/bin/env bash
#
# Tabbit2API 一键远程部署脚本
# 在任何有 Docker 的服务器上直接运行，无需预装项目文件
#
# 用法:
#   bash quick-deploy.sh                          # 交互式部署
#   curl -fsSL <raw-url>/scripts/quick-deploy.sh | bash
#   curl -fsSL <raw-url>/scripts/quick-deploy.sh | bash -s -- --cookie "YOUR_COOKIE"
#   curl -fsSL <raw-url>/scripts/quick-deploy.sh | bash -s -- --port 9090
#
# 选项:
#   --cookie   TABBIT_COOKIE（交互式提示可省略）
#   --port     服务端口（默认 8787）
#   --api-key  API 访问密钥（可选）
#   --dir      部署目录（默认 ~/tabbit2api）
#   --version  镜像版本标签（默认 latest）
#   --update   更新模式：拉取新镜像并重启（不重新生成配置）
#   --uninstall 停止并删除容器和配置
#   --help     显示帮助

set -euo pipefail

# ─── 颜色 ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${CYAN}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✔${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
err()   { echo -e "${RED}✖${NC}  $*" >&2; }
step()  { echo -e "\n${BOLD}${CYAN}── $* ──${NC}"; }

# ─── 默认值 ────────────────────────────────────────────────
COOKIE=""
PORT="8787"
API_KEY=""
DEPLOY_DIR="$HOME/tabbit2api"
IMAGE_TAG="latest"
IMAGE_NAME="tabbit2api"
MODE="install"  # install | update | uninstall

# GHCR 用户（镜像发布者）
GHCR_OWNER="${GHCR_OWNER:-RongLiXu}"
# Docker Hub 用户（可选）
DOCKERHUB_USER="${DOCKERHUB_USER:-}"

# ─── 常量 ──────────────────────────────────────────────────
GHCR_IMAGE="ghcr.io/${GHCR_OWNER}/${IMAGE_NAME}"
DOCKERHUB_IMAGE="${DOCKERHUB_USER:+${DOCKERHUB_USER}/${IMAGE_NAME}}"

# ─── 帮助 ──────────────────────────────────────────────────
usage() {
  cat <<'EOF'
╔══════════════════════════════════════════════════╗
║        Tabbit2API 一键远程部署脚本               ║
╚══════════════════════════════════════════════════╝

用法:
  bash quick-deploy.sh [选项]
  curl -fsSL <url>/quick-deploy.sh | bash -s -- --cookie "xxx"

选项:
  --cookie    Tabbit Cookie（必需，交互模式可省略）
  --port      服务端口（默认: 8787）
  --api-key   API 访问密钥（可选）
  --dir       部署目录（默认: ~/tabbit2api）
  --version   镜像版本（默认: latest）
  --update    更新模式：拉取最新镜像并重启
  --uninstall 停止并删除容器和配置文件
  --help      显示此帮助

示例:
  # 交互式部署
  bash quick-deploy.sh

  # 非交互式一键部署
  bash quick-deploy.sh --cookie "your_cookie_here"

  # 指定端口和密钥
  bash quick-deploy.sh --cookie "your_cookie" --port 9090 --api-key "mykey"

  # 远程一键部署
  curl -fsSL https://raw.githubusercontent.com/goehou/tabbit-toy/main/scripts/quick-deploy.sh | bash -s -- --cookie "your_cookie"

  # 更新到最新版本
  bash quick-deploy.sh --update

  # 卸载
  bash quick-deploy.sh --uninstall
EOF
}

# ─── 解析参数 ──────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --cookie)     COOKIE="$2"; shift 2 ;;
    --port)       PORT="$2"; shift 2 ;;
    --api-key)    API_KEY="$2"; shift 2 ;;
    --dir)        DEPLOY_DIR="$2"; shift 2 ;;
    --version)    IMAGE_TAG="$2"; shift 2 ;;
    --update)     MODE="update"; shift ;;
    --uninstall)  MODE="uninstall"; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            warn "未知参数: $1"; shift ;;
  esac
done

# ─── 依赖检查 ──────────────────────────────────────────────
check_deps() {
  local missing=()
  for cmd in docker curl; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    err "缺少依赖: ${missing[*]}"
    info "安装 Docker: https://docs.docker.com/engine/install/"
    exit 1
  fi

  # 检查 Docker Compose（v2 插件或独立二进制）
  if docker compose version &>/dev/null; then
    COMPOSE_CMD="docker compose"
  elif command -v docker-compose &>/dev/null; then
    COMPOSE_CMD="docker-compose"
  else
    err "缺少 Docker Compose"
    info "安装: https://docs.docker.com/compose/install/"
    exit 1
  fi

  ok "依赖检查通过（Docker + ${COMPOSE_CMD}）"
}

# ─── 镜像拉取（双源自动选择）─────────────────────────────────
pull_image() {
  local full_image=""
  local tag="$1"

  # 优先尝试 ghcr.io
  if docker pull "${GHCR_IMAGE}:${tag}" 2>/dev/null; then
    full_image="${GHCR_IMAGE}:${tag}"
    ok "从 ghcr.io 拉取成功"
  # 回退到 Docker Hub
  elif [ -n "$DOCKERHUB_IMAGE" ] && docker pull "${DOCKERHUB_IMAGE}:${tag}" 2>/dev/null; then
    full_image="${DOCKERHUB_IMAGE}:${tag}"
    ok "从 Docker Hub 拉取成功"
  else
    err "无法拉取镜像（ghcr.io 和 Docker Hub 均失败）"
    err "请检查网络连接或镜像是否存在"
    exit 1
  fi

  echo "$full_image"
}

# ─── 生成 .env 文件 ────────────────────────────────────────
generate_env() {
  local env_file="${DEPLOY_DIR}/.env"

  # 如果已存在，备份
  if [ -f "$env_file" ]; then
    cp "$env_file" "${env_file}.bak.$(date +%s)"
    warn "已备份旧 .env 文件"
  fi

  cat > "$env_file" <<ENVEOF
# ─── Tabbit2API 配置 ────────────────────────────────────────
# 由 quick-deploy.sh 于 $(date '+%Y-%m-%d %H:%M:%S') 自动生成

# Tabbit Cookie（必需，从浏览器导出）
TABBIT_COOKIE=${COOKIE}

# 服务端口
PORT=${PORT}

# API 访问密钥（留空不鉴权）
API_KEY=${API_KEY}

# Tabbit 版本号
TABBIT_VERSION=1.1.39(10101039)

# 签名 key（留空自动拉取）
TABBIT_SIGN_KEY=

# 探测用测试模型
TABBIT_TEST_MODEL=Default
ENVEOF

  ok ".env 文件已生成"
}

# ─── 生成 docker-compose.yml ────────────────────────────────
generate_compose() {
  local compose_file="${DEPLOY_DIR}/docker-compose.yml"
  local full_image="$1"

  cat > "$compose_file" <<COMPOSEOF
# Tabbit2API Docker Compose
# 由 quick-deploy.sh 于 $(date '+%Y-%m-%d %H:%M:%S') 自动生成

services:
  tabbit2api:
    image: ${full_image}
    container_name: tabbit2api
    restart: unless-stopped
    ports:
      - "${PORT}:8787"
    env_file:
      - .env
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8787/v1/models"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
COMPOSEOF

  ok "docker-compose.yml 文件已生成"
}

# ─── 启动服务 ──────────────────────────────────────────────
start_service() {
  cd "$DEPLOY_DIR"
  info "启动服务 ..."
  $COMPOSE_CMD up -d
  ok "服务已启动"

  echo ""
  info "等待健康检查 ..."
  local retries=10
  while [ $retries -gt 0 ]; do
    if curl -s "http://localhost:${PORT}/v1/models" > /dev/null 2>&1; then
      ok "服务健康检查通过"
      break
    fi
    retries=$((retries - 1))
    sleep 2
  done

  echo ""
  echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════${NC}"
  echo -e "${BOLD}${GREEN}  ✅ Tabbit2API 部署成功！${NC}"
  echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════${NC}"
  echo ""
  echo -e "  🌐 API 地址:  ${BOLD}http://localhost:${PORT}/v1${NC}"
  echo -e "  📁 部署目录:  ${DEPLOY_DIR}"
  echo -e "  📋 查看日志:  ${BOLD}cd ${DEPLOY_DIR} && ${COMPOSE_CMD} logs -f${NC}"
  echo -e "  🔄 更新配置:  ${BOLD}vim ${DEPLOY_DIR}/.env && ${COMPOSE_CMD} restart${NC}"
  echo ""
  echo -e "  测试命令:"
  echo -e "  ${CYAN}curl http://localhost:${PORT}/v1/models${NC}"
  echo ""
}

# ─── 交互式获取 Cookie ──────────────────────────────────────
interactive_cookie() {
  if [ -z "$COOKIE" ]; then
    echo ""
    echo -e "${BOLD}请输入 Tabbit Cookie${NC}"
    echo -e "（从浏览器登录 web.tabbit.ai，使用 cookie-helper-extension 扩展导出）"
    echo -e "提示: 直接粘贴完整 Cookie 字符串，支持多行"
    echo ""
    read -r -p "Cookie: " COOKIE
    if [ -z "$COOKIE" ]; then
      err "Cookie 不能为空"
      exit 1
    fi
  fi
}

# ─── 安装 ──────────────────────────────────────────────────
do_install() {
  step "Tabbit2API 一键部署"
  echo ""

  check_deps

  step "Step 1/5  创建部署目录"
  mkdir -p "$DEPLOY_DIR"
  ok "目录: ${DEPLOY_DIR}"

  step "Step 2/5  配置环境变量"
  interactive_cookie
  generate_env

  step "Step 3/5  拉取 Docker 镜像"
  local full_image
  full_image=$(pull_image "$IMAGE_TAG")

  step "Step 4/5  生成 docker-compose.yml"
  generate_compose "$full_image"

  step "Step 5/5  启动服务"
  start_service
}

# ─── 更新 ──────────────────────────────────────────────────
do_update() {
  step "Tabbit2API 更新"
  echo ""

  check_deps

  if [ ! -f "${DEPLOY_DIR}/docker-compose.yml" ]; then
    err "部署目录不存在或缺少 docker-compose.yml"
    info "请先执行安装: bash quick-deploy.sh"
    exit 1
  fi

  step "Step 1/3  拉取最新镜像"
  local full_image
  full_image=$(pull_image "$IMAGE_TAG")

  # 更新 docker-compose.yml 中的镜像
  generate_compose "$full_image"

  step "Step 2/3  重启服务"
  cd "$DEPLOY_DIR"
  $COMPOSE_CMD down
  $COMPOSE_CMD up -d

  step "Step 3/3  验证"
  sleep 3
  if curl -s "http://localhost:${PORT}/v1/models" > /dev/null 2>&1; then
    ok "更新完成，服务运行正常"
  else
    warn "服务可能还在启动中，请稍后检查: curl http://localhost:${PORT}/v1/models"
  fi

  echo ""
  echo -e "${GREEN}✅ 更新完成${NC}"
}

# ─── 卸载 ──────────────────────────────────────────────────
do_uninstall() {
  step "Tabbit2API 卸载"
  echo ""

  if [ ! -f "${DEPLOY_DIR}/docker-compose.yml" ]; then
    warn "部署目录不存在: ${DEPLOY_DIR}"
    exit 0
  fi

  read -r -p "确认卸载？将停止容器并删除配置文件 (y/N): " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    info "已取消"
    exit 0
  fi

  cd "$DEPLOY_DIR"
  $COMPOSE_CMD down 2>/dev/null || true
  rm -rf "$DEPLOY_DIR"
  ok "已停止容器并删除 ${DEPLOY_DIR}"
  echo -e "${GREEN}✅ 卸载完成${NC}"
}

# ─── 主入口 ────────────────────────────────────────────────
case "$MODE" in
  install)   do_install ;;
  update)    do_update ;;
  uninstall) do_uninstall ;;
esac
