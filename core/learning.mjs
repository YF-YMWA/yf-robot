/**
 * 词库学习：联网搜集网络用语，自动扩充词库。
 *
 * 分两步：
 *   1. 搜索「2026 最新网络用语 / 梗」这类页面
 *   2. 让模型从搜索结果里提炼出「词条｜解释」格式
 *
 * 安全约束：
 *   - 必须手动开启（learning.enabled）
 *   - 单次最多学多少条有限制
 *   - 学到的词先入库（data/learned-words.json），用户可以在控制台审阅后合并进词库
 *   - 不会自动覆盖已有词库
 */
import fs from 'node:fs';
import path from 'node:path';
import { safeFetchText, SafeFetchError, htmlToPlainText } from './safe-fetch.mjs';

/** 默认学习配置。 */
export const LEARNING_DEFAULTS = {
  enabled: false,
  /** 一次最多学多少条 */
  maxPerRun: 20,
  /** 搜索关键词 */
  queries: ['2026 最新网络用语', '网络流行语 梗 大全', '年轻人 黑话 2026'],
  /**
   * 定向网站：从指定页面学词。
   * 每项 { url, note?, kind? }，kind='words' | 'media'
   */
  sites: [],
  /** 学习到的词放这里，等用户确认 */
  pendingFile: 'learned-words.json',
};

/** HTML 实体解码（只处理常见的，够用）。 */
function decodeEntities(s) {
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
 * 从 HTML 里抠出图片直链。
 *
 * 覆盖几种常见写法：
 *   <img src>、<img data-src>（懒加载）、<img srcset>、
 *   og:image、twitter:image、CSS background-image
 *
 * @param {string} html
 * @param {string} baseUrl 相对地址的基准
 * @returns {string[]} 绝对 URL（去重）
 */
export function extractImageUrls(html, baseUrl) {
  const s = String(html || '');
  const out = [];
  const seen = new Set();

  const push = (raw) => {
    let u = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
    if (!u || u.startsWith('data:') || u.startsWith('blob:')) return;

    // srcset：「a.jpg 1x, b.jpg 2x」取第一个
    if (u.includes(' ') && /[,]\s*\S+\s+\d/.test(u)) {
      u = u.split(',')[0].trim().split(/\s+/)[0];
    } else if (u.includes(' ')) {
      u = u.split(/\s+/)[0];
    }

    try {
      u = new URL(u, baseUrl).toString();
    } catch {
      return;
    }

    if (!/^https?:/i.test(u)) return;
    if (!/\.(jpg|jpeg|png|gif|webp|bmp)(\?|#|$)/i.test(u)) {
      // 有些 CDN 地址不带扩展名，靠 query 传格式，放行常见图床特征
      if (!/(image|img|pic|photo|thumb|avatar|cover)/i.test(u)) return;
    }
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };

  // <img> 的各类属性
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(s)) !== null) {
    const tag = m[0];
    for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src', 'srcset', 'data-srcset']) {
      const re = new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'i');
      const mm = re.exec(tag);
      if (mm) push(mm[1]);
    }
  }

  // og:image / twitter:image
  const metaRe =
    /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:image|og:image:url|twitter:image)["'][^>]*>/gi;
  while ((m = metaRe.exec(s)) !== null) {
    const mm = /content\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (mm) push(mm[1]);
  }

  // CSS background-image
  const bgRe = /background(?:-image)?\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  while ((m = bgRe.exec(s)) !== null) push(m[1]);

  return out;
}

/**
 * 抓取一个网页里的图片（只返回链接，不下载）。
 *
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, url:string, images:string[], error?:string}>}
 */
export async function fetchSiteImages(url, opts = {}) {
  const target = String(url || '').trim();
  if (!target) return { ok: false, url: target, images: [], error: '没有 URL' };

  let u;
  try {
    u = new URL(target);
  } catch {
    return { ok: false, url: target, images: [], error: 'URL 格式不对' };
  }
  if (!/^https?:$/.test(u.protocol)) {
    return { ok: false, url: target, images: [], error: '只支持 http/https' };
  }

  try {
    /**
     * 统一走 safe-fetch：只允许公网 http/https，挡内网/元数据地址，
     * 限制大小，跳转逐跳校验。
     *
     * 以前这里是直接 fetch —— 没有 SSRF 防护，抓
     * http://127.0.0.1:8899/api/admin/config 也能拿到东西。
     */
    const page = await safeFetchText(target, {
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: opts.timeoutMs || 20000,
    });
    const images = extractImageUrls(page.text, target);

    return { ok: true, url: target, images };
  } catch (e) {
    return {
      ok: false,
      url: target,
      images: [],
      error: e.name === 'AbortError' ? '抓取超时' : e.message,
    };
  }
}

