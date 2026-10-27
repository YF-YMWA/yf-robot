/**
 * 群聊会话：每个群一份独立的历史与状态。
 *
 * 与私聊会话的区别：
 *   - 历史是"事件流"不是对话轮次（群里多人说话）
 *   - 需要记录接话窗口、回复时间、发言人
 *   - 有免打扰和速率控制
 */
import { GroupEvent, GroupContextBuilder, GroupTrigger, cannedReply } from './group.mjs';

/** 单个群的状态。 */
export class GroupSession {
  /**
   * @param {string} groupId
   * @param {object} opts
   * @param {object} opts.cfg group 配置
   * @param {number} [opts.maxEvents]
   */
  constructor(groupId, { cfg, maxEvents = 150 }) {
    this.groupId = groupId;
    this.cfg = cfg;
    this.maxEvents = maxEvents;

    /** @type {GroupEvent[]} 事件流，按时间正序 */
    this.events = [];
    /** 接话窗口截止时间 */
    this.engagedUntil = 0;
    /** 开启接话窗口的人 */
    this.engagedBy = '';
    /** 最近一次回复时间 */
    this.lastSpokeAt = 0;
    /** 回复时间戳（用于速率控制） */
    this.replyTimes = [];
    /** 免打扰截止 */
    this.muteUntil = 0;
    /** 群成员昵称 → 出现次数 */
    this.members = new Map();

    /**
     * 发言人 id → 序号（1、2、3…，按第一次出现分配）
     *
     * 为什么不用哈希：原来是 `小明（参与者a1b2c3d4）` 这种，
     * 一串随机十六进制模型根本不看 —— 实测它会把 Alice 说的
     * 「我叫小美」直接安到 Bob 头上。
     * 换成「参与者1」「参与者2」，一眼就能分出是两个人。
     */
    this.participantIndex = new Map();

    this.trigger = new GroupTrigger(cfg);
    this.builder = new GroupContextBuilder(cfg.context ? cfg.context : {});
  }

  /**
   * 给发言人分配一个可读序号（同一个人始终是同一个号）。
   * @param {string} id
   * @returns {number}
   */
  participantNo(id) {
    const key = String(id || '').trim();
    if (!key) return 0;
    if (!this.participantIndex.has(key)) {
      this.participantIndex.set(key, this.participantIndex.size + 1);
    }
    return this.participantIndex.get(key);
  }

