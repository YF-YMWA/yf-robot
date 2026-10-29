/**
 * 上传素材后自动打标签。
 *
 * 真实问题：面板里上传的动图，文件进了目录但索引里 tags 和 desc 都是空的 ——
 * 因为上传接口只写文件、从没调用过视觉识别。挑图是靠标签匹配语气的，
 * 没标签就等于「收了但永远不用」。
 *
 * 第二个坑：给打标签用的提示词写死了格式（「格式固定：X，Y，Z」+ 情绪只能从词表选），
 * glm-4v-flash 直接回一个特殊标记 <|observation|>，于是「识别成功但描述为空」。
 * 换成普通的一句话描述就正常了。
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
    signal: AbortSignal.timeout(120000),
  });
  return r.json().catch(() => ({}));
}

test('索引里每张素材都有标签（没有「收了但不打标签」的）', async (t) => {
  if (!(await alive())) {
    t.skip('服务没在跑');
    return;
  }

  const dir = path.join(process.cwd(), 'data', 'stickers');
  const files = fs.readdirSync(dir).filter((n) => /\.(gif|png|jpe?g|webp)$/i.test(n));
  if (!files.length) {
    t.skip('素材库是空的');
    return;
  }

  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const items = idx.items || idx;

  const untagged = files.filter((f) => {
    const e = items[f] || {};
    return !(e.tags && e.tags.length);
  });

  assert.deepEqual(untagged, [], '这些素材没有标签（挑图时永远选不中）：' + untagged.join(', '));
});

test('上传接口会返回识别结果（tags / desc）', async (t) => {
  if (!(await alive())) {
    t.skip('服务没在跑');
    return;
  }

  const dir = path.join(process.cwd(), 'data', 'stickers');
  const gif = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith('.gif'));
  if (!gif) {
    t.skip('没有动图可测');
    return;
  }

  const buf = fs.readFileSync(path.join(dir, gif));
  const j = await api('media/upload', { kind: 'stickers', data: buf.toString('base64') });

  assert.equal(j.ok, true, '上传本身应该成功');
  assert.ok(Array.isArray(j.tags), '返回里应该有 tags 字段');
  assert.equal(typeof j.message, 'string');

  // 有看图模型时应该识别成功；没配 Key 时允许失败但要说清原因
  if (j.tagged) {
    assert.ok(j.tags.length > 0, '识别成功就应该至少有一个标签');
  } else {
    assert.match(j.message, /没识别成功|打不了标签/, '失败要说清原因，不能静默');
  }
});

test('模型吐出的特殊标记会被清掉，不会当成描述', async (t) => {
  if (!(await alive())) {
    t.skip('服务没在跑');
    return;
  }

  const dir = path.join(process.cwd(), 'data', 'stickers');
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const items = idx.items || idx;

  const dirty = Object.entries(items).filter(([, e]) => /<\|[^|>]*\|>/.test(String(e.desc || '')));
  assert.deepEqual(dirty.map(([k]) => k), [], '描述里不该留着 <|observation|> 这类标记');
});
