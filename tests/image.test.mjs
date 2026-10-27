/**
 * 图片处理测试。
 *
 * 用 ffmpeg 生成真实的测试图片（JPEG/PNG/GIF/WebP），
 * 验证格式识别不依赖扩展名、转码链路可用。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sniffFormat, isLikelyWxgf, prepareImage, toJpeg, probeSize, findFfmpeg } from '../core/image.mjs';

const execFileAsync = promisify(execFile);
const FFMPEG = findFfmpeg();
const _tmpRoot = path.join(process.cwd(), ".tmp");
fs.mkdirSync(_tmpRoot, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(_tmpRoot, "t-"));

/** 用 ffmpeg 生成一张纯色测试图。 */
async function makeImage(ext, { w = 200, h = 150 } = {}) {
  const file = path.join(tmpDir, `test.${ext}`);
  try {
    await execFileAsync(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${w}x${h}:d=1`, '-frames:v', '1', file],
      { timeout: 20000 },
    );
  } catch (e) {
    return null;
  }
  if (!fs.existsSync(file)) return null;
  return { file, buf: fs.readFileSync(file) };
}

// ---------- 格式识别（纯字节，不需要 ffmpeg）----------

test('sniffFormat 识别 JPEG', () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(sniffFormat(buf), 'jpeg');
});

test('sniffFormat 识别 PNG', () => {
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  assert.equal(sniffFormat(buf), 'png');
});

test('sniffFormat 识别 GIF', () => {
  const buf = Buffer.from('GIF89a......', 'ascii');
  assert.equal(sniffFormat(buf), 'gif');
});

test('sniffFormat 识别 BMP', () => {
  const buf = Buffer.from([0x42, 0x4d, 0x00, 0x00]);
  assert.equal(sniffFormat(buf), 'bmp');
});

test('sniffFormat 识别 WebP', () => {
  const head = Buffer.from('RIFF');
  const size = Buffer.from([0, 0, 0, 0]);
  const webp = Buffer.from('WEBPVP8 ');
  const buf = Buffer.concat([head, size, webp]);
  assert.equal(sniffFormat(buf), 'webp');
});

test('sniffFormat 识别 HEIC（ftyp 品牌）', () => {
  const buf = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftyp', 'ascii'),
    Buffer.from('heic', 'ascii'),
    Buffer.alloc(20),
  ]);
  assert.equal(sniffFormat(buf), 'heic');
});

test('sniffFormat 未知格式返回 unknown', () => {
  assert.equal(sniffFormat(Buffer.from('hello world this is text', 'ascii')), 'unknown');
});

test('sniffFormat 空数据安全返回', () => {
  assert.equal(sniffFormat(Buffer.alloc(0)), 'unknown');
  assert.equal(sniffFormat(null), 'unknown');
});

test('sniffFormat 不信任扩展名（内容是 PNG 就叫 png）', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  // 假设文件名是 .jpg，识别结果仍应是 png
  assert.equal(sniffFormat(png), 'png');
});

// ---------- wxgf 启发式判断 ----------

test('isLikelyWxgf 对普通文本返回 false', () => {
  assert.equal(isLikelyWxgf(Buffer.from('this is plain text content here', 'ascii')), false);
});

test('isLikelyWxgf 对 JPEG 返回 false', () => {
  const jpg = Buffer.alloc(100);
  jpg[0] = 0xff;
  jpg[1] = 0xd8;
  jpg[2] = 0xff;
  assert.equal(isLikelyWxgf(jpg), false);
});

test('isLikelyWxgf 识别含 HEVC NAL 起始码的数据', () => {
  // 构造：若干非 ASCII 字节 + HEVC VPS NAL (type 32) 起始码
  const buf = Buffer.alloc(200);
  buf.fill(0x80, 0, 50);
  // 00 00 01 后跟 NAL：type 32 → (0x40 >> 1) = 32
  buf[50] = 0x00;
  buf[51] = 0x00;
  buf[52] = 0x01;
  buf[53] = 0x40;
  assert.equal(isLikelyWxgf(buf), true);
});

test('isLikelyWxgf 数据太短返回 false', () => {
  assert.equal(isLikelyWxgf(Buffer.alloc(10)), false);
});

// ---------- 真实文件转码（需要 ffmpeg）----------

test('prepareImage 对 JPEG 直接编码，不转码', async (t) => {
  const img = await makeImage('jpg');
  if (!img) return t.skip('ffmpeg 不可用');

  const r = await prepareImage(img.buf);
  assert.equal(r.format, 'jpeg');
  assert.equal(r.converted, false);
  assert.ok(r.dataUrl.startsWith('data:image/jpeg;base64,'));
});

test('prepareImage 对 PNG 保留原格式', async (t) => {
  const img = await makeImage('png');
  if (!img) return t.skip('ffmpeg 不可用');

  const r = await prepareImage(img.buf);
  assert.equal(r.format, 'png');
  assert.ok(r.dataUrl.startsWith('data:image/png;base64,'));
});

test('prepareImage 把 GIF 转成 JPEG', async (t) => {
  const img = await makeImage('gif');
  if (!img) return t.skip('ffmpeg 不可用');

  const r = await prepareImage(img.buf, { maxEdge: 800 });
  assert.equal(r.format, 'jpeg', 'GIF 应转码');
  assert.equal(r.converted, true);
  assert.ok(r.dataUrl.startsWith('data:image/jpeg;base64,'));
});

test('prepareImage 超尺寸时缩小', async (t) => {
  const img = await makeImage('png', { w: 3000, h: 2000 });
  if (!img) return t.skip('ffmpeg 不可用');

  const r = await prepareImage(img.buf, { maxEdge: 400 });
  assert.ok(r.width <= 400, `宽度应 <= 400，实际 ${r.width}`);
});

test('prepareImage 无法识别的数据抛错', async () => {
  await assert.rejects(
    () => prepareImage(Buffer.from('这不是图片，只是一段文字内容而已')),
    /无法识别/,
  );
});

test('toJpeg 转码后能被识别为 JPEG', async (t) => {
  const img = await makeImage('png');
  if (!img) return t.skip('ffmpeg 不可用');

  const jpg = await toJpeg(img.buf);
  assert.equal(sniffFormat(jpg), 'jpeg');
  assert.ok(jpg.length > 0);
});

test('probeSize 读出真实尺寸', async (t) => {
  const img = await makeImage('png', { w: 320, h: 240 });
  if (!img) return t.skip('ffmpeg 不可用');

  const size = await probeSize(img.buf);
  assert.ok(size, '应读出版本信息');
  assert.equal(size.width, 320);
  assert.equal(size.height, 240);
  assert.equal(size.isTall, false);
});

test('probeSize 识别长截图', async (t) => {
  const img = await makeImage('png', { w: 300, h: 1500 });
  if (!img) return t.skip('ffmpeg 不可用');

  const size = await probeSize(img.buf);
  assert.ok(size);
  assert.equal(size.isTall, true, '高宽比 5:1 应判为长截图');
});

test('cleanup', async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
