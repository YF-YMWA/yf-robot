/**
 * 群聊通道：完整的微信群聊系统。
 *
 * 采用 whale-girl 的实战设计：
 *   - 结构化事件流承载群聊历史
 *   - 参与者哈希去标识
 *   - 接话窗口 + 多重速率限制
 *   - 快捷回复走固定文本，不浪费模型
 *
 * 数据来源由适配器提供（见文件底部契约）。
 */
import { GroupSessionStore } from '../core/group-session.mjs';
import { GroupEvent, cleanForModel } from '../core/group.mjs';
import http from 'node:http';

export class WeChatGroupChannel {
  /**
   * @param {object} opts
   * @param {object} opts.config 完整配置
   * @param {import('../core/engine.mjs').ChatEngine} opts.engine
   * @param {object} [opts.logger]
   */
  constructor({ config, engine, logger = console }) {
    this.config = config;
    this.engine = engine;
    this.log = logger;
    this.name = 'wechat-group';

    this.cfg = config.group;
    this.store = new GroupSessionStore(this.cfg);
    this.seen = new Set();
    /** HTTP 服务，供适配器推送消息 */
    this.server = null;
    /** 待适配器拉取的回复队列 */
    this.outbox = [];
  }

  async start() {
    const webCfg = this.config.channels['wechat-group'] || {};
    const host = webCfg.listenHost || '127.0.0.1';
    const port = webCfg.listenPort || 8898;
    const token = webCfg.token || '';

    this.token = token;
    this.server = http.createServer((req, res) => this.#route(req, res));

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, resolve);
    });

    this.log.info?.(
      `[group] 群聊接口就绪 http://${host}:${port}（@才回=${this.cfg.requireAt}，接话窗口=${this.cfg.engagedMinutes}分钟）`,
    );
    return `http://${host}:${port}`;
  }

  /** HTTP 路由。 */
  async #route(req, res) {
    const url = new URL(req.url, 'http://localhost');

    // 鉴权（如果配了 token）
    if (this.token) {
      const auth = req.headers.authorization || '';
      const given = auth.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
      if (given !== this.token) {
        return json(res, 401, { ok: false, error: 'unauthorized' });
      }
    }

    try {
      // 适配器推送群消息
      if (req.method === 'POST' && url.pathname === '/group/inbound') {
        return await this.#inbound(req, res);
      }
      // 适配器拉取待发送的回复
      if (req.method === 'GET' && url.pathname === '/group/outbox') {
        const messages = this.outbox.splice(0, this.outbox.length);
        return json(res, 200, { ok: true, messages });
      }
      // 健康检查
      if (req.method === 'GET' && url.pathname === '/group/health') {
        return json(res, 200, { ok: true, groups: this.store.stats() });
      }
      // 手动清空回复队列
      if (req.method === 'POST' && url.pathname === '/group/clear') {
        this.outbox.length = 0;
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      this.log.error?.('[group] ' + e.message);
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  /** 处理入站消息。 */
  async #inbound(req, res) {
    const body = await readJson(req);

    // 支持单条或批量
    const list = Array.isArray(body) ? body : body.messages || [body];
    const results = [];

    for (const msg of list) {
      const r = await this.onMessage(msg);
      results.push(r);

      // 有回复就放进队列，等适配器来取
      if (r.reply && Array.isArray(r.bubbles)) {
        for (const bubble of r.bubbles) {
          this.outbox.push({
            groupId: msg.groupId,
            text: bubble,
            at: Date.now(),
          });
        }
      }
    }

    return json(res, 200, { ok: true, results });
  }

  /**
   * 处理一条群消息。这是适配器应该调用的入口。
   *
   * @param {object} msg
   * @param {string} msg.groupId 群标识
   * @param {string} msg.from 发送者 wxid
   * @param {string} [msg.name] 发送者昵称
   * @param {string} msg.text 消息内容
   * @param {string} [msg.msgId] 消息 id
   * @param {boolean} [msg.atMe] 是否 @ 了机器人
   * @param {boolean} [msg.replyToBot] 是否引用回复机器人
   * @param {boolean} [msg.isGroupAdmin] 是否群管理员
   * @param {string} [msg.replyToName] 引用的是谁
   * @param {Buffer|string} [msg.audio] 语音
   * @param {Buffer|string|Buffer[]} [msg.images] 图片
   * @returns {Promise<{reply:boolean, bubbles?:string[], reason:string}>}
   */
  async onMessage(msg) {
    const { groupId, from, text } = msg;
    if (!groupId || !from) return { reply: false, reason: 'invalid' };

    // 去重
    if (msg.msgId) {
      if (this.seen.has(msg.msgId)) return { reply: false, reason: 'duplicate' };
      this.seen.add(msg.msgId);
      if (this.seen.size > 5000) this.seen.clear();
    }

    const group = this.store.get(groupId);

    // 指令优先（不记录为普通事件）
    const cmdResult = this.#handleCommand(msg, group);
    if (cmdResult) {
      group.addEvent(
        new GroupEvent({
          senderId: 'bot',
          senderName: '鲸鲸',
          text: cmdResult.bubbles.join(' '),
          isBot: true,
          addressedToBot: false,
        }),
      );
      return cmdResult;
    }

    // 记录事件（即使不回复也记，让它知道群里在聊什么）
    const event = new GroupEvent({
      senderId: from,
      senderName: msg.name || '群友',
      text: cleanForModel(text),
      ts: Date.now(),
      addressedToBot: Boolean(msg.atMe || msg.replyToBot),
      replyTo: msg.replyToName || '',
    });
    group.addEvent(event);

    /**
     * 主人识别。
     *
     * 以前只看 group.ownerIds —— 那个默认是空的，于是：
     *   · 主人在群里说话不被当成主人（masterAlwaysReply 不生效）
     *   · 主人执行 /mute 被拒（"这个我说了不算"）
     * 现在回退到全局主人配置（owner.wxids / persona.master.wxids），
     * 群里和私聊认的是同一个人。
     */
    const isOwner = this.#isOwnerWxid(from);

    // 策略判断
    const decision = group.shouldReply({
      text,
      senderId: from,
      senderName: msg.name,
      atMe: msg.atMe,
      replyToBot: msg.replyToBot,
      isOwner,
    });

    if (!decision.reply) {
      this.log.info?.(`[group] 不回 (${decision.reason})`);
      return { reply: false, reason: decision.reason };
    }

    // 快捷回复
    if (decision.canned) {
      group.recordReply({ reason: decision.reason, senderId: from });
      const bubbles = [decision.canned];
      group.addEvent(new GroupEvent({ senderId: 'bot', senderName: '鲸鲸', text: decision.canned, isBot: true }));
      return { reply: true, bubbles, reason: decision.reason };
    }

    // 走模型：构建群聊上下文
    const context = group.buildContext({
      ...event,
      // 当前消息可能带语音/图片
      text: event.text,
    });

    const userContent = context[0]?.content || event.text;

    const result = await this.engine.handle({
      sessionId: `grp:${groupId}`,
      text: userContent,
      speakerName: msg.name || '群友',
      // 群聊里按发言人记事实要用到，私聊不看这个字段
      speakerId: from,
      isOwner,
      // 重名提醒（见 duplicatedNames 的说明）
      groupNote: this.#buildGroupNote(group),
      images: msg.images,
      audio: msg.audio,
    });

    if (result.bubbles.length === 0) {
      return { reply: false, reason: result.reason };
    }

    // 记录回复
    group.recordReply({
      reason: decision.reason,
      mentioned: Boolean(msg.atMe),
      senderId: from,
    });
    group.addEvent(
      new GroupEvent({
        senderId: 'bot',
        senderName: '鲸鲸',
        text: result.bubbles.join(' '),
        isBot: true,
      }),
    );

    return { reply: true, bubbles: result.bubbles, reason: decision.reason };
  }

  /**
   * 这个 wxid 是不是主人。
   *
   * 查找顺序：
   *   1. group.ownerIds（群聊专用名单，优先）
   *   2. owner.wxids（控制台「主人设置」里填的）
   *   3. persona.master.wxids（老配置位置，兼容用）
   *
   * @param {string} wxid
   * @returns {boolean}
   */
  #isOwnerWxid(wxid) {
    const id = String(wxid || '').trim();
    if (!id) return false;

    if ((this.cfg.ownerIds || []).includes(id)) return true;

    const global = this.config?.owner?.wxids || this.config?.persona?.master?.wxids || [];
    return Array.isArray(global) && global.includes(id);
  }

  /**
   * 拼群聊专用的提示词补充。
   *
   * 两个作用：
   *   1. **始终**提醒「发言人编号才是身份，名字不是」——
   *      群聊历史里 Alice 说过「我叫小美」，Bob 问「我叫什么」时，
   *      模型有相当概率直接把小美安到 Bob 头上。加了这条规则能显著降下来。
   *   2. 有重名时额外点名说清楚。
   *
   * @param {GroupSession} group
   * @returns {string}
   */
  #buildGroupNote(group) {
    try {
      const parts = [
        '【群聊规则】上面的聊天记录里，每条都有「（参与者N）」。' +
          '**N 不同就是不同的人**，哪怕名字完全一样。' +
          '回答「我叫什么」「我喜欢什么」这类关于对方自己的问题时，' +
          '只认当前发言人那一条，别把别人（别的参与者编号）说过的内容安到他头上。' +
          '分不清就直说「我不确定是谁说的」。',
      ];

      const dups = group.duplicatedNames?.() || [];
      if (dups.length) {
        const list = dups.map((d) => `「${d.name}」有 ${d.count} 个不同的人`).join('；');
        parts.push(
          `【注意】这个群里有重名：${list}。` +
            '他们是不同的人，不要因为名字一样就把 A 说过的事算到 B 头上。',
        );
      }

      return parts.join('\n');
    } catch {
      return '';
    }
  }

  /** 处理群管理指令。 */
  #handleCommand(msg, group) {
    const text = String(msg.text || '').trim();
    const m = /^\/(\w+)(?:\s+(.+))?$/.exec(text);
    if (!m) return null;

    const cmd = m[1].toLowerCase();
    const arg = (m[2] || '').trim();

    // 权限：主人或群管理员
    const isOwner = this.#isOwnerWxid(msg.from);
    const allowed = isOwner || msg.isGroupAdmin;
    if (!allowed) {
      return { reply: true, bubbles: ['这个我说了不算，得主人或者管理员来。'], reason: 'command_denied' };
    }

    switch (cmd) {
      case 'mute': {
        const min = parseInt(arg, 10) || this.cfg.muteDefaultMinutes || 30;
        group.mute(min);
        return { reply: true, bubbles: [`好，我安静 ${min} 分钟。`], reason: 'command_mute' };
      }
      case 'unmute':
        group.unmute();
        return { reply: true, bubbles: ['我回来了。'], reason: 'command_unmute' };
      case 'reset':
        this.engine.reset(`grp:${group.groupId}`);
        group.clear();
        return { reply: true, bubbles: ['刚才聊的我都忘了。'], reason: 'command_reset' };
      case 'who':
      case 'members': {
        const top = group.topMembers(5);
        if (top.length === 0) return { reply: true, bubbles: ['群里还没人说话。'], reason: 'command_who' };
        const list = top.map(([n, c]) => `${n}(${c})`).join('、');
        return { reply: true, bubbles: [`常说话的就这些：${list}`], reason: 'command_who' };
      }
      case 'status': {
        const s = group.stats();
        return {
          reply: true,
          bubbles: [
            `本群状态：${s.events} 条记录，${s.members} 个成员，` +
              `${s.muted ? '免打扰中' : '正常'}，${s.engaged ? '接话中' : '待命'}，` +
              `最近一小时回了 ${s.repliesLastHour} 条`,
          ],
          reason: 'command_status',
        };
      }
      case 'help':
        return {
          reply: true,
          bubbles: [
            '可用指令：',
            '/mute [分钟] 让我安静',
            '/unmute 让我回来',
            '/reset 忘掉刚才聊的',
            '/who 看看谁最活跃',
            '/status 看看我的状态',
          ],
          reason: 'command_help',
        };
      default:
        return null;
    }
  }

  stats() {
    return {
      ...this.store.stats(),
      outbox: this.outbox.length,
    };
  }

  async stop() {
    if (this.server) {
      await new Promise((r) => this.server.close(r));
      this.server = null;
    }
  }
}

