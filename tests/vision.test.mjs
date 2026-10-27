/**
 * 视觉层测试：用 mock 视觉接口验证完整链路。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { VisionClient, VisionError, wrapImageMessage } from '../core/vision.mjs';
import { findFfmpeg } from '../core/image.mjs';
import { ChatEngine } from '../core/engine.mjs';
import { loadConfig } from '../core/config.mjs';
import { PERSONA_DEFAULTS } from '../core/persona.mjs';

const execFileAsync = promisify(execFile);
const FFMPEG = findFfmpeg();
const _tmpRoot = path.join(process.cwd(), ".tmp");
fs.mkdirSync(_tmpRoot, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(_tmpRoot, "t-"));

async function makePng(w = 200, h = 150) {
  const file = path.join(tmpDir, `v${Math.random().toString(36).slice(2)}.png`);
  try {
    await execFileAsync(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=red:s=${w}x${h}:d=1`, '-frames:v', '1', file],
      { timeout: 20000 },
    );
  } catch {
    return null;
  }
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function visionCfg(over = {}) {
  return {
    enabled: true,
    baseUrl: 'http://vision.mock',
    apiKey: 'k',
    model: 'v-model',
    timeoutMs: 5000,
    maxEdge: 1568,
    maxTokens: 1024,
    segments: 3,
    ...over,
  };
}

/** 假视觉接口：返回固定描述。 */
function mockVisionFetch(desc = '一张红色的图片') {
  return async () => {
    return new Response(
      JSON.stringify({ choices: [{ message: { content: desc } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

test('VisionClient 未启用时抛错', async () => {
  const c = new VisionClient({ enabled: false });
  await assert.rejects(() => c.describe(Buffer.alloc(10)), VisionError);
});

test('VisionClient 识别图片返回描述', async (t) => {
  const png = await makePng();
  if (!png) return t.skip('ffmpeg 不可用');

  const c = new VisionClient(visionCfg(), { fetchImpl: mockVisionFetch('图里是一只猫') });
  const r = await c.describe(png);
  assert.equal(r.description, '图里是一只猫');
  assert.ok(['png', 'jpeg'].includes(r.format));
});

test('VisionClient 长截图切段识别', async (t) => {
  const png = await makePng(300, 1500);
  if (!png) return t.skip('ffmpeg 不可用');

  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: `第${calls}段内容` } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const c = new VisionClient(visionCfg(), { fetchImpl });
  const r = await c.describe(png);
  assert.ok(calls > 1, `长截图应多次调用，实际 ${calls} 次`);
  assert.ok(r.description.includes('第 1 段') || r.description.includes('第1段'));
  assert.ok(r.segments > 1);
});

test('VisionClient 接口失败时抛 VisionError', async (t) => {
  const png = await makePng();
  if (!png) return t.skip('ffmpeg 不可用');

  const c = new VisionClient(visionCfg(), {
    fetchImpl: async () => new Response('bad request', { status: 400 }),
  });
  await assert.rejects(() => c.describe(png), VisionError);
});

test('wrapImageMessage 组织图文消息', () => {
  const out = wrapImageMessage('图里有一个表格', '这是啥');
  assert.ok(out.includes('图片'));
  assert.ok(out.includes('图里有一个表格'));
  assert.ok(out.includes('这是啥'));
});

test('引擎：图片消息走视觉再进模型', async (t) => {
  const png = await makePng();
  if (!png) return t.skip('ffmpeg 不可用');

  const config = loadConfig({
    root: process.cwd(),
    env: {},
    override: {
      tools: { enabled: false },
      llm: { baseUrl: 'http://llm.mock', apiKey: 'k', model: 'm' },
      vision: { enabled: true, baseUrl: 'http://vision.mock', apiKey: 'k', model: 'v' },
      channels: { web: { enabled: true } },
      reply: { bubbleDelayMs: 0 },
    },
  });

  let llmSawImageDescription = false;

  const fetchImpl = async (url, init) => {
    if (url.includes('vision.mock')) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '图片里写着：今日特价' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    // LLM 请求：检查是否收到了图片描述
    const body = JSON.parse(init.body);
    const lastUser = body.messages.filter((m) => m.role === 'user').pop();
    if (lastUser?.content?.includes('今日特价')) llmSawImageDescription = true;

    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: '哦，看到了，是特价信息' } }] })}\n\n`,
          ),
        );
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const engine = new ChatEngine({
    config,
    persona: { ...PERSONA_DEFAULTS, name: '鲸鲸' },
    logger: { error() {}, warn() {}, info() {} },
    fetchImpl,
  });

  const r = await engine.handle({ sessionId: 'img1', text: '这上面写的什么', images: [png] });
  assert.ok(r.bubbles.length > 0);
  assert.ok(llmSawImageDescription, '主模型应收到图片描述');
});

test('引擎：视觉失败时不影响整体回复', async (t) => {
  const png = await makePng();
  if (!png) return t.skip('ffmpeg 不可用');

  const config = loadConfig({
    root: process.cwd(),
    env: {},
    override: {
      tools: { enabled: false },
      llm: { baseUrl: 'http://llm.mock', apiKey: 'k', model: 'm' },
      vision: { enabled: true, baseUrl: 'http://vision.mock', apiKey: 'k', model: 'v' },
      channels: { web: { enabled: true } },
      reply: { bubbleDelayMs: 0 },
    },
  });

  const fetchImpl = async (url) => {
    if (url.includes('vision.mock')) {
      return new Response('boom', { status: 500 });
    }
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: '图好像没看懂' } }] })}\n\n`,
          ),
        );
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const engine = new ChatEngine({
    config,
    persona: PERSONA_DEFAULTS,
    logger: { error() {}, warn() {}, info() {} },
    fetchImpl,
  });

  const r = await engine.handle({ sessionId: 'img2', text: '看看这个', images: [png] });
  assert.ok(r.bubbles.length > 0, '视觉失败仍应有回复');
});

test('cleanup', () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
