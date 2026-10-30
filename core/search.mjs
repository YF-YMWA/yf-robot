/**
 * 联网搜索：让模型能查实时信息。
 *
 * 两种后端：
 *   1. Bing / Google 风格的 HTML 抓取（无需 key，但脆弱）
 *   2. 搜索 API（博查 / Serper / Tavily 等，需要 key，稳定）
 *
 * 设计：查询 → 拿若干条结果（标题 + 摘要 + 链接）→ 拼成上下文交给模型。
 * 不做网页正文抓取（那需要额外做正文提取，容易引入大段噪音）。
 */

export class SearchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SearchError';
  }
}

export class SearchClient {
  /**
   * @param {object} cfg search 配置段
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.fetch = opts.fetchImpl || globalThis.fetch;
  }

  get enabled() {
    if (!this.cfg.enabled) return false;
    // 内置默认地址的后端，不强制要求 baseUrl
    const hasDefault = ['bocha', 'serper', 'tavily'].includes(this.cfg.provider || 'bocha');
    return Boolean(hasDefault || this.cfg.baseUrl);
  }

  /**
   * 执行搜索。
   * @param {string} query
   * @param {object} [opts]
   * @returns {Promise<Array<{title:string, snippet:string, url:string}>>}
   */
  async search(query, opts = {}) {
    if (!this.enabled) throw new SearchError('未启用搜索');
    if (!query || !query.trim()) return [];

    const provider = this.cfg.provider || 'bocha';
    const limit = opts.limit || this.cfg.maxResults || 5;

    switch (provider) {
      case 'bocha':
        return this.#bocha(query, limit, opts.signal);
      case 'serper':
        return this.#serper(query, limit, opts.signal);
      case 'tavily':
        return this.#tavily(query, limit, opts.signal);
      case 'custom':
        return this.#custom(query, limit, opts.signal);
      default:
        throw new SearchError(`未知搜索后端: ${provider}`);
    }
  }

