/**
 * 词库加载与拼接。
 *
 * 三类词库各有用途：
 *   slang    网络用语/梗 —— 自然穿插进对话
 *   clapback 回怼库 —— 被骂时用
 *   abbrev   缩写对照 —— 帮模型理解对方在说什么
 *
 * 只有启用的词库才会被拼进提示词。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 词库默认配置：全部启用。 */
export const DEFAULT_BANKS = {
  slang: { enabled: true, label: '网络用语', maxEntries: 60 },
  clapback: { enabled: true, label: '回怼库', maxEntries: 40 },
  abbrev: { enabled: true, label: '缩写对照', maxEntries: 30 },
};

/**
 * 解析词库文件。
 *
 * 格式：`词条｜解释` 或 `缩写|全称|回法`
 * # 开头是注释/分类标题。
 *
 * @returns {Array<{word:string, explain:string, section:string}>}
 */
export function parseBank(content) {
  const out = [];
  let section = '';

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    // 分类标题（## 抽象 / 情绪 / 反应）
    if (line.startsWith('#')) {
      const t = line.replace(/^#+\s*/, '').trim();
      if (t) section = t;
      continue;
    }

    // 全角竖线优先，其次半角
    const sep = line.includes('｜') ? '｜' : '|';
    const parts = line.split(sep).map((s) => s.trim());
    if (parts.length < 2) continue;

    const word = parts[0];
    const explain = parts.slice(1).filter(Boolean).join(' / ');

    if (!word || word.length > 30) continue;
    out.push({ word, explain: explain.slice(0, 80), section });
  }

  return out;
}

/**
 * 读某个词库（带缓存，文件没变就不重读）。
 */
const cache = new Map();

export function loadBank(dir, name) {
  const file = path.join(dir, name + '.txt');
  try {
    const stat = fs.statSync(file);
    const key = `${file}:${stat.mtimeMs}:${stat.size}`;

    if (cache.has(key)) return cache.get(key);

    const content = fs.readFileSync(file, 'utf8');
    const entries = parseBank(content);

    // 只留最近 3 个缓存，避免无限增长
    if (cache.size > 3) cache.clear();
    cache.set(key, entries);

    return entries;
  } catch {
    return [];
  }
}

/**
 * 拼词库到系统提示词。
 *
 * @param {object} opts
 * @param {string} opts.dir 词库目录
 * @param {object} [opts.banks] 词库启用配置
 * @returns {string} 拼好的提示词片段（没有启用任何词库时返回空串）
 */
export function renderWordBanks({ dir, banks = {} }) {
  const cfg = { ...DEFAULT_BANKS, ...banks };
  const parts = [];

  // 网络用语
  if (cfg.slang?.enabled !== false) {
    const list = loadBank(dir, 'slang');
    if (list.length) {
      const max = cfg.slang.maxEntries || 60;
      // 随机抽，避免每次都一样的词
      const picked = shuffle(list).slice(0, max);
      const text = picked.map((e) => (e.explain ? `${e.word}（${e.explain}）` : e.word)).join('、');
      parts.push(
        '【网络用语参考】\n' +
          '什么时候用：对方在开玩笑、吐槽、发牢骚、闲聊八卦、语气轻松时，' +
          '挑 1~2 个自然地嵌进话里 —— 是「真的说出来」，不是只在心里想。\n' +
          '什么时候不用：对方在说正经事、难过、求助、吵架时，一个都别用。\n' +
          `可用的词：${text}`,
      );
    }
  }

  // 回怼库
  if (cfg.clapback?.enabled !== false) {
    const list = loadBank(dir, 'clapback');
    if (list.length) {
      const max = cfg.clapback.maxEntries || 40;
      // 按类别分组，取一部分
      const bySection = new Map();
      for (const e of list) {
        const s = e.section || '通用';
        if (!bySection.has(s)) bySection.set(s, []);
        bySection.get(s).push(e.explain || e.word);
      }

      const chunks = [];
      for (const [section, lines] of bySection) {
        const take = Math.max(2, Math.floor(max / bySection.size));
        chunks.push(`${section}：${shuffle(lines).slice(0, take).join('；')}`);
      }

      if (chunks.length) {
        parts.push(
          `【被骂时的回怼参考】对方骂你/挑衅时才用，平时别用。\n${chunks.join('\n')}`,
        );
      }
    }
  }

  // 缩写对照
  if (cfg.abbrev?.enabled !== false) {
    const list = loadBank(dir, 'abbrev');
    if (list.length) {
      const max = cfg.abbrev.maxEntries || 30;
      const text = list
        .slice(0, max)
        .map((e) => `${e.word}=${e.explain}`)
        .join('、');
      parts.push(`【常见缩写】（帮你看懂对方在说什么，不用主动用）\n${text}`);
    }
  }

  return parts.join('\n\n');
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 清缓存（词库被编辑后调用）。 */
export function clearCache() {
  cache.clear();
}
