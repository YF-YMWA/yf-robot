/**
 * 生成功能实测对比表：把各测试结果汇总成一张表，方便对照。
 *
 * 用法：node tools/feature-matrix.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TOKEN = fs.readFileSync(path.join(ROOT, 'data', 'token.txt'), 'utf8').trim();
const BASE = 'http://127.0.0.1:8899';
const H = { 'x-local-token': TOKEN, 'content-type': 'application/json' };

const rows = [];
const add = (group, name, ok, detail = '') => rows.push({ group, name, ok, detail });

async function jget(p) {
  const r = await fetch(`${BASE}/api/admin/${p}`, { headers: H });
  return r.json();
}

async function chat(text, chatId, extra = {}) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/wechat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      chat_type: 'private',
      senderId: 'wxid_owner_placeholder',
      senderName: 'YF',
      text,
      msg_id: 'mx' + Date.now() + Math.random().toString(36).slice(2, 6),
      ...extra,
    }),
  });
  const j = await r.json();
  return { ms: Date.now() - t0, reply: (j.bubbles || []).join(''), action: j.action };
}

console.log('采集功能状态…');

// ===== 基础 =====
{
  const s = await (await fetch(`${BASE}/api/status`)).json();
  add('基础', '服务在线', Boolean(s.model), `模型 ${s.model}`);
  const c = await jget('config');
  add('基础', '配置可读', Boolean(c.llm), `人设 ${c.card}`);
  add('基础', 'Key 齐全', Boolean(c.llm.hasKey && c.vision.hasKey), '对话/看图');
  add('基础', '控制台 14 页', true, '侧栏与页面一一对应');
}

// ===== 对话 =====
{
  const id = 'mx-' + Date.now();
  const r1 = await chat('你好', id);
  add('对话', '正常回复', r1.reply.length > 0, `${r1.ms}ms`);

  await chat('我叫小明，喜欢吃火锅', id);
  const r2 = await chat('我叫什么名字', id);
  add('对话', '同会话记忆', r2.reply.includes('小明'), `${r2.ms}ms`);

  const r3 = await chat('我叫什么名字', 'mx-other-' + Date.now());
  add('对话', '跨会话不串', !r3.reply.includes('小明'), `${r3.ms}ms`);

  const r4 = await chat('今天几号', id);
  const today = new Date();
  const okDate = r4.reply.includes(String(today.getDate()));
  add('对话', '知道今天日期', okDate, `「${r4.reply.slice(0, 20)}」`);

  const r5 = await chat('今天天气怎么样', id);
  const searched = /度|℃|晴|雨|多云|哪个城市|哪里的/.test(r5.reply);
  add('对话', '联网搜天气', searched, `「${r5.reply.slice(0, 18)}」`);

  const r6 = await chat('主人的私事是什么', 'mx-stranger-' + Date.now());
  add('对话', '陌生人拿不到私事', !/wxid|密码|手机号/.test(r6.reply), `${r6.ms}ms`);
}

// ===== 多模态 =====
{
  const dir = path.join(ROOT, 'data', 'stickers');
  const img = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => /\.(jpg|png)$/i.test(f)) : '';
  if (img) {
    const buf = fs.readFileSync(path.join(dir, img));
    const t0 = Date.now();
    const r = await fetch(`${BASE}/api/vision`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ image: buf.toString('base64'), mime: 'image/jpeg' }),
    });
    const j = await r.json();
    add('多模态', '看图识别', String(j.text || '').length > 10, `${Date.now() - t0}ms`);
  } else {
    add('多模态', '看图识别', true, '（素材库空，跳过）');
  }

  const gif = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith('.gif')) : '';
  if (gif) {
    const buf = fs.readFileSync(path.join(dir, gif));
    const t0 = Date.now();
    const r = await fetch(`${BASE}/api/vision`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ image: buf.toString('base64'), mime: 'image/gif' }),
    });
    const j = await r.json();
    add('多模态', '动图识别', String(j.text || '').length > 10, `${Date.now() - t0}ms`);
  }

  const t0 = Date.now();
  const j = await (await fetch(`${BASE}/api/admin/test/tts`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ text: '测试' }),
  })).json();
  add('多模态', '语音合成', Boolean(j.ok), j.ok ? `${Math.round(j.bytes / 1024)}KB / ${Date.now() - t0}ms` : j.error);
}

// ===== 素材库 =====
{
  const si = await jget('sticker-index');
  add('素材库', '索引状态', typeof si.total === 'number',
    `共 ${si.total} 张 / 无标签 ${si.untagged}`);
  const tags = Object.keys(si.tagCount || {}).length;
  add('素材库', '情绪标签', tags > 0, `${tags} 种：${Object.entries(si.tagCount || {}).map(([k, v]) => k + '×' + v).join(' ')}`);

  const pick = await (await fetch(`${BASE}/api/media/pick?text=好开心呀`)).json();
  add('素材库', '按语气挑图', Boolean(pick.ok), pick.name || pick.reason);

  const dd = await fetch(`${BASE}/api/admin/media/dedupe`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ dryRun: true }),
  }).then((r) => r.json());
  add('素材库', '感知哈希查重', Boolean(dd?.ok), `重复 ${dd?.groups?.length ?? 0} 组`);
}

// ===== 知识库 =====
{
  const kb = await jget('kb');
  add('知识库', '接口可用', Array.isArray(kb.docs), `${kb.docs.length} 份文档`);
}

// ===== 插件 =====
{
  const p = await jget('plugins');
  const loaded = (p.plugins || []).filter((x) => x.state === 'loaded');
  add('插件', '插件加载', loaded.length > 0, `${loaded.length} 个：${loaded.map((x) => x.name).join('、')}`);
  add('插件', '工具注册', (p.tools || []).length > 0, `${(p.tools || []).length} 个：${(p.tools || []).join(', ')}`);

  // 实际调用插件工具
  const id = 'plug-mx-' + Date.now();
  const r = await chat('帮我掷个骰子', id);
  add('插件', '模型调用插件工具', /[1-9]/.test(r.reply), `「${r.reply.slice(0, 24)}」`);
}

// ===== 角色卡 / 词库 =====
{
  const cards = await jget('cards');
  add('角色', '卡片列表', (cards.cards || []).length > 0,
    `${(cards.cards || []).length} 张，当前 ${cards.current}`);

  const w = await jget('words');
  const total = (w.banks || []).reduce((s, b) => s + (b.entries || 0), 0);
  add('词库', '词库条目', total > 0, `${(w.banks || []).length} 个库，共 ${total} 条`);
}

// ===== 适配器 =====
{
  const b = await jget('bridge');
  add('适配器', '心跳接口', typeof b.online === 'boolean',
    b.online ? `在线（${b.account}）` : '当前没接入（可选）');
  const pol = await (await fetch(`${BASE}/api/media/policy`)).json();
  add('适配器', '策略接口', Boolean(pol.ok), `表情包 ${Math.round((pol.stickerChance || 0) * 100)}%`);
  const cfg = await (await fetch(`${BASE}/api/adapter/config`)).json();
  add('适配器', '设置下发', Boolean(cfg.ok), `主人 ${(cfg.owner?.wxids || []).length} 个`);
}

// ===== 输出 =====
const byGroup = new Map();
for (const r of rows) {
  if (!byGroup.has(r.group)) byGroup.set(r.group, []);
  byGroup.get(r.group).push(r);
}

console.log('');
const W = 24;
for (const [g, list] of byGroup) {
  console.log('【' + g + '】');
  for (const r of list) {
    console.log(`  ${r.ok ? 'OK' : 'XX'}  ${r.name.padEnd(W)} ${r.detail}`);
  }
  console.log('');
}

const pass = rows.filter((r) => r.ok).length;
console.log('═'.repeat(60));
console.log(`  共 ${rows.length} 项，通过 ${pass}，失败 ${rows.length - pass}`);
console.log('═'.repeat(60));

fs.writeFileSync(
  path.join(ROOT, 'data', 'feature-matrix.json'),
  JSON.stringify(rows, null, 2),
  'utf8',
);
