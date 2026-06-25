#!/usr/bin/env bash
#
# 一键构建 → 推送 → 部署 Docker 镜像
# 用法:
#   ./scripts/deploy.sh build              # 仅构建
#   ./scripts/deploy.sh push               # 构建 + 推送
#   ./scripts/deploy.sh deploy              # 构建 + 推送 + 远程部署
#   ./scripts/deploy.sh deploy --host USER@SERVER  # 指定远程服务器
#   ./scripts/deploy.sh local              # 本地 docker compose up
#
# 环境变量（可通过 .env 或 export 设置）:
#   DOCKERHUB_USER    — Docker Hub 用户名
#   GHCR_USER         — GitHub 用户名（默认从 git remote 推断）
#   IMAGE_NAME        — 镜像名（默认 tabbit2api）
#   IMAGE_TAG         — 镜像标签（默认从 package.json 读取）
#   DEPLOY_HOST       — 远程部署目标（user@host）
#   DEPLOY_DIR        — 远程部署目录（默认 ~/tabbit2api）
#   PORT              — 端口（默认 8787）

set -euo pipefail

# ─── 颜色 ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${CYAN}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✔${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
err()   { echo -e "${RED}✖${NC}  $*" >&2; }

# ─── 加载 .env ─────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

if [ -f .env ]; then
  set -a; source .env; set +a
fi

# ─── 配置 ──────────────────────────────────────────────────
IMAGE_NAME="${IMAGE_NAME:-tabbit2api}"
IMAGE_TAG="${IMAGE_TAG:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)}"
DOCKERHUB_USER="${DOCKERHUB_USER:-}"
# 从 git remote 推断 GitHub 用户名
GHCR_USER="${GHCR_USER:-$(git remote get-url origin 2>/dev/null | sed -n 's|.*github\.com[:/]\([^/]*\)/.*|\1|p')}"
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_DIR="${DEPLOY_DIR:-~/tabbit2api}"
PORT="${PORT:-8787}"

SKIP_BUILD=false
SKIP_DOCKERHUB=false
SKIP_GHCR=false

# ─── 函数 ──────────────────────────────────────────────────

check_deps() {
  for cmd in docker; do
    if ! command -v "$cmd" &>/dev/null; then
      err "缺少依赖: $cmd"; exit 1
    fi
  done
  ok "依赖检查通过"
}

docker_build() {
  info "构建镜像 ${IMAGE_NAME}:${IMAGE_TAG} ..."
  docker build \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    -t "${IMAGE_NAME}:latest" \
    -f Dockerfile .
  ok "构建完成"

  # 标记推送目标
  if [ -n "$DOCKERHUB_USER" ] && [ "$SKIP_DOCKERHUB" = false ]; then
    docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "${DOCKERHUB_USER}/${IMAGE_NAME}:${IMAGE_TAG}"
    docker tag "${IMAGE_NAME}:latest"       "${DOCKERHUB_USER}/${IMAGE_NAME}:latest"
    info "已标记 Docker Hub: ${DOCKERHUB_USER}/${IMAGE_NAME}:${IMAGE_TAG}"
  fi
  if [ -n "$GHCR_USER" ] && [ "$SKIP_GHCR" = false ]; then
    docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "ghcr.io/${GHCR_USER}/${IMAGE_NAME}:${IMAGE_TAG}"
    docker tag "${IMAGE_NAME}:latest"       "ghcr.io/${GHCR_USER}/${IMAGE_NAME}:latest"
    info "已标记 ghcr.io: ghcr.io/${GHCR_USER}/${IMAGE_NAME}:${IMAGE_TAG}"
  fi
}

docker_push() {
  local pushed=0

  if [ -n "$DOCKERHUB_USER" ] && [ "$SKIP_DOCKERHUB" = false ]; then
    info "推送到 Docker Hub ..."
    docker push "${DOCKERHUB_USER}/${IMAGE_NAME}:${IMAGE_TAG}"
    docker push "${DOCKERHUB_USER}/${IMAGE_NAME}:latest"
    ok "Docker Hub 推送完成"
    pushed=1
  else
    warn "跳过 Docker Hub（DOCKERHUB_USER 未设置或 --skip-dockerhub）"
  fi

  if [ -n "$GHCR_USER" ] && [ "$SKIP_GHCR" = false ]; then
    info "推送到 ghcr.io ..."
    if [ -z "${GITHUB_TOKEN:-}" ]; then
      warn "GITHUB_TOKEN 未设置，推送可能失败"
      warn "登录: echo \$GITHUB_TOKEN | docker login ghcr.io -u \$GITHUB_USER --password-stdin"
    fi
    docker push "ghcr.io/${GHCR_USER}/${IMAGE_NAME}:${IMAGE_TAG}"
    docker push "ghcr.io/${GHCR_USER}/${IMAGE_NAME}:latest"
    ok "ghcr.io 推送完成"
    pushed=1
  else
    warn "跳过 ghcr.io（GHCR_USER 未设置或 --skip-ghcr）"
  fi

  if [ "$pushed" -eq 0 ]; then
    err "没有可用的镜像仓库，请设置 DOCKERHUB_USER 或 GITHUB_TOKEN"
    exit 1
  fi
}

