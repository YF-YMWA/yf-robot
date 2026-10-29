/**
 * 主动搭话：判断「现在该不该找对方说话」。
 *
 * 设计：
 *   - 时间窗：只在合适的时段搭话（上班、深夜不打扰）
 *   - 频率：两次之间至少隔多久
 *   - 每日上限：一天最多几次
 *   - 冷却：刚聊过就别打扰
 *
 * 桥接只管「到点问一次」，具体该不该发交给这里判断。
 */

/** 默认配置。 */
export const CARE_DEFAULTS = {
  enabled: true,
  /** 两次搭话最少间隔（分钟） */
  minIntervalMinutes: 120,
  /** 每天最多几次 */
  maxPerDay: 3,
  /** 允许搭话的时段（24 小时制） */
  quietHours: { start: 23, end: 9 },
  /** 对方多久没说话才算「冷掉」（分钟） */
  idleMinutes: 60,
};

/**
 * 判断现在该不该主动搭话。
 *
 * @param {object} opts
 * @param {number} opts.lastTs 上次搭话时间戳（毫秒），0 表示没搭过
 * @param {number} opts.sentToday 今天已搭话次数
 * @param {Date} [opts.now]
 * @param {object} [opts.cfg] 覆盖默认配置
 * @returns {{due: boolean, reason: string}}
 */
export function checkCareDue({ lastTs = 0, sentToday = 0, now = new Date(), cfg = {} } = {}) {
  const c = { ...CARE_DEFAULTS, ...cfg };

  if (!c.enabled) return { due: false, reason: '主动搭话已关闭' };

  const hour = now.getHours();
  const qs = c.quietHours?.start ?? 23;
  const qe = c.quietHours?.end ?? 9;

  // 安静时段：跨午夜或同日
  const inQuiet = qs <= qe ? hour >= qs && hour < qe : hour >= qs || hour < qe;
  if (inQuiet) {
    return { due: false, reason: `安静时段（${qs}:00-${qe}:00）` };
  }

  if (sentToday >= c.maxPerDay) {
    return { due: false, reason: `今天已搭话 ${sentToday} 次（上限 ${c.maxPerDay}）` };
  }

  if (lastTs > 0) {
    const elapsedMin = (now.getTime() - lastTs) / 60000;
    if (elapsedMin < c.minIntervalMinutes) {
      const wait = Math.ceil(c.minIntervalMinutes - elapsedMin);
      return { due: false, reason: `距上次 ${Math.floor(elapsedMin)} 分钟，还需等 ${wait} 分钟` };
    }
  }

  return { due: true, reason: '可以搭话' };
}

/**
 * 生成搭话内容。
 *
 * 不调模型，用模板 + 时间/天气感知拼一句。
 * 调模型会让桥接等太久，而且搭话本来就不需要多复杂。
 *
 * @param {object} opts
 * @param {string} [opts.persona] 角色名
 * @param {Date} [opts.now]
 * @param {function} [opts.pick] 随机选择函数（测试可注入）
 * @returns {string}
 */
export function composeCare({ persona = '', now = new Date(), pick = defaultPick } = {}) {
  const hour = now.getHours();
  const minutes = now.getMinutes();

  let slot;
  if (hour >= 5 && hour < 9) slot = 'morning';
  else if (hour >= 9 && hour < 12) slot = 'forenoon';
  else if (hour >= 12 && hour < 14) slot = 'noon';
  else if (hour >= 14 && hour < 18) slot = 'afternoon';
  else if (hour >= 18 && hour < 22) slot = 'evening';
  else slot = 'night';

  const lines = CARE_LINES[slot] || CARE_LINES.night;
  return pick(lines);
}

function defaultPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 按时段分的搭话模板。 */
export const CARE_LINES = {
  morning: [
    '早，醒了没？',
    '起了吗，该吃早饭了',
    '早上好，今天什么安排',
  ],
  forenoon: [
    '上午忙吗？',
    '在干啥呢',
    '刚忙完一阵，歇会儿',
  ],
  noon: [
    '中午了，吃饭没？',
    '午饭吃了什么',
    '别忘了吃饭',
  ],
  afternoon: [
    '下午犯困了吧',
    '这会儿在忙什么',
    '午后有点懒，你呢',
  ],
  evening: [
    '晚上好，今天怎么样',
    '吃晚饭了吗',
    '忙了一天，累不累',
  ],
  night: [
    '还没睡呢？',
    '这么晚了，早点休息',
    '夜深了，别熬太久',
  ],
};
