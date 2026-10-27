/**
 * 每日热点摘要。
 *
 * 干什么：
 *   每天抓一次订阅源（B站热门、微博热搜…），让模型总结成三五条「今天大家都在聊什么」，
 *   存进长期记忆。之后聊天时她会自然带出来，而不是一问三不知。
 *
 * 为什么不用定时精确到点：
 *   服务可能半夜没开、电脑关机。改成「每小时检查一次，够一天了就抓」，
 *   错过也能补，比 crontab 省心。
 */
import { fetchFeed } from './rss.mjs';

export const DIGEST_DEFAULTS = {
  enabled: false,
  /** 每隔多少小时最多跑一次 */
  intervalHours: 24,
  /** 每次最多取几个订阅源 */
  maxFeeds: 5,
  /** 每个源取几条 */
  maxItemsPerFeed: 6,
  /** 总结成几条要点 */
  maxPoints: 5,
};

/**
 * 该不该跑摘要。
 *
 * @param {object} opts
 * @param {object} opts.cfg digest 配置
 * @param {number} [opts.lastTs]
 * @param {number} [opts.now]
 */
export function shouldRunDigest({ cfg = {}, lastTs = 0, now = Date.now() } = {}) {
  const c = { ...DIGEST_DEFAULTS, ...cfg };
  if (!c.enabled) return { want: false, reason: '每日摘要未开启' };

  const gapMs = Math.max(1, c.intervalHours) * 3600 * 1000;
  if (lastTs && now - lastTs < gapMs) {
    const leftH = ((gapMs - (now - lastTs)) / 3600000).toFixed(1);
    return { want: false, reason: `距上次摘要还差 ${leftH} 小时` };
  }

  return { want: true, reason: '到时间了' };
}

/**
 * 抓取所有订阅源，整理成给模型的素材。
 *
 * @param {Array<{url:string,note?:string}>} feeds
 * @param {object} [cfg]
 * @returns {Promise<{items:Array, feeds:Array}>}
 */
export async function collectFeedItems(feeds = [], cfg = {}) {
  const c = { ...DIGEST_DEFAULTS, ...cfg };
  const items = [];
  const details = [];

  for (const f of feeds.slice(0, c.maxFeeds)) {
    const url = String(f?.url || f || '').trim();
    if (!url) continue;

    const r = await fetchFeed(url);
    if (!r.ok) {
      details.push({ url, ok: false, error: r.error });
      continue;
    }

    details.push({ url, ok: true, title: r.title, count: r.items.length });

    for (const it of r.items.slice(0, c.maxItemsPerFeed)) {
      items.push({
        title: it.title,
        text: it.text.slice(0, 220),
        link: it.link,
        feed: r.title || url,
      });
    }
  }

  return { items, feeds: details };
}

/**
 * 让模型把素材总结成几条速览。
 *
 * 为什么要求用 ||| 分隔：
 *   模型经常无视「每行一条」，把要点挤成一段，靠猜分隔符（句号/分号/空格）
 *   拆出来经常断在词的中间。给一个不会自然出现的符号最保险。
 */
export async function summarizeDigest(items, askLlm, max = 5) {
  if (!items?.length) return [];

  const corpus = items
    .map((it, i) => `[${i + 1}] ${it.title}${it.text ? ' — ' + it.text : ''}`)
    .join('\n');

  const prompt = `把下面的资讯压缩成 ${max} 条速览。

【输出格式】每条之间用 ||| 三个竖线隔开，一条一行也行，但必须有 |||。
每条不超过 25 字，只陈述事实，不评论、不加括号、不写开场白。

【示例】
多地降温十度，注意保暖|||新手机开售，门店排长队|||某剧大结局，讨论量破亿

【资讯】
${corpus.slice(0, 6000)}`;

  let reply = '';
  try {
    reply = String(await askLlm(prompt));
  } catch {
    return [];
  }

  return parseDigestPoints(reply, max);
}

/**
 * 解析摘要结果。
 *
 * 优先按 ||| 拆；没有的话再退回按行、按句末标点。
 */
export function parseDigestPoints(reply, max = 5) {
  const raw = String(reply || '').trim();
  if (!raw) return [];

  const cleaned = raw
    .replace(/^```[\s\S]*?\n/, '')
    .replace(/```$/, '')
    .trim();

  const normalize = (s) =>
    String(s)
      .replace(/^[-*·•—]\s*/, '')
      .replace(/^\d+[.、)]\s*/, '')
      .trim();

  const isJunk = (s) =>
    !s ||
    s.length < 4 ||
    /^(好的|以下是|总结|速览|要求|格式|资讯|示例|输出|另外|注|每条)/.test(s) ||
    /^(以上就是|希望|如果|需要|【)/.test(s);

  let lines = [];

  // 1. 有 ||| 就按它拆（最可靠）
  if (cleaned.includes('|||')) {
    lines = cleaned.split('|||').map(normalize).filter((l) => !isJunk(l));
  }

  // 2. 按行拆
  if (!lines.length) {
    lines = cleaned.split('\n').map(normalize).filter((l) => !isJunk(l));
  }

  // 3. 行数还是不够 → 按句末标点拆
  if (lines.length < Math.min(2, max)) {
    const pieces = cleaned
      .split(/[。；;]\s*/)
      .map(normalize)
      .filter((l) => !isJunk(l));
    if (pieces.length > lines.length) lines = pieces;
  }

  // 4. 最后手段：两个以上空格
  if (lines.length === 1 && lines[0].length > 30) {
    const pieces = lines[0].split(/\s{2,}/).map(normalize).filter((l) => !isJunk(l));
    if (pieces.length > 1) lines = pieces;
  }

  return lines
    .filter((l) => l.length <= 80)
    .map((l) => l.slice(0, 60))
    .slice(0, max);
}
