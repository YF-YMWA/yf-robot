/**
 * 长期记忆。
 *
 * 三层结构：
 *   1. 短期：会话最近 20 轮原文（在 Session.history 里）
 *   2. 摘要：超过 20 轮的部分压成一段摘要
 *   3. 长期：用户信息 + 风格要求 + 重要事件，持久化到文件
 *
 * 为什么要摘要压缩：
 *   模型上下文有限，无限堆对话会爆。
 *   但直接丢又会「失忆」——所以丢掉之前先让模型总结。
 *
 * 存储：
 *   data/memory/<sessionId>.json
 */
import fs from 'node:fs';
import path from 'node:path';

/** 记忆文件版本，格式变了方便迁移。 */
const VERSION = 1;

export class MemoryStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir 存储目录
   * @param {number} [opts.maxFacts] 事实上限
   * @param {number} [opts.maxSummaries] 摘要条数上限
   */
  constructor(opts = {}) {
    this.dir = opts.dir || path.join(process.cwd(), 'data', 'memory');
    this.maxFacts = opts.maxFacts || 50;
    this.maxSummaries = opts.maxSummaries || 10;
    this.cache = new Map();
  }

  #file(id) {
    // 会话 id 可能有冒号（group:xxx），换成下划线
    const safe = String(id).replace(/[^\w.-]/g, '_').slice(0, 80);
    return path.join(this.dir, safe + '.json');
  }

  /** 某个会话的记忆文件绝对路径（控制台用来展示/跳转）。 */
  filePathFor(id) {
    return this.#file(id);
  }

  /** 读记忆（带缓存）。 */
  load(id) {
    if (this.cache.has(id)) return this.cache.get(id);

    const file = this.#file(id);
    let data = null;

    try {
      if (fs.existsSync(file)) {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } catch {}

    const mem = {
      version: VERSION,
      id,
      facts: data?.facts || {},
      summaries: data?.summaries || [],
      // 从上次摘要之后累积、待压缩的旧对话
      archivedTurns: data?.archivedTurns || 0,
      createdAt: data?.createdAt || Date.now(),
      updatedAt: data?.updatedAt || Date.now(),
    };

    this.cache.set(id, mem);
    return mem;
  }

  /** 写记忆。 */
  save(id, mem) {
    mem.updatedAt = Date.now();
    this.cache.set(id, mem);

    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.#file(id), JSON.stringify(mem, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** 记一条事实。 */
  setFact(id, key, value) {
    const mem = this.load(id);
    if (!key || !value) return false;

    const k = String(key).slice(0, 40);
    const v = String(value).slice(0, 200);
    mem.facts[k] = v;

    // 超过上限删最旧的（按插入顺序）
    const keys = Object.keys(mem.facts);
    if (keys.length > this.maxFacts) {
      for (const old of keys.slice(0, keys.length - this.maxFacts)) {
        delete mem.facts[old];
      }
    }

    this.save(id, mem);
    return true;
  }

  /** 追加一条摘要。 */
  addSummary(id, text) {
    const mem = this.load(id);
    const t = String(text || '').trim();
    if (!t) return false;

    mem.summaries.push({ text: t.slice(0, 800), at: Date.now() });

    // 只留最近 N 条
    if (mem.summaries.length > this.maxSummaries) {
      mem.summaries = mem.summaries.slice(-this.maxSummaries);
    }

    this.save(id, mem);
    return true;
  }

  /** 拼成提示词片段。 */
  render(id) {
    const mem = this.load(id);
    const parts = [];

    // 事实
    const factKeys = Object.keys(mem.facts);
    if (factKeys.length) {
      const lines = factKeys.map((k) => `- ${k}：${mem.facts[k]}`);
      parts.push(`【关于对方的记忆】\n${lines.join('\n')}`);
    }

    // 摘要
    if (mem.summaries.length) {
      const lines = mem.summaries.map((s) => `- ${typeof s === 'string' ? s : s.text}`);
      const title = id.startsWith('shared:')
        ? '【你最近看到的热点】（这些是你自己知道的，聊天时可以自然提起）'
        : '【之前聊过的内容】';
      parts.push(`${title}\n${lines.join('\n')}`);
    }

    if (!parts.length) return '';

    // 这条很关键：模型很容易「顺着对方的话编一段回忆」，
    // 表现就是明明没记过却说「你上次说过…」。明确禁止。
    parts.push(
      '（以上才是你真正记得的。对方问的事情如果不在上面，' +
        '就说「你没跟我说过」或「我不记得了」，' +
        '绝对不要编「你之前说过…」。没记住就是没记住。）',
    );

    return parts.join('\n\n');
  }

  /** 清空某个会话的记忆。 */
  clear(id) {
    this.cache.delete(id);
    try {
      fs.unlinkSync(this.#file(id));
    } catch {}
    return { ok: true };
  }

  /** 列出所有有记忆的会话。 */
  list() {
    const out = [];
    try {
      if (!fs.existsSync(this.dir)) return out;
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
          out.push({
            id: data.id || name.replace('.json', ''),
            facts: Object.keys(data.facts || {}).length,
            summaries: (data.summaries || []).length,
            updatedAt: data.updatedAt,
          });
        } catch {}
      }
    } catch {}
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
}

/**
 * 从对话里提取「风格/偏好」类指令。
 *
 * 这类要求不写进记忆就会丢，所以单独识别：
 *   以后别用网络用语
 *   说话短一点
 *   不要叫我主人
 *   叫我老板
 */
export function extractPreferences(text) {
  if (!text) return [];
  const t = String(text).trim();
  const out = [];

  // 「以后/今后/从现在起 + 要求」
  const m1 = /(?:以后|今后|从现在起|往后|之后)[,，\s]*(.{2,60})/.exec(t);
  if (m1) out.push(['说话要求', m1[1].trim()]);

  // 「别/不要/不许 + 行为」
  const m2 = /(?:别|不要|不许|不准|不用)\s*(?:再)?\s*(.{2,40})/.exec(t);
  if (m2) out.push(['不要做的', m2[1].trim()]);

  // 「叫我 X」
  const m3 = /(?:以后)?叫(?:我|俺)\s*([^\s，。,.!！?？]{1,10})/.exec(t);
  if (m3) out.push(['称呼', m3[1].trim()]);

  // 「说话/回复 + 形容词」
  const m4 = /(?:说话|讲话|回复|回答)(?:要|得|应该|可以)?\s*(.{2,20})/.exec(t);
  if (m4 && /短|长|简单|详细|活泼|正经|严肃|可爱|凶|温柔|直接|委婉/.test(m4[1])) {
    out.push(['说话风格', m4[1].trim()]);
  }

  // 「用/不用 + 词」
  const m5 = /(?:不)?(?:要)?(?:用|使用)\s*([^\s，。,.!！?？]{2,20})(?:说话|回我|回复)?/.exec(t);
  if (m5 && /网络用语|梗|表情|emoji|颜文字|脏话|英文/.test(m5[1])) {
    const neg = /不|别/.test(t.slice(Math.max(0, m5.index - 3), m5.index + 2));
    out.push([neg ? '不要用的' : '要用的', m5[1].trim()]);
  }

  // 去重
  const seen = new Set();
  return out.filter(([k, v]) => {
    const key = `${k}:${v}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