/**
 * 从 HTML 里抠出可读正文。
 *
 * 不引第三方库：去掉 script/style/nav/footer 等噪声块，
 * 再把标签剥掉，压缩空白。够模型看懂内容，不必完美。
 */
export function htmlToText(html) {
  let s = String(html || '');

  /** 去掉整块噪声（含内容）。 */
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

  // 关键顺序：先解实体再剥标签。
  // 反过来会把 &lt;style&gt; 解码成真标签，导致 CSS 混进正文（百度首页实测）。
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

/**
 * 抓一个网页并转成纯文本。
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.maxChars] 正文上限
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, url:string, title:string, text:string, error?:string}>}
 */
export async function fetchSiteText(url, opts = {}) {
  const target = String(url || '').trim();
  if (!target) return { ok: false, url: target, title: '', text: '', error: '没有 URL' };

  let u;
  try {
    u = new URL(target);
  } catch {
    return { ok: false, url: target, title: '', text: '', error: 'URL 格式不对' };
  }

  if (!/^https?:$/.test(u.protocol)) {
    return { ok: false, url: target, title: '', text: '', error: '只支持 http/https' };
  }

  const maxChars = opts.maxChars || 12000;

  // 网络偶发抖动时重试一次（实测 example.com 会间歇性 "fetch failed"）
  const attempt = async (n) => {
    try {
      return await safeFetchText(target, {
        maxBytes: Math.max(maxChars * 4, 256 * 1024),
        timeoutMs: opts.timeoutMs || 20000,
      });
    } catch (e) {
      // 安全策略拒绝的不要重试（重试也没用）
      if (e instanceof SafeFetchError && !/超时|fetch failed|抓取失败/.test(e.message)) throw e;
      if (n > 0) {
        await new Promise((r) => setTimeout(r, 600));
        return attempt(n - 1);
      }
      throw e;
    }
  };

  try {
    const page = await attempt(1);
    const html = page.text;

    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const title = titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 120) : '';

    let text = htmlToPlainText(html);
    if (text.length > maxChars) text = text.slice(0, maxChars);

    if (text.length < 50) {
      return { ok: false, url: target, title, text, error: '页面几乎没有正文（可能是 JS 渲染的）' };
    }

    return { ok: true, url: target, title, text };
  } catch (e) {
    return {
      ok: false,
      url: target,
      title: '',
      text: '',
      error: e.name === 'AbortError' ? '抓取超时' : e.message,
    };
  }
}


/** 读待审词条。 */
export function readPending(dataDir) {
  const file = path.join(dataDir, 'learned-words.json');
  try {
    if (!fs.existsSync(file)) return { words: [], updatedAt: null };
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { words: j.words || [], updatedAt: j.updatedAt || null };
  } catch {
    return { words: [], updatedAt: null };
  }
}

/** 写待审词条（合并去重）。 */
export function savePending(dataDir, newWords) {
  const file = path.join(dataDir, 'learned-words.json');
  const cur = readPending(dataDir);
  const map = new Map(cur.words.map((w) => [w.word, w]));

  for (const w of newWords) {
    if (w?.word && !map.has(w.word)) map.set(w.word, w);
  }

  const words = Array.from(map.values());
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ words, updatedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );

  return { total: words.length, added: words.length - cur.words.length };
}

/**
 * 从搜索结果里提炼词条。
 *
 * @param {object} opts
 * @param {Array<{title:string,snippet:string}>} opts.results
 * @param {function} opts.askLlm  (prompt) => Promise<string>
 * @param {number} [opts.max]
 * @returns {Promise<Array<{word:string, explain:string, from:string}>>}
 */
export async function extractWords({ results, askLlm, max = 20 }) {
  if (!results?.length) return [];

  const corpus = results
    .slice(0, 8)
    .map((r, i) => `[${i + 1}] ${r.title}\n${(r.snippet || '').slice(0, 200)}`)
    .join('\n\n');

  const prompt = `下面是从网上搜到的资料。请从中提炼出网络用语/流行梗。

要求：
1. 只输出格式为「词条｜一句话解释」的行，每行一条
2. 最多 ${max} 条
3. 只要资料里真实出现的，不要自己编
4. 不要编号、不要标题、不要解释性文字
5. 解释不超过 20 字

资料：
${corpus}`;

  let reply = '';
  try {
    reply = String(await askLlm(prompt));
  } catch {
    return [];
  }

  return parseWordLines(reply, max, 'web');
}

