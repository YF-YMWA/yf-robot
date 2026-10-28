/**
 * HTML → 纯文本（唯一实现）。
 *
 * 以前有过三份：
 *   · core/kb.mjs        简单版，够用但不去导航页脚
 *   · core/learning.mjs  处理最细（去 script/style/nav/header/footer，
 *                        先解实体再剥标签，防双层转义，压缩空白）
 *   · core/safe-fetch.mjs 简单版
 * 三份行为略有差别，同一段 HTML 出来的文本不一样，调试时很难对上。
 *
 * 现在统一用 learning 这份最细的，其他模块都从这里引。
 */

/** HTML 实体解码（只处理常见的，够用）。 */
export function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * 把 HTML 变成可读文本。
 *
 * 几个关键点：
 *   1. 先解码实体再剥标签 —— 反过来会把 &lt;style&gt; 变成真标签，
 *      CSS 就混进正文了（百度首页实测）
 *   2. 整块丢掉 script/style/nav/header/footer/aside，这些是噪声
 *   3. 解码后可能又冒出标签（双层转义），再剥一次
 */
export function htmlToPlainText(html) {
  let s = String(html || '');

  const stripBlocks = (t) =>
    t
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header\b[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<aside\b[\s\S]*?<\/aside>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');

  s = decodeEntities(s);
  s = stripBlocks(s);

  // 换行标签先变真换行
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n');

  // 剥掉剩下的标签
  s = s.replace(/<[^>]+>/g, ' ');

  // 解码一遍残留实体（&nbsp; 之类）
  s = decodeEntities(s);

  // 解码后可能又冒出标签（双层转义），再剥一次并清掉残块
  s = stripBlocks(s);
  s = s.replace(/<[^>]+>/g, ' ');

  // 压缩空白：行内多空格变一个，多空行变一个
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  return s.trim();
}