/** 发送 JSON 响应。 */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 读取 JSON 请求体。 */
function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 适配器契约（你需要实现的部分）
 * ==================================
 *
 * 你的适配器负责从微信客户端读取群消息，然后调用 onMessage()：
 *
 *   import { WeChatGroupChannel } from './channels/wechat-group.mjs';
 *
 *   const channel = new WeChatGroupChannel({ config, engine });
 *   await channel.start();
 *
 *   // 收到群消息时
 *   const result = await channel.onMessage({
 *     groupId: '123456@chatroom',        // 群 id
 *     from: 'wxid_abc123',                // 发送者 wxid
 *     name: '张三',                       // 发送者昵称
 *     text: '鲸鲸你好',                   // 文本内容
 *     msgId: 'msg_xyz',                   // 唯一 id，用于去重
 *     atMe: true,                         // 是否 @ 了机器人（适配器判断）
 *     replyToBot: false,                  // 是否引用回复机器人
 *     isGroupAdmin: false,                // 是否群管理员
 *     replyToName: '',                    // 引用的是谁
 *     // audio: '/path/to/voice.amr',     // 可选：语音文件路径
 *     // images: ['/path/to/img.jpg'],    // 可选：图片路径
 *   });
 *
 *   if (result.reply) {
 *     for (const bubble of result.bubbles) {
 *       await yourBridge.sendToGroup(groupId, bubble);
 *     }
 *   }
 *
 * 关键点：
 *   1. `atMe` 必须由适配器判断——本通道不解析微信原始消息格式
 *   2. `groupId` 用群原始 id（xxx@chatroom 形式）
 *   3. 语音/图片传本地路径，转码由本通道负责
 *   4. 即使 result.reply 为 false，消息也已被记录进上下文，
 *      下次被叫到时模型能看到群里刚才聊了什么
 *
 * 适配器本身需要读写微信客户端（UIA 或数据库），那部分不在本项目范围内。
 */
