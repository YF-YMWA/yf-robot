/**
 * 表情能力：让回复带上 emoji 和颜文字。
 *
 * 微信不支持发标准表情包（需要 CDN 上传+加密），
 * 但 emoji 和颜文字是纯文本，效果一样自然。
 *
 * 设计原则：默认保守，只在语气合适时才加，不要每句都带。
 */

/** 常用 emoji，按情绪分类。 */
const EMOJI = {
  happy: ['😊', '🙂', '😄', '😆', '😊', '😋'],
  shy: ['😳', '🙈', '😌', '☺️'],
  sad: ['😔', '🥺', '😞', '😢'],
  tired: ['😮‍💨', '😪', '🥱', '😑'],
  angry: ['😤', '😠', '🙄', '😾'],
  think: ['🤔', '🧐', '😶'],
  cute: ['🥰', '😽', '💕', '🌸'],
  surprise: ['😯', '😲', '😮'],
};

/** 颜文字，比 emoji 更有"老网友"感。 */
const KAOMOJI = [
  '(・ω・)', '(´･ω･`)', '(๑•̀ㅂ•́)و', '(=_=)', '(￣▽￣)',
  '(；一_一)', '(◕‿◕)', '(｡･ω･｡)', '(っ˘ω˘ς)', '(*/ω＼*)',
  '(๑´ㅂ`๑)', '(・_・;)', '(´-ω-`)', '(￣ω￣)', 'ヾ(•ω•`)o',
];

/** 情绪关键词 → 分类。 */
const MOOD_PATTERNS = [
  { mood: 'tired', re: /(累|困|疲惫|没力气|加班|好晚|睡觉)/ },
  { mood: 'sad', re: /(难过|伤心|哭|失望|委屈|想哭|emo)/ },
  { mood: 'happy', re: /(开心|高兴|哈哈|太好了|棒|不错|喜欢)/ },
  { mood: 'angry', re: /(生气|烦|讨厌|气死|无语|过分)/ },
  { mood: 'surprise', re: /(真的吗|竟然|居然|没想到|吃惊)/ },
  { mood: 'cute', re: /(可爱|喜欢|想你|抱抱|亲亲)/ },
];

/**
 * 从文本推测情绪。
 * @param {string} text
 * @returns {string} 情绪分类，无法判断返回 ''
 */
export function detectMood(text) {
  if (!text) return '';
  for (const { mood, re } of MOOD_PATTERNS) {
    if (re.test(text)) return mood;
  }
  return '';
}

/**
 * 给一条回复加上表情。
 *
 * 规则（保守）：
 *   - 只在回复末尾加，不插在句中
 *   - 已有表情就跳过
 *   - 问句不加（会影响语气）
 *   - 太长的回复不加（会显得刻意）
 *   - **检测不到情绪时不加**（平淡的话加表情反而怪）
 *
 * @param {string} text 回复文本
 * @param {object} [opts]
 * @param {string} [opts.mood] 情绪，不传则从文本推测
 * @param {number} [opts.chance] 添加概率，默认 0.35
 * @param {boolean} [opts.useKaomoji] 是否允许颜文字，默认 true
 * @returns {string}
 */
export function decorate(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) return t;

  const chance = opts.chance ?? 0.35;
  const useKaomoji = opts.useKaomoji !== false;

  // 已经带 emoji 就不加
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t)) return t;
  // 结尾是颜文字（含日文假名或颜字符）就跳过；
  // 中文动作描述如「（尾巴拍了拍）」不算表情，可以继续加
  const tailKaomoji = /[（(]([^)）]{1,14})[)）]\s*$/.exec(t);
  if (tailKaomoji && /[ぁ-んァ-ヶω・∀≧≦◕◡ᴗ∇＿▽°´｀]/.test(tailKaomoji[1])) return t;
  // 问句不加
  if (/[？?]\s*$/.test(t)) return t;
  // 太长不加
  if (t.length > 60) return t;

  // 概率控制
  if (Math.random() > chance) return t;

  const mood = opts.mood || detectMood(t);

  // 有明确情绪：加对应 emoji
  if (mood && EMOJI[mood]) {
    const list = EMOJI[mood];
    return t + list[Math.floor(Math.random() * list.length)];
  }

  // 无情绪：只有显式开启时加颜文字，且概率减半
  if (useKaomoji && opts.allowNeutral) {
    if (Math.random() > 0.5) return t;
    return t + ' ' + KAOMOJI[Math.floor(Math.random() * KAOMOJI.length)];
  }

  return t;
}

/**
 * 给一组气泡加表情（只加最后一个）。
 * @param {string[]} bubbles
 * @param {object} [opts]
 * @param {string} [opts.mood] 情绪（优先用这个，否则从文本推测）
 * @returns {string[]}
 */
export function decorateBubbles(bubbles, opts = {}) {
  if (!Array.isArray(bubbles) || bubbles.length === 0) return bubbles;
  const out = [...bubbles];
  const last = out.length - 1;
  out[last] = decorate(out[last], opts);
  return out;
}

/** 表情池大小，供测试与统计。 */
export function emojiStats() {
  return {
    categories: Object.keys(EMOJI).length,
    emojis: Object.values(EMOJI).reduce((n, list) => n + list.length, 0),
    kaomoji: KAOMOJI.length,
  };
}