/**
 * 解析模型返回的「词｜解释」文本（搜索和定向网站共用）。
 *
 * 模型经常把所有词条挤在一个气泡里用空格分隔，
 * 所以不能只按行切，要按「词｜解释」这个模式全局匹配。
 */
export function parseWordLines(reply, max = 20, from = 'web') {
  const out = [];
  const seen = new Set();

  const text = String(reply || '')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (/^[0-9]+[.、)]/.test(t)) return false;
      if (/^(词条|要求|资料|下面|格式|只输出|页面标题|正文)/.test(t)) return false;
      return true;
    })
    .join('\n');

  const re =
    /([^\s｜|。，,；;：:]{2,20})\s*[｜|]\s*([^｜|\n]{1,60}?)(?=\s*[^\s｜|。，,；;：:]{2,20}\s*[｜|]|[\n。；;]|$)/g;

  let m;
  while ((m = re.exec(text)) !== null) {
    const word = m[1].replace(/^[-*\s\d.、)]+/, '').trim();
    const explain = m[2].replace(/[。；;，,\s]+$/, '').trim();

    if (!word || word.length < 2 || explain.length < 2) continue;
    if (seen.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    if (/^(要求|资料|格式|下面)$/.test(word)) continue;

    seen.add(word);
    out.push({ word, explain, from, addedAt: new Date().toISOString() });

    if (out.length >= max) break;
  }

  return out;
}

/**
 * 从**整篇文章**里提炼词条（定向网站学习用）。
 *
 * 和 extractWords 的区别：那个吃的是搜索摘要（短），这个吃的是整页正文，
 * 提示词里要让它忽略导航、广告、评论区这类噪声。
 *
 * @param {object} opts
 * @param {string} opts.text 正文
 * @param {string} [opts.title] 页面标题
 * @param {string} [opts.source] 来源 URL（记进词条里方便追溯）
 * @param {function} opts.askLlm
 * @param {number} [opts.max]
 */
export async function extractFromText({ text, title = '', source = '', askLlm, max = 20 }) {
  const body = String(text || '').trim();
  if (body.length < 30) return [];

  const prompt = `下面是一个网页的正文。请从中提炼出网络用语/流行梗/黑话。

要求：
1. 只输出「词条｜一句话解释」的行，每行一条
2. 最多 ${max} 条
3. 只提取正文里真实出现过、有明确含义的
4. 忽略导航文字、广告、推荐列表、评论区、版权声明
5. 不要编号、不要标题、不要任何解释性文字
6. 解释不超过 20 字

${title ? `页面标题：${title}\n` : ''}正文：
${body.slice(0, 8000)}`;

  let reply = '';
  try {
    reply = String(await askLlm(prompt));
  } catch {
    return [];
  }

  return parseWordLines(reply, max, source || 'site');
}

/**
 * 把审阅通过的词条写进词库文件。
 *
 * @param {string} bankFile 词库路径
 * @param {Array<{word,explain}>} words
 * @returns {{added:number, skipped:number}}
 */
export function mergeIntoBank(bankFile, words) {
  let existing = '';
  try {
    existing = fs.readFileSync(bankFile, 'utf8');
  } catch {}

  const lines = existing.split('\n');
  const existingWords = new Set();

  for (const l of lines) {
    const m = /^(.{1,20}?)\s*[｜|]/.exec(l.trim());
    if (m) existingWords.add(m[1].trim());
  }

  const toAdd = [];
  let skipped = 0;

  for (const w of words) {
    if (existingWords.has(w.word)) {
      skipped++;
      continue;
    }
    // 用全角竖线分隔，和现有词库格式一致
    toAdd.push(`${w.word}｜${w.explain}`);
    existingWords.add(w.word);
  }

  if (toAdd.length) {
    // 追加到文件末尾，加个标记区
    const marker = '## 联网学习';
    let content = existing;
    if (!content.includes(marker)) {
      content += `\n\n${marker}\n`;
    }
    content += toAdd.join('\n') + '\n';
    fs.writeFileSync(bankFile, content, 'utf8');
  }

  return { added: toAdd.length, skipped };
}
