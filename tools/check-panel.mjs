/**
 * 面板自检：把这轮改动的面板功能逐项点一遍。
 *
 * 不只 grep 代码，还真去调接口 —— 只看「代码里有」不看「跑起来对不对」，
 * 之前就吃过这个亏（工具开关存了但没接上）。
 */
import fs from 'node:fs';

const T = fs.readFileSync('data/token.txt', 'utf8').trim();
const H = { 'x-local-token': T, 'content-type': 'application/json' };

const api = async (p, body) => {
  const r = await fetch('http://127.0.0.1:8899/api/admin/' + p, {
    method: body ? 'POST' : 'GET',
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

const html = fs.readFileSync('web/console.html', 'utf8');

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

// ---------- 1. 多适配器 ----------
{
  const j = await api('adapters');
  const list = j.adapters || [];
  check(
    '多适配器列表',
    j.ok !== false && Array.isArray(list),
    `返回 ${list.length} 个：` + list.map((a) => `${a.id}${a.running ? '(运行中)' : ''}`).join(', '),
  );
  check(
    '面板有适配器卡片',
    html.includes('loadAdapters') && html.includes('adapterStart') && html.includes('adapterStop'),
    html.includes('adapterStart') ? '有选择/启动/停止按钮' : '缺按钮',
  );
}

// ---------- 2. 素材清理 ----------
{
  const j = await api('media/clean', { kind: 'stickers', dryRun: true });
  check(
    '素材清理（可预览）',
    j.ok !== false,
    j.ok ? `扫描到 ${j.count ?? 0} 个不合格` : `错误：${j.error}`,
  );
  check('面板有清理按钮', html.includes('cleanMedia'), html.includes('清理') ? '' : '缺按钮');
}

// ---------- 3. 配置读写（工具开关 / 概率）----------
{
  const before = await api('config');
  const hasTools = before.tools !== undefined;
  const hasWechat = before.wechat !== undefined;
  check(
    '配置回显：tools + wechat',
    hasTools && hasWechat,
    `tools=${hasTools ? '有' : '**缺**'} wechat=${hasWechat ? '有' : '**缺**'}`,
  );

  // 工具开关存一次再读回来（这正好是 BUGS #12 的坑）
  const orig = before.tools?.enabled !== false;
  await api('config', { tools: { enabled: !orig } });
  const after = await api('config');
  const now = after.tools?.enabled !== false;
  await api('config', { tools: { enabled: orig } }); // 还原
  check('工具开关：存了能读回来', now === !orig, `写 ${!orig} → 读 ${now}（原值 ${orig}，已还原）`);
}

// ---------- 4. 发送健康度 ----------
{
  const j = await api('bridge');
  check(
    '接入状态：发送健康度',
    j.send !== undefined,
    j.send ? `成功 ${j.send.ok} / 失败 ${j.send.fail}` : '**还是 null**',
  );
  check('面板显示发送健康度', html.includes('发送 成功/失败') || html.includes('b.send'), '');
}

// ---------- 5. 记忆备份 ----------
{
  const j = await api('memory/snapshots');
  check('记忆快照列表', Array.isArray(j.list), `共 ${(j.list || []).length} 份`);
  check('面板/脚本：备份入口', fs.existsSync('备份记忆.bat') && fs.existsSync('恢复记忆.bat'), '两个 bat 都在');
}

// ---------- 6. 语音 Key 显示 ----------
{
  check(
    '语音 Key 不再写死「未配置」',
    !html.includes("'未配置'") || html.includes('共用'),
    html.includes('共用') ? '改为读真实状态' : '可能还写死',
  );
}

// ---------- 7. 工具列表 ----------
{
  check(
    '对话内管理工具存在',
    fs.readFileSync('core/tools.mjs', 'utf8').includes("name: 'admin_config'"),
    'admin_config / admin_media',
  );
}

// ---------- 输出 ----------
console.log('');
let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}` + (r.detail ? `  —  ${r.detail}` : ''));
}
console.log('');
console.log(`  通过 ${results.length - bad} / ${results.length}` + (bad ? `，**还有 ${bad} 项没过**` : '，全部正常'));
process.exit(bad ? 1 : 0);
