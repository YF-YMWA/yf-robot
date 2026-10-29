/**
 * 绘图：让她能自己画图。
 *
 * 支持智谱 CogView 系列（用同一个 API Key，cogview-3-flash 免费）。
 *
 * 关键细节：
 *   智谱返回的 URL 指向的文件「实际格式」可能是 JPEG，
 *   不能按扩展名判断，必须嗅探文件头，否则发出去微信显示不出来。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 默认配置。 */
export const IMAGEGEN_DEFAULTS = {
  enabled: false,
  provider: 'zhipu',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'cogview-3-flash',
  size: '1024x1024',
  /** 生成后存到哪（相对项目根） */
  saveDir: 'data/generated',
  /** 单次最多生成几张 */
  maxPerCall: 2,
};

export class ImageGenError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ImageGenError';
    this.code = opts.code;
  }
}

/**
 * 嗅探图片真实格式。
 * @param {Buffer} buf
 * @returns {{ext: string, mime: string}|null}
 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;

  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: '.png', mime: 'image/png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  if (buf.slice(0, 3).toString() === 'GIF') {
    return { ext: '.gif', mime: 'image/gif' };
  }
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

export class ImageGenClient {
  /**
   * @param {object} cfg imagegen 配置段
   * @param {object} [opts]
   * @param {string} [opts.apiKey]
   * @param {string} [opts.root] 项目根（存图用）
   * @param {object} [opts.logger]
   */
  constructor(cfg, opts = {}) {
    this.cfg = { ...IMAGEGEN_DEFAULTS, ...cfg };
    this.apiKey = opts.apiKey || cfg.apiKey || '';
    this.root = opts.root || process.cwd();
    this.log = opts.logger || console;
  }

  get enabled() {
    return Boolean(this.cfg.enabled && this.apiKey);
  }

  /**
   * 生成图片。
   *
   * @param {string} prompt
   * @param {object} [opts]
   * @param {string} [opts.size]
   * @returns {Promise<Array<{path:string, name:string, size:number, mime:string}>>}
   */
  async generate(prompt, opts = {}) {
    if (!this.enabled) {
      throw new ImageGenError('绘图未启用（检查 imagegen.enabled 和 apiKey）');
    }

    const text = String(prompt || '').trim();
    if (!text) throw new ImageGenError('没有描述词');
    if (text.length > 500) throw new ImageGenError('描述太长（上限 500 字）');

    const size = opts.size || this.cfg.size || '1024x1024';
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/images/generations`;

    const t0 = Date.now();

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.cfg.model, prompt: text, size }),
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      throw new ImageGenError(
        e.name === 'AbortError' ? '绘图超时（2 分钟）' : `请求失败: ${e.message}`,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      /**
       * 把「用的哪个模型」写进错误。
       *
       * 上游常常只回一句「模型不存在，请检查模型代码」—— 看着这句话，
       * 用户不知道是模型名填错了，还是这把 Key 根本不开这个模型。
       */
      const cf = this.cfg || {};
      const hint = /模型|model/i.test(body)
        ? `（画图模型：${cf.model || '未设置'}；地址：${cf.baseUrl || '未设置'}）`
        : '';
      throw new ImageGenError(`绘图接口返回 ${res.status}: ${body.slice(0, 200)}${hint}`);
    }

    const j = await res.json();
    const items = j.data || [];
    if (!items.length) throw new ImageGenError('接口没返回图片');

    const dir = path.join(this.root, this.cfg.saveDir || 'data/generated');
    fs.mkdirSync(dir, { recursive: true });

    const out = [];
    const crypto = await import('node:crypto');

    for (const item of items.slice(0, this.cfg.maxPerCall)) {
      let buf = null;

      // 优先 base64，其次 URL 下载
      if (item.b64_json) {
        buf = Buffer.from(item.b64_json, 'base64');
      } else if (item.url) {
        try {
          const img = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
          if (!img.ok) throw new Error(`HTTP ${img.status}`);
          buf = Buffer.from(await img.arrayBuffer());
        } catch (e) {
          this.log.warn?.(`[imagegen] 下载失败: ${e.message}`);
          continue;
        }
      }

      if (!buf || buf.length < 1024) continue;

      // 关键：按文件头判断真实格式（智谱返回的常是 JPEG，哪怕扩展名写着 png）
      const fmt = sniffImage(buf);
      if (!fmt) {
        this.log.warn?.('[imagegen] 返回内容不是图片，跳过');
        continue;
      }

      const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12);
      const name = `gen_${hash}${fmt.ext}`;
      const full = path.join(dir, name);

      if (!fs.existsSync(full)) fs.writeFileSync(full, buf);

      out.push({ path: full, name, size: buf.length, mime: fmt.mime });
    }

    if (!out.length) throw new ImageGenError('生成的图片都拿不到（下载失败或格式不认识）');

    this.log.info?.(
      `[imagegen] 生成 ${out.length} 张（${((Date.now() - t0) / 1000).toFixed(1)}s）`,
    );

    return out;
  }

  /** 状态（给控制台看）。 */
  status() {
    return {
      enabled: Boolean(this.cfg.enabled),
      hasKey: Boolean(this.apiKey),
      provider: this.cfg.provider,
      model: this.cfg.model,
      size: this.cfg.size,
      saveDir: this.cfg.saveDir,
    };
  }
}