  /** 博查搜索（国内可用，接口稳定）。 */
  async #bocha(query, limit, signal) {
    const json = await this.#postJson(
      this.cfg.baseUrl || 'https://api.bochaai.com/v1/web-search',
      {
        query,
        summary: true,
        count: limit,
      },
      signal,
    );
    const items = json?.data?.webPages?.value || [];
    return items.slice(0, limit).map((it) => ({
      title: it.name || '',
      snippet: it.summary || it.snippet || '',
      url: it.url || '',
      date: it.datePublished || it.dateLastCrawled || '',
    }));
  }

  /**
   * 图片搜索：返回图片直链。
   *
   * 只有博查支持（它有专门的 /images/search 接口）。
   * 其他服务商退化为网页搜索 + 从摘要里抠图片链接。
   *
   * @param {string} query
   * @param {number} [limit]
   * @returns {Promise<Array<{url:string, title:string}>>}
   */
  async searchImages(query, limit = 10) {
    if (!this.enabled) throw new SearchError('未启用搜索');
    if (!query?.trim()) return [];

    const provider = this.cfg.provider || 'bocha';

    // 1. 先试博查的图片接口（需要单独开通权限，没有权限会 401）
    if (provider === 'bocha') {
      try {
        const json = await this.#postJson(
          'https://api.bochaai.com/v1/image-search',
          { query, count: limit },
          undefined,
        );
        const items = json?.data?.value || json?.data || [];
        const out = (Array.isArray(items) ? items : [])
          .map((it) => ({
            url: it.contentUrl || it.thumbnailUrl || it.url || '',
            title: it.name || query,
          }))
          .filter((x) => x.url && /^https?:\/\//i.test(x.url));

        if (out.length) return out.slice(0, limit);
      } catch {
        // 没权限或接口变了，继续走后面的兜底
      }
    }

    // 2. 兜底：普通搜索 + 从结果里抠图片直链
    const results = await this.search(query, { limit: limit * 2 });
    const out = [];
    const seen = new Set();

    const push = (u, title) => {
      if (!u || seen.has(u)) return;
      if (!/^https?:\/\//i.test(u)) return;
      if (!/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(u)) return;
      seen.add(u);
      out.push({ url: u, title: title || query });
    };

    for (const r of results) {
      const text = `${r.url || ''}\n${r.snippet || ''}\n${r.title || ''}`;

      // 抠所有图片直链
      const found = text.match(/https?:\/\/[^\s"'<>)）\]]+\.(?:jpg|jpeg|png|gif|webp)/gi) || [];
      for (const u of found) push(u, r.title);

      // 图片站常见：URL 里带 /img/ 或图片 CDN，配上 .jpg 后缀
      const cdn = text.match(/https?:\/\/[a-z0-9.-]*(?:img|image|pic|photo|cdn)[a-z0-9.-]*\.[a-z]{2,}\/[^\s"'<>)）\]]{3,80}/gi) || [];
      for (const u of cdn.slice(0, 3)) {
        // 只保留看起来像图片文件的
        if (/\.(jpg|jpeg|png|gif|webp)/i.test(u)) push(u, r.title);
      }

      if (out.length >= limit) break;
    }

    return out.slice(0, limit);
  }

  /** Serper.dev（Google 结果）。 */
  async #serper(query, limit, signal) {
    const json = await this.#postJson(
      this.cfg.baseUrl || 'https://google.serper.dev/search',
      { q: query, num: limit },
      signal,
      { 'X-API-KEY': this.cfg.apiKey },
    );
    const items = json?.organic || [];
    return items.slice(0, limit).map((it) => ({
      title: it.title || '',
      snippet: it.snippet || '',
      url: it.link || '',
    }));
  }

  /** Tavily。 */
  async #tavily(query, limit, signal) {
    const json = await this.#postJson(
      this.cfg.baseUrl || 'https://api.tavily.com/search',
      { query, max_results: limit, api_key: this.cfg.apiKey },
      signal,
    );
    const items = json?.results || [];
    return items.slice(0, limit).map((it) => ({
      title: it.title || '',
      snippet: it.content || '',
      url: it.url || '',
    }));
  }

  /** 自定义：用户提供 baseUrl 与字段映射。 */
  async #custom(query, limit, signal) {
    const json = await this.#postJson(this.cfg.baseUrl, { query, count: limit }, signal);
    const map = this.cfg.fieldMap || { list: 'results', title: 'title', snippet: 'snippet', url: 'url' };
    const list = json?.[map.list] || [];
    return list.slice(0, limit).map((it) => ({
      title: it[map.title] || '',
      snippet: it[map.snippet] || '',
      url: it[map.url] || '',
    }));
  }

  async #postJson(url, body, signal, extraHeaders = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs || 15000);
    timer.unref?.();
    signal?.addEventListener('abort', () => ac.abort(), { once: true });

    try {
      const headers = {
        'content-type': 'application/json',
        ...(this.cfg.apiKey && !extraHeaders['X-API-KEY']
          ? { authorization: `Bearer ${this.cfg.apiKey}` }
          : {}),
        ...extraHeaders,
      };

      const res = await this.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        /**
         * 把常见失败翻译成「人该做什么」。
         * 用户截图里看到的是：
         *   搜索接口返回 403: {"code":403,"message":"You do not have enough money or package quota"}
         * 这句话对普通用户等于没说 —— 他不知道自己该去充值。
         */
        const low =
          res.status === 403 || /quota|money|balance|余额|额度|insufficient/i.test(detail)
            ? '（这个搜索服务的额度用完了，去它官网充值，或在「模型与功能」里换个服务商）'
            : res.status === 401 || /unauthorized|invalid.*key/i.test(detail)
              ? '（Key 不对或已失效，去「模型与功能」重新填一次）'
              : '';
        throw new SearchError(
          `搜索接口返回 ${res.status}: ${detail.slice(0, 150)}${low}`,
        );
      }
      return await res.json();
    } catch (e) {
      if (e instanceof SearchError) throw e;
      if (e.name === 'AbortError') throw new SearchError('搜索超时');
      throw new SearchError(`搜索失败: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 把搜索结果拼成给模型的上下文。
 *
 * 关键设计（防幻觉）：
 *   - 标注每条资料的日期，让模型知道信息是否过期
 *   - 明确要求「只能用资料里的信息」
 *   - 资料不足时要求说不知道，而不是编
 *
 * @param {Array<{title,snippet,url,date?}>} results
 * @returns {string}
 */
export function formatSearchResults(results) {
  if (!results || results.length === 0) return '';

  const today = new Date();
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

  const lines = [];
  lines.push('[联网搜索结果]');
  lines.push(`查询时间：${dateStr}`);
  lines.push('');
  lines.push('【重要规则】');
  lines.push('1. 只能使用下面资料里明确写到的信息');
  lines.push('2. 资料里没有的，直接说"没查到"，绝对不要编造');
  lines.push('3. 天气、股价、新闻这类数据必须和资料一致，不能自己推测');
  lines.push('4. 如果资料明显过期或不相关，说明情况而不是硬套');
  lines.push('');

  results.forEach((r, i) => {
    lines.push(`--- 资料 ${i + 1} ---`);
    lines.push(`标题：${r.title || '（无）'}`);
    if (r.date) lines.push(`日期：${r.date}`);
    if (r.snippet) {
      // 保留更多原文，避免关键信息被截断
      lines.push(`内容：${r.snippet.replace(/\s+/g, ' ').slice(0, 500)}`);
    }
    if (r.url) lines.push(`来源：${r.url}`);
    lines.push('');
  });

  lines.push('[资料结束]');
  return lines.join('\n');
}

/**
 * 检查回复里的关键数据是否来自搜索结果（防幻觉）。
 *
 * 只做保守检查：提取回复里的温度和数字，
 * 如果资料里完全找不到对应数字，就标记为可疑。
 *
 * @param {string} reply
 * @param {Array<{title,snippet}>} results
 * @returns {{suspicious:boolean, reason?:string}}
 */
export function checkGrounding(reply, results) {
  if (!reply || !results || results.length === 0) return { suspicious: false };

  const corpus = results.map((r) => `${r.title || ''} ${r.snippet || ''}`).join(' ');

  // 提取温度：支持 "20度"、"二十度"、"17-18度"、"20℃"
  const CN = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const parseCn = (s) => {
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s === '十') return 10;
    if (s.length === 2 && s[0] === '十') return 10 + (CN[s[1]] ?? 0);
    if (s.length === 2 && s[1] === '十') return (CN[s[0]] ?? 0) * 10;
    if (s.length === 3 && s[1] === '十') return (CN[s[0]] ?? 0) * 10 + (CN[s[2]] ?? 0);
    return CN[s] ?? NaN;
  };

  const tempRe = /([0-9]{1,2}|[零一二三四五六七八九十]{1,3})\s*(?:到|-|~)\s*([0-9]{1,2}|[零一二三四五六七八九十]{1,3})\s*[度℃]|([0-9]{1,2}|[零一二三四五六七八九十]{1,3})\s*[度℃]/g;

  for (const m of reply.matchAll(tempRe)) {
    const nums = [m[1], m[2], m[3]].filter(Boolean);
    for (const raw of nums) {
      const n = parseCn(raw);
      if (!Number.isFinite(n)) continue;

      // 资料里是否有这个数字（阿拉伯或中文形式都算）
      const cnForm = toCn(n);
      const found = corpus.includes(String(n)) || corpus.includes(cnForm);
      if (!found) {
        return { suspicious: true, reason: `温度「${raw}」在资料里找不到` };
      }
    }
  }

  // 编造天气现象
  if (/明天.*(雨|雪)/.test(reply) && !/明天[^。]{0,20}(雨|雪)/.test(corpus)) {
    return { suspicious: true, reason: '提到的明日天气在资料里找不到' };
  }

  return { suspicious: false };
}

/** 数字转中文（支持 0-99）。 */
function toCn(n) {
  const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n < 10) return CN[n];
  if (n < 20) return '十' + (n % 10 ? CN[n % 10] : '');
  if (n < 100) return CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : '');
  return String(n);
}

/**
 * 判断消息是否需要联网（关键词触发）。
 * @param {string} text
 * @returns {boolean}
 */
export function needsSearch(text) {
  if (!text) return false;
  const t = String(text).trim();

  // 情绪表达不搜（"今天好累啊"不是要查新闻）
  if (/(累|困|烦|难过|开心|高兴|无聊|郁闷|生气|委屈|痛|饿|瞌睡|失眠)/.test(t)) {
    // 但如果同时有明确查询意图，仍然搜
    if (!/(查|搜|新闻|天气|股价|比分)/.test(t)) return false;
  }

  // 明确的查询意图，最可靠
  if (/(查一下|查查|搜一下|搜搜|帮我查|帮我搜|网上|百度|搜一下)/.test(t)) return true;

  // 时效性话题
  if (/(新闻|热点|热搜|头条|发生了什么|怎么回事)/.test(t)) return true;
  if (/(今天|现在|目前|最近|最新|今年).*(天气|新闻|股价|汇率|价格|行情|比分|赛程|发生)/.test(t)) return true;

  // 具体数据查询
  if (/(天气|气温|下雨|股价|汇率|油价|房价|金价)/.test(t)) return true;
  if (/(多少钱|什么价|价格多少)/.test(t)) return true;
  if (/(比分|赛程|比赛结果|赢了|输给)/.test(t)) return true;

  // 事实性询问（需带疑问词，避免误判）
  if (/(谁是|哪一年|什么时候|几点开始|有多少人)/.test(t) && t.length < 40) return true;

  // 时间/日期询问：这类问题模型没有实时时钟，必须搜
  if (/(现在|今天|此刻)?\s*(几点|几号|几月几号|星期几|周几|日期|时间)/.test(t) && t.length < 30) return true;

  // 版本 / 发布信息：会随时间变化
  if (/(最新|新版|新版本|更新|发布|上线).*(版本|功能|特性)/.test(t)) return true;
  if (/版本.*(多少|几|什么|更新)/.test(t)) return true;

  // 「X 是什么」——专有名词询问，容易被模型编造定义，值得核一下
  // 只对简称/英文名生效，避免「爱是什么」这种哲学问题被搜
  if (/[A-Za-z][A-Za-z0-9.+-]{1,20}\s*(是什么|是啥|什么意思|干啥的)/.test(t) && t.length < 40) return true;

  // 年份 + 事件
  if (/\d{4}\s*年.*(发生|事件|爆炸|地震|战争)/.test(t)) return true;

  return false;
}
