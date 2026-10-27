/**
 * 语音合成（TTS）：把文字变成语音。
 *
 * 用阿里云百炼（DashScope）的 qwen3-tts-flash —— 和语音转写用的是同一个 Key，
 * 用户不用再注册第二个服务。
 *
 * 为什么单独一个模块：
 *   适配器要「发语音条」就得先有音频文件，而合成是核心的能力
 *   （跟看图、画图一样，不该让每个适配器各写一遍）。
 *
 * 接口形状：
 *   POST /api/tts { text, voice? }  →  返回音频字节（wav）
 */
import fs from 'node:fs';
import path from 'node:path';

/** 默认音色（Cherry：女声，比较自然） */
export const DEFAULT_VOICE = 'Cherry';

/** 常用音色，控制台可以选 */
export const VOICES = [
  { id: 'Cherry', label: 'Cherry（女声，自然）' },
  { id: 'Serena', label: 'Serena（女声，温柔）' },
  { id: 'Ethan', label: 'Ethan（男声，阳光）' },
  { id: 'Chelsie', label: 'Chelsie（女声，活泼）' },
  { id: 'Dylan', label: 'Dylan（男声，北京话）' },
  { id: 'Jada', label: 'Jada（女声，上海话）' },
];

/** 单次最多合成多少字（接口上限 600，留点余量） */
const MAX_CHARS = 560;

/**
 * 合成语音。
 *
 * @param {object} opts
 * @param {string} opts.text 要合成的文字
 * @param {string} [opts.voice] 音色
 * @param {object} opts.config 核心配置（读 voice.apiKey / baseUrl）
 * @param {string} [opts.ffmpeg] ffmpeg 路径（可选，转格式用）
 * @param {Function} [opts.log]
 * @returns {Promise<{ok:boolean, buf?:Buffer, error?:string, chars?:number}>}
 */
export async function synthesize({ text, voice = DEFAULT_VOICE, config, log = () => {} }) {
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, error: '没有文字' };
  if (clean.length > MAX_CHARS) {
    return { ok: false, error: `文字太长（${clean.length} 字），上限 ${MAX_CHARS}` };
  }

  // 语音合成可以单独配 Key（有些人转写和合成用的不是同一个账号）
  const key = config?.voice?.ttsApiKey || config?.voice?.apiKey || '';
  if (!key) {
    return {
      ok: false,
      error: '没配语音合成 Key（控制台「模型与功能」→ 语音回复 里填，留空则用语音转写那把）',
    };
  }

  // baseUrl 可能是 compatible-mode，也可能带完整路径；统一取站点根
  let origin = 'https://dashscope.aliyuncs.com';
  try {
    const u = new URL(config?.voice?.baseUrl || origin);
    origin = u.origin;
  } catch {}

  const url = `${origin}/api/v1/services/aigc/multimodal-generation/generation`;
  const body = {
    model: config?.voice?.ttsModel || 'qwen3-tts-flash',
    input: {
      text: clean,
      voice: voice || config?.voice?.ttsVoice || DEFAULT_VOICE,
      language_type: 'Chinese',
    },
  };

  let j;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config?.voice?.timeoutMs || 60000),
    });
    j = await r.json();
    if (!r.ok || j?.code) {
      return { ok: false, error: j?.message || `HTTP ${r.status}` };
    }
  } catch (e) {
    return { ok: false, error: `请求失败：${e.message}` };
  }

  const audio = j?.output?.audio || {};
  const chars = j?.usage?.characters || clean.length;

  // 优先拿 base64（省一次下载），没有就下 url
  try {
    if (audio.data) {
      const buf = Buffer.from(audio.data, 'base64');
      if (buf.length) return { ok: true, buf, chars, format: 'wav' };
    }
    if (audio.url) {
      const r = await fetch(audio.url, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) return { ok: false, error: `下载音频失败 HTTP ${r.status}` };
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length) return { ok: true, buf, chars, format: 'wav' };
    }
  } catch (e) {
    return { ok: false, error: `取音频失败：${e.message}` };
  }

  return { ok: false, error: '接口没返回音频' };
}

/**
 * 把 wav 转成微信能当语音条发的格式（AMR-NB，8kHz 单声道）。
 *
 * 编码器名字注意：ffmpeg 里叫 libopencore_amrnb（不是 libamr_nb）——
 * 实测 Gyan 的 full 构建只有前者，写错名字会直接失败。
 * 两个都试一遍，都不行就原样返回 wav（当音频文件发，也能听）。
 *
 * @returns {Promise<{buf:Buffer, ext:string}>}
 */
export async function toVoiceFormat(buf, { ffmpeg = '', tmpDir = '', log = () => {} } = {}) {
  if (!ffmpeg) return { buf, ext: 'wav' };

  const { execFile } = await import('node:child_process');

  // 用调用方给的目录（通常是项目的 data/tmp）。
  // 不用 os.tmpdir()：在某些受限环境里 node 写系统临时目录会 EPERM。
  const base = tmpDir || path.join(process.cwd(), 'data', 'tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'yf-tts-'));

  try {
    const inFile = path.join(dir, 'in.wav');
    const outFile = path.join(dir, 'out.amr');
    fs.writeFileSync(inFile, buf);

    const ENCODERS = ['libopencore_amrnb', 'libamr_nb'];
    for (const enc of ENCODERS) {
      const ok = await new Promise((resolve) => {
        execFile(
          ffmpeg,
          ['-v', 'error', '-y', '-i', inFile, '-ar', '8000', '-ac', '1', '-c:a', enc, '-b:a', '12.2k', outFile],
          { timeout: 30000 },
          (err) => resolve(!err),
        );
      });
      if (ok && fs.existsSync(outFile)) {
        const out = fs.readFileSync(outFile);
        if (out.length > 100) return { buf: out, ext: 'amr' };
      }
    }

    log('转 amr 失败（ffmpeg 没有 amr 编码器），退回 wav');
    return { buf, ext: 'wav' };
  } catch (e) {
    log(`转格式异常：${e.message}`);
    return { buf, ext: 'wav' };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}
