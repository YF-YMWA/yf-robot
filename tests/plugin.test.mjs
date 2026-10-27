/**
 * 插件系统单元测试。
 *
 * 覆盖：加载、三种导出写法、工具调用、名字冲突、钩子串联、
 *       钩子拦截、出错隔离、禁用、数据读写。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { PluginHost } from '../core/plugins.mjs';

const TMP = path.join(process.cwd(), '.tmp', 'plugin-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

/** 造一个插件 */
function makePlugin(id, { manifest = {}, code = '' } = {}) {
  const dir = path.join(TMP, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ name: id, version: '1.0.0', ...manifest }),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'index.mjs'), code, 'utf8');
}

const host = () => new PluginHost({ root: TMP, config: {}, log: () => {} });

test('加载：没有 plugins 目录也不报错', async () => {
  const empty = path.join(TMP, 'nothing');
  fs.mkdirSync(empty, { recursive: true });
  const h = new PluginHost({ root: empty, config: {}, log: () => {} });
  await h.load();
  assert.deepEqual(h.list(), []);
});

test('加载：缺 plugin.json 的目录被跳过', async () => {
  fs.mkdirSync(path.join(TMP, 'plugins', 'no-manifest'), { recursive: true });
  const h = host();
  await h.load();
  assert.equal(h.list().find((x) => x.id === 'no-manifest'), undefined);
});

test('加载：正常插件，支持 tools 对象写法', async () => {
  makePlugin('ok-object', {
    manifest: { tools: [{ name: 'greet', description: '打招呼' }] },
    code: `export const tools = { greet: () => '你好呀' };`,
  });
  const h = host();
  await h.load();
  const p = h.list().find((x) => x.id === 'ok-object');
  assert.equal(p.state, 'loaded');
  assert.equal(await h.runTool('greet'), '你好呀');
});

test('加载：支持 tools_xxx 函数写法', async () => {
  makePlugin('ok-fn', {
    manifest: { tools: [{ name: 'ping', description: 'pong' }] },
    code: `export function tools_ping() { return 'pong'; }`,
  });
  const h = host();
  await h.load();
  assert.equal(await h.runTool('ping'), 'pong');
});

test('加载：支持同名顶层函数', async () => {
  makePlugin('ok-top', {
    manifest: { tools: [{ name: 'echo', description: '回显' }] },
    code: `export function echo(a) { return 'echo:' + (a.q || ''); }`,
  });
  const h = host();
  await h.load();
  assert.equal(await h.runTool('echo', { q: 'hi' }), 'echo:hi');
});

test('工具：清单声明了但没实现的不进索引', async () => {
  makePlugin('missing-impl', {
    manifest: { tools: [{ name: 'ghost', description: '不存在' }] },
    code: `export const tools = {};`,
  });
  const h = host();
  await h.load();
  assert.equal(h.hasTool('ghost'), false);
});

test('工具：同名冲突时加插件前缀', async () => {
  makePlugin('dup-a', {
    manifest: { tools: [{ name: 'same', description: 'A' }] },
    code: `export const tools = { same: () => 'A' };`,
  });
  makePlugin('dup-b', {
    manifest: { tools: [{ name: 'same', description: 'B' }] },
    code: `export const tools = { same: () => 'B' };`,
  });
  const h = host();
  await h.load();
  const names = h.definitions().map((d) => d.function.name);
  assert.ok(names.includes('same'));
  assert.ok(names.includes('dup-b_same'), '冲突的那个应该加前缀');
});

test('工具：执行出错返回一句话，不抛异常', async () => {
  makePlugin('boom', {
    manifest: { tools: [{ name: 'explode', description: '炸' }] },
    code: `export const tools = { explode: () => { throw new Error('炸了'); } };`,
  });
  const h = host();
  await h.load();
  const r = await h.runTool('explode');
  assert.match(r, /出错了/);
  assert.match(r, /炸了/);
});

test('工具：调用不存在的工具返回提示，不抛', async () => {
  const h = host();
  await h.load();
  const r = await h.runTool('no_such_tool');
  assert.match(r, /没有这个工具/);
});

test('钩子：onMessage 能改写消息', async () => {
  makePlugin('rewriter', {
    code: `export function onMessage(p) { return p.text === '旧' ? '新' : undefined; }`,
  });
  const h = host();
  await h.load();
  const outs = await h.runHook('onMessage', { text: '旧' });
  const hit = outs.find((o) => o.id === 'rewriter');
  assert.equal(hit.result, '新');
});

test('钩子：返回 undefined 表示不干预', async () => {
  makePlugin('silent', {
    code: `export function onMessage() { return undefined; }`,
  });
  const h = host();
  await h.load();
  const outs = await h.runHook('onMessage', { text: '随便' });
  const hit = outs.find((o) => o.id === 'silent');
  assert.equal(hit.result, undefined);
});

test('钩子：一个插件抛错不影响别人', async () => {
  makePlugin('bad-hook', {
    code: `export function onMessage() { throw new Error('我坏了'); }`,
  });
  makePlugin('good-hook', {
    code: `export function onMessage() { return '我还在'; }`,
  });
  const h = host();
  await h.load();
  const outs = await h.runHook('onMessage', { text: 'x' });
  assert.equal(outs.find((o) => o.id === 'good-hook')?.result, '我还在');
});

test('禁用：状态存盘，重新加载后不加载该插件', async () => {
  makePlugin('toggle-me', {
    manifest: { tools: [{ name: 'tm', description: 'x' }] },
    code: `export const tools = { tm: () => 'on' };`,
  });
  const h1 = host();
  await h1.load();
  assert.ok(h1.hasTool('tm'));

  const r = h1.setEnabled('toggle-me', false);
  assert.equal(r.ok, true);

  const h2 = host();
  await h2.load();
  const p = h2.list().find((x) => x.id === 'toggle-me');
  assert.equal(p.state, 'disabled');
  assert.equal(h2.hasTool('tm'), false);
});

test('数据：插件能读写自己的 JSON，互相隔离', async () => {
  makePlugin('store-a', {
    manifest: { tools: [{ name: 'sa', description: 'x' }] },
    code: `
      export const tools = {
        sa: (args, ctx) => {
          const n = ctx.loadData('n', 0) + 1;
          ctx.saveData('n', n);
          return String(n);
        },
      };
    `,
  });
  const h = host();
  await h.load();
  assert.equal(await h.runTool('sa'), '1');
  assert.equal(await h.runTool('sa'), '2');
  assert.ok(fs.existsSync(path.join(TMP, 'data', 'plugin-data', 'store-a', 'n.json')));
});

test('加载失败：语法错误的插件标记 error，不影响其他插件', async () => {
  makePlugin('syntax-err', { code: `export const tools = { ;;; }` });
  makePlugin('still-ok', {
    manifest: { tools: [{ name: 'fine', description: 'x' }] },
    code: `export const tools = { fine: () => 'ok' };`,
  });
  const h = host();
  await h.load();
  assert.equal(h.list().find((x) => x.id === 'syntax-err').state, 'error');
  assert.equal(await h.runTool('fine'), 'ok');
});
