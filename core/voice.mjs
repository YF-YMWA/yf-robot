/**
 * 语音层：把音频转成文字。
 *
 * 支持两种接口：
 *   1. OpenAI 兼容的 chat/completions + input_audio（qwen3-asr-flash 等）
 *   2. 传统 OpenAI /audio/transcriptions（whisper 等）
 *
 * 音频格式处理：
 *   微信语音是 AMR / SILK，多数 ASR 接口不认，先用 ffmpeg 转 mp3/wav。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findFfmpeg, makeTmpDir } from './image.mjs';

const execFileAsync = promisify(execFile);

export class VoiceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VoiceError';
  }
}

/** 常见音频格式的 magic 与 mime。 */
export const AUDIO_FORMATS = {
  mp3: { mime: 'audio/mpeg', magic: [0xff, 0xfb], alt: [0xff, 0xf3, 0xff, 0xf2] },
  wav: { mime: 'audio/wav', riff: 'RIFF' },
  ogg: { mime: 'audio/ogg', magic: [0x4f, 0x67, 0x67, 0x53] }, // OggS
  amr: { mime: 'audio/amr', magic: [0x23, 0x21, 0x41, 0x4d, 0x52] }, // #!AMR
  silk: { mime: 'audio/silk', magic: [0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b] }, // \x02#!SILK
  m4a: { mime: 'audio/mp4', ftyp: true },
  aac: { mime: 'audio/aac', magic: [0xff, 0xf1] },
};

/**
 * 按文件头识别音频格式。
 * @param {Buffer} buf
 * @returns {string} 格式名或 'unknown'
 */
export function sniffAudioFormat(buf) {
  if (!buf || buf.length < 8) return 'unknown';

  // AMR: "#!AMR"
  if (buf.subarray(0, 5).toString('ascii') === '#!AMR') return 'amr';
  // SILK: 0x02 后跟 "#!SILK"
  if (buf[0] === 0x02 && buf.subarray(1, 7).toString('ascii') === '#!SILK') return 'silk';
  // WAV: "RIFF"...."WAVE"
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') {
    return 'wav';
  }
  // OGG: "OggS"
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  // MP3: ID3 标签或帧同步
  if (buf.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  // M4A: ftyp box
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a';
  // AAC ADTS
  if (buf[0] === 0xff && (buf[1] === 0xf1 || buf[1] === 0xf9)) return 'aac';

  return 'unknown';
}

/** 需要转码的格式：ASR 接口基本都不支持 */
const NEEDS_CONVERT = new Set(['amr', 'silk', 'unknown']);

/**
 * 把音频转成 mp3（ASR 接口通用格式）。
 * @param {Buffer} buf
 * @param {object} [opts]
 * @returns {Promise<Buffer>}
 */
