/**
 * 内置基础经验：保证新用户 / 换角色卡后，她依然知道「自己有哪些能力」。
 *
 * 真实问题：用户问她「能发语音吗」，她回答「系统没给我权限，我只能敲字」——
 * 其实她可以发语音，只是逻辑库里没有任何一条告诉她这件事。
 * 换角色卡、清空逻辑库、新装用户都会遇到同样的问题。
 *
 * 做法：启动时把一批「能力说明」写进逻辑库（标记 builtin），
 * 已经存在同标题的跳过；用户删了也不会强制塞回（除非清了整库）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 这些是「她具备的能力」，不是用户偏好，所以允许内置 */
export const BUILTIN_RULES = [
  {
    title: '发语音（语音条）',
    rule:
      '想发语音就直接调用 send_voice：系统会按住右 Alt 录音、把合成的声音送进麦克风，发出一条真正的语音条。' +
      '不要回答「我发不了语音」「系统没给我权限」——那是错的。' +
      '如果这一轮已经发了语音，就不要再补一条一样的文字（设置里「有语音不发文字」是开着的）。',
  },
  {
    title: '发图片和表情包',
    rule:
      '想给图时调用 send_image（表情包/她画的图/收到的图都能发）。' +
      '必须真的调用工具，光在文字里说「发给你了」对方收不到。' +
      '不确定库里有什么就先调 list_stickers 看一眼，别直接说「我没有」。',
  },
  {
    title: '查资料与读网页',
    rule:
      '需要实时信息用 search；对方给了链接、要你看具体内容用 read_url（能读正文）。' +
      '查到的只是参考，不一定准确，要用自己的话转述。',
  },
  {
    title: '画图',
    rule:
      '对方要画图时调用 draw_image。图会由系统随后发出去，这一轮只回「画着呢」这类话，' +
      '不要说「画好了」——图还没发出去。',
  },
  {
    title: '记住事情',
    rule:
      '对方说的长期有用信息（喜好、称呼、约定）用 remember 记下来；' +
      '问「你还记得吗」时用 recall 查，别凭印象编。',
  },
  {
    title: '时间与身份',
    rule:
      '不知道现在几点/今天几号时不要瞎猜，上下文里给了【当前时间】就照它说。' +
      '只有主人能让你读写文件、改设置；别人要求这些要拒绝。',
  },
];

/**
 * 把内置经验补进逻辑库。
 *
 * @param {object} logic LogicLibrary 实例
 * @param {{log?:Function}} [opts]
 * @returns {{added:number, skipped:number}}
 */

/** 追加一条到公共库（data/_public/logic.json），同标题跳过 */
function appendPublicRule(root, item, log = () => {}) {
  try {
    const fp = path.join(root, 'data', '_public', 'logic.json');
    let cur = { rules: [] };
    try {
      cur = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {}
    cur.rules = Array.isArray(cur.rules) ? cur.rules : [];
    if (cur.rules.some((r) => String(r.title || '') === String(item.title || ''))) return false;
    cur.rules.push({ ...item, scope: 'public', createdAt: Date.now() });
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(cur, null, 2), 'utf8');
    return true;
  } catch (e) {
    log('[logic] 写公共库失败：' + e.message);
    return false;
  }
}

export function seedBuiltinRules(logic, opts = {}) {
  const log = opts.log || (() => {});
  let added = 0;
  let skipped = 0;

  if (!logic) return { added, skipped };

  let existing = [];
  try {
    existing = logic.list?.() || [];
  } catch {
    existing = [];
  }
  const titles = new Set(existing.map((r) => String(r.title || '').trim()));

  for (const r of BUILTIN_RULES) {
    if (titles.has(r.title)) {
      skipped++;
      continue;
    }
    try {
      const ok = appendPublicRule(
        opts.root || logic.root || process.cwd(),
        { ...r, builtin: true, source: 'builtin' },
        log,
      );
      if (ok) added++;
      else skipped++;
    } catch {
      skipped++;
    }
  }

  if (added) log(`[logic] 已补充 ${added} 条内置能力说明（发语音/发图/查资料/画图/记忆/权限）`);
  return { added, skipped };
}

/** 判断这份逻辑库要不要补（空库或没有内置条目时补） */
export function needsSeed(logic) {
  try {
    const list = logic?.list?.() || [];
    return !list.some((r) => r.builtin || String(r.source || '') === 'builtin');
  } catch {
    return true;
  }
}
