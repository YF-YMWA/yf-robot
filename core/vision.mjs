/**
 * 视觉层：把图片交给支持多模态的模型，返回文字描述。
 *
 * 用途：让主模型（可能不支持图片）也能"看图"——
 * 先用视觉模型把图转成文字描述，再把描述拼进对话。
 *
 * 为什么不直接把图塞给主模型：
 *   1. 主模型未必支持图像输入
 *   2. 微信场景下图片格式杂乱（wxgf），必须先转码
 *   3. 转成文字后能进历史、能被引用，比一次性图像上下文更实用
 */
import { prepareImage, splitTallImage, sniffFormat } from './image.mjs';

export class VisionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VisionError';
  }
}

export class VisionClient {
  /**
   * @param {object} cfg vision 配置段
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.fetch = opts.fetchImpl || globalThis.fetch;
  }

  get enabled() {
    return Boolean(this.cfg.enabled && this.cfg.baseUrl && this.cfg.model);
  }

  /**
   * 识别图片，返回文字描述。
   *
   * @param {Buffer|string} input 图片数据或路径
   * @param {object} [opts]
   * @param {string} [opts.prompt] 识别指令
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{description:string, format:string, converted:boolean, segments:number}>}
   */
  async describe(input, opts = {}) {
    if (!this.enabled) throw new VisionError('未启用视觉模型');

    const prompt =
      opts.prompt ||
      '请描述这张图片的内容。如果有文字，逐字转写出来，不要省略、不要概括。如果有多条信息（如聊天记录、列表），按顺序逐条写。';

    const prepared = await prepareImage(input, {
      maxEdge: this.cfg.maxEdge,
      ffmpeg: this.cfg.ffmpeg,
    });

    // 长截图切段识别
    let segments = 0;
    let description;

    const size = prepared.width && prepared.height ? { width: prepared.width, height: prepared.height } : null;
    if (size && size.height / size.width > 2.2) {
      const raw = Buffer.isBuffer(input) ? input : await (await import('node:fs/promises')).readFile(input);
      const parts = await splitTallImage(raw, { maxEdge: this.cfg.maxEdge, ffmpeg: this.cfg.ffmpeg });
      if (parts.length > 1) {
        segments = parts.length;
        const texts = [];
        for (const p of parts) {
          const t = await this.#call(p.dataUrl, prompt, opts.signal);
          texts.push(`[第 ${p.index + 1} 段]\n${t}`);
        }
        description = texts.join('\n\n');
      }
    }

    if (!description) {
      description = await this.#call(prepared.dataUrl, prompt, opts.signal);
    }

    return {
      description: description.trim(),
      format: prepared.format,
      converted: prepared.converted,
      segments,
    };
  }

  /** 调用视觉接口。 */
  async #call(dataUrl, prompt, signal) {
    const url = this.cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', () => ac.abort(), { once: true });

    try {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: this.cfg.maxTokens || 1024,
          temperature: 0.3,
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new VisionError(`视觉模型返回 ${res.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
      }

      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        throw new VisionError('视觉模型返回空内容');
      }
      return text;
    } catch (e) {
      if (e instanceof VisionError) throw e;
      if (e.name === 'AbortError') throw new VisionError('视觉识别超时');
      throw new VisionError(`视觉识别失败: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 把图片识别结果包装成给主模型的用户消息。
 * @param {string} description
 * @param {string} [userText] 用户随图说的话
 */
export function wrapImageMessage(description, userText) {
  const parts = ['[用户发来一张图片，内容如下]', description];
  if (userText && userText.trim()) {
    parts.push('', `[用户说] ${userText.trim()}`);
  }
  return parts.join('\n');
}