export async function toMp3(buf, opts = {}) {
  const ffmpeg = opts.ffmpeg || findFfmpeg();
  const tmpDir = await makeTmpDir("jj-audio-");
  const inFile = path.join(tmpDir, 'in.bin');
  const outFile = path.join(tmpDir, 'out.mp3');

  try {
    await fs.promises.writeFile(inFile, buf);
    await execFileAsync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', inFile,
        // 16k 单声道，ASR 标准配置，体积也小
        '-ar', '16000',
        '-ac', '1',
        '-b:a', '64k',
        outFile,
      ],
      { timeout: 60000 },
    );
    return await fs.promises.readFile(outFile);
  } catch (e) {
    throw new VoiceError(`音频转码失败: ${e.message}`);
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 读取音频时长（秒）。
 * @param {Buffer} buf
 * @param {object} [opts]
 * @returns {Promise<number|null>}
 */
export async function probeDuration(buf, opts = {}) {
  const ffmpeg = opts.ffmpeg || findFfmpeg();
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));

  const tmpDir = await makeTmpDir("jj-adur-");
  const file = path.join(tmpDir, 'audio');
  try {
    await fs.promises.writeFile(file, buf);
    const { stdout } = await execFileAsync(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeout: 15000 },
    );
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export class VoiceClient {
  /**
   * @param {object} cfg voice 配置段
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
   * 语音转文字。
   *
   * @param {Buffer|string} input 音频数据或文件路径
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{text:string, format:string, converted:boolean, duration:number|null}>}
   */
  async transcribe(input, opts = {}) {
    if (!this.enabled) throw new VoiceError('未启用语音转文字');

    const buf = Buffer.isBuffer(input) ? input : await fs.promises.readFile(input);
    const format = sniffAudioFormat(buf);

    // 时长检查
    const duration = await probeDuration(buf, { ffmpeg: this.cfg.ffmpeg }).catch(() => null);
    if (duration && this.cfg.maxSeconds && duration > this.cfg.maxSeconds) {
      throw new VoiceError(`语音太长（${duration.toFixed(1)}s），上限 ${this.cfg.maxSeconds}s`);
    }

    // 决定是否需要转码
    let audioBuf = buf;
    let finalFormat = format;
    let converted = false;

    if (NEEDS_CONVERT.has(format)) {
      audioBuf = await toMp3(buf, { ffmpeg: this.cfg.ffmpeg });
      finalFormat = 'mp3';
      converted = true;
    }

    // base64 编码会膨胀 1/3，控制在上限内
    const b64 = audioBuf.toString('base64');
    if (b64.length > 10 * 1024 * 1024) {
      throw new VoiceError('音频文件过大（编码后超过 10MB）');
    }

    const mime = AUDIO_FORMATS[finalFormat]?.mime || 'audio/mpeg';
    const dataUrl = `data:${mime};base64,${b64}`;

    const text = this.cfg.mode === 'transcriptions'
      ? await this.#callTranscriptions(audioBuf, finalFormat, opts.signal)
      : await this.#callChatCompletions(dataUrl, mime, opts.signal);

    return { text: text.trim(), format: finalFormat, converted, duration };
  }

  /** OpenAI 兼容 chat/completions + input_audio（qwen3-asr-flash 等）。 */
  async #callChatCompletions(dataUrl, mime, signal) {
    const url = this.cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';

    const body = {
      model: this.cfg.model,
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: dataUrl } }],
        },
      ],
      stream: false,
      asr_options: { enable_itn: this.cfg.enableItn !== false },
    };

    let json;
    try {
      json = await this.#post(url, body, signal);
    } catch (e) {
      /**
       * 兼容模式不认这个模型时，DashScope 会报
       * 「An incorrect modal `audio` was entered…」。
       * 这种情况换原生多媒体接口再试一次。
       */
      if (/modal|audio|InvalidParameter|not supported/i.test(String(e.message || ''))) {
        this.log?.warn?.('[voice] 兼容模式不认，改用原生音频接口');
        return await this.#callNativeAudio(dataUrl, signal);
      }
      throw e;
    }

    // DashScope 兼容模式：标准 choices
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content;

    // DashScope 原生 multimodal 结构
    const native = json?.output?.output?.sentence?.text || json?.output?.text;
    if (typeof native === 'string' && native.trim()) return native;

    throw new VoiceError(`语音识别返回空结果: ${JSON.stringify(json).slice(0, 200)}`);
  }

  /**
   * DashScope 原生多媒体接口（qwen3-asr-flash 等）。
   *
   * 请求体：
   *   { model, input: { messages: [ { role:'user', content: [ { audio: "data:audio/wav;base64,..." } ] } ] } }
   * 注意这里是键名 audio，不是兼容模式的 input_audio —— 弄错就会报
   * 「An incorrect modal `audio` was entered」。
   */
  async #callNativeAudio(dataUrl, signal) {
    const origin = (() => {
      try {
        return new URL(this.cfg.baseUrl).origin;
      } catch {
        return 'https://dashscope.aliyuncs.com';
      }
    })();

    const url = origin + '/api/v1/services/aigc/multimodal-generation/generation';
    const body = {
      model: this.cfg.model,
      input: {
        messages: [
          { role: 'user', content: [{ audio: dataUrl }] },
        ],
      },
      parameters: this.cfg.enableItn === false ? {} : { asr_options: { enable_itn: true } },
    };

    const json = await this.#post(url, body, signal);

    // 原生结构：output.choices[0].message.content[0].text 或 output.text
    const c0 = json?.output?.choices?.[0]?.message?.content;
    if (Array.isArray(c0)) {
      const t = c0.map((x) => x?.text || '').join('').trim();
      if (t) return t;
    }
    const alt = json?.output?.text || json?.output?.output?.sentence?.text;
    if (typeof alt === 'string' && alt.trim()) return alt;

    throw new VoiceError(
      '语音识别返回空结果（原生接口）：' + JSON.stringify(json).slice(0, 200),
    );
  }

  /** 传统 /audio/transcriptions（whisper 等）。 */
  async #callTranscriptions(buf, format, signal) {
    const url = this.cfg.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
    const form = new FormData();
    const mime = AUDIO_FORMATS[format]?.mime || 'audio/mpeg';
    const ext = format === 'unknown' ? 'mp3' : format;
    form.append('file', new Blob([buf], { type: mime }), `audio.${ext}`);
    form.append('model', this.cfg.model);
    if (this.cfg.language) form.append('language', this.cfg.language);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', () => ac.abort(), { once: true });

    try {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.apiKey}` },
        body: form,
        signal: ac.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new VoiceError(`语音接口返回 ${res.status}: ${detail.slice(0, 200)}`);
      }
      const json = await res.json();
      if (typeof json?.text === 'string') return json.text;
      throw new VoiceError('语音接口返回格式异常');
    } catch (e) {
      if (e instanceof VoiceError) throw e;
      if (e.name === 'AbortError') throw new VoiceError('语音识别超时');
      throw new VoiceError(`语音识别失败: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async #post(url, body, signal) {
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
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new VoiceError(`语音接口返回 ${res.status}: ${detail.slice(0, 200)}`);
      }
      return await res.json();
    } catch (e) {
      if (e instanceof VoiceError) throw e;
      if (e.name === 'AbortError') throw new VoiceError('语音识别超时');
      throw new VoiceError(`语音识别失败: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
