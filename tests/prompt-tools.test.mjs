/**
 * 文字协议（给不支持 function calling 的模型用）。
 *
 * 存在的原因：用户换了个非 DeepSeek 的 Key，那家不支持 tools 字段。
 * 上一版直接降级成纯聊天 —— 能说话，但发图、收藏、搜索、改设置全没了。
 * 这一版让模型用文字写 {{tool:名字 {...}}}，我们解析执行，能力基本不丢。
 *
 * 对比 whale_gril：它干脆不依赖模型决定能力，全由代码规则判断
 * （能用的模型多，但模型没法自己判断「这里该搜一下」）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { renderToolSpec, parseToolCalls, stripToolCalls } from '../core/prompt-tools.mjs';

const DEFS = [
  {
    type: 'function',
    function: {
      name: 'send_image',
      description: '把素材库里的图发给对方',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['stickers'] } },
        required: ['name'],
      },
    },
  },
];

// ---------- 提示词 ----------
test('提示词：把工具写成人能看懂的调用格式', () => {
  const spec = renderToolSpec(DEFS);

  assert.match(spec, /【可以做的事】/);
  assert.match(spec, /\{\{tool:工具名/);
  assert.match(spec, /send_image\(name:string/);
  assert.match(spec, /required|name:string/, '必填参数不用 ? 前缀');
});

test('提示词：没有工具时返回空串（不污染上下文）', () => {
  assert.equal(renderToolSpec([]), '');
  assert.equal(renderToolSpec(null), '');
});

// ---------- 解析 ----------
test('解析：标准写法', () => {
  const calls = parseToolCalls('给你 {{tool:send_image {"name":"stk_a.gif"}}} 接住');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'send_image');
  assert.deepEqual(calls[0].args, { name: 'stk_a.gif' });
});

test('解析：没有参数也能调', () => {
  const calls = parseToolCalls('{{tool:list_stickers}}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'list_stickers');
  assert.deepEqual(calls[0].args, {});
});

test('解析：模型写成方括号也认', () => {
  const calls = parseToolCalls('[[tool:search_web {"query":"天气"}]]');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'search_web');
  assert.deepEqual(calls[0].args, { query: '天气' });
});

test('解析：一次写多个', () => {
  const calls = parseToolCalls(
    '{{tool:list_stickers {}}} 然后 {{tool:send_image {"name":"a.gif"}}}',
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => c.name),
    ['list_stickers', 'send_image'],
  );
});

test('解析：参数写坏不崩，标记成 parseError', () => {
  const calls = parseToolCalls('{{tool:send_image {name: 说错了}}}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'send_image');
  assert.ok(calls[0].parseError, '应该标出参数解析失败，而不是静默丢掉');
});

test('解析：普通回复里没有标记就返回空', () => {
  assert.deepEqual(parseToolCalls('在的，什么事'), []);
  assert.deepEqual(parseToolCalls(''), []);
});

// ---------- 清理 ----------
test('清理：标记不发给用户看', () => {
  const clean = stripToolCalls('喏，给你 {{tool:send_image {"name":"a.gif"}}} 接住');
  assert.ok(!clean.includes('{{tool'), '标记必须去掉');
  assert.match(clean, /喏，给你/);
  assert.match(clean, /接住/);
});

test('清理：只有标记时返回空串', () => {
  assert.equal(stripToolCalls('{{tool:send_image {"name":"a.gif"}}}'), '');
});

test('清理：不会误删正常花括号', () => {
  const s = '这个 { 不是工具 } 调用';
  assert.equal(stripToolCalls(s), s);
});
