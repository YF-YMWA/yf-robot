/**
 * 语音回复：念哪一段、要不要念。
 *
 * 以前是适配器掷骰子决定的，而且把**整段原文**拿去合成 ——
 * 包括「（尾巴拍了拍）」这种动作描写、emoji、甚至代码块。
 * 念出来就是灾难：四十秒里一半是「括号」和「星号」。
 *
 * 现在决策放在核心（适配器只负责发），规则：
 *   · 清洗：去掉动作描写、emoji、markdown、代码、URL
 *   · 太长不念：超过阈值就不发语音（真人也不会把一段长文念给你听）
 *   · 太短不念：一两个字没必要单独录一条
 *   · 内容不合适不念：代码、报错、链接、表格
 */

/** 超过这个字数就不发语音（念出来太久） */
export const MAX_SPEECH_CHARS = 80;
/** 少于这个字数不发（「在。」没必要单独录） */
export const MIN_SPEECH_CHARS = 4;

/**
 * 把回复文本清洗成「适合念出来」的样子。
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanForSpeech(text) {
  let s = String(text || '');

  // 代码块整段丢掉（念代码毫无意义）
  s = s.replace(/```[\s\S]*?```/g, ' ');
  // 行内代码
  s = s.replace(/`[^`\n]{1,80}`/g, ' ');
  // URL
  s = s.replace(/https?:\/\/\S+/g, ' ');

  // 括号里的动作/神态描写（中英文括号都算）
  s = s.replace(/（[^）]{0,60}）/g, ' ');
  s = s.replace(/\([^)]{0,60}\)/g, ' ');

  // Markdown 记号
  s = s.replace(/[*_~#>|]+/g, ' ');

  // emoji / 颜文字（颜文字里有重复符号，单独处理）
  s = s.replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu,
    ' ',
  );
  s = s.replace(/[≧≦╯╰▽ω´｀・‿◕ᴗ∀]+\S*/g, ' ');

  // 压缩空白
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*([，。！？、；：])\s*/g, '$1')
    .trim();
}

/**
 * 这段内容值不值得发语音。
 *
 * @param {string} text 原始回复（会是多条气泡拼起来的）
 * @returns {{ok:boolean, reason?:string, text?:string, chars?:number}}
 */
export function speechCandidate(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { ok: false, reason: '空内容' };

  const clean = cleanForSpeech(raw);
  const chars = [...clean].length;

  if (chars < MIN_SPEECH_CHARS) {
    return { ok: false, reason: `念出来只剩 ${chars} 字，太短` };
  }
  if (chars > MAX_SPEECH_CHARS) {
    return { ok: false, reason: `太长（${chars} 字 > ${MAX_SPEECH_CHARS}）` };
  }

  // 清洗完剩下的大多是代码/英文符号 → 不值得念
  const cjk = (clean.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjk < chars * 0.3) {
    return { ok: false, reason: '中文占比太低（多半是代码或链接）' };
  }

  return { ok: true, text: clean, chars };
}

/**
 * 决定这一轮要不要补发语音。
 *
 * @param {object} opts
 * @param {string} opts.text 回复正文
 * @param {number} [opts.chance] 概率（0~1）
 * @param {boolean} [opts.enabled] 总开关
 * @param {(n:number)=>number} [opts.rand] 随机源（测试用）
 * @returns {{speak:boolean, text?:string, reason?:string}}
 */
export function decideVoiceReply({ text, chance = 0, enabled = true, rand = Math.random } = {}) {
  if (!enabled) return { speak: false, reason: '语音回复没开' };
  if (!(chance > 0)) return { speak: false, reason: '概率是 0' };

  const cand = speechCandidate(text);
  if (!cand.ok) return { speak: false, reason: cand.reason };

  if (rand() >= chance) return { speak: false, reason: '这次没命中概率' };

  return { speak: true, text: cand.text, chars: cand.chars };
}
