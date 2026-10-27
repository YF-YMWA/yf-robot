/**
 * 对话时自动学习。
 *
 * 为什么需要节流：
 *   每条消息都学 = 每条消息多花几秒 + 烧 API 额度。
 *   改成「每 N 轮学一次、每天最多 M 次、两次至少隔 X 分钟」，
 *   体感上她照样在长本事，成本却可控。
 *
 * 默认关闭：自动联网属于「花你的钱」，得你亲手打开。
 */

/** 默认配置。 */
export const AUTO_LEARN_DEFAULTS = {
  enabled: false,
  /** 每多少轮对话尝试一次 */
  everyNTurns: 15,
  /** 两次自动学习至少间隔（分钟） */
  minIntervalMinutes: 30,
  /** 每天最多自动学几次 */
  maxPerDay: 6,
  /** 学什么：words=词条，media=图片 */
  mode: 'words',
  /** 单次最多学多少条 */
  maxPerRun: 10,
};

/**
 * 该不该触发自动学习。
 *
 * @param {object} opts
 * @param {object} opts.cfg 自动学习配置
 * @param {number} opts.turnCount 当前会话累计轮数
 * @param {number} [opts.lastTs] 上次自动学习时间戳
 * @param {number} [opts.todayCount] 今天已自动学次数
 * @param {number} [opts.now]
 * @returns {{want:boolean, reason:string, stage?:string}}
 */
export function shouldAutoLearn({
  cfg = {},
  turnCount = 0,
  lastTs = 0,
  todayCount = 0,
  now = Date.now(),
} = {}) {
  const c = { ...AUTO_LEARN_DEFAULTS, ...cfg };

  if (!c.enabled) return { want: false, reason: '自动学习未开启' };

  // 每日上限
  if (todayCount >= c.maxPerDay) {
    return { want: false, reason: `今天已学 ${todayCount} 次，达上限 ${c.maxPerDay}` };
  }

  // 轮数门槛
  const every = Math.max(1, c.everyNTurns);
  if (turnCount < every) {
    return { want: false, reason: `还没到 ${every} 轮（当前 ${turnCount}）` };
  }

  // 最小间隔
  const gapMs = Math.max(1, c.minIntervalMinutes) * 60 * 1000;
  if (lastTs && now - lastTs < gapMs) {
    const left = Math.ceil((gapMs - (now - lastTs)) / 60000);
    return { want: false, reason: `距上次学习还差 ${left} 分钟` };
  }

  // 轮数要对得上（避免每轮都触发）
  if (turnCount % every !== 0) {
    return { want: false, reason: `下一轮在第 ${Math.ceil(turnCount / every) * every} 轮` };
  }

  return { want: true, reason: `第 ${turnCount} 轮，满足条件` };
}

/**
 * 自动学习的运行期状态。
 *
 * 全局一份（不限会话）：跨会话共享额度，避免每个群各学一遍。
 */
export class AutoLearnState {
  constructor() {
    this.lastTs = 0;
    this.day = '';
    this.todayCount = 0;
    this.totalRuns = 0;
    this.running = false;
    this.lastResult = null;
    /** 每会话累计轮数 */
    this.turns = new Map();
  }

  #today() {
    return new Date().toISOString().slice(0, 10);
  }

  /** 记一轮对话，返回该会话的累计轮数。 */
  addTurn(sessionId) {
    const d = this.#today();
    if (this.day !== d) {
      this.day = d;
      this.todayCount = 0;
    }

    const n = (this.turns.get(sessionId) || 0) + 1;
    this.turns.set(sessionId, n);
    return n;
  }

  /** 是否该触发。 */
  check(cfg, sessionId) {
    const turnCount = this.turns.get(sessionId) || 0;

    return shouldAutoLearn({
      cfg,
      turnCount,
      lastTs: this.lastTs,
      todayCount: this.todayCount,
    });
  }

  /** 标记开始跑。 */
  begin() {
    this.running = true;
  }

  /** 跑完了。 */
  finish(result) {
    this.running = false;
    this.lastTs = Date.now();
    this.todayCount += 1;
    this.totalRuns += 1;
    this.lastResult = { ...result, at: Date.now() };
  }

  /** 给控制台看的状态。 */
  status() {
    return {
      running: this.running,
      todayCount: this.todayCount,
      totalRuns: this.totalRuns,
      lastAt: this.lastTs || null,
      lastResult: this.lastResult,
      sessions: this.turns.size,
    };
  }
}
