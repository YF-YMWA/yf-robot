/**
 * 情绪状态：让她有「今天心情怎么样」的连续感。
 *
 * 为什么需要：
 *   现在每一轮都是独立的 —— 上一句被骂了，下一句照样热络地撒娇，
 *   或者被夸了也毫无波澜。真人不是这样，情绪有惯性，也会慢慢平复。
 *
 * 做法：
 *   · 每轮根据「对方说了什么」和「这段对话的走向」给情绪加减分
 *   · 分数有时效：越久没说话，越往中间回归（气消了、也没那么高兴了）
 *   · 分数影响三件事：回复长短、要不要发语音、主动搭话的口气
 *
 * 存哪：跟记忆一样按角色卡隔离（data/<卡片>/mood.json），
 *       按会话分开记 —— 对这个人生气，不代表对那个人也生气。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 情绪区间：-100（很烦）~ +100（很乐） */
export const MIN_SCORE = -100;
export const MAX_SCORE = 100;

/** 多久往中间回归一次（分钟） */
const DECAY_MINUTES = 90;
/** 每次回归的比例 */
const DECAY_RATE = 0.35;

/**
 * 一段话的情绪增量。
 *
 * 只看「对方怎么说」，不看内容对错 —— 目的是情绪反应，不是理解语义。
 * @returns {number} -3 ~ +3
 */
export function moodDelta(text) {
  const t = String(text || '');
  if (!t.trim()) return 0;

  let d = 0;

  // 骂人 / 挑衅 → 明显拉低
  if (/(傻逼|智障|脑残|滚|去死|废物|垃圾|狗东西|你妈的|操你|闭嘴|滚蛋)/.test(t)) d -= 3;
  else if (/(你算老几|不服|阴阳怪气|就这|呵呵|无语)/.test(t)) d -= 1.5;

  // 夸 / 感谢 / 亲密 → 拉高
  if (/(谢谢|辛苦|真好|喜欢你|厉害|棒|可爱|乖|抱抱|亲亲)/.test(t)) d += 2;
  else if (/(哈哈|嘿嘿|笑死|好玩|有意思)/.test(t)) d += 1;

  // 撒娇 / 依赖 → 小幅拉高
  if (/(陪我|想你了|在不在|理理我)/.test(t)) d += 0.8;

  // 冷淡 / 敷衍对方 → 小幅拉低（她也会有点失落）
  if (/^(嗯|哦|额|额|行|好|知道了|随便)[。！!～~]*$/.test(t.trim())) d -= 0.6;

  // 对方在诉苦 → 不是针对她，但会让她沉下来
  if (/(累|难受|烦|不开心|压力|加班|睡不着)/.test(t)) d -= 0.5;

  return Math.max(-3, Math.min(3, d));
}

/** 把分数映射成一句人能听懂的话 */
export function describeMood(score) {
  if (score >= 60) return { label: '心情很好', hint: '话可以多一点，愿意撒娇、愿意接梗' };
  if (score >= 25) return { label: '心情不错', hint: '正常聊，可以偶尔开玩笑' };
  if (score > -25) return { label: '平静', hint: '正常说话就行，不用特别热情也不用端着' };
  if (score > -60) return { label: '有点烦', hint: '话变短，少卖萌，别主动贴上去' };
  return { label: '很不爽', hint: '回复一两句就够，带点刺也行，不要哄人' };
}

/**
 * 情绪存储。按作用域（角色卡）一个文件，里面按会话分开。
 */
export class MoodStore {
  /**
   * @param {object} opts
   * @param {string} opts.file 数据文件
   * @param {Function} [opts.log]
   */
  constructor({ file, log = () => {} }) {
    this.file = file;
    this.log = log;
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = j && typeof j === 'object' ? j : {};
    } catch {
      this.data = {};
    }
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data || {}, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      this.log(`[mood] 保存失败：${e.message}`);
      return false;
    }
  }

  /**
   * 取当前情绪分数（带时间衰减）。
   * @param {string} sessionId
   * @param {Date} [now]
   */
  score(sessionId, now = new Date()) {
    const all = this.load();
    const rec = all[sessionId];
    if (!rec || typeof rec.score !== 'number') return 0;

    const minutes = Math.max(0, (now.getTime() - Number(rec.updatedAt || 0)) / 60000);
    if (minutes < DECAY_MINUTES) return rec.score;

    // 每过 DECAY_MINUTES 就往 0 靠 DECAY_RATE
    const steps = Math.floor(minutes / DECAY_MINUTES);
    let s = rec.score;
    for (let i = 0; i < steps; i++) s *= 1 - DECAY_RATE;
    return Math.round(s);
  }

  /**
   * 记一轮的情绪影响。
   * @param {string} sessionId
   * @param {number} delta
   * @param {Date} [now]
   * @returns {number} 更新后的分数
   */
  apply(sessionId, delta, now = new Date()) {
    if (!delta) return this.score(sessionId, now);
    const all = this.load();
    const base = this.score(sessionId, now);
    const next = Math.max(MIN_SCORE, Math.min(MAX_SCORE, base + delta));

    all[sessionId] = { score: next, updatedAt: now.getTime() };
    this.save();
    return next;
  }

  /** 拼进提示词的那一行 */
  render(sessionId, now = new Date()) {
    const s = this.score(sessionId, now);
    const d = describeMood(s);
    return `【你此刻的心情】${d.label}（${d.hint}）`;
  }

  /** 列出所有会话的情绪（控制台用） */
  list() {
    const all = this.load();
    return Object.entries(all)
      .map(([id, rec]) => ({
        sessionId: id,
        score: this.score(id),
        label: describeMood(this.score(id)).label,
        updatedAt: rec.updatedAt || 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
