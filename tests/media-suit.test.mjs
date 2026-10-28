/**
 * 图片适用性判断的测试。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { imageDims, suitableAsSticker, suitableAsImage } from '../core/media-suit.mjs';

/** 造一个最小的 PNG 头（只有宽高是真的，像素数据是垃圾） */
function fakePNG(w, h, padTo = 2048) {
  const buf = Buffer.alloc(padTo);
  // 签名
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

/** 造一个最小 GIF 头 */
function fakeGIF(w, h, padTo = 2048) {
  const buf = Buffer.alloc(padTo);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(w, 6);
  buf.writeUInt16LE(h, 8);
  return buf;
}

// ===== 尺寸解析 =====

test('读尺寸：PNG', () => {
  const d = imageDims(fakePNG(300, 200));
  assert.equal(d.width, 300);
  assert.equal(d.height, 200);
  assert.equal(d.format, 'png');
});

test('读尺寸：GIF', () => {
  const d = imageDims(fakeGIF(120, 150));
  assert.equal(d.width, 120);
  assert.equal(d.height, 150);
  assert.equal(d.format, 'gif');
});

test('读尺寸：认不出的返回 null', () => {
  assert.equal(imageDims(Buffer.from('hello world, not an image')), null);
  assert.equal(imageDims(null), null);
});

// ===== 表情包判定 =====

test('表情包：方形 GIF 通过', () => {
  assert.equal(suitableAsSticker(fakeGIF(200, 200)).ok, true);
});

test('表情包：稍有纵向也通过（0.65~1.55）', () => {
  assert.equal(suitableAsSticker(fakePNG(120, 160)).ok, true); // 0.75
  assert.equal(suitableAsSticker(fakePNG(160, 120)).ok, true); // 1.33
});

test('表情包：图标级太小被拒', () => {
  const r = suitableAsSticker(fakePNG(32, 32));
  assert.equal(r.ok, false);
  assert.match(r.reason, /太小/);
});

test('表情包：超宽横幅被拒', () => {
  const r = suitableAsSticker(fakePNG(900, 200));
  assert.equal(r.ok, false);
  assert.match(r.reason, /不是方形/);
});

test('表情包：超长截图被拒', () => {
  const r = suitableAsSticker(fakePNG(800, 1800));
  assert.equal(r.ok, false);
  assert.match(r.reason, /不是方形|太大/);
});

test('表情包：过大尺寸被拒', () => {
  const r = suitableAsSticker(fakePNG(2000, 2000));
  assert.equal(r.ok, false);
  assert.match(r.reason, /太大/);
});

test('表情包：体积超过 2MB 被拒', () => {
  const big = fakePNG(300, 300, 3 * 1024 * 1024);
  const r = suitableAsSticker(big);
  assert.equal(r.ok, false);
  assert.match(r.reason, /KB/);
});

test('表情包：太小（占位图）被拒', () => {
  const r = suitableAsSticker(Buffer.alloc(100));
  assert.equal(r.ok, false);
});

test('表情包：读不出尺寸被拒', () => {
  // 要超过 512 字节，否则会先被「太小」拦住
  const r = suitableAsSticker(Buffer.alloc(2048, 0x41));
  assert.equal(r.ok, false);
  assert.match(r.reason, /读不出/);
});

// ===== 普通图片判定（标准更宽） =====

test('图片：大尺寸横图通过（不要求方形）', () => {
  assert.equal(suitableAsImage(fakePNG(1600, 900)).ok, true);
});

test('图片：太小的被拒', () => {
  const r = suitableAsImage(fakePNG(100, 100));
  assert.equal(r.ok, false);
  assert.match(r.reason, /分辨率太低/);
});

test('图片：几千像素的也能过，离谱的不过', () => {
  assert.equal(suitableAsImage(fakePNG(3000, 2000)).ok, true);
  assert.equal(suitableAsImage(fakePNG(8000, 8000)).ok, false);
});

// ===== 真实素材 =====

test('真实素材：现有表情包不会误判', () => {
  const dir = path.join(process.cwd(), 'data', 'stickers');
  if (!fs.existsSync(dir)) return; // 干净环境跳过

  const files = fs.readdirSync(dir).filter((n) => /\.(png|jpg|jpeg|gif|webp)$/i.test(n));
  if (!files.length) return;

  let okCount = 0;
  for (const f of files) {
    if (suitableAsSticker(fs.readFileSync(path.join(dir, f))).ok) okCount++;
  }
  // 库里都是真表情包，绝大多数应该通过
  assert.ok(
    okCount / files.length > 0.7,
    `现有 ${files.length} 张里只有 ${okCount} 张判为适合，阈值可能太严`,
  );
});
