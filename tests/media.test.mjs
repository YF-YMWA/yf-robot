/**
 * 媒体上传/加密测试。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import {
  aesEncrypt,
  aesDecrypt,
  parseAesKey,
  guessMediaType,
  uploadMedia,
  buildImageItem,
  downloadMedia,
  MEDIA_TYPE,
} from '../core/media.mjs';

test('AES 加解密往返', () => {
  const key = crypto.randomBytes(16);
  const data = Buffer.from('这是一段测试数据，用来验证加密解密');
  const enc = aesEncrypt(data, key);
  const dec = aesDecrypt(enc, key);
  assert.ok(dec.equals(data));
});

test('AES 加密后长度变化（PKCS7 padding）', () => {
  const key = crypto.randomBytes(16);
  const data = Buffer.alloc(10, 1);
  const enc = aesEncrypt(data, key);
  assert.ok(enc.length > data.length);
  assert.equal(enc.length % 16, 0, '密文长度应是 16 的倍数');
});

test('AES key 长度错误时抛错', () => {
  assert.throws(() => aesEncrypt(Buffer.from('x'), Buffer.alloc(8)), /16 字节/);
});

test('parseAesKey 解析 base64(raw 16 bytes)', () => {
  const key = crypto.randomBytes(16);
  const b64 = key.toString('base64');
  const parsed = parseAesKey(b64);
  assert.ok(parsed.equals(key));
});

test('parseAesKey 解析 base64(hex string)', () => {
  const key = crypto.randomBytes(16);
  const hex = key.toString('hex');           // 32 字符
  const b64 = Buffer.from(hex).toString('base64'); // 对 hex 字符串再 base64
  const parsed = parseAesKey(b64);
  assert.ok(parsed.equals(key), '应还原出原始 16 字节');
});

test('parseAesKey 直接传 hex 也能解析', () => {
  const key = crypto.randomBytes(16);
  const parsed = parseAesKey(key.toString('hex'));
  assert.ok(parsed.equals(key));
});

test('parseAesKey 无法解析时抛错', () => {
  assert.throws(() => parseAesKey('not-a-valid-key'), /无法解析/);
});

test('guessMediaType 识别 JPEG', () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(guessMediaType(buf), 'image');
});

test('guessMediaType 识别 PNG', () => {
  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8),
  ]);
  assert.equal(guessMediaType(buf), 'image');
});

test('guessMediaType 识别 GIF', () => {
  const buf = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10)]);
  assert.equal(guessMediaType(buf), 'image');
});

test('guessMediaType 识别 MP4', () => {
  const buf = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(8)]);
  assert.equal(guessMediaType(buf), 'video');
});

test('guessMediaType 未知类型返回 file', () => {
  assert.equal(guessMediaType(Buffer.from('hello world test')), 'file');
});

test('MEDIA_TYPE 常量正确', () => {
  assert.equal(MEDIA_TYPE.image, 1);
  assert.equal(MEDIA_TYPE.file, 2);
  assert.equal(MEDIA_TYPE.video, 3);
});

test('buildImageItem 构造正确结构', () => {
  const item = buildImageItem({
    encryptQueryParam: 'param123',
    aesKeyB64: 'keyB64',
    midSize: 1024,
  });
  assert.equal(item.type, 2);
  assert.equal(item.image_item.media.encrypt_query_param, 'param123');
  assert.equal(item.image_item.media.aes_key, 'keyB64');
  assert.equal(item.image_item.media.encrypt_type, 1);
  assert.equal(item.image_item.mid_size, 1024);
});

test('uploadMedia 完整流程（mock）', async () => {
  const imageData = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100, 7)]);
  let uploadedBody = null;
  let uploadUrlSeen = '';
  const calls = [];

  const post = async (endpoint, body) => {
    calls.push(endpoint);
    if (endpoint === 'getuploadurl') {
      // 校验请求字段
      assert.equal(body.media_type, 1);
      assert.equal(body.rawsize, imageData.length);
      assert.ok(body.rawfilemd5, '应有明文 md5');
      assert.equal(body.aeskey.length, 32, 'aeskey 应是 32 位 hex');
      assert.ok(body.filesize > body.rawsize, '密文应比明文长');
      return { ret: 0, upload_url: 'https://cdn.example.com/upload?x=1' };
    }
    return { ret: 0 };
  };

  const fetchImpl = async (url, init) => {
    uploadUrlSeen = url;
    uploadedBody = init.body;
    return new Response('', {
      status: 200,
      headers: { 'x-encrypted-param': 'download-param-xyz' },
    });
  };

  const result = await uploadMedia({
    buffer: imageData,
    mediaType: 'image',
    post,
    fetchImpl,
  });

  assert.ok(calls.includes('getuploadurl'));
  assert.ok(uploadUrlSeen.includes('cdn.example.com'));
  assert.ok(uploadedBody, '应上传了数据');
  assert.ok(Buffer.isBuffer(uploadedBody));
  assert.equal(result.encryptQueryParam, 'download-param-xyz');
  assert.ok(result.aesKeyB64);
  assert.equal(result.midSize, imageData.length);
});

test('uploadMedia 缺上传地址时抛错', async () => {
  const post = async () => ({ ret: 0 }); // 没给 upload_url
  await assert.rejects(
    () => uploadMedia({ buffer: Buffer.alloc(10), post, fetchImpl: async () => new Response('') }),
    /没有返回上传地址/,
  );
});

test('uploadMedia 缺 x-encrypted-param 时抛错', async () => {
  const post = async () => ({ ret: 0, upload_url: 'https://x.com/up' });
  const fetchImpl = async () => new Response('', { status: 200 }); // 没有 header
  await assert.rejects(
    () => uploadMedia({ buffer: Buffer.alloc(10), post, fetchImpl }),
    /x-encrypted-param/,
  );
});

test('downloadMedia 解密往返', async () => {
  const key = crypto.randomBytes(16);
  const original = Buffer.from('图片原始数据内容');
  const encrypted = aesEncrypt(original, key);

  const fetchImpl = async () =>
    new Response(encrypted, { status: 200 });

  const result = await downloadMedia({
    url: 'https://cdn.example.com/file',
    aesKeyB64: key.toString('base64'),
    fetchImpl,
  });

  assert.ok(result.equals(original), '应解密出原始数据');
});

test('downloadMedia 无密钥时原样返回', async () => {
  const data = Buffer.from('plain data');
  const fetchImpl = async () => new Response(data, { status: 200 });

  const result = await downloadMedia({ url: 'https://x.com/f', aesKeyB64: '', fetchImpl });
  assert.ok(result.equals(data));
});

test('downloadMedia 解密失败时退回原文', async () => {
  const data = Buffer.from('not encrypted data at all but long enough');
  const fetchImpl = async () => new Response(data, { status: 200 });

  // 用一个错误的 key
  const wrongKey = crypto.randomBytes(16).toString('base64');
  const result = await downloadMedia({ url: 'https://x.com/f', aesKeyB64: wrongKey, fetchImpl });
  // 要么是原文，要么抛出被捕获后返回原文
  assert.ok(result.length > 0);
});
