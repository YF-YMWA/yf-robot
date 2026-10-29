/**
 * 回复整形层：把模型输出变成适合聊天的多气泡文本。
 *
 * 职责单一：
 *   - 去掉 Markdown 标记（微信等渠道不渲染）
 *   - 按语义切成多个短气泡
 *   - 清理首尾空白和多余标点
 */

/**
 * 移除 Markdown 标记，保留可读内容。
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdown(text) {
  if (!text) return '';
  let t = text;

  // 代码块：保留内容，去掉围栏和语言标记
  t = t.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => body.trim());
  // 行内代码
  t = t.replace(/`([^`]+)`/g, '$1');
  // 粗体、斜体
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '$1');
  // 删除线
  t = t.replace(/~~([^~]+)~~/g, '$1');
  // 标题
  t = t.replace(/^#{1,6}\s*/gm, '');
  // 引用
  t = t.replace(/^>\s?/gm, '');
  // 链接
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  // 分隔线
  t = t.replace(/^\s*([-*_])\s*\1\s*\1[\s\1]*$/gm, '');
  // 列表符号统一去掉（聊天里不需要）
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+[.)]\s+/gm, '');
  // 表格分隔行
  t = t.replace(/^\s*\|?[\s:-]{5,}\|?\s*$/gm, '');
  // 表格竖线变空格
  t = t.replace(/\s*\|\s*/g, ' ');

  // 压缩空行
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/**
 * 把一段回复切成多个气泡。
 *
 * 策略：优先按空行分段，其次按句末标点，最后按长度硬切。
 * 每个气泡控制在 maxChars 以内，总数不超过 maxBubbles。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.maxChars]
 * @param {number} [opts.maxBubbles]
 * @returns {string[]}
 */
export function toBubbles(text, opts = {}) {
  const maxChars = opts.maxChars || 300;
  const maxBubbles = opts.maxBubbles || 3;
  const clean = (text || '').trim();
  if (!clean) return [];

  // 先按空行分段
  let parts = clean
    .split(/\n{2,}/)
    .map((s) => s.replace(/\n+/g, ' ').trim())
    .filter(Boolean);

  // 段落太少或太长时，按句子拆。优先句末标点，其次逗号类停顿
  if (parts.length < 2) {
    let bySentence = clean
      .split(/(?<=[。！？!?…~～])\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    // 如果按句末标点拆不开，退到逗号级切分
    if (bySentence.length < 2) {
      bySentence = clean
        .split(/(?<=[，,；;、])\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (bySentence.length > 1) parts = bySentence;
  }

  // 先把超长段落切开，再考虑合并，避免合并后重新超限
  const splitLong = [];
  for (const p of parts) {
    if (p.length <= maxChars) {
      splitLong.push(p);
      continue;
    }
    // 超长段落：先试句末标点，再退到逗号，最后硬切
    let pieces = p
      .split(/(?<=[。！？!?…])\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (pieces.length < 2) {
      pieces = p
        .split(/(?<=[，,；;、])\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    let buf = '';
    for (const s of pieces) {
      if (buf.length + s.length > maxChars && buf) {
        splitLong.push(buf.trim());
        buf = s;
      } else {
        buf += s;
      }
    }
    if (buf.trim()) splitLong.push(buf.trim());
  }
  parts = splitLong.length ? splitLong : parts;

  // 合并到不超过 maxBubbles 个，但保证合并后的长度不超限
  while (parts.length > maxBubbles) {
    let bestIdx = -1;
    let bestLen = Infinity;
    for (let i = 0; i < parts.length - 1; i++) {
      const len = parts[i].length + parts[i + 1].length;
      // 只在合并后仍不超限时考虑
      if (len <= maxChars && len < bestLen) {
        bestLen = len;
        bestIdx = i;
      }
    }
    // 找不到可安全合并的对，说明数量确实压不下去，停止合并
    if (bestIdx < 0) break;
    parts.splice(bestIdx, 2, parts[bestIdx] + parts[bestIdx + 1]);
  }

  return parts.filter(Boolean);
}

/**
 * 完整整形流程：去 Markdown → 切气泡 → 清理。
 * @param {string} raw
 * @param {object} cfg reply 配置段
 * @returns {string[]}
 */
export function shapeReply(raw, cfg) {
  let text = raw || '';
  if (cfg.stripMarkdown !== false) text = stripMarkdown(text);

  const bubbles = toBubbles(text, {
    maxChars: cfg.maxChars,
    maxBubbles: cfg.maxBubbles,
  });

  return bubbles
    .map((b) =>
      b
        // 去掉回复开头的「名字：」
        .replace(/^[\u4e00-\u9fa5A-Za-z]{1,8}[：:]\s*/, '')
        .replace(/\s+/g, ' ')
        /**
         * 去掉句尾残留的逗号/顿号/分号。
         *
         * 分句时如果退到了「按逗号切」，逗号会留在前半句末尾，
         * 于是每条消息都以「，」结尾 —— 用户看到的就是
         * 「她说话结尾总是逗号，不是句号」。
         * 中文聊天里句子常常不带句号，但以逗号收尾绝对不对。
         */
        .replace(/[，,；;、]+$/, '')
        .trim(),
    )
    .filter(Boolean);
}

/**
 * 判断回复是否需要重写（空、只剩标点、纯 Markdown 残渣）。
 * @param {string} text
 */
export function needsRewrite(text) {
  if (!text) return true;
  const visible = text.replace(/[\s\p{P}\p{S}]/gu, '');
  return visible.length === 0;
}
