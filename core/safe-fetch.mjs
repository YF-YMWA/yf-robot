/**
 * 安全的网页抓取。
 *
 * 联网学习最大的风险是「抓回来的东西是攻击者写的」，
 * 所以这里只做一件事：**只允许抓公网上的 http/https，且限制大小**。
 *
 * 挡住的东西：
 *   · file:// 之类的协议（读本地文件）
 *   · 内网地址（127.0.0.1、192.168.x、10.x、169.254.x …）—— 防止被当成跳板
 *   · 云元数据地址（169.254.169.254）
 *   · 超大响应（默认 512KB，读一半就断）
 *   · 重定向到上面那些（每一跳都重新检查）
 *
 * 不挡：公开网页的正常内容 —— 包括里面夹带的指令。
 * 内容本身不可信，靠调用方（logic.mjs）把它当数据而不是指令来用。
 */

/** 私有/保留网段，解析出来的 IP 落在这里就拒绝 */
const PRIVATE_PATTERNS = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, // 运营商级 NAT
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i, // IPv6 唯一本地地址
  /^fe80:/i,
  /^::$/,
];

/** 明显不该抓的主机名（本地服务常用名） */
const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

export class SafeFetchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

/** 看起来是不是一个 IP 字面量（含 IPv6） */
function looksLikeIp(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** 这个 IP 是不是内网/保留地址 */
export function isPrivateAddress(ip) {
  const s = String(ip).trim().toLowerCase().replace(/^\[|\]$/g, '');
  return PRIVATE_PATTERNS.some((re) => re.test(s));
}

/**
 * 校验 URL 能不能抓。
 * @returns {URL} 通过校验的 URL 对象
 * @throws {SafeFetchError}
 */
export function assertFetchable(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new SafeFetchError('不是合法的网址');
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SafeFetchError(`只允许 http/https，不接受 ${u.protocol}`);
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (!host) throw new SafeFetchError('网址里没有主机名');
  if (BLOCKED_HOSTS.has(host)) throw new SafeFetchError(`不允许访问 ${host}`);

  // 端口只放行 80/443，其他一律拒绝（防止探测内网服务）
  if (u.port && u.port !== '80' && u.port !== '443') {
    throw new SafeFetchError(`不允许访问端口 ${u.port}`);
  }

  // 直接写成 IP 的，必须是公网 IP
  if (looksLikeIp(host) && isPrivateAddress(host)) {
    throw new SafeFetchError(`不允许访问内网地址 ${host}`);
  }

  return u;
}

/**
 * 抓一个网页（纯文本）。
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] 最大读取字节数
 * @param {number} [opts.timeoutMs] 超时
 * @param {(m:string)=>void} [opts.log]
 * @returns {Promise<{url:string, finalUrl:string, status:number, text:string, bytes:number, truncated:boolean}>}
 */
export async function safeFetchText(url, opts = {}) {
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const log = opts.log || (() => {});

  let current = assertFetchable(url);
  let hop = 0;

  while (hop <= 3) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();

    try {
      const res = await fetch(current.href, {
        signal: ac.signal,
        redirect: 'manual', // 自己跟跳转，每一跳都重新校验，防止跳到内网
        headers: {
          'user-agent': 'YF-Robot/1.0 (learning)',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
      });

      // 跳转：检查 Location 再跟
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new SafeFetchError(`跳转响应没有 Location（${res.status}）`);
        current = assertFetchable(new URL(loc, current).href);
        hop++;
        log(`[fetch] 跟随跳转 → ${current.host}`);
        continue;
      }

      if (!res.ok) {
        throw new SafeFetchError(`抓取失败：HTTP ${res.status}`);
      }

      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (ctype && !/text\/|html|xml|json|plain/.test(ctype)) {
        throw new SafeFetchError(`不是文本内容（${ctype.split(';')[0]}）`);
      }

      // 边读边计数，超过上限就断开
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      let truncated = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))));
          truncated = true;
          try {
            await reader.cancel();
          } catch {}
          break;
        }
        chunks.push(value);
      }

      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      const text = buf.toString('utf8');

      return {
        url: String(url),
        finalUrl: current.href,
        status: res.status,
        text,
        bytes: buf.length,
        truncated,
      };
    } catch (e) {
      if (e instanceof SafeFetchError) throw e;
      if (e.name === 'AbortError') throw new SafeFetchError('抓取超时');
      throw new SafeFetchError(`抓取失败：${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new SafeFetchError('跳转次数过多');
}

/**
 * HTML 转纯文本（够用就行，不追求完美）。
 * 顺带把 <script>/<style> 整段丢掉 —— 那里面最容易藏东西。
 */
export function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
