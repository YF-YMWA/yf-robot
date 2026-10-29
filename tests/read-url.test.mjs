/**
 * read_url：能读网页正文，但不能读内网。
 *
 * 用户原话：「无法打开你给的 http 链接，依旧只能看外表不能读取内容」。
 * 以前根本没有抓网页的能力，她只能回「你发我看看」。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { ToolKit } from '../core/tools.mjs';

function kit() {
  return new ToolKit({
    config: { tools: { enabled: true, off: [] } },
    sandbox: '.tmp',
    logger: { info() {}, warn() {} },
  });
}

test('工具表里有 read_url', () => {
  const defs = kit().definitions().map((d) => (d.function || d).name);
  assert.ok(defs.includes('read_url'), '没有 read_url 就还是「只能看外表」');
});

test('拒绝非 http 协议（file:// 之类）', async () => {
  const out = await kit().run('read_url', { url: 'file:///C:/Windows/win.ini' }, { isOwner: true });
  assert.match(out, /只支持 http/);
});

test('拒绝本机 / 内网地址（不当内网探针）', async () => {
  const k = kit();
  for (const url of [
    'http://127.0.0.1:8899/console',
    'http://localhost:8899/',
    'http://192.168.1.1/',
    'http://10.0.0.1/',
  ]) {
    const out = await k.run('read_url', { url }, { isOwner: true });
    assert.match(out, /内网|本机/, `${url} 应该被拒绝，实际：${out}`);
  }
});

test('链接格式不对时给明白话', async () => {
  const out = await kit().run('read_url', { url: '这不是链接' }, { isOwner: true });
  assert.match(out, /格式不对/);
});

test('真网页能读出正文，且不掺 CSS', async (t) => {
  const out = await kit().run('read_url', { url: 'https://www.baidu.com' }, { isOwner: true });

  // 网络不通时跳过，别让离线环境误报
  if (/打开失败|打不开/.test(out)) {
    t.skip('当前网络访问不了这个站点：' + out.slice(0, 40));
    return;
  }

  assert.ok(out.length > 30, '应该读出一些正文');
  assert.ok(!/font-size:|html\{/.test(out), 'CSS 不该混进正文');
  assert.ok(!/<script|<style/i.test(out), '标签不该留着');
});
