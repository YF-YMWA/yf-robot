/**
 * 核心层单元测试。不启动服务、不调真实模型。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { stripMarkdown, toBubbles, shapeReply, needsRewrite } from '../core/reply.mjs';
import { extractFacts, isEcho, Session } from '../core/session.mjs';
import { renderSystemPrompt, formatTime, loadPersona, PERSONA_DEFAULTS } from '../core/persona.mjs';
import { deepMerge, getByPath, setByPath, loadConfig, validate, DEFAULTS } from '../core/config.mjs';
import { inspectOutput, parseSseStream } from '../core/llm.mjs';

// ---------- reply ----------

test('stripMarkdown 清除常见标记', () => {
  const input = '**粗体** 和 `代码`\n```js\nconsole.log(1)\n```\n# 标题\n- 列表项\n[链接](http://a.com)';
  const out = stripMarkdown(input);
  assert.ok(!out.includes('**'), '应清除粗体');
  assert.ok(!out.includes('```'), '应清除代码围栏');
  assert.ok(!out.includes('# '), '应清除标题');
  assert.ok(out.includes('console.log(1)'), '代码内容应保留');
  assert.ok(out.includes('链接'), '链接文字应保留');
  assert.ok(!out.includes('http://a.com'), 'URL 应移除');
});

test('stripMarkdown 保留普通文本', () => {
  const t = '今天天气不错呀，出去走走？';
  assert.equal(stripMarkdown(t), t);
});

test('toBubbles 按空行分段', () => {
  const out = toBubbles('第一句\n\n第二句\n\n第三句', { maxChars: 100, maxBubbles: 3 });
  assert.deepEqual(out, ['第一句', '第二句', '第三句']);
});

test('toBubbles 不超过 maxBubbles', () => {
  const text = Array.from({ length: 6 }, (_, i) => `第${i}段`).join('\n\n');
  const out = toBubbles(text, { maxChars: 200, maxBubbles: 3 });
  assert.ok(out.length <= 3, `实际 ${out.length} 段`);
});

test('toBubbles 单段超长会切分', () => {
  const long = '这是一个很长的句子，'.repeat(30);
  const out = toBubbles(long, { maxChars: 50, maxBubbles: 10 });
  assert.ok(out.length > 1);
  assert.ok(Math.max(...out.map((s) => s.length)) <= 60);
});

test('shapeReply 去掉角色名前缀', () => {
  const out = shapeReply('鲸鲸：你好呀', { maxChars: 100, maxBubbles: 2, stripMarkdown: true });
  assert.deepEqual(out, ['你好呀']);
});

test('needsRewrite 识别空内容', () => {
  assert.ok(needsRewrite(''));
  assert.ok(needsRewrite('。。。'));
  assert.ok(needsRewrite('!!!'));
  assert.ok(!needsRewrite('好'));
});

// ---------- session ----------

test('extractFacts 提取名字', () => {
  const facts = extractFacts('我叫小明，今年二十岁');
  const map = Object.fromEntries(facts);
  assert.equal(map['名字'], '小明');
});

test('extractFacts 提取喜好', () => {
  const facts = extractFacts('我喜欢吃西瓜');
  assert.ok(facts.some(([k, v]) => k === '喜欢' && v === '吃西瓜'));
});

test('extractFacts 无匹配返回空', () => {
  assert.deepEqual(extractFacts('今天天气不错'), []);
});

test('isEcho 识别原样重复', () => {
  assert.ok(isEcho('你好', '你好'));
  assert.ok(!isEcho('你好呀，今天怎么样', '你好'));
});

test('Session 历史裁剪保留最近轮次', () => {
  const s = new Session('t', { historyTurns: 2 });
  for (let i = 0; i < 10; i++) s.addTurn(`u${i}`, `a${i}`);
  assert.equal(s.history.length, 4, '应只保留 2 轮 = 4 条');
  assert.equal(s.history[0].content, 'u8');
});

test('Session 事实记忆', () => {
  const s = new Session('t', { historyTurns: 5 });
  s.remember('名字', '小明');
  const summary = s.factSummary();
  assert.ok(summary.includes('小明'));
});

test('Session 序列化往返', () => {
  const s = new Session('t', { historyTurns: 5 });
  s.addTurn('你好', '你好呀');
  s.remember('名字', '小明');
  const restored = Session.fromJSON(s.toJSON(), { historyTurns: 5 });
  assert.equal(restored.history.length, 2);
  assert.equal(restored.facts.get('名字'), '小明');
});

// ---------- persona ----------

test('renderSystemPrompt 包含核心要素', () => {
  const p = { ...PERSONA_DEFAULTS, name: '鲸鲸', personality: '温柔', rules: ['要真诚'], forbidden: ['不要卖萌'] };
  const out = renderSystemPrompt(p, { ownerName: '主人' });
  assert.ok(out.includes('鲸鲸'));
  assert.ok(out.includes('温柔'));
  assert.ok(out.includes('要真诚'));
  assert.ok(out.includes('不要卖萌'));
  assert.ok(out.includes('Markdown'), '应包含通用的禁止 Markdown 要求');
});

test('renderSystemPrompt 非主人时加距离提示', () => {
  const out = renderSystemPrompt(PERSONA_DEFAULTS, { isOwner: false });
  assert.ok(out.includes('不是你的主人'));
});

test('formatTime 输出可读时间', () => {
  const d = new Date(2026, 9, 25, 14, 30);
  const s = formatTime(d);
  assert.ok(s.includes('2026'));
  assert.ok(s.includes('14:30'));
});

// ---------- config ----------

test('deepMerge 深度合并', () => {
  const a = { x: { y: 1, z: 2 }, list: [1, 2] };
  const b = { x: { z: 3 }, list: [9] };
  const m = deepMerge(a, b);
  assert.equal(m.x.y, 1);
  assert.equal(m.x.z, 3);
  assert.deepEqual(m.list, [9], '数组应直接替换');
});

test('deepMerge 忽略注释字段', () => {
  const m = deepMerge({ a: 1 }, { _说明: '注释', a: 2 });
  assert.equal(m.a, 2);
  assert.ok(!('_说明' in m));
});

test('getByPath / setByPath', () => {
  const o = {};
  setByPath(o, 'a.b.c', 42);
  assert.equal(getByPath(o, 'a.b.c'), 42);
});

test('loadConfig 环境变量覆盖', () => {
  const cfg = loadConfig({
    root: process.cwd(),
    env: { LLM_MODEL: 'from-env', PORT: '9999' },
    override: { channels: { web: { enabled: true } } },
  });
  assert.equal(cfg.llm.model, 'from-env');
  assert.equal(cfg.server.port, 9999);
});

test('validate 拒绝非法端口', () => {
  const bad = JSON.parse(JSON.stringify(DEFAULTS));
  bad.server.port = 99999;
  assert.throws(() => validate(bad), /port/);
});

test('validate 要求至少一个通道', () => {
  const bad = JSON.parse(JSON.stringify(DEFAULTS));
  for (const k of Object.keys(bad.channels)) bad.channels[k].enabled = false;
  assert.throws(() => validate(bad), /通道/);
});

test('validate 看图开启但缺配置时报错', () => {
  const bad = JSON.parse(JSON.stringify(DEFAULTS));
  bad.vision.enabled = true;
  assert.throws(() => validate(bad), /vision/);
});

// ---------- llm ----------

test('inspectOutput 识别空回复', () => {
  assert.equal(inspectOutput(''), '空回复');
  assert.equal(inspectOutput('   '), '空回复');
});

test('inspectOutput 识别复读', () => {
  const problem = inspectOutput('哈哈哈哈哈哈哈哈哈哈');
  assert.ok(problem, '应识别出重复');
});

test('inspectOutput 正常文本返回 null', () => {
  assert.equal(inspectOutput('今天天气不错，出去走走吧。'), null);
});

test('parseSseStream 解析流式增量', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  let out = '';
  for await (const part of parseSseStream(stream)) out += part;
  assert.equal(out, '你好');
});
