/**
 * 会话与记忆层。
 *
 * 职责：
 *   - 每个对话者一个独立会话（历史隔离）
 *   - 消息串行处理（同一人连发多条不会错乱）
 *   - 历史超长时裁剪，保留最近若干轮
 *   - 简单的事实记忆（从对话里提取「我叫X」「我喜欢Y」）
 *   - **落盘持久化**：服务重启、桥接断开重连，对话接着上次继续
 *
 * 不做的事：不做语义检索、不做向量库。保持简单可预测。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 单个会话。 */
export class Session {
  /**
   * @param {string} id 会话标识（如 wxid 或 web session id）
   * @param {object} cfg session 配置段
   */
  constructor(id, cfg) {
    this.id = id;
    this.cfg = cfg;
    /** @type {Array<{role:'user'|'assistant', content:string, at:number}>} */
    this.history = [];
    /** 从对话里学到的事实 */
    this.facts = new Map();
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    this.turns = 0;
    /** 串行队列 */
    this.queue = Promise.resolve();
  }

  /** 追加一轮对话。 */
  addTurn(userText, assistantText) {
    const now = Date.now();
    this.history.push({ role: 'user', content: userText, at: now });
    this.history.push({ role: 'assistant', content: assistantText, at: now });
    this.turns += 1;
    this.lastActive = now;
    this.#trim();
  }

  /**
   * 裁剪历史，保留最近 N 轮。
   *
   * 快溢出时先通知 onOverflow，让上层把旧对话压成摘要再丢，
   * 而不是直接忘掉。
   */
  #trim() {
    const maxMsgs = Math.max(2, this.cfg.historyTurns * 2);

    if (this.history.length > maxMsgs) {
      // 即将被丢掉的旧对话
      const dropped = this.history.slice(0, this.history.length - maxMsgs);
      this.history = this.history.slice(-maxMsgs);

      if (dropped.length && typeof this.onOverflow === 'function') {
        try {
          // 不阻塞：摘要可以异步做
          this.onOverflow(dropped);
        } catch {}
      }
    }
  }

  /** 生成发给模型的消息数组（不含 system）。 */
  toMessages() {
    return this.history.map((m) => ({ role: m.role, content: m.content }));
  }

  /** 记录一个事实。 */
  remember(key, value) {
    if (!key || !value) return;
    this.facts.set(key, value);
  }

  /** 事实摘要，注入提示词。 */
  factSummary() {
    if (this.facts.size === 0) return '';
    const lines = [...this.facts.entries()].map(([k, v]) => `- ${k}：${v}`);
    return '【我记住的事】\n' + lines.join('\n');
  }

  /** 序列化为可存储的形式。 */
  toJSON() {
    return {
      id: this.id,
      history: this.history.slice(-40),
      facts: Object.fromEntries(this.facts),
      createdAt: this.createdAt,
      lastActive: this.lastActive,
      turns: this.turns,
    };
  }

  /** 从存储恢复。 */
  static fromJSON(data, cfg) {
    const s = new Session(data.id, cfg);
    s.history = Array.isArray(data.history) ? data.history : [];
    s.facts = new Map(Object.entries(data.facts || {}));
    s.createdAt = data.createdAt || Date.now();
    s.lastActive = data.lastActive || Date.now();
    s.turns = data.turns || 0;
    return s;
  }
}

