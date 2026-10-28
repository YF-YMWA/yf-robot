/**
 * 管理工具（主人专用）的测试。
 *
 * 用户反馈「对话里让她清理素材库 / 改概率，现在不行了」——
 * 查下来工具表里根本没有管理类工具。补了之后这里锁住行为：
 *   · 只有主人能调（非主人返回拒绝语）
 *   · 白名单外的字段不给改
 *   · 改完的值会同步进配置对象
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { ToolKit } from '../core/tools.mjs';

function makeKit(overrides = {}) {
  const config = {
    root: process.cwd(),
    wechat: { voiceChance: 0.2, stickerChance: 0.5 },
    reply: { maxBubbles: 3, maxChars: 500 },
    tools: { enabled: true, off: [] },
    care: { enabled: true },
    ...overrides,
  };

  let saved = null;
  const kit = new ToolKit({
    config,
    sandbox: 'agent-workspace',
    logger: { info() {}, warn() {} },
    adminSaveConfig: async (patch) => {
      saved = patch;
      // 模拟 admin：#saveConfig 会把值合并进 config
      if (patch.wechat) Object.assign(config.wechat, patch.wechat);
      if (patch.reply) Object.assign(config.reply, patch.reply);
      if (patch.tools) Object.assign(config.tools, patch.tools);
      if (patch.care) Object.assign(config.care, patch.care);
      return { ok: true };
    },
    adminCleanMedia: async () => ({ ok: true, dryRun: true, count: 0, items: [] }),
  });

  return { kit, config, getSaved: () => saved };
}

test('读取：不带 value 时返回当前设置', async () => {
  const { kit } = makeKit();
  const out = await kit.run('admin_config', {}, { isOwner: true });
  assert.match(out, /表情包概率 50%/);
  assert.match(out, /语音概率 20%/);
});

test('修改：表情包概率可以改', async () => {
  const { kit, config, getSaved } = makeKit();
  const out = await kit.run('admin_config', { key: 'stickerChance', value: '10%' }, { isOwner: true });

  assert.match(out, /改好了/);
  assert.equal(config.wechat.stickerChance, 0.1);
  assert.deepEqual(getSaved().wechat, { stickerChance: 0.1 });
});

test('修改：百分数和小数都接受', async () => {
  const { kit, config } = makeKit();
  await kit.run('admin_config', { key: 'voiceChance', value: '0.3' }, { isOwner: true });
  assert.equal(config.wechat.voiceChance, 0.3);

  await kit.run('admin_config', { key: 'voiceChance', value: '30' }, { isOwner: true });
  assert.equal(config.wechat.voiceChance, 0.3);
});

test('修改：气泡数会被夹在 1~6', async () => {
  const { kit, config } = makeKit();
  await kit.run('admin_config', { key: 'maxBubbles', value: '99' }, { isOwner: true });
  assert.equal(config.reply.maxBubbles, 6);
});

test('白名单外：Key 这类字段不给改', async () => {
  const { kit } = makeKit({ llm: { apiKey: 'sk-secret' } });
  const out = await kit.run('admin_config', { key: 'llm.apiKey', value: 'x' }, { isOwner: true });
  assert.match(out, /不给改/);
});

test('非主人：拒绝执行', async () => {
  const { kit, config } = makeKit();
  const out = await kit.run('admin_config', { key: 'stickerChance', value: '0' }, { isOwner: false });

  assert.match(out, /只有主人/);
  assert.equal(config.wechat.stickerChance, 0.5, '非主人不能改');
});

test('素材：stats 返回张数', async () => {
  const { kit } = makeKit();
  const out = await kit.run('admin_media', { action: 'stats' }, { isOwner: true });
  assert.match(out, /素材库/);
});

test('素材：非主人不能清理', async () => {
  const { kit } = makeKit();
  const out = await kit.run('admin_media', { action: 'clean' }, { isOwner: false });
  assert.match(out, /只有主人/);
});

test('素材：dryRun 没东西可清时说清楚', async () => {
  const { kit } = makeKit();
  const out = await kit.run('admin_media', { action: 'dryRun' }, { isOwner: true });
  assert.match(out, /没有不合格|会清理/);
});
