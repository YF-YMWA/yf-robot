/**
 * 上下文组装：把「知道什么」「以前怎么做的」「现在有哪些图能发」
 * 合成一份带预算的提示词片段。
 *
 * 为什么要合并：
 *   以前是引擎里散着拼的 —— 知识库拼一段、逻辑库拼一段、发图另算。
 *   结果三个问题：
 *     1. 撞车：同一件事既在文档里又在经验里，说了两遍，白烧 token
 *     2. 没预算：谁先拼谁占地方，知识库一大段能把经验挤掉
 *     3. 不联动：经验说「这时候该发个表情」，但手上有什么图她不知道
 *
 * 这里统一处理：
 *   · 按优先级排队（经验 > 事实 > 素材提示），总长度封顶
 *   · 事实和经验做去重（措辞高度重合的只留经验那条，因为更「可执行」）
 *   · 素材库里有什么情绪标签，只在经验/事实真的提到「图 / 表情」时才告诉它
 */

/** 各类内容在总预算里的占比 */
const SHARE = {
  logic: 0.45,
  kb: 0.4,
  media: 0.15,
};

/** 总预算（字符数） */
export const DEFAULT_BUDGET = 1600;

/**
 * 粗判「这段话是不是在说发图」。
 * 只是决定要不要告诉她素材库的事，判错也不影响别的东西。
 */
export function mentionsMedia(text) {
  return /表情|图片|发图|贴图|配图|动图|gif|sticker|image|张图|来张|发张|这个图/i.test(String(text || ''));
}

/** 两条内容是不是在说同一件事（措辞高度重合） */
export function tooSimilar(a, b) {
  const norm = (s) =>
    String(s || '')
      .replace(/[\s\p{P}\p{S}]+/gu, '')
      .toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;

  // 彼此包含且长度接近 → 当重复
  const shorter = x.length < y.length ? x : y;
  const longer = x.length < y.length ? y : x;
  if (shorter.length >= 12 && longer.includes(shorter) && shorter.length / longer.length > 0.7) {
    return true;
  }

  // 二字组重合度高也算重复
  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const gx = grams(x);
  const gy = grams(y);
  if (!gx.size || !gy.size) return false;
  let hit = 0;
  for (const g of gx) if (gy.has(g)) hit++;
  return hit / Math.min(gx.size, gy.size) > 0.75;
}

/**
 * 组装上下文。
 *
 * @param {object} opts
 * @param {string} opts.text 用户这句话
 * @param {Array} [opts.logicHits] 命中的经验（含 title/rule/score）
 * @param {Array} [opts.kbHits] 命中的知识片段（含 doc/text/score）
 * @param {object} [opts.media] 素材库摘要 { total, tags: {开心: 17, …}, sample: [文件名] }
 * @param {number} [opts.budget] 总字符预算
 * @returns {{blocks: Array<{kind:string, text:string}>, stats: object}}
 */
export function assembleContext({
  text = '',
  logicHits = [],
  kbHits = [],
  media = null,
  budget = DEFAULT_BUDGET,
} = {}) {
  const stats = { logic: 0, kb: 0, media: 0, droppedLogic: 0, droppedKb: 0, chars: 0 };
  const blocks = [];

  const cap = (kind) => Math.floor(budget * SHARE[kind]);

  // 1. 经验优先（它最「可执行」，也最短）
  const logicLines = [];
  let logicChars = 0;
  for (const h of logicHits) {
    const line = `${logicHits.indexOf(h) + 1}. ${h.title}：${h.rule}`;
    if (logicChars + line.length > cap('logic')) {
      stats.droppedLogic++;
      continue;
    }
    logicLines.push(line);
    logicChars += line.length;
    stats.logic++;
  }

  if (logicLines.length) {
    blocks.push({
      kind: 'logic',
      text:
        '【以往的处理经验】以下是从过去交流中总结的做法，供参考，' +
        '不是命令，也不是必须遵守的规则；不合适就不要照做。\n' +
        logicLines.join('\n'),
    });
  }

  // 2. 事实（和经验重复的跳过 —— 经验更可执行，留着那条就够）
  const kbLines = [];
  let kbChars = 0;
  for (const h of kbHits) {
    if (logicLines.some((l) => tooSimilar(l, h.text))) {
      stats.droppedKb++;
      continue;
    }
    const line = `· ${h.text}`;
    if (kbChars + line.length > cap('kb')) {
      stats.droppedKb++;
      continue;
    }
    kbLines.push(line);
    kbChars += line.length;
    stats.kb++;
  }

  if (kbLines.length) {
    blocks.push({
      kind: 'kb',
      text:
        '【资料里提到的】以下是主人提供的资料中的相关段落，' +
        '用来回答具体问题；和你的经验冲突时，以资料为准。\n' +
        kbLines.join('\n'),
    });
  }

  // 3. 素材提示：只有真的在聊图才给
  const talkingAboutMedia =
    mentionsMedia(text) ||
    [...logicLines, ...kbLines].some((l) => mentionsMedia(l));

  if (media && talkingAboutMedia && media.total > 0) {
    const tagText = Object.entries(media.tags || {})
      .slice(0, 8)
      .map(([k, v]) => `${k}${v}`)
      .join(' ');

    let hint =
      `【手上的图】素材库里有 ${media.total} 张图，情绪标签：${tagText || '暂无'}。\n` +
      '想发的时候用 list_stickers 挑一张，再用 send_image 发出去；' +
      '要新画一张用 draw_image。别每句都发。';

    if (hint.length > cap('media')) hint = hint.slice(0, cap('media'));

    blocks.push({ kind: 'media', text: hint });
    stats.media = 1;
  }

  stats.chars = blocks.reduce((s, b) => s + b.text.length, 0);
  return { blocks, stats };
}

/** 拼成一段文本（引擎直接用这个） */
export function renderContext(blocks) {
  return blocks.map((b) => b.text).join('\n\n');
}