  /** 记录一条事件。 */
  addEvent(event) {
    // 先分配序号，保证历史里显示的是稳定编号
    if (!event.isBot && event.senderId) this.participantNo(event.senderId);

    this.events.push(event);
    if (event.senderName && !event.isBot) {
      this.members.set(event.senderName, (this.members.get(event.senderName) || 0) + 1);
    }
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  /** 是否免打扰中。 */
  isMuted(now = Date.now()) {
    return now < this.muteUntil;
  }

  /** 进入免打扰。 */
  mute(minutes) {
    this.muteUntil = Date.now() + minutes * 60000;
  }

  /** 解除免打扰。 */
  unmute() {
    this.muteUntil = 0;
  }

  /**
   * 判断是否该回复一条消息。
   *
   * @param {object} msg
   * @param {string} msg.text
   * @param {string} msg.senderId
   * @param {string} msg.senderName
   * @param {boolean} msg.atMe
   * @param {boolean} [msg.replyToBot]
   * @param {boolean} [msg.isOwner]
   * @param {number} [msg.now]
   * @returns {{reply:boolean, reason:string, canned?:string}}
   */
  shouldReply(msg) {
    const now = msg.now ?? Date.now();

    // 免打扰优先
    if (this.isMuted(now)) {
      return { reply: false, reason: 'muted' };
    }

    // 速率限制
    const rate = this.trigger.checkRate(this, now);
    if (rate.limited) {
      return { reply: false, reason: `rate_${rate.reason}` };
    }

    const decision = this.trigger.decide({
      text: msg.text,
      senderId: msg.senderId,
      senderName: msg.senderName,
      atMe: msg.atMe,
      replyToBot: msg.replyToBot,
      isOwner: msg.isOwner,
      state: this,
      muted: false,
      now,
    });

    if (!decision.wake) return { reply: false, reason: decision.reason };

    // 快捷回复：这类不需要模型
    const canned = cannedReply({ text: msg.text, isOwner: msg.isOwner });
    if (canned) {
      return { reply: true, reason: canned.reason, canned: canned.text };
    }

    return { reply: true, reason: decision.reason };
  }

  /**
   * 构建发给模型的上下文。
   * @param {GroupEvent} current
   */
  buildContext(current) {
    // 历史不含当前这条
    return this.builder.build({
      groupId: this.groupId,
      history: this.events.slice(-50),
      current,
      // 让 builder 用本会话的稳定序号，而不是哈希
      participantNo: (id) => this.participantNo(id),
    });
  }

  /**
   * 群里有没有重名的人。
   *
   * 为什么需要：两个人都叫「小明」时，上下文里虽然带了「参与者+哈希」的标签，
   * 但模型基本不看那串哈希 —— 实测它会直接把第一个小明说过的话
   * 安到第二个小明头上（"火锅啊！你刚说的"）。
   * 所以要在提示词里用自然语言明说「群里有 N 个同名的人，别混」。
   *
   * @returns {Array<{name: string, count: number}>}
   */
  duplicatedNames() {
    const byName = new Map();

    for (const e of this.events) {
      if (e.isBot) continue;
      const name = String(e.senderName || '').trim();
      const id = String(e.senderId || '').trim();
      if (!name || !id) continue;

      let set = byName.get(name);
      if (!set) {
        set = new Set();
        byName.set(name, set);
      }
      set.add(id);
    }

    const out = [];
    for (const [name, ids] of byName) {
      if (ids.size > 1) out.push({ name, count: ids.size });
    }
    return out;
  }

  /**
   * 记录一次成功回复。
   * @param {object} opts
   * @param {string} [opts.reason] 触发原因
   * @param {boolean} [opts.mentioned]
   * @param {string} [opts.senderId]
   * @param {number} [opts.now]
   */
  recordReply({ reason = '', mentioned = false, senderId = '', now = Date.now() } = {}) {
    this.lastSpokeAt = now;
    this.replyTimes.push(now);

    // 剪掉一小时前的记录
    const cutoff = now - 3600000;
    while (this.replyTimes.length && this.replyTimes[0] < cutoff) this.replyTimes.shift();

    // 只有明确叫她，才开启/延长接话窗口
    const extendReasons = ['addressed', 'called_by_name', 'engaged', 'insulted', 'owner'];
    if (extendReasons.includes(reason)) {
      const minutes = Math.max(1, this.cfg.engagedMinutes || 6);
      this.engagedUntil = now + minutes * 60000;
      this.engagedBy = String(senderId || '');
    }
  }

  /** 结束接话窗口（用于"换个话题"）。 */
  endEngagement() {
    this.engagedUntil = 0;
    this.engagedBy = '';
  }

  /** 群成员活跃度排行。 */
  topMembers(limit = 5) {
    return [...this.members.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  /** 清空历史。 */
  clear() {
    this.events = [];
    this.members.clear();
    this.engagedUntil = 0;
    this.engagedBy = '';
  }

  stats() {
    return {
      groupId: this.groupId,
      events: this.events.length,
      members: this.members.size,
      muted: this.isMuted(),
      engaged: Date.now() < this.engagedUntil,
      repliesLastHour: this.replyTimes.filter((t) => Date.now() - t < 3600000).length,
    };
  }
}

/** 群聊会话管理器。 */
export class GroupSessionStore {
  /**
   * @param {object} cfg group 配置
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.groups = new Map();
  }

  get(groupId) {
    let g = this.groups.get(groupId);
    if (!g) {
      g = new GroupSession(groupId, { cfg: this.cfg, maxEvents: this.cfg.historyTurns ? this.cfg.historyTurns * 10 : 150 });
      this.groups.set(groupId, g);
    }
    return g;
  }

  remove(groupId) {
    this.groups.delete(groupId);
  }

  /** 清理闲置的群。 */
  sweep(maxIdleMs = 24 * 3600000, now = Date.now()) {
    let count = 0;
    for (const [id, g] of this.groups) {
      const last = g.events[g.events.length - 1]?.ts || 0;
      if (now - last > maxIdleMs) {
        this.groups.delete(id);
        count++;
      }
    }
    return count;
  }

  stats() {
    return {
      groups: [...this.groups.values()].map((g) => g.stats()),
    };
  }
}
