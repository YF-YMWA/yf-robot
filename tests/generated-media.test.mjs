/**
 * 「她画的图」列表为空的问题。
 *
 * 根因：存图和列图用的不是同一个目录。
 *   · 角色卡机制上线后，画图存到 data/<卡片>/generated
 *   · 但 config.imagegen.saveDir 仍是老的 data/generated
 *   · 面板「试画一张」走临时客户端（继承 config.saveDir）→ 存到根目录
 * 于是图确实画好了，面板上永远显示 0 张。
 *
 * 修法：存图一律按角色卡；列表把老目录一起合并（老图不丢）；
 *       读 / 删也都兼顾老目录。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8899';

function token() {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'data', 'token.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function alive() {
  try {
    const r = await fetch(BASE + '/api/adapter/config', { signal: AbortSignal.timeout(1500) });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function api(p, body) {
  const r = await fetch(BASE + '/api/admin/' + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-local-token': token(), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180000),
  });
  return r.json().catch(() => ({}));
}

test('她画的图：列表不能是空的（画过就必须看得到）', async (t) => {
  if (!(await alive())) {
    t.skip('服务没在跑');
    return;
  }

  const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  const card = cfg.card || 'dafeiyu';
  const scoped = path.join(process.cwd(), 'data', card, 'generated');
  const legacy = path.join(process.cwd(), 'data', 'generated');

  const onDisk =
    (fs.existsSync(scoped) ? fs.readdirSync(scoped).filter((n) => /\.(jpe?g|png)$/i.test(n)).length : 0) +
    (fs.existsSync(legacy) ? fs.readdirSync(legacy).filter((n) => /\.(jpe?g|png)$/i.test(n)).length : 0);

  if (!onDisk) {
    t.skip('本地一张图都没有，跳过');
    return;
  }

  const j = await api('media/generated');
  assert.ok(Array.isArray(j.items), '接口要返回 items 数组');
  assert.equal(
    j.items.length,
    onDisk,
    `磁盘上有 ${onDisk} 张，列表只给了 ${j.items.length} 张（说明目录没对上）`,
  );
});

test('画一张新图：存在角色卡目录，并且立刻出现在列表里', async (t) => {
  if (!(await alive())) {
    t.skip('服务没在跑');
    return;
  }

  const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  if (!cfg.imagegen?.enabled) {
    t.skip('画图功能没开');
    return;
  }

  const drawn = await api('test/imagegen', { prompt: '一只橘猫，简单卡通' });
  if (!drawn.ok) {
    t.skip('画图调用失败（可能是额度/Key 问题）：' + (drawn.error || '').slice(0, 40));
    return;
  }

  const name = drawn.names?.[0];
  assert.ok(name, '应该返回文件名');

  const card = cfg.card || 'dafeiyu';
  const inScoped = fs.existsSync(path.join(process.cwd(), 'data', card, 'generated', name));
  assert.equal(inScoped, true, '新画的图应该存在 data/<卡片>/generated 里');

  const list = await api('media/generated');
  assert.ok(
    list.items.some((i) => i.name === name),
    '刚画的图应该立刻出现在列表里',
  );
});

test('清空全部：老目录里的图也要算进去（预览数量 = 实际能删的数量）', async (t) => {
  if (!(await alive())) {
    t.skip('服务没在跑');
    return;
  }

  const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  const card = cfg.card || 'dafeiyu';
  const scoped = path.join(process.cwd(), 'data', card, 'generated');
  const legacy = path.join(process.cwd(), 'data', 'generated');

  const countIn = (d) =>
    fs.existsSync(d) ? fs.readdirSync(d).filter((n) => /\.(jpe?g|png)$/i.test(n)).length : 0;

  const onDisk = countIn(scoped) + countIn(legacy);

  const pre = await api('media/delete-all', { kind: 'generated', dryRun: true });
  assert.ok(pre.ok, '预览应该成功');
  assert.equal(
    pre.count,
    onDisk,
    `磁盘上有 ${onDisk} 张，预览只说 ${pre.count} 张（老目录没算进去就会点不动）`,
  );
});

test('清空全部：没有图时给出明白的结果，而不是失败', async (t) => {
  if (!(await alive())) {
    t.skip('服务没在跑');
    return;
  }

  // 先用预览确认当前是空的（上面那个测试删过，或者本来就空）
  const pre = await api('media/delete-all', { kind: 'generated', dryRun: true });
  if (pre.count > 0) {
    t.skip('库里还有图，跳过（避免误删）');
    return;
  }

  const r = await api('media/delete-all', { kind: 'generated', only: 'all' });
  assert.equal(r.ok, true, '空库清空不该算失败');
  assert.equal(r.deleted, 0);
  assert.match(String(r.message || ''), /没有可删/);
});
