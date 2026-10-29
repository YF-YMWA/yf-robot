/**
 * 换模型服务商时的兼容性。
 *
 * 用户问「换个非 DeepSeek 的 Key，所有功能还成吗」。
 * 真正的风险是 function calling —— 不是所有 OpenAI 兼容接口都支持，
 * 不支持时以前整轮对话直接失败，表现是「换了 Key 她就不回话了」。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { LlmClient } from '../core/llm.mjs';

const CFG = {
  apiKey: 'sk-test',
  baseUrl: 'https://example.com/v1',
  model: 'x',
  timeoutMs: 5000,
  maxTokens: 100,
};

/** 假的 fetch：带 tools → 400「不支持」；不带 tools → 正常回复 */
function fakeFetch(seen) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ hasTools: Array.isArray(body.tools) && body.tools.length > 0 });

    if (body.tools && body.tools.length) {
      return {
        ok: false,
        status: 400,
        async text() {
          return '{"error":{"message":"tools is not supported by this model"}}';
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: '在的' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
    };
  };
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'send_image',
      description: '发图',
      parameters: { type: 'object', properties: {} },
    },
  },
];

test('服务商不支持工具：去掉 tools 重试，对话仍然成功', async () => {
  const seen = [];
  const c = new LlmClient(CFG, { fetchImpl: fakeFetch(seen) });

  const r = await c.streamWithTools([{ role: 'user', content: '在吗' }], TOOLS);

  assert.equal(r.text, '在的', '降级后应该正常拿到回复');
  assert.equal(seen.length, 2, '应该两次：带工具失败 + 不带工具成功');
  assert.equal(seen[0].hasTools, true, '第一次带工具');
  assert.equal(seen[1].hasTools, false, '第二次不带工具');
});

test('降级后会记住：下次不再带工具', async () => {
  const seen = [];
  const c = new LlmClient(CFG, { fetchImpl: fakeFetch(seen) });

  await c.streamWithTools([{ role: 'user', content: '第一次' }], TOOLS);
  const before = seen.length;

  await c.streamWithTools([{ role: 'user', content: '第二次' }], TOOLS);

  const second = seen.slice(before);
  assert.equal(second.length, 1, '第二次只请求一次（不再试探）');
  assert.equal(second[0].hasTools, false, '第二次直接不带工具');
});

test('普通 400（与工具无关）不该被吞掉', async () => {
  const c = new LlmClient(CFG, {
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      async text() {
        return '{"error":{"message":"余额不足"}}';
      },
    }),
  });

  await assert.rejects(
    () => c.streamWithTools([{ role: 'user', content: '在吗' }], TOOLS),
    /余额不足/,
    '不是工具问题就该如实报错，别假装降级',
  );
});

test('服务商原生支持工具：一次成功，不降级', async () => {
  const seen = [];
  const c = new LlmClient(CFG, {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ hasTools: Boolean(body.tools) });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'send_image', arguments: '{}' } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          };
        },
      };
    },
  });

  const r = await c.streamWithTools([{ role: 'user', content: '发个图' }], TOOLS);

  assert.equal(seen.length, 1);
  assert.equal(r.toolCalls.length, 1);
});
