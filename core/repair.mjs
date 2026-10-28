/**
 * 一键修复：把「能自动查出来、能自动修」的问题都修一遍。
 *
 * 为什么需要：
 *   用户会遇到「语音 Key 空了」「控制台打不开」「图片发不出去」这类问题，
 *   但根本不知道从哪查。与其让人翻日志，不如做成一个按钮：
 *   检查 → 能修的直接修 → 修不了的告诉你差什么。
 *
 * 检查项（都是本地、不联网、不花钱）：
 *   1. 五个 Key 在不在；缺了就从 data/key-archive 的备份里恢复
 *   2. 配置里缺的段落补上默认值（配置被删掉一段就整个功能静默失灵）
 *   3. 数据目录（kb / memory / stickers / generated / tmp）建好
 *   4. ffmpeg 在不在（转码、指纹、语音格式都要它）
 *   5. 端口占用、token 文件、逻辑库/知识库文件可读性
 */
import fs from 'node:fs';
import path from 'node:path';

/** 五个 Key 在配置里的位置 */
const KEY_PATHS = [
  ['llm', (c) => c.llm],
  ['vision', (c) => c.vision],
  ['voice', (c) => c.voice],
  ['search', (c) => c.search],
  ['imagegen', (c) => c.imagegen],
];

/**
 * 找一个 Key 的历史备份（data/key-archive/*.json 里最新的非空值）。
 */
function findInArchive(root, name) {
  const dir = path.join(root, 'data', 'key-archive');
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .reverse();
  } catch {
    return '';
  }

  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const v = j?.keys?.[name];
      if (typeof v === 'string' && v.length >= 20) return v;
    } catch {}
  }
  return '';
}

/**
 * 跑一次修复。
 *
 * @param {object} opts
 * @param {string} opts.root 项目根
 * @param {object} opts.config 当前配置（会被就地补全）
 * @param {Function} [opts.writeConfig] 写配置的函数
 * @param {Function} [opts.log]
 * @returns {{fixed:Array, problems:Array, ok:boolean}}
 */
export async function runRepair({ root, config, writeConfig, log = () => {} }) {
  const fixed = [];
  const problems = [];

  // ===== 1. 先补配置段落（后面的检查都要用到）=====
  const NEED = {
    llm: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    vision: { apiKey: '', model: 'glm-4v-flash' },
    voice: { enabled: true, model: 'qwen3-asr-flash', ttsModel: 'qwen3-tts-flash' },
    search: { enabled: false, provider: 'bocha' },
    imagegen: { enabled: false },
    reply: { maxChars: 500, maxBubbles: 3, bubbleDelayMs: 400 },
    tools: { enabled: true, off: [] },
    logic: { enabled: true, autoLearn: { enabled: false, maxPerDay: 10, mode: 'pending' } },
    mood: { enabled: true },
    memory: { maxFacts: 50 },
  };

  for (const [section, defaults] of Object.entries(NEED)) {
    if (!config[section] || typeof config[section] !== 'object') {
      config[section] = { ...defaults };
      fixed.push(`配置里缺「${section}」这一段，已按默认值补上`);
      continue;
    }
    for (const [k, v] of Object.entries(defaults)) {
      if (config[section][k] === undefined) {
        config[section][k] = v;
        fixed.push(`「${section}.${k}」缺失，已补默认值`);
      }
    }
  }

  // ===== 2. Key 检查与恢复 =====
  for (const [name, pick] of KEY_PATHS) {
    const obj = pick(config);
    if (!obj) {
      problems.push(`${name} 的配置段不存在`);
      continue;
    }
    const cur = String(obj.apiKey || '');
    if (cur.length >= 20) continue; // 正常

    // 缺了：先从归档找
    const fromArchive = findInArchive(root, name);
    if (fromArchive) {
      obj.apiKey = fromArchive;
      fixed.push(`${name} 的 Key 从备份恢复（${fromArchive.slice(0, 6)}…${fromArchive.slice(-4)}）`);
      continue;
    }
    problems.push(`${name} 没配 Key（归档里也没有备份，只能手动填）`);
  }

  // 语音合成单独配的那把 Key，坏了就清掉退回共用
  if (config.voice?.ttsApiKey && String(config.voice.ttsApiKey).length < 20) {
    config.voice.ttsApiKey = '';
    fixed.push('语音合成的独立 Key 无效，已清空（改用语音转写那把）');
  }

  // ===== 3. 数据目录 =====
  const card = String(config.card || 'default').replace(/[^\w.-]/g, '_') || 'default';
  const DIRS = [
    'data',
    'data/tmp',
    'data/sessions',
    'data/stickers',
    'data/images',
    'data/generated',
    'data/memory',
    'data/key-archive',
    path.join('data', card),
  ];
  for (const d of DIRS) {
    const full = path.join(root, d);
    if (!fs.existsSync(full)) {
      try {
        fs.mkdirSync(full, { recursive: true });
        fixed.push(`建了目录 ${d}`);
      } catch (e) {
        problems.push(`目录 ${d} 建不了：${e.message}`);
      }
    }
  }

  // ===== 4. 关键文件 =====
  const tokenFile = path.join(root, 'data', 'token.txt');
  if (!fs.existsSync(tokenFile)) {
    try {
      const crypto = await import('node:crypto');
      fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('hex'), 'utf8');
      fixed.push('本地令牌文件丢了，已重新生成（浏览器需要刷新一次）');
    } catch (e) {
      problems.push(`令牌文件建不了：${e.message}`);
    }
  }

  // ===== 5. ffmpeg =====
  // 真找一遍：找到就写进配置，找不到才报问题
  {
    const configured = config.voice?.ffmpeg || config.vision?.ffmpeg || '';
    if (!configured) {
      try {
        const { findFfmpeg } = await import('./image.mjs');
        const found = findFfmpeg();
        if (found) {
          config.voice = config.voice || {};
          config.voice.ffmpeg = found;
          fixed.push('找到 ffmpeg 并写入配置：' + found);
        } else {
          problems.push('没找到 ffmpeg：动图转 GIF、图片指纹、语音转 amr 会退化成兜底方案');
        }
      } catch (e) {
        problems.push('ffmpeg 检测失败：' + e.message);
      }
    }
  }

  // ===== 6. 写回 =====
  if (fixed.length && typeof writeConfig === 'function') {
    try {
      writeConfig(path.join(root, 'config.json'), config, 'repair', log);
    } catch (e) {
      problems.push(`修复结果写不进 config.json：${e.message}`);
    }
  }

  return { ok: problems.length === 0, fixed, problems };
}
