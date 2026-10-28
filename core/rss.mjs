/**
 * RSS / Atom 解析。
 *
 * 为什么需要它：
 *   B站、小黑盒、微博这类站点的网页是前端 JS 渲染的，直接抓 HTML 只能拿到空壳。
 *   RSSHub 把这些站转成标准 RSS，我们解析 XML 就能拿到结构化内容 ——
 *   比模拟浏览器简单得多，也不会被封。
 *
 * 只依赖正则，不引第三方库（feedparser 之类的在打包时会拖一堆依赖）。
 */
import { htmlToText, extractImageUrls } from './learning.mjs';
import { safeFetchText, SafeFetchError } from './safe-fetch.mjs';

/** XML 实体解码。 */
function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * 取某个标签的内容（支持带属性的形式）。
 *
 * @param {string} xml
 * @param {string} tag 标签名
 * @returns {string[]} 所有匹配到的内容
 */
function pickTag(xml, tag) {
  const out = [];
  // <tag>内容</tag> 或 <tag attr="x">内容</tag>
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** 取某个标签的属性值（自闭合形式：<enclosure url="..." />）。 */
function pickSelfClosing(xml, tag, attr) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*["']([^"']+)["'][^>]*/?>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/**
 * 从一段 HTML/文本里提取第一张图（用于 item 缩略图）。
 */
function firstImage(html, baseUrl) {
  const urls = extractImageUrls(html, baseUrl);
  return urls[0] || '';
}

/**
 * 解析 RSS 2.0 / Atom / RSS 1.0(RDF)。
 *
 * @param {string} xml
 * @param {string} [baseUrl] 用于解析相对链接
 * @returns {{ok:boolean, title:string, items:Array, error?:string}}
 */
export function parseFeed(xml, baseUrl = '') {
  const s = String(xml || '');
  if (!s.trim()) return { ok: false, title: '', items: [], error: '内容为空' };

  // 判断格式
  const isAtom = /<feed\b[^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(s) ||
    /<feed\b/i.test(s);
  const isRss = /<rss\b/i.test(s) || /<rdf:RDF\b/i.test(s);

  if (!isAtom && !isRss) {
    return {
      ok: false,
      title: '',
      items: [],
      error: '不是 RSS/Atom（可能返回了网页或错误页）',
    };
  }

  // 频道标题（避免误取 item 里的 title）
  let title = '';
  const channelBlock = /<channel\b[^>]*>([\s\S]*?)<\/channel>/i.exec(s);
  if (channelBlock) {
    const t = pickTag(channelBlock[1], 'title')[0];
    if (t) title = decodeXml(htmlToText(t)).slice(0, 120);
  }
  if (!title) {
    const t = pickTag(s, 'title')[0];
    if (t) title = decodeXml(htmlToText(t)).slice(0, 120);
  }

  // 切分 item / entry
  const itemBlocks = [];
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = itemRe.exec(s)) !== null) itemBlocks.push(m[2]);

  const items = [];

  for (const block of itemBlocks) {
    // 标题
    let itemTitle = decodeXml(pickTag(block, 'title')[0] || '');

    // 链接：<link>href</link> 或 <link href="..."/>
    let link = decodeXml(pickTag(block, 'link')[0] || '');
    if (!link || /^\s*$/.test(link)) {
      const href = pickSelfClosing(block, 'link', 'href')[0];
      if (href) link = decodeXml(href);
    }
    if (!link) link = decodeXml(pickTag(block, 'guid')[0] || '');

    // 正文：content:encoded > content > description > summary
    const rawContent =
      pickTag(block, 'content:encoded')[0] ||
      pickTag(block, 'content')[0] ||
      pickTag(block, 'description')[0] ||
      pickTag(block, 'summary')[0] ||
      '';

    const contentHtml = decodeXml(rawContent);
    const text = htmlToText(contentHtml);

    // 时间
    const date =
      decodeXml(
        pickTag(block, 'pubDate')[0] ||
          pickTag(block, 'published')[0] ||
          pickTag(block, 'updated')[0] ||
          pickTag(block, 'dc:date')[0] ||
          '',
      ) || '';

    // 图片：enclosure / media:content / media:thumbnail / 正文里的 img
    const images = [];
    for (const u of pickSelfClosing(block, 'enclosure', 'url')) {
      if (/\.(jpg|jpeg|png|gif|webp)|image/i.test(u)) images.push(decodeXml(u));
    }
    for (const u of pickSelfClosing(block, 'media:content', 'url')) images.push(decodeXml(u));
    for (const u of pickSelfClosing(block, 'media:thumbnail', 'url')) images.push(decodeXml(u));

    if (!images.length) {
      const fi = firstImage(contentHtml, baseUrl);
      if (fi) images.push(fi);
    }

    // 绝对化
    const abs = (u) => {
      try {
        return new URL(u, baseUrl || undefined).toString();
      } catch {
        return '';
      }
    };

    const itemLink = abs(link) || link;
    const absImages = images.map(abs).filter(Boolean);

    // 全空的条目跳过
    if (!itemTitle && !text && !absImages.length) continue;

    items.push({
      title: itemTitle,
      link: itemLink,
      text,
      date,
      images: [...new Set(absImages)],
    });
  }

  if (!items.length) {
    return {
      ok: false,
      title,
      items: [],
      error: '是 RSS 格式但里面没有条目',
    };
  }

  return { ok: true, title, items };
}

/**
 * 抓取并解析一个 RSS 地址。
 *
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, url:string, title:string, items:Array, error?:string}>}
 */
export async function fetchFeed(url, opts = {}) {
  const target = String(url || '').trim();
  if (!target) return { ok: false, url: target, title: '', items: [], error: '没有 URL' };

  let u;
  try {
    u = new URL(target);
  } catch {
    return { ok: false, url: target, title: '', items: [], error: 'URL 格式不对' };
  }
  if (!/^https?:$/.test(u.protocol)) {
    return { ok: false, url: target, title: '', items: [], error: '只支持 http/https' };
  }

  const attempt = async (n) => {
    try {
      /**
       * 统一走 safe-fetch：以前这里只检查了协议就 fetch(target, {redirect:'follow'})，
       * 抓 http://127.0.0.1:8899/... 或内网地址都能成功。
       * RSS 本来就是纯文本 XML，不需要浏览器 UA。
       */
      return await safeFetchText(target, {
        maxBytes: 2 * 1024 * 1024,
        timeoutMs: opts.timeoutMs || 20000,
        log: (m) => opts.log?.(m),
      });
    } catch (e) {
      // 安全策略明确拒绝的，重试也没用
      if (e instanceof SafeFetchError && /不允许|只支持/.test(e.message)) throw e;
      if (n > 0) {
        await new Promise((r) => setTimeout(r, 600));
        return attempt(n - 1);
      }
      throw e;
    }
  };

  try {
    const page = await attempt(1);
    const xml = page.text;
    const parsed = parseFeed(xml, target);

    return {
      ok: parsed.ok,
      url: target,
      title: parsed.title,
      items: parsed.items,
      error: parsed.error,
      // 原始长度，方便排查「是不是被反爬拦了」
      bytes: xml.length,
    };
  } catch (e) {
    return {
      ok: false,
      url: target,
      title: '',
      items: [],
      error: e.name === 'AbortError' ? '抓取超时' : e.message,
    };
  }
}
