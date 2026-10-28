/**
 * 拟人化后处理：偶尔「手滑打错字，然后改口」。
 *
 * 为什么这个有用：
 *   真人发消息几乎不可能零错字。每条都干干净净、语法完美，
 *   反而是最强的不真实信号 —— 比说话内容更容易让人察觉「这是机器」。
 *
 * 做法：
 *   以一定概率挑一条气泡，把其中一个常用的字换成同音/形近的错字，
 *   然后紧接着发一条更正（「…是 XX」）。
 *   概率很低（默认 4%），而且只在消息够长时才做，避免每条都错。
 *
 * 风险控制：
 *   · 不在第一句上动手（第一印象别搞砸）
 *   · 不动数字、英文、标点、括号里的动作描写
 *   · 只换白名单里的常见混淆字，不知道换什么就不换
 */

/** 形近/同音混淆对（只收常见、不会造成误会的） */
const CONFUSIONS = {
  在: '再',
  再: '在',
  的: '得',
  得: '的',
  已: '以',
  以: '已',
  他: '她',
  她: '他',
  那: '哪',
  哪: '那',
  做: '作',
  作: '做',
  象: '像',
  像: '象',
};

/** 哪些位置不碰（数字/英文/标点/括号内） */
const SAFE_CHAR = /[\u4e00-\u9fff]/;

/**
 * 给一条气泡制造一个错字。
 * @returns {{wrong:string, right:string}|null} 换好之后的两段文字
 */
export function makeTypo(bubble) {
  const text = String(bubble || '');
  if (text.length < 6) return null; // 太短，改起来太假

  // 跳过括号里的动作描写（（挪了挪）这种不该有错字）
  const candidates = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '（' || ch === '(') {
      depth++;
      continue;
    }
    if (ch === '）' || ch === ')') {
      depth--;
      continue;
    }
    if (depth > 0) continue;
    if (!SAFE_CHAR.test(ch)) continue;
    if (!CONFUSIONS[ch]) continue;
    candidates.push(i);
  }

  if (!candidates.length) return null;

  // 随机挑一个位置
  const at = candidates[Math.floor(Math.random() * candidates.length)];
  const right = text[at];
  const wrong = CONFUSIONS[right];

  return {
    wrong: text.slice(0, at) + wrong + text.slice(at + 1),
    right,
    // 更正的说法，几种换着用
    fixes: [`不对，是${right}`, `打错了，${right}`, `……是${right}`, `${right}，我说的是${right}`],
  };
}

/**
 * 按概率给一组气泡加上「手滑 + 改口」。
 *
 * @param {string[]} bubbles
 * @param {object} cfg { chance, maxPerReply }
 * @returns {string[]} 处理后的气泡（可能多出一条更正）
 */
export function addTypoSlip(bubbles, cfg = {}) {
  const chance = Number.isFinite(cfg.chance) ? cfg.chance : 0.04;
  if (!Array.isArray(bubbles) || bubbles.length === 0) return bubbles;
  if (chance <= 0) return bubbles;
  if (Math.random() >= chance) return bubbles;

  // 只在后几条上动手，第一句保持干净
  const indexes = bubbles.map((_, i) => i).filter((i) => i > 0 || bubbles.length === 1);
  if (!indexes.length) return bubbles;

  const pick = indexes[Math.floor(Math.random() * indexes.length)];
  const slip = makeTypo(bubbles[pick]);
  if (!slip) return bubbles;

  const fix = slip.fixes[Math.floor(Math.random() * slip.fixes.length)];
  const out = [...bubbles];
  out[pick] = slip.wrong;
  out.splice(pick + 1, 0, fix);
  return out;
}

/**
 * 标点自然化：把「太像书面语」的句尾处理掉。
 *
 * 实测她 77% 的气泡以句号结尾 —— 这是最像机器的地方。
 * 中文微信聊天里，句号通常只在强调、生气或者长句里出现，
 * 平常一句话说完就直接发，什么都不加。
 *
 * 规则（都带概率，不然又会变成另一种规律）：
 *   · 短句（<18 字）结尾的「。」→ 删掉
 *   · 长句结尾的「。」→ 一半概率保留（书面感），一半删
 *   · 问号、感叹号、省略号不动（这些是情绪，人也会用）
 *   · 不止一句的不动（句号在句中是有意义的）
 *
 * @param {string[]} bubbles
 * @param {object} [cfg] { chance }
 * @returns {string[]}
 */
export function naturalizePunctuation(bubbles, cfg = {}) {
  const chance = Number.isFinite(cfg.chance) ? cfg.chance : 0.75;
  if (!Array.isArray(bubbles) || !bubbles.length) return bubbles;

  return bubbles.map((raw) => {
    const text = String(raw || '');
    if (!text.endsWith('。')) return text;

    // 只处理「最后一句就是结尾」的情况：句中还有句号说明是长段落，保留
    const inner = text.slice(0, -1);
    if (inner.includes('。')) return text;

    // 太长的不动（长段落带句号反而正常）
    if (text.length > 40) return text;

    if (Math.random() >= chance) return text;
    return inner;
  });
}

/**
 * 偶尔只回一小段。
 *
 * 真人有时候就回一句，不会每轮都发两三条。
 * 概率触发时只保留第一条（前提是第一条本身够完整）。
 *
 * @param {string[]} bubbles
 * @param {object} [cfg] { chance }
 */
export function sometimesTerse(bubbles, cfg = {}) {
  const chance = Number.isFinite(cfg.chance) ? cfg.chance : 0.15;
  if (!Array.isArray(bubbles) || bubbles.length <= 1) return bubbles;
  if (Math.random() >= chance) return bubbles;

  const first = String(bubbles[0] || '');
  // 第一条太短（一两个字）就再带上第二条，否则只发这一条太空
  if (first.replace(/[^\u4e00-\u9fff]/g, '').length < 4) return bubbles.slice(0, 2);
  return [bubbles[0]];
}
