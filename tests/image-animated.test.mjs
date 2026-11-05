import test from 'node:test';
import assert from 'node:assert/strict';

import { isAnimatedImage, sniffFormat } from '../core/image.mjs';

test('GIF 两帧以上识别为动图', () => {
  const buf = Buffer.concat([
    Buffer.from('GIF89a'),
    Buffer.from([0x21, 0xf9, 0x04, 0, 0, 0, 0, 0]),
    Buffer.from([0x21, 0xf9, 0x04, 0, 0, 0, 0, 0]),
    Buffer.from(';'),
  ]);
  assert.equal(sniffFormat(buf), 'gif');
  assert.equal(isAnimatedImage(buf), true);
});

test('GIF 只有一帧不是动图', () => {
  const buf = Buffer.concat([
    Buffer.from('GIF89a'),
    Buffer.from([0x21, 0xf9, 0x04, 0, 0, 0, 0, 0]),
    Buffer.from(';'),
  ]);
  assert.equal(isAnimatedImage(buf), false);
});

test('APNG 识别为动图', () => {
  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('acTL'),
  ]);
  assert.equal(sniffFormat(buf), 'png');
  assert.equal(isAnimatedImage(buf), true);
});

test('普通 PNG 不是动图', () => {
  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('IDAT'),
  ]);
  assert.equal(isAnimatedImage(buf), false);
});

test('动画 WebP 识别为动图', () => {
  const buf = Buffer.alloc(24);
  buf.write('RIFF', 0);
  buf.write('WEBP', 8);
  buf.write('VP8X', 12);
  buf[20] = 0x02;
  assert.equal(sniffFormat(buf), 'webp');
  assert.equal(isAnimatedImage(buf), true);
});

test('静态 WebP 不是动图', () => {
  const buf = Buffer.alloc(24);
  buf.write('RIFF', 0);
  buf.write('WEBP', 8);
  buf.write('VP8X', 12);
  assert.equal(isAnimatedImage(buf), false);
});
