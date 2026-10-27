/**
 * 本地访问令牌。
 *
 * 目的：防止本机上其他程序（尤其是浏览器里的恶意网页）随意调用管理接口。
 * 原理：
 *   - 启动时生成一个随机 token，存到 data/token.txt
 *   - 控制台页面加载时从服务端拿到 token（同一个响应里下发）
 *   - 之后每个管理接口请求都带 X-Local-Token 头
 *   - 校验失败直接 403
 *
 * 为什么能防 CSRF：
 *   恶意网页可以伪造 POST 请求，但读不到响应内容（同源策略），
 *   所以拿不到 token，也就无法通过校验。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 读取或生成 token。
 *
 * @param {string} dataDir
 * @returns {string}
 */
export function ensureToken(dataDir) {
  const file = path.join(dataDir, 'token.txt');

  try {
    if (fs.existsSync(file)) {
      const t = fs.readFileSync(file, 'utf8').trim();
      if (t && t.length >= 32) return t;
    }
  } catch {}

  const token = crypto.randomBytes(32).toString('hex');

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, token, 'utf8');
    // Windows 下尽量限制文件权限（只有当前用户可读）
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
  } catch {}

  return token;
}

/**
 * 校验请求是否带正确的 token。
 *
 * 支持三种传法（方便不同客户端）：
 *   - X-Local-Token 头
 *   - Authorization: Bearer xxx
 *   - ?token=xxx 查询参数（给不方便加头的场景）
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} url
 * @param {string} expected
 * @returns {boolean}
 */
export function checkToken(req, url, expected) {
  if (!expected) return true; // 没配 token 就不校验（向后兼容）

  const fromHeader = req.headers['x-local-token'];
  if (fromHeader && safeEqual(String(fromHeader), expected)) return true;

  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    if (safeEqual(auth.slice(7).trim(), expected)) return true;
  }

  const fromQuery = url.searchParams.get('token');
  if (fromQuery && safeEqual(fromQuery, expected)) return true;

  return false;
}

/** 定长比较，避免时序攻击。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
