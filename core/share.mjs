/**
 * B 站视频分享：定时挑一个视频，配一句自己的话。
 *
 * 不依赖登录，只用公开 API：
 *   - 热门视频：x/web-interface/popular
 *   - 搜索：x/web-interface/wbi/search/type（需要 wbi 签名，较复杂）
 *
 * 这里用热门接口 + 关键词过滤，避免维护 wbi 签名逻辑。
 */

export class BilibiliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BilibiliError';
  }
}

export class BilibiliClient {
  /**
   * @param {object} cfg share 配置段
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.fetch = opts.fetchImpl || globalThis.fetch;
    this.lastShared = null;
  }

  get enabled() {
    return Boolean(this.cfg.enabled);
  }

  /**
   * 拉取热门视频列表。
   * @param {object} [opts]
   * @returns {Promise<Array<object>>}
   */
  async fetchPopular(opts = {}) {
    const ps = opts.count || this.cfg.count || 20;
    const url = `https://api.bilibili.com/x/web-interface/popular?ps=${ps}&pn=1`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    timer.unref?.();

    try {
      const res = await this.fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          referer: 'https://www.bilibili.com/',
        },
        signal: ac.signal,
      });

      if (!res.ok) throw new BilibiliError(`B站接口返回 ${res.status}`);
      const json = await res.json();
      if (json.code !== 0) throw new BilibiliError(`B站接口错误: ${json.message}`);

      const list = json?.data?.list || [];
      return list.map((v) => ({
        bvid: v.bvid,
        title: v.title,
        desc: v.desc || '',
        owner: v.owner?.name || '',
        url: `https://www.bilibili.com/video/${v.bvid}`,
        cover: v.pic || '',
        duration: v.duration,
        stat: {
          view: v.stat?.view,
          like: v.stat?.like,
          danmaku: v.stat?.danmaku,
        },
        cid: v.cid,
      }));
    } catch (e) {
      if (e instanceof BilibiliError) throw e;
      if (e.name === 'AbortError') throw new BilibiliError('B站请求超时');
      throw new BilibiliError(`B站请求失败: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 挑一个视频。
   *
   * 策略：
   *   - 命中关键词的优先
   *   - 排除最近分享过的
   *   - 播放量不至于太低
   *
   * @param {object} [opts]
   * @returns {Promise<object|null>}
   */
  async pick(opts = {}) {
    const list = await this.fetchPopular(opts);
    if (list.length === 0) return null;

    const keywords = this.cfg.keywords || [];
    const exclude = new Set(this.cfg.recentIds || []);
    if (this.lastShared) exclude.add(this.lastShared);

    let candidates = list.filter((v) => !exclude.has(v.bvid));

    // 关键词加权
    if (keywords.length) {
      const scored = candidates.map((v) => {
        const text = v.title + ' ' + v.desc;
        const hits = keywords.filter((k) => text.includes(k)).length;
        return { v, hits };
      });
      const withHits = scored.filter((s) => s.hits > 0);
      if (withHits.length) {
        withHits.sort((a, b) => b.hits - a.hits);
        return withHits[0].v;
      }
    }

    if (candidates.length === 0) candidates = list;
    // 随机挑一个，避免每次都一样
    return candidates[Math.floor(Math.random() * Math.min(candidates.length, 10))];
  }

  /**
   * 生成分享文案（交给模型配一句吐槽，失败则用模板）。
   * @param {object} video
   * @param {(video: object) => Promise<string>} [generate] 可选的模型生成函数
   * @returns {Promise<string>}
   */
  async composeShare(video, generate) {
    this.lastShared = video.bvid;

    if (generate) {
      try {
        const text = await generate(video);
        if (text && text.trim()) {
          return `${text.trim()}\n${video.url}`;
        }
      } catch {
        // 生成失败退回模板
      }
    }

    const views = video.stat?.view;
    const stat = views ? `（${formatCount(views)} 播放）` : '';
    return `看到这个，${video.title}${stat}\n${video.url}`;
  }

  /** 记录已分享，供去重。 */
  rememberRecent(bvid, max = 20) {
    const list = this.cfg.recentIds || [];
    if (!list.includes(bvid)) list.push(bvid);
    this.cfg.recentIds = list.slice(-max);
  }
}

/** 数字转「12.3万」这种形式。 */
export function formatCount(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(n);
}

/**
 * 简单的分享调度器：按间隔触发。
 */
export class ShareScheduler {
  /**
   * @param {object} opts
   * @param {BilibiliClient} opts.client
   * @param {number} opts.intervalMs
   * @param {(content: string) => Promise<void>} opts.onShare
   * @param {object} [opts.logger]
   */
  constructor({ client, intervalMs, onShare, logger = console }) {
    this.client = client;
    this.intervalMs = intervalMs;
    this.onShare = onShare;
    this.log = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.running = true;

    const tick = async () => {
      if (!this.running) return;
      try {
        const video = await this.client.pick();
        if (!video) {
          this.log.warn?.('[share] 没有可分享的视频');
          return;
        }
        const content = await this.client.composeShare(video);
        this.client.rememberRecent(video.bvid);
        await this.onShare(content);
        this.log.info?.(`[share] 已分享: ${video.title}`);
      } catch (e) {
        this.log.error?.('[share] ' + e.message);
      }
    };

    // 首次延迟一轮再开始，避免启动就发
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
    this.log.info?.(`[share] 已启用，每 ${(this.intervalMs / 3600000).toFixed(1)} 小时分享一次`);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
