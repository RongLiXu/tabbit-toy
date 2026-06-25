// src/scheduler.mjs — 多 Cookie 调度器
//
// 职责：
//   1. 按轮询（Round-Robin）将请求均衡分发到不同 cookie slot
//   2. 每个 cookie slot 独立维护 signKey / session 缓存
//   3. slot 请求失败时标记冷却，自动切换
//
// 为什么用轮询而不是客户端亲和：
//   - 反向代理场景（Nginx / Cloudflare）下所有请求 IP 相同
//   - 客户端不太可能主动加 x-user-id / user 字段
//   - handleChat 每次请求都带完整 messages 历史 → 上下文不依赖 slot 亲和
//   - 轮询最简单可靠，零客户端配合

import {
  fetchSignKey, fetchSessionList, TabbitError,
} from '../scripts/lib/tabbit.mjs';

// ─── 常量 ─────────────────────────────────────────────────
const SIGN_KEY_TTL = 10 * 60 * 1000;  // 10 分钟刷新签名 key
const SESSION_TTL  =  5 * 60 * 1000;  // 5 分钟刷新会话列表
const COOLDOWN_TTL =  2 * 60 * 1000;  // 2 分钟冷却（slot 失败后暂停使用）

// ─── 单个 Cookie Slot ─────────────────────────────────────
class CookieSlot {
  constructor(cookie, index) {
    this.index = index;
    this.cookie = cookie;
    this.signKey = '';
    this.signKeyFetchedAt = 0;
    this.sessionCache = null;
    this.sessionCacheAt = 0;
    // 健康状态
    this.healthy = true;
    this.cooldownUntil = 0;
  }

  /** 是否处于冷却期（不可用） */
  isCoolingDown() {
    if (!this.healthy && Date.now() < this.cooldownUntil) return true;
    // 冷却期结束，恢复健康
    if (!this.healthy && Date.now() >= this.cooldownUntil) {
      this.healthy = true;
    }
    return false;
  }

  /** 标记失败，进入冷却 */
  markFailed() {
    this.healthy = false;
    this.cooldownUntil = Date.now() + COOLDOWN_TTL;
  }

  /** 标记成功 */
  markHealthy() {
    this.healthy = true;
    this.cooldownUntil = 0;
  }

  /** 获取签名 key（带缓存） */
  async ensureSignKey(version, fallbackSignKey) {
    if (fallbackSignKey) return fallbackSignKey;
    if (this.signKey && Date.now() - this.signKeyFetchedAt < SIGN_KEY_TTL) return this.signKey;
    this.signKey = await fetchSignKey(this.cookie, version);
    this.signKeyFetchedAt = Date.now();
    return this.signKey;
  }

  /** 获取会话 ID（带缓存） */
  async getSessionId() {
    if (this.sessionCache && Date.now() - this.sessionCacheAt < SESSION_TTL) {
      return this.sessionCache;
    }
    const sessions = await fetchSessionList(this.cookie);
    if (sessions.length === 0) {
      throw new Error(`Cookie slot #${this.index}: 账号下无可用会话`);
    }
    this.sessionCache = sessions[0];
    this.sessionCacheAt = Date.now();
    return this.sessionCache;
  }

  /** 清除会话缓存（TabbitError 时调用） */
  invalidateSession() {
    this.sessionCache = null;
  }

  /** 简要标识（脱敏） */
  get label() {
    const c = this.cookie;
    return c.length > 20 ? c.slice(0, 20) + '…' : c;
  }
}

// ─── 调度器 ───────────────────────────────────────────────
export class CookieScheduler {
  constructor(cookies) {
    /** @type {CookieSlot[]} */
    this.slots = cookies.map((c, i) => new CookieSlot(c, i));
    /** @type {number} 轮询指针 */
    this.rrIndex = 0;

    console.log(`[scheduler] 初始化 ${this.slots.length} 个 Cookie slot（轮询分发）`);
  }

  /** slot 数量 */
  get size() {
    return this.slots.length;
  }

  /**
   * 轮询选择一个健康的 slot
   * - 跳过冷却中的 slot
   * - 如果所有 slot 都不可用，返回第一个 slot（等冷却恢复）
   */
  next() {
    if (this.slots.length === 1) return this.slots[0];

    const n = this.slots.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.rrIndex + i) % n;
      if (!this.slots[idx].isCoolingDown()) {
        this.rrIndex = (idx + 1) % n;
        return this.slots[idx];
      }
    }
    // 所有 slot 都不可用 → 返回默认 slot
    return this.slots[0];
  }

  /**
   * 获取一个 slot 的完整上下文（signKey + sessionId）
   */
  async prepare(slot, version, fallbackSignKey) {
    const [key, sessionId] = await Promise.all([
      slot.ensureSignKey(version, fallbackSignKey),
      slot.getSessionId(),
    ]);
    return { cookie: slot.cookie, signKey: key, sessionId };
  }

  /** 所有 slot 的健康状态摘要 */
  status() {
    return this.slots.map(s => ({
      index: s.index,
      healthy: s.healthy,
      cooling: s.isCoolingDown(),
      label: s.label,
    }));
  }
}
