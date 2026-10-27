/**
 * 微信 iLink 官方通道（单聊）。
 *
 * 只负责收发，不掺业务逻辑。收到消息 → 交给 engine；engine 出气泡 → 逐条发出。
 *
 * 协议要点（踩过的坑都在这）：
 *   - sendmessage 返回 200 且 body 为空 {} 才算成功
 *   - 必须带 client_id / message_type=2 / message_state=2 / base_info，缺一不投递
 *   - context_token 必须来自对方消息，可复用但不能凭空生成
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { uploadMedia, buildImageItem, guessMediaType, downloadMedia, parseAesKey } from '../core/media.mjs';

const BASE = 'https://ilinkai.weixin.qq.com';

export class ILinkChannel {
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
    this.name = 'ilink';

    this.credFile = config.channels.ilink.credFile;
    this.token = '';
    this.botId = '';
    this.ownerId = '';
    this.cursor = '';
    /** userId → context_token */
    this.contexts = new Map();
    this.running = false;
  }

  /** 读凭据，返回是否可用。 */
  loadCredentials() {
    try {
      const j = JSON.parse(fs.readFileSync(this.credFile, 'utf8'));
      if (!j.token) return false;
      this.token = j.token;
      this.botId = j.botId || '';
      this.ownerId = j.ownerId || '';
      this.cursor = j.cursor || '';
      for (const [k, v] of Object.entries(j.contextTokens || {})) this.contexts.set(k, v);
      return true;
    } catch {
      return false;
    }
  }

  saveCredentials() {
    const data = {
      token: this.token,
      botId: this.botId,
      ownerId: this.ownerId,
      cursor: this.cursor,
      contextTokens: Object.fromEntries(this.contexts),
      savedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(this.credFile), { recursive: true });
    fs.writeFileSync(this.credFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  #headers() {
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${this.token}`,
      'X-WECHAT-UIN': Buffer.from(String(randomInt(0, 0xffffffff))).toString('base64'),
    };
  }

  async #post(endpoint, body, timeoutMs = 35000) {
    const payload = { ...body, base_info: { channel_version: '1.0.3' } };
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();

    try {
      const res = await fetch(`${BASE}/ilink/bot/${endpoint}`, {
        method: 'POST',
        headers: { ...this.#headers(), 'Content-Length': String(raw.length) },
        body: raw,
        signal: ac.signal,
      });
      const text = (await res.text()).trim();
      if (!text || text === '{}') return { ret: 0 };
      try {
        return JSON.parse(text);
      } catch {
        return { ret: 0 };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** 启动：校验凭据 + 开始轮询。 */
  async start() {
    if (!this.loadCredentials()) {
      throw new Error(`没有微信凭据，请先扫码登录（${this.credFile}）`);
    }
    this.running = true;
    this.#pollLoop();
    return `bot:${this.botId}`;
  }

  async #pollLoop() {
    while (this.running) {
      try {
        const res = await this.#post('getupdates', { get_updates_buf: this.cursor });
        if (res.get_updates_buf) {
          this.cursor = res.get_updates_buf;
          this.#saveQuiet();
        }

        for (const m of res.msgs || []) {
          const from = m.from_user_id || '';
          const ct = m.context_token || '';
          if (from && ct) this.contexts.set(from, ct);
          if (!from || from === this.botId) continue;

          const parsed = extractContent(m);
          if (!parsed.text && !parsed.imageUrl) continue;

          await this.#onMessage(from, parsed);
        }
      } catch (e) {
        this.log.error?.(`[ilink] 拉取失败: ${e.message}，3 秒后重试`);
        await sleep(3000);
      }
      await sleep(200);
    }
  }

  /**
   * 处理一条消息。
   * @param {string} from
   * @param {{text:string, imageUrl?:string, kind:string}} parsed
   */
  async #onMessage(from, parsed) {
    const isOwner = !this.ownerId || from === this.ownerId;

    // 收到图片/表情包：下载解密后交给视觉模型识别
    let images;
    if (parsed.imageUrl) {
      try {
        const buf = await this.#downloadImage(parsed.imageUrl, parsed.aesKey);
        if (buf) images = [buf];
      } catch (e) {
        this.log.warn?.(`[ilink] ${e.message}`);
      }
    }

    const result = await this.engine.handle({
      sessionId: `wx:${from}`,
      text: parsed.text || (images ? '' : ''),
      images,
      speakerName: isOwner ? '主人' : '对方',
      isOwner,
    });

    if (!result.bubbles.length) {
      this.log.warn?.(`[ilink] 无回复内容 (${result.reason})`);
      return;
    }

    for (let i = 0; i < result.bubbles.length; i++) {
      if (i > 0) await sleep(this.config.reply.bubbleDelayMs);
      try {
        await this.send(from, result.bubbles[i]);
      } catch (e) {
        this.log.error?.(`[ilink] 发送失败: ${e.message}`);
        break;
      }
    }
  }

  /**
   * 下载图片/表情包，支持解密。
   * @param {string} url
   * @param {string} [aesKeyB64]
   */
  async #downloadImage(url, aesKeyB64) {
    if (!url) return null;
    try {
      const buf = await downloadMedia({ url, aesKeyB64 });
      if (!buf || buf.length === 0) throw new Error('空文件');
      if (buf.length > 10 * 1024 * 1024) throw new Error('图片过大');
      return buf;
    } catch (e) {
      throw new Error(`图片下载失败: ${e.message}`);
    }
  }

  /** 发送文本。 */
  async send(to, text, contextToken) {
    const ct = contextToken || this.contexts.get(to);
    if (!ct) throw new Error(`缺少 ${to} 的 context_token，需要对方先发一条消息`);

    const body = {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: `jj-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        message_type: 2,
        message_state: 2,
        context_token: ct,
        item_list: [{ type: 1, text_item: { text } }],
      },
    };

    const res = await this.#post('sendmessage', body, 20000);
    if (res.ret && res.ret !== 0) {
      throw new Error(`发送被拒绝: ${JSON.stringify(res).slice(0, 120)}`);
    }
    return true;
  }

  /**
   * 发送图片。
   *
   * 流程：AES 加密 → 上传 CDN → 发媒体引用。
   *
   * @param {string} to
   * @param {Buffer} imageBuf 图片数据
   * @param {object} [opts]
   * @param {string} [opts.caption] 图片附带的文字
   * @param {string} [opts.contextToken]
   */
  async sendImage(to, imageBuf, opts = {}) {
    const ct = opts.contextToken || this.contexts.get(to);
    if (!ct) throw new Error(`缺少 ${to} 的 context_token`);
    if (!Buffer.isBuffer(imageBuf) || imageBuf.length === 0) {
      throw new Error('图片数据为空');
    }

    // 1. 上传（内部完成加密）
    let media;
    try {
      media = await uploadMedia({
        buffer: imageBuf,
        mediaType: guessMediaType(imageBuf),
        post: (endpoint, body) => this.#post(endpoint, body, 60000),
      });
    } catch (e) {
      // 没有上传权限时降级：发一句文字代替
      if (/没有图片上传权限|ret=-2/.test(e.message)) {
        this.log.warn?.('[ilink] 当前 Bot 无图片权限，改用文字');
        if (opts.caption) {
          await this.send(to, opts.caption, ct);
          return { sent: false, reason: 'no_permission' };
        }
        throw e;
      }
      throw e;
    }

    // 2. 发媒体引用
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: `jj-img-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        message_type: 2,
        message_state: 2,
        context_token: ct,
        item_list: [buildImageItem(media)],
      },
    };

    const res = await this.#post('sendmessage', body, 30000);
    if (res.ret && res.ret !== 0) {
      throw new Error(`图片发送被拒: ${JSON.stringify(res).slice(0, 200)}`);
    }

    // 有文字说明就单独发一条
    if (opts.caption) {
      await sleep(300);
      await this.send(to, opts.caption, ct);
    }

    return { sent: true, bytes: imageBuf.length };
  }

  #saveQuiet() {
    try {
      this.saveCredentials();
    } catch {}
  }

  async stop() {
    this.running = false;
  }
}

/**
 * 解析消息内容。支持文本和图片/表情包。
 *
 * iLink 的 item_list 里：
 *   type 1 = 文本
 *   type 2 = 图片（含表情包），字段在 image_item 里
 *   type 3 = 文件
 *
 * @param {object} msg
 * @returns {{text:string, imageUrl?:string, kind:string}}
 */
function extractContent(msg) {
  let text = '';
  let imageUrl = '';
  let aesKey = '';
  let kind = 'unknown';

  for (const item of msg.item_list || []) {
    if (item.type === 1) {
      text = item.text_item?.text || '';
      kind = 'text';
      break;
    }
    if (item.type === 2) {
      const img = item.image_item || {};
      const media = img.media || {};

      // 下载地址：优先 CDN 完整地址，其次用 encrypt_query_param 拼
      imageUrl =
        media.full_url ||
        media.cdn_url ||
        img.cdn_url ||
        img.url ||
        img.file_path ||
        (media.encrypt_query_param
          ? `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
          : '');

      // 密钥：可能是 media.aes_key 或 img.aes_key
      aesKey = media.aes_key || img.aes_key || '';
      kind = 'image';
      if (img.text) text = img.text;
    }
  }

  return { text, imageUrl, aesKey, kind };
}

/** 兼容旧接口。 */
function extractText(msg) {
  return extractContent(msg).text;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
