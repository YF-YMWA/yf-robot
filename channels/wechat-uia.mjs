/**
 * 微信 UIA 通道 —— 接口占位。
 *
 * ⚠️ 本文件只定义接口，不含任何微信客户端操作实现。
 *
 * 为什么是空的：
 *   在微信 4.x 上要让 UI Automation 看到控件树，需要往微信进程写内存
 *   （即 Qt accessibility gate）。那部分实现需要你自己提供，
 *   本文件负责把「你的实现」和「聊天引擎」优雅地接起来。
 *
 * 你需要做的：
 *   1. 实现一个 Bridge 对象，提供 start / stop / send 三个方法（见下方契约）
 *      —— 可以是 Python 子进程、HTTP 服务、或任何你已有的桥接程序
 *   2. 在 config.json 里把 channels['wechat-uia'].enabled 设为 true
 *   3. 把 channels['wechat-uia'].bridgeUrl 指向它（若是 HTTP 服务）
 *
 * 桥接契约（HTTP 模式）：
 *   你的桥接程序需要：
 *
 *   POST {bridgeUrl}/inbound
 *     由你的桥接调用，把收到的微信消息推给本服务
 *     body: { "from": "wxid", "text": "...", "name": "昵称", "msgId": "..." }
 *     响应: { "ok": true }
 *
 *   POST {bridgeUrl}/outbound
 *     本服务调用，请求你的桥接发送消息
 *     body: { "to": "wxid", "text": "..." }
 *     响应: { "ok": true } 或 { "ok": false, "error": "原因" }
 *
 *   GET {bridgeUrl}/health
 *     健康检查，响应: { "ok": true, "uia": true }
 *
 * 也就是说：你那边负责「怎么读写微信」，我这边负责「收到之后回什么」。
 */

/**
 * UIA 通道。
 *
 * 即使没有接上真实桥接，这个类也能完整跑通协议层，
 * 方便你先用 mock 桥接验证逻辑，再接真实实现。
 */
export class WeChatUiaChannel {
  /**
   * @param {object} opts
   * @param {object} opts.config 完整配置
   * @param {import('../core/engine.mjs').ChatEngine} opts.engine
   * @param {object} [opts.logger]
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor({ config, engine, logger = console, fetchImpl }) {
    this.config = config;
    this.engine = engine;
    this.log = logger;
    this.fetch = fetchImpl || globalThis.fetch;
    this.name = 'wechat-uia';

    this.cfg = config.channels['wechat-uia'] || {};
    this.bridgeUrl = (this.cfg.bridgeUrl || '').replace(/\/+$/, '');
    this.server = null;
    this.seen = new Set();
  }

  /** 启动：校验桥接可用。 */
  async start() {
    if (!this.bridgeUrl) {
      throw new Error(
        "channels['wechat-uia'].bridgeUrl 未配置。\n" +
          '请先实现桥接程序（见本文件顶部契约），再把地址填进 config.json。',
      );
    }

    // 探活，但不阻塞启动：桥接可能比本服务晚起
    this.#probeBridge().catch(() => {});

    return this.bridgeUrl;
  }

  async #probeBridge() {
    try {
      const res = await this.fetch(`${this.bridgeUrl}/health`, { signal: AbortSignal.timeout(5000) });
      const j = await res.json();
      this.log.info?.(`[uia] 桥接在线 (uia=${j.uia})`);
      return j;
    } catch (e) {
      this.log.warn?.(`[uia] 桥接暂不可用: ${e.message}`);
      return null;
    }
  }

  /**
   * 处理由桥接推送进来的消息。
   *
   * 你的桥接程序收到微信消息后，应调用 HTTP 接口或直接调用本方法。
   *
   * @param {object} msg
   * @param {string} msg.from 发送者 wxid
   * @param {string} msg.text 文本内容
   * @param {string} [msg.name] 昵称
   * @param {string} [msg.msgId] 消息 id（用于去重）
   * @param {boolean} [msg.isGroup] 是否群聊
   * @param {boolean} [msg.isSelf] 是否自己发的
   * @returns {Promise<{ok: boolean, skipped?: string}>}
   */
  async onInbound(msg) {
    if (!msg?.from || typeof msg.text !== 'string') {
      return { ok: false, skipped: 'invalid' };
    }
    if (msg.isSelf) return { ok: true, skipped: 'self' };

    // 去重
    if (msg.msgId) {
      if (this.seen.has(msg.msgId)) return { ok: true, skipped: 'duplicate' };
      this.seen.add(msg.msgId);
      if (this.seen.size > 5000) this.seen.clear();
    }

    // 群聊也处理，但会话按群 + 发送者区分，避免串台
    const sessionId = msg.isGroup ? `grp:${msg.groupId || msg.from}` : `wx:${msg.from}`;

    const result = await this.engine.handle({
      sessionId,
      text: msg.text,
      speakerName: msg.name || '对方',
      isOwner: this.#isOwner(msg.from),
    });

    if (!result.bubbles.length) {
      return { ok: true, skipped: `no_reply:${result.reason}` };
    }

    for (let i = 0; i < result.bubbles.length; i++) {
      if (i > 0) await sleep(this.config.reply.bubbleDelayMs);
      try {
        await this.send(msg.from, result.bubbles[i]);
      } catch (e) {
        this.log.error?.(`[uia] 发送失败: ${e.message}`);
        break;
      }
    }

    return { ok: true };
  }

  #isOwner(wxid) {
    const owners = this.cfg.ownerIds || [];
    return owners.length === 0 || owners.includes(wxid);
  }

  /**
   * 通过桥接发送消息。
   * @param {string} to
   * @param {string} text
   */
  async send(to, text) {
    if (!this.bridgeUrl) throw new Error('未配置 bridgeUrl');
    const res = await this.fetch(`${this.bridgeUrl}/outbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, text }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`桥接返回 ${res.status}`);
    const j = await res.json().catch(() => ({}));
    if (j.ok === false) throw new Error(j.error || '桥接发送失败');
    return true;
  }

  async stop() {
    this.server = null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
