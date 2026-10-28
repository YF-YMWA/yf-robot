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
  做: '作',
  作: '做',
  因: '应',
  应: '因',
  象: '像',
  像: '象',
  餐: '参',
  饭: '反',
  睡: '谁',
  说: '税',
  好: '号',
  来: '莱',
  去: '取',
  看: '砍',
  吃: '池',
  要: '药',
  没: '梅',
  有: '友',
  是: '事',
  不: '布',
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