remote_deploy() {
  local host="$1"
  info "远程部署到 ${host}:${DEPLOY_DIR} ..."

  ssh "$host" "mkdir -p $DEPLOY_DIR"
  scp docker-compose.yml "$host:$DEPLOY_DIR/"
  [ -f .env ] && scp .env "$host:$DEPLOY_DIR/"

  # 构造远程拉取命令
  local pull_image=""
  if [ -n "$DOCKERHUB_USER" ] && [ "$SKIP_DOCKERHUB" = false ]; then
    pull_image="${DOCKERHUB_USER}/${IMAGE_NAME}"
  elif [ -n "$GHCR_USER" ] && [ "$SKIP_GHCR" = false ]; then
    pull_image="ghcr.io/${GHCR_USER}/${IMAGE_NAME}"
  else
    err "没有可用的镜像源进行远程部署"; exit 1
  fi

  # shellcheck disable=SC2086
  ssh "$host" "cd $DEPLOY_DIR && docker pull ${pull_image}:${IMAGE_TAG} 2>/dev/null || docker pull ${pull_image}:latest 2>/dev/null; docker compose down 2>/dev/null || docker-compose down 2>/dev/null; IMAGE_TAG=${IMAGE_TAG} docker compose up -d 2>/dev/null || IMAGE_TAG=${IMAGE_TAG} docker-compose up -d 2>/dev/null"
  ok "远程部署完成"
  info "远程状态:"
  ssh "$host" "cd $DEPLOY_DIR && docker compose ps 2>/dev/null || docker-compose ps 2>/dev/null"
}

local_up() {
  info "本地 docker compose 启动 ..."
  docker compose up -d 2>/dev/null || docker-compose up -d
  ok "启动完成！访问 http://localhost:${PORT}"
  docker compose logs -f 2>/dev/null || docker-compose logs -f
}

usage() {
  cat <<EOF
用法: $0 <命令> [选项]

命令:
  build               仅构建镜像
  push                构建 + 推送
  deploy              构建 + 推送 + 远程部署
  local               本地 docker compose up

选项:
  --host USER@SERVER  远程部署地址
  --push-only         跳过构建，仅推送
  --skip-dockerhub    跳过 Docker Hub
  --skip-ghcr         跳过 ghcr.io

环境变量:
  DOCKERHUB_USER      Docker Hub 用户名
  GHCR_USER           GitHub 用户名（默认从 git remote 推断）
  GITHUB_TOKEN        ghcr.io 推送 token
  IMAGE_NAME          镜像名（默认: tabbit2api）
  IMAGE_TAG           镜像标签（默认: package.json 版本号）

示例:
  $0 build
  $0 push --skip-dockerhub
  $0 deploy --host root@my-server.com
  $0 local
EOF
}

# ─── 解析参数 ──────────────────────────────────────────────

CMD="${1:-}"
shift || true

while [ $# -gt 0 ]; do
  case "$1" in
    --host)            DEPLOY_HOST="$2"; shift 2 ;;
    --push-only)       SKIP_BUILD=true; shift ;;
    --skip-dockerhub)  SKIP_DOCKERHUB=true; shift ;;
    --skip-ghcr)       SKIP_GHCR=true; shift ;;
    -h|--help)         usage; exit 0 ;;
    *)                 warn "未知参数: $1"; shift ;;
  esac
done

# ─── Banner ─────────────────────────────────────────────────

echo -e "${BOLD}"
echo "═══════════════════════════════════════════════"
echo "  Tabbit2API Docker 部署脚本"
echo "  镜像: ${IMAGE_NAME}:${IMAGE_TAG}"
echo "═══════════════════════════════════════════════"
echo -e "${NC}"

# --help 或无参数不需要检查依赖
case "$CMD" in
  -h|--help|"") usage; exit 0 ;;
esac

check_deps

# ─── 执行 ──────────────────────────────────────────────────

case "$CMD" in
  build)
    docker_build
    ok "✅ 构建完成"
    echo ""
    docker images | grep "${IMAGE_NAME}" | head -5
    ;;

  push)
    [ "$SKIP_BUILD" = false ] && docker_build
    docker_push
    ok "✅ 推送完成"
    ;;

  deploy)
    [ "$SKIP_BUILD" = false ] && docker_build
    docker_push
    if [ -n "$DEPLOY_HOST" ]; then
      remote_deploy "$DEPLOY_HOST"
    else
      warn "未指定远程主机，跳过远程部署"
      info "用法: $0 deploy --host user@server"
    fi
    ok "✅ 部署完成"
    ;;

  local)
    docker_build
    local_up
    ;;

  *)
    usage
    exit 1
    ;;
esac