/** 会话管理器。 */
export class SessionStore {
  /**
   * @param {object} cfg session 配置段
   * @param {object} [opts]
   * @param {(s: Session) => void} [opts.onEvict]
   * @param {string} [opts.dir] 会话落盘目录。不传就纯内存（测试用）
   */
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.sessions = new Map();
    this.onEvict = opts.onEvict || (() => {});
    this.dir = opts.dir || '';
    this.log = opts.log || (() => {});

    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
      } catch (e) {
        // 目录建不出来就退回纯内存，不能因为落盘失败把服务搞挂
        this.log(`[session] 落盘目录创建失败，改为纯内存：${e.message}`);
        this.dir = '';
      }
    }
  }

  /** 会话 id → 文件名。id 里可能有 / 和 : 之类，统一编码。 */
  #file(id) {
    if (!this.dir) return '';
    // wxid 只含字母数字下划线，但群 id 可能带 @chatroom，
    // 用 encodeURIComponent + 替换，保证任何 id 都能安全落盘
    const safe = encodeURIComponent(String(id)).replace(/[*?<>|:"/\\]/g, '_');
    return path.join(this.dir, safe + '.json');
  }

  /** 把会话写到磁盘。 */
  save(id) {
    if (!this.dir) return false;
    const s = this.sessions.get(id);
    if (!s) return false;

    const file = this.#file(id);
    try {
      // 先写临时文件再改名，避免写到一半断电留下半截 JSON
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s.toJSON(), null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      this.log(`[session] 保存失败 ${id}：${e.message}`);
      return false;
    }
  }

  /** 从磁盘读会话。 */
  #load(id) {
    if (!this.dir) return null;
    const file = this.#file(id);
    try {
      if (!fs.existsSync(file)) return null;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const s = Session.fromJSON(data, this.cfg);
      s.queue = Promise.resolve();
      return s;
    } catch (e) {
      this.log(`[session] 读取失败 ${id}：${e.message}`);
      return null;
    }
  }

  /** 取或建会话。内存里没有时优先从磁盘恢复。 */
  get(id) {
    let s = this.sessions.get(id);

    if (!s) {
      // 关键：重启后第一次访问时把上次的对话捡回来，
      // 否则桥接断开重连就等于失忆
      s = this.#load(id);
      if (s) {
        this.sessions.set(id, s);
        this.log(`[session] 恢复会话 ${id}（${s.history.length} 条记录）`);
      }
    }

    if (!s) {
      s = new Session(id, this.cfg);
      this.sessions.set(id, s);
    }

    s.lastActive = Date.now();
    return s;
  }

  /**
   * 串行执行：把任务接到该会话队列尾部。
   * @param {string} id
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   * @template T
   */
  async run(id, task) {
    const s = this.get(id);
    const result = s.queue.then(task, task);
    // 队列里保留一个总是 resolve 的壳，避免一次失败卡死后续
    s.queue = result.catch(() => {});
    return result;
  }

  /** 回收闲置会话。回收前必须落盘，否则这段对话就真没了。 */
  sweep(now = Date.now()) {
    const limit = this.cfg.idleMinutes * 60 * 1000;
    let count = 0;
    for (const [id, s] of this.sessions) {
      if (now - s.lastActive > limit) {
        this.save(id);
        this.onEvict(s);
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  /** 清空指定会话（用户主动要求重置）。磁盘上的一起删。 */
  reset(id) {
    this.sessions.delete(id);
    const file = this.#file(id);
    if (file) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {}
    }
  }

  stats() {
    return { count: this.sessions.size, ids: [...this.sessions.keys()] };
  }

  /** 磁盘上有多少个会话存档。 */
  diskStats() {
    if (!this.dir) return { count: 0 };
    try {
      const files = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
      return { count: files.length, dir: this.dir };
    } catch {
      return { count: 0 };
    }
  }

  /** 全部落盘（关服务前调用）。 */
  saveAll() {
    if (!this.dir) return 0;
    let n = 0;
    for (const id of this.sessions.keys()) {
      if (this.save(id)) n++;
    }
    return n;
  }
}

/**
 * 从用户消息里提取可记住的事实。
 * 规则明确、可测试，不做语义推断。
 * @param {string} text
 * @returns {Array<[string, string]>} [key, value] 对
 */
export function extractFacts(text) {
  const out = [];
  if (!text) return out;
  const t = text.trim();

  // 问句不提取：对方在「问」而不是「说」，提取出来会是垃圾
  // （实测「我最喜欢的颜色是什么」会抓出「最喜欢的颜色=什么」）
  if (/[?？]\s*$/.test(t)) return out;
  // 句末是疑问词才算问句。「几岁」不算——「我今年25岁」是陈述
  if (/(什么|啥|哪个|哪些|多少|几个|几号|几点|几位|谁|哪一年|吗|呢)\s*[。.!！]?\s*$/.test(t)) {
    return out;
  }

  const patterns = [
    // 名字
    [/我叫([^\s，。,.!！?？]{1,12})/, '名字'],
    [/我的名字是([^\s，。,.!！?？]{1,12})/, '名字'],
    // 地点
    [/我住在([^\s，。,.!！?？]{1,20})/, '住处'],
    [/我在([^\s，。,.!！?？]{1,20})工作/, '工作地点'],
    // 年龄
    [/我今年([0-9一二三四五六七八九十]{1,3})岁/, '年龄'],
    // 生日
    [/我?(?:的)?生日是([^\s，。,.!！?？]{1,15})/, '生日'],
    // 「我最喜欢的颜色是蓝色」→ key='最喜欢的颜色', value='蓝色'
    [
      /我(最|很|超|特别)?喜欢的([^\s，。,.!！?？是]{1,10})是([^\s，。,.!！?？]{1,15})/,
      (m) => `${m[1] || ''}喜欢的${m[2]}`,
      (m) => m[3],
    ],
    // 「我喜欢蓝色」——排除「喜欢的X是Y」结构（那是上一条的）
    [
      /(?:^|[，,。\s])我(?:最|很|超|特别)?喜欢(?!的)([^\s，。,.!！?？是]{1,15})(?![是为])/,
      '喜欢',
    ],
    // 「我不喜欢香菜」
    [/我不(?:太)?喜欢([^\s，。,.!！?？]{1,15})/, '不喜欢'],
    // 「我讨厌香菜」
    [/我(?:最|很|超)?讨厌([^\s，。,.!！?？]{1,15})/, '讨厌'],
    // 「我对X过敏」
    [/我对([^\s，。,.!！?？]{1,10})过敏/, '过敏'],
    // 「我的工作是程序员」
    [/我的?工作是([^\s，。,.!！?？]{1,15})/, '工作'],
    // 「记住X是Y」——显式要求记忆
    [
      /记住我?(?:的)?([^\s，。,.!！?？是]{1,10})是([^\s，。,.!！?？]{1,15})/,
      (m) => m[1],
      (m) => m[2],
    ],
  ];

  for (const [re, key, valueFn] of patterns) {
    const m = re.exec(t);
    if (!m) continue;

    const k = typeof key === 'function' ? key(m) : key;
    const v = valueFn ? valueFn(m) : m[1];

    if (k && v && !out.some(([ok]) => ok === k)) {
      out.push([k, v]);
    }
  }

  return out;
}

/**
 * 判断回复是否只是重复了对方的话（学舌检测）。
 * @param {string} reply
 * @param {string} userText
 */
export function isEcho(reply, userText) {
  const norm = (s) => s.replace(/[\s，。,.!！?？~～]/g, '').toLowerCase();
  const r = norm(reply);
  const u = norm(userText);
  if (!r || !u) return false;
  if (r === u) return true;
  // 回复是用户原话加上「你才」「你也」之类
  if (r.length <= u.length + 4 && r.startsWith(u)) return true;
  return false;
}
