/**
 * 主动画图的触发判断。
 *
 * 为什么要单独一层：
 *   不能每条消息都画（烧钱 + 刷屏），也不能永不画。
 *   需要「概率 + 最小间隔 + 每日上限」三重限制。
 */

/** 默认值。 */
export const PROACTIVE_DEFAULTS = {
  enabled: false,
  /** 每条消息触发「想画」的概率 */
  chance: 0.05,
  /** 两次主动画图的最小间隔（分钟） */
  minIntervalMinutes: 60,
  /** 每天最多主动画几张 */
  maxPerDay: 2,
};

/**
 * @param {object} opts
 * @param {object} opts.cfg proactive 配置
 * @param {number} [opts.lastTs] 上次主动画图时间戳
 * @param {number} [opts.todayCount] 今天已画数量
 * @param {number} [opts.now] 当前时间戳（测试用）
 * @param {() => number} [opts.random] 随机数源（测试用）
 * @returns {{want: boolean, reason: string, chance: number}}
 */
export function shouldProactiveDraw({
  cfg = {},
  lastTs = 0,
  todayCount = 0,
  now = Date.now(),
  random = Math.random,
} = {}) {
  const c = { ...PROACTIVE_DEFAULTS, ...cfg };

  if (!c.enabled) {
    return { want: false, reason: '主动画图已关闭', chance: 0 };
  }

  // 每日上限
  if (todayCount >= c.maxPerDay) {
    return { want: false, reason: `今天已画 ${todayCount} 张，达上限 ${c.maxPerDay}`, chance: 0 };
  }

  // 最小间隔
  const gapMs = c.minIntervalMinutes * 60 * 1000;
  const elapsed = now - (lastTs || 0);
  if (lastTs && elapsed < gapMs) {
    const leftMin = Math.ceil((gapMs - elapsed) / 60000);
    return { want: false, reason: `距上次才 ${Math.floor(elapsed / 60000)} 分钟，还差 ${leftMin} 分钟`, chance: c.chance };
  }

  // 概率
  const roll = random();
  if (roll >= c.chance) {
    return { want: false, reason: `没掷中（${(roll * 100).toFixed(1)}% ≥ ${(c.chance * 100).toFixed(1)}%）`, chance: c.chance };
  }

  return { want: true, reason: `掷中了（${(roll * 100).toFixed(1)}% < ${(c.chance * 100).toFixed(1)}%）`, chance: c.chance };
}

/**
 * 生成「想画图」的提示词片段，注入到 system 提示里。
 *
 * 注意：这里是「鼓励」，不是「命令」——
 * 让她自己判断当下话题适不适合画，比硬塞一张图自然得多。
 */
export function renderProactiveHint() {
  return (
    '【现在的一个小冲动】\n' +
    '你突然想画点什么给对方看。如果当下聊的话题适合（比如聊到动物、风景、吃的、心情），' +
    '就用 draw_image 画一张发过去，画之前不用说"我要画"，直接画完再说一句。' +
    '如果对方在说正经事、或者正在难过需要安慰，就别画，专心回话。'
  );
}
