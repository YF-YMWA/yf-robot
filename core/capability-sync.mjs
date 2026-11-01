/**
 * 能力表自动同步：逻辑库里的「能力说明」从实际工具表生成。
 *
 * 为什么不用写死的人格约束：
 *   写死两句话能治「她否认能发语音」，但下次加插件、加工具又要手写一遍，
 *   而且写多了会挤占人设、还可能互相打架。
 *   真正的解法是：她「知道的能力」= 她「实际有的工具」，由工具表自动推出来。
 *
 * 做法：
 *   1. 启动时（以及插件加载后）读工具表（ToolKit.spec()）
 *   2. 为每个工具生成/刷新一条逻辑库经验（source=capability，标题=工具中文名）
 *   3. 工具被删掉时，对应条目自动标记 stale（不删，免得用户手改的丢失）
 *   4. 只更新本模块生成的那批（source=capability），不碰用户自己的经验
 */
import fs from 'node:fs';

const MARK = 'capability';

/** 从工具定义里取一句人话描述 */
function describe(tool) {
  const name =
    tool?.name || tool?.function?.name || tool?.id || tool?.tool ||
    (typeof tool === 'string' ? tool : '') || '';
  const desc = String(tool?.description || '').split('\n')[0].trim();
  return desc || name;
}

/**
 * 同步逻辑库。
 *
 * @param {object} logic  LogicLibrary
 * @param {object[]} tools ToolKit.spec() 的结果
 * @param {{log?:Function}} [opts]
 * @returns {{added:number, updated:number, staled:number}}
 */
export function syncCapabilities(logic, tools, opts = {}) {
  const log = opts.log || (() => {});
  const res = { added: 0, updated: 0, staled: 0 };
  if (!logic || !Array.isArray(tools) || !tools.length) return res;

  let existing = [];
  try {
    existing = logic.list?.() || [];
  } catch {
    existing = [];
  }

  const mine = new Map();
  for (const r of existing) {
    if (r.source === MARK) mine.set(String(r.title || ''), r);
  }

  const alive = new Set();

  for (const t of tools) {
    // 名字取不到就跳过：以前会生成「能力：undefined」这种脏数据
    const _nm = t?.name || t?.function?.name || t?.id || t?.tool || (typeof t === 'string' ? t : '');
    if (!_nm) continue;
    const title = `能力：${_nm}`;
    alive.add(title);
    const rule =
      `你有能力「${t.name}」：${describe(t)}。` +
      `\n想用就直接调用它；不要回答「我做不到」「系统没给我这个权限」——` +
      `有没有这个能力以工具列表为准。` +
      `\n如果调用失败，按工具返回的原因说明（例如「微信没在前台」），不要说成「我没有这个能力」。`;

    const old = mine.get(title);
    try {
      if (!old) {
        const r = logic.add({ title, rule, source: MARK, builtin: true });
        if (r?.ok) res.added++;
      } else if (String(old.rule || '') !== rule) {
        // 描述变了（插件升级）→ 更新正文
        if (typeof logic.update === 'function') {
          logic.update(old.id, { rule });
          res.updated++;
        }
      }
    } catch {
      /* 单条失败不影响其它 */
    }
  }

  // 工具没了 → 标记失效（不删）
  for (const [title, r] of mine) {
    if (alive.has(title)) continue;
    try {
      if (typeof logic.disable === 'function' && r.enabled !== false) {
        logic.disable(r.id);
        res.staled++;
      }
    } catch {}
  }

  if (res.added || res.updated || res.staled) {
    log(
      `[capability] 能力表同步：新增 ${res.added}、更新 ${res.updated}、失效 ${res.staled}`,
    );
  }
  return res;
}
