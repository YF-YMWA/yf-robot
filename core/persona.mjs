/**
 * 人设层：把角色定义渲染成提示词。
 *
 * 设计原则：
 *   - 人设是数据，不是代码。所有性格、口癖、禁忌都写在 persona.json 里
 *   - 渲染是纯函数，可单独测试
 *   - 支持动态变量（时间、称呼、关系）
 */
import fs from 'node:fs';

/** 人设默认值，用户配置只需覆盖差异部分。 */
export const PERSONA_DEFAULTS = {
  name: '助手',
  /** 对话者称呼 */
  ownerName: '你',
  /** 一句话定位 */
  identity: '',
  /** 外貌（可选，影响说话风格时才有用） */
  appearance: '',
  /** 性格描述 */
  personality: '',
  /** 背景故事 */
  background: '',
  /** 说话风格：长度偏好、口癖、语气 */
  speech: {
    /** 回复长度倾向 */
    length: 'short',
    /** 常用口头词 */
    catchphrases: [],
    /** 语气词 */
    particles: [],
    /** 是否使用表情/颜文字 */
    emoji: false,
  },
  /** 行为准则 */
  rules: [],
  /** 明确禁止 */
  forbidden: [],
};

/**
 * 加载人设文件。
 * @param {string} file
 * @returns {object} 合并了默认值的人设
 */
export function loadPersona(file) {
  let user = {};
  try {
    const raw = fs.readFileSync(file, 'utf8');
    user = JSON.parse(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`人设文件读取失败: ${e.message}`);
    // 没有文件就用默认
  }
  return mergePersona(PERSONA_DEFAULTS, user);
}

function mergePersona(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (k.startsWith('_')) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 长度偏好 → 提示词描述 */
const LENGTH_HINT = {
  short: '每次回复控制在一两句话内，不超过 60 字。',
  medium: '每次回复两三句话，不超过 120 字。',
  long: '可以说得详细些，但不超过 300 字。',
};

/**
 * 渲染系统提示词。
 * @param {object} persona
 * @param {object} [ctx] 上下文
 * @param {string} [ctx.ownerName] 当前对话者称呼（覆盖人设默认）
 * @param {Date} [ctx.now] 当前时间
 * @param {boolean} [ctx.isOwner] 是否是主人
 * @returns {string}
 */
export function renderSystemPrompt(persona, ctx = {}) {
  const ownerName = ctx.ownerName || persona.ownerName || '你';
  const now = ctx.now || new Date();
  const lines = [];

  // 身份
  if (persona.identity) {
    lines.push(persona.identity);
  } else {
    lines.push(`你是「${persona.name}」，正在和${ownerName}聊天。`);
  }

  if (persona.appearance) {
    lines.push(`【外貌】${persona.appearance}`);
  }
  if (persona.personality) {
    lines.push(`【性格】${persona.personality}`);
  }
  if (persona.background) {
    lines.push(`【背景】${persona.background}`);
  }

  // 说话风格
  const speech = persona.speech || {};
  const styleParts = [];
  if (LENGTH_HINT[speech.length]) styleParts.push(LENGTH_HINT[speech.length]);
  if (speech.particles?.length) styleParts.push(`偶尔带语气词：${speech.particles.join('、')}。`);
  if (speech.catchphrases?.length) styleParts.push(`常用口语：${speech.catchphrases.join('、')}，但不要每句都用。`);
  // 只有卡片明确指定时才加 emoji 的说明，否则不干预（由全局表情开关控制）
  if (speech.emoji === true) styleParts.push('可以偶尔用一个 emoji 或颜文字。');
  else if (speech.emoji === false) styleParts.push('不使用 emoji 和颜文字。');

  if (styleParts.length) lines.push('【说话风格】\n' + styleParts.map((s) => '- ' + s).join('\n'));

  // 行为准则
  if (persona.rules?.length) {
    lines.push('【行为准则】\n' + persona.rules.map((r) => '- ' + r).join('\n'));
  }

  // 禁止项（含通用项）
  //
  // 「不许自称助手/AI」这条以前只写在某张卡里，换张卡就没约束了，
  // 实测她会说「我是大肥鱼，你的助手啊」。所以在代码层兜底，
  // 不依赖人设文件写没写。
  const forbidden = [
    '不要用 Markdown 格式（星号加粗、井号标题、代码围栏都不行）',
    '要给代码时，把代码写进文件（用 write_file 工具），回复里只说「写好放在 xxx」和一两句要点，不要贴大段代码到聊天里',
    '不要在回复开头写自己的名字或加冒号',
    '不要用「助手」「AI」「人工智能」「模型」这类词介绍自己。人设里如果提到「助手」，那指的是职责，不是自称——被问「你是谁」时直接说名字和自己是什么（比如「我是那条蓝色大肥鱼」），不要加「助手」这个词',
    '想表达自己顶用，就说具体能干什么（写代码、查资料），别给自己贴标签',
    '不要解释自己在做什么（「我来帮你…」「让我想想…」这类一律不要）',
    '动作或神态描写不要句句都有，最多每三四条出现一次；同一个动作不要反复用（老写「尾巴拍了拍」「挪了挪」会像模板）',
    '不要每条都答得完整漂亮；可以只回一两个字（嗯、在、等会儿），也可以说一半停下',
    ...(persona.forbidden || []),
  ];
  lines.push('【不要做】\n' + forbidden.map((r) => '- ' + r).join('\n'));

  // 环境信息
  lines.push(`【当前时间】${formatTime(now)}`);

  if (ctx.isOwner === false) {
    lines.push('【注意】对方不是你的主人。保持礼貌但有距离，不要过度亲近。');
  }

  return lines.join('\n\n');
}

/**
 * 生成开场白。
 * @param {object} persona
 * @returns {string}
 */
export function greeting(persona) {
  if (persona.greeting) return persona.greeting;
  return `我是${persona.name}。`;
}

/** 格式化时间为可读中文。 */
export function formatTime(date) {
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${week} ${hh}:${mm}`;
}

/**
 * 从人设里取出用于展示的摘要。
 * @param {object} persona
 */
export function personaSummary(persona) {
  return {
    name: persona.name,
    identity: persona.identity || persona.personality || '',
    length: persona.speech?.length || 'short',
    emoji: Boolean(persona.speech?.emoji),
  };
}
