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
  logic: 0.3,
  kb: 0.28,
  media: 0.1,
  style: 0.32,
};

/**
 * 判断这句话什么语气，决定词库要拼哪几类。
 *
 * 词库全拼约 1900 字（≈1150 token），每轮都发太贵，
 * 而大多数时候其实只用得上一类：
 *   · 被骂/挑衅 → 回怼库
 *   · 闲聊/开玩笑 → 网络用语
 *   · 正经求助 → 只给缩写对照（帮着看懂对方在说什么）
 */
export function detectTone(text) {
  const t = String(text || '');

  const hostile =
    /(傻逼|智障|脑残|滚|去死|废物|垃圾|狗东西|你妈的|操你|闭嘴|有你这种|你算老几|不服来|阴阳怪气)/.test(
      t,
    );
  if (hostile) return 'hostile';

  const casual = /(哈哈|嘿嘿|嘻嘻|笑死|绝了|梗|绷不住|离谱|无语|乐)/.test(t);
  if (casual) return 'casual';

  const serious = /(帮我|怎么|为什么|如何|请问|能不能|该不该|合同|工资|生病|医院|报错|错误|代码)/.test(
    t,
  );
  if (serious) return 'serious';

  // 默认当闲聊：宁可给点风格，也别让她说话太干
  return 'casual';
}

/** 按语气决定拼哪几类词库 */
export function banksForTone(tone) {
  if (tone === 'hostile') return ['clapback'];
  if (tone === 'serious') return ['abbrev'];
  return ['slang', 'abbrev'];
}

/** 总预算（字符数） */
export const DEFAULT_BUDGET = 1600;

/**
 * 粗判「这段话是不是在说发图」。
 * 只是决定要不要告诉她素材库的事，判错也不影响别的东西。
 */
export function mentionsMedia(text) {
  return /表情|图片|发图|贴图|配图|动图|gif|sticker|image|张图|来张|发张|这个图/i.test(String(text || ''));
}

/**
 * 按长度截断，但尽量切在分隔符上。
 *
 * 词库是一串「词、词、词」，硬切会把最后那个词砍成半截
 * （「破防了」变「破防」），模型可能把半截词当新词用。
 */
export function clipAtBoundary(text, limit) {
  if (!text || text.length <= limit) return text || '';
  const head = text.slice(0, limit);
  // 从后往前找最近的天然断点
  const cut = Math.max(
    head.lastIndexOf('、'),
    head.lastIndexOf('，'),
    head.lastIndexOf('。'),
    head.lastIndexOf('；'),
    head.lastIndexOf('\n'),
  );
  // 断点太靠前（只剩不到一半）就还是硬切，免得丢太多
  if (cut > limit * 0.5) return head.slice(0, cut + 1) + '…';
  return head + '…';
}

/** 两条内容是不是在说同一件事（措辞高度重合） */export function tooSimilar(a, b) {
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
  recentMedia = null,
  styleText = '',
  budget = DEFAULT_BUDGET,
} = {}) {
  const stats = { logic: 0, kb: 0, media: 0, style: 0, droppedLogic: 0, droppedKb: 0, chars: 0 };
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
  //
  // 刚收过图也算「在聊图」：用户发来一个表情包，紧接着说「发回给我看看」
  // 「再发一次」—— 这几句里没有「图」字，按关键词判断会漏掉，
  // 于是素材块整块不出现，她只能瞎猜。
  const talkingAboutMedia =
    mentionsMedia(text) ||
    Boolean(recentMedia) ||
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

    /**
     * 刚收进来的那张，把文件名点出来 —— 但**只在对方明确要「刚才那张」时**。
     *
     * 真实事故：这句提示写得太强，导致「发张图给我看看」「发张动图」时
     * 她也只发刚收的那张，连着三次都是同一张（20:51→20:54 的聊天记录）。
     * 所以这里收窄成「要回原图」才提，泛泛要图让她自己挑。
     */
    const askBack = /(刚才那[张个]|刚收的|发回来|发回给|再发一次|同一张|原图)/.test(text);
    if (recentMedia && recentMedia.name && askBack) {
      hint +=
        `\n【刚收到的素材】对方刚发来一张，已存成 ${recentMedia.name}。` +
        `她这次是要「刚才那张」，用 send_image(name="${recentMedia.name}")。`;
    }

    if (hint.length > cap('media')) hint = hint.slice(0, cap('media'));

    blocks.push({ kind: 'media', text: hint });
    stats.media = 1;
  }

  // 4. 说话风格（词库）：最后拼，占固定份额
  if (styleText) {
    blocks.push({ kind: 'style', text: clipAtBoundary(styleText, cap('style')) });
    stats.style = 1;
  }

  stats.chars = blocks.reduce((s, b) => s + b.text.length, 0);
  return { blocks, stats };
}

/** 拼成一段文本（引擎直接用这个） */
export function renderContext(blocks) {
  return blocks.map((b) => b.text).join('\n\n');
}
