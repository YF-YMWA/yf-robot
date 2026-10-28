/**
 * 微信媒体上传：AES 加密 + CDN 上传。
 *
 * 流程：
 *   1. 生成 16 字节 AES key
 *   2. AES-128-ECB + PKCS7 加密文件
 *   3. getuploadurl 拿到上传地址
 *   4. POST 密文到 CDN，从响应头取 x-encrypted-param
 *   5. sendmessage 发媒体引用（不传文件本体）
 */
import crypto from 'node:crypto';
import { assertFetchable } from './safe-fetch.mjs';

/**
 * AES-128-ECB 加密，PKCS7 padding。
 * @param {Buffer} data
 * @param {Buffer} key 16 字节
 * @returns {Buffer}
 */
export function aesEncrypt(data, key) {
  if (key.length !== 16) throw new Error(`AES key 必须是 16 字节，实际 ${key.length}`);
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true); // PKCS7
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * AES-128-ECB 解密。
 * @param {Buffer} data
 * @param {Buffer} key 16 字节
 * @returns {Buffer}
 */
export function aesDecrypt(data, key) {
  if (key.length !== 16) throw new Error('AES key 必须是 16 字节');
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * 解析 aes_key 字符串，还原成 16 字节。
 *
 * 协议里存在两种编码：
 *   1. base64(raw 16 bytes)        —— 图片常见
 *   2. base64(hex string)           —— 先 hex 再 base64
 *
 * @param {string} str
 * @returns {Buffer}
 */
export function parseAesKey(str) {
  const raw = Buffer.from(str, 'base64');

  // 16 字节，直接用
  if (raw.length === 16) return raw;

  // 32 字节 —— 可能是 hex 字符串的 ASCII
  if (raw.length === 32) {
    const asHex = raw.toString('ascii');
    if (/^[0-9a-fA-F]{32}$/.test(asHex)) {
      return Buffer.from(asHex, 'hex');
    }
  }

  // 兜底：当字符串本身是 hex
  if (/^[0-9a-fA-F]{32}$/.test(str)) {
    return Buffer.from(str, 'hex');
  }

  throw new Error(`无法解析 aes_key（长度 ${raw.length}）`);
}

/**
 * 媒体类型常量。
 */
export const MEDIA_TYPE = {
  image: 1,
  file: 2,
  video: 3,
};

/**
 * 从文件头推断媒体类型。
 * @param {Buffer} buf
 * @returns {'image'|'file'|'video'}
 */
export function guessMediaType(buf) {
  if (!buf || buf.length < 12) return 'file';

  // 图片
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image'; // JPEG
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image'; // PNG
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image';

  // 视频
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'video';
  if (buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video'; // MKV

  return 'file';
}

/**
 * 上传媒体到微信 CDN。
 *
 * @param {object} deps
 * @param {Buffer} deps.buffer 文件明文
 * @param {string} deps.mediaType image | file | video
 * @param {(body: object) => Promise<object>} deps.post 调适配器接口的函数
 * @param {typeof fetch} [deps.fetchImpl]
 * @returns {Promise<{encryptQueryParam: string, aesKeyB64: string, midSize: number, rawSize: number}>}
 */
export async function uploadMedia({ buffer, mediaType = 'image', post, fetchImpl }) {
  const fetch = fetchImpl || globalThis.fetch;

  // 1. 生成密钥
  const key = crypto.randomBytes(16);
  const keyHex = key.toString('hex');

  // 2. 加密
  const encrypted = aesEncrypt(buffer, key);

  // 3. 拿上传地址
  const rawMd5 = crypto.createHash('md5').update(buffer).digest('hex');
  const filekey = crypto.randomBytes(16).toString('hex');

  const upRes = await post('getuploadurl', {
    filekey,
    media_type: MEDIA_TYPE[mediaType] ?? MEDIA_TYPE.image,
    rawsize: buffer.length,
    rawfilemd5: rawMd5,
    filesize: encrypted.length,
    aeskey: keyHex,
  });

  if (upRes.ret && upRes.ret !== 0) {
    // ret = -2 表示该 Bot 没有媒体上传权限（实测常见于个人 Bot）
    if (upRes.ret === -2) {
      throw new Error(
        '当前 Bot 没有图片上传权限（getuploadurl 返回 ret=-2）。\n' +
          '这是账号权限限制，不是代码问题。文字消息不受影响。',
      );
    }
    throw new Error(`getuploadurl 失败 (ret=${upRes.ret}): ${JSON.stringify(upRes).slice(0, 200)}`);
  }

  // 上传地址可能在 upload_url / url / cdn_url 字段
  const uploadUrl = upRes.upload_url || upRes.url || upRes.cdn_url || upRes.upload_param;
  if (!uploadUrl) {
    throw new Error(`getuploadurl 没有返回上传地址: ${JSON.stringify(upRes).slice(0, 300)}`);
  }

  // 4. 上传密文
  const uploadTarget = uploadUrl.startsWith('http')
    ? uploadUrl
    : `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(uploadUrl)}&filekey=${encodeURIComponent(filekey)}`;

  const up = await fetch(uploadTarget, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: encrypted,
  });

  if (!up.ok) {
    throw new Error(`CDN 上传失败: HTTP ${up.status}`);
  }

  // 5. 从响应头取下载凭证
  const encryptParam =
    up.headers.get('x-encrypted-param') ||
    up.headers.get('X-Encrypted-Param') ||
    upRes.encrypt_query_param ||
    '';

  if (!encryptParam) {
    throw new Error('CDN 响应没有 x-encrypted-param');
  }

  return {
    encryptQueryParam: encryptParam,
    aesKeyB64: key.toString('base64'),
    midSize: buffer.length,
    rawSize: buffer.length,
  };
}

/**
 * 构造图片消息项。
 * @param {object} media uploadMedia 的返回值
 * @returns {object}
 */
export function buildImageItem(media) {
  return {
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: media.encryptQueryParam,
        aes_key: media.aesKeyB64,
        encrypt_type: 1,
      },
      mid_size: media.midSize,
    },
  };
}

/**
 * 下载并解密微信媒体。
 *
 * @param {object} deps
 * @param {string} deps.url 下载地址
 * @param {string} deps.aesKeyB64 密钥（两种编码都支持）
 * @param {typeof fetch} [deps.fetchImpl]
 * @returns {Promise<Buffer>}
 */
export async function downloadMedia({ url, aesKeyB64, fetchImpl }) {
  const fetch = fetchImpl || globalThis.fetch;

  /**
   * 只允许公网 http/https。
   *
   * 这个 url 平时来自微信 CDN，看着可信；但它毕竟是「别人给的地址」，
   * 万一适配器被换成恶意的，就能让核心去读内网。
   * 代价几乎为零，加一道更稳。
   */
  assertFetchable(url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDN 下载失败: HTTP ${res.status}`);

  const encrypted = Buffer.from(await res.arrayBuffer());

  // 没有密钥就原样返回（有些 CDN 链接是明文的）
  if (!aesKeyB64) return encrypted;

  try {
    const key = parseAesKey(aesKeyB64);
    return aesDecrypt(encrypted, key);
  } catch (e) {
    // 解密失败时返回原文，交给上层判断格式
    return encrypted;
  }
}
