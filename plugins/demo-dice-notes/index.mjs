/**
 * 示例插件：掷骰子 + 便签本。
 *
 * 这个插件存在的意义是「当模板」——想给她加功能时，照这个结构写就行：
 *   1. plugin.json 里声明工具有哪些（名字、说明、参数）
 *   2. index.mjs 里实现同名函数
 *   3. 想插手消息流程就导出 onMessage
 *
 * 它能用的东西都在 `ctx` 上：ctx.log / ctx.config / ctx.loadData / ctx.saveData /
 * ctx.fetch / ctx.now / ctx.dataDir。详见 docs/plugin-api.md。
 */

/** 每个插件导出这些内容（命名随意，运行时按名字找） */
export function onLoad(ctx) {
  ctx.log('示例插件已加载，数据目录：', ctx.dataDir);
}

/**
 * 工具：掷骰子。
 *
 * 模型会按 plugin.json 里的 parameters 传参进来。
 * 返回值会被当成工具结果喂回模型 —— 尽量用「人话」描述结果，
 * 模型读得懂才回答得像样。
 */
export function tools_roll_dice(args = {}) {
  const sides = Math.min(Math.max(Number(args.sides) || 6, 2), 1000);
  const times = Math.min(Math.max(Number(args.times) || 1, 1), 10);

  const rolls = [];
  for (let i = 0; i < times; i++) {
    rolls.push(1 + Math.floor(Math.random() * sides));
  }
  const sum = rolls.reduce((a, b) => a + b, 0);

  if (times === 1) return `${sides} 面骰子掷出：${rolls[0]}`;
  return `${sides} 面骰子掷 ${times} 次：${rolls.join('、')}（合计 ${sum}）`;
}

/** 工具：记便签 */
export function tools_save_note(args = {}, ctx) {
  const text = String(args.text || '').trim();
  if (!text) return '（没有内容可记）';

  const notes = ctx.loadData('notes', []);
  notes.push({ text, at: ctx.now().toISOString() });
  // 只留最近 200 条，别让文件无限长
  const kept = notes.slice(-200);
  const ok = ctx.saveData('notes', kept);

  return ok ? `已记下（第 ${kept.length} 条）：${text}` : '（记录失败，写文件出错）';
}

/** 工具：列出便签 */
export function tools_list_notes(_args = {}, ctx) {
  const notes = ctx.loadData('notes', []);
  if (!notes.length) return '便签本是空的';
  return notes
    .slice(-20)
    .map((n, i) => `${i + 1}. ${n.text}`)
    .join('\n');
}

/**
 * 钩子：消息进模型之前。
 *
 * 这里演示「改写消息」：把英文的 hi/hello 换成中文，
 * 让后面的流程按中文处理。返回字符串就是替换后的消息。
 *
 * 不需要改写就别返回东西（返回 undefined）。
 */
export function onMessage(payload) {
  const t = String(payload.text || '');
  if (/^(hi|hello|hey)\b/i.test(t.trim())) {
    return t.replace(/^(hi|hello|hey)\b/i, '你好');
  }
  return undefined;
}
