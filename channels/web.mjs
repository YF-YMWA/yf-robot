/**
 * 网页通道：HTTP + SSE。
 *
 * 接口：
 *   GET  /              聊天页面
 *   POST /api/chat      发消息，SSE 流式返回
 *   POST /api/reset     清空会话
 *   GET  /api/status    运行状态
 */
import http from 'node:http';
import fs from 'node:fs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCareDue, composeCare } from '../core/care.mjs';
import { ensureToken, checkToken } from '../core/token.mjs';
import { MediaLibrary } from '../core/media-ingest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 这个会话/发送者发的图要不要收藏。
 *
 * 规则和适配器上报的一致（以核心这份为准）：
 *   1. 白名单为空 → 全收
 *   2. 会话或发送者在白名单 → 收
 *   3. 否则不收
 *
 * @param {string[]} whitelist
 * @param {string} chatId
 * @param {string} senderId
 * @returns {boolean}
 */
export function isCollectAllowed(whitelist, chatId, senderId) {
  const allowed = new Set(
    (Array.isArray(whitelist) ? whitelist : [])
      .map((x) => String(x).trim())
      .filter(Boolean),
  );
  if (!allowed.size) return true;
  if (chatId && allowed.has(String(chatId).trim())) return true;
  if (senderId && allowed.has(String(senderId).trim())) return true;
  return false;
}

export class WebChannel {
  /**
   * @param {object} opts
   * @param {import('../core/engine.mjs').ChatEngine} opts.engine
   * @param {object} opts.config 完整配置
   * @param {object} [opts.logger]
   */
  constructor({ engine, config, logger = console, admin = null, dataDir = null }) {
    this.engine = engine;
    this.config = config;
    this.log = logger;
    this.admin = admin;
    this.server = null;
    this.name = 'web';

    /**
     * 数据目录。
     *
     * 默认是项目里的 data/，但**测试必须能改**：
     * 之前 e2e 测试用 18083 起通道，它把 actual-port.txt 写进了真实 data/，
     * 于是下次双击YF-Robot.bat 时启动脚本读到 18083、打开一个死链接 ——
     * 用户看到的就是「突然无法运行」。
     */
    this.dataDir = dataDir || path.join(__dirname, '..', 'data');

    // 本地访问令牌：防止同机其他程序（含恶意网页）调用管理接口。
    // 设 authToken = false 可关闭（不建议）。
    this.token = config.server?.authToken === false
      ? ''
      : ensureToken(this.dataDir);

    /**
     * 控制台页面在线表：pageId → 最后一次 ping 的时间戳。
     *
     * 用来支持「关掉网页就停服务」这个可选开关。
     * 只有「本次运行中确实有页面连上来过」之后才会自动停 ——
     * 开机自启 / 双击 bat 直接起的服务，没人开页面也不会莫名其妙自杀。
     */
    this.consolePages = new Map();
    this.sawConsolePage = false;
    this.stopTimer = null;
    /** 页面报拜拜之后，等多久才真正停（给刷新留余量） */
    this.idleMs = 15000;

    /**
     * 判定一个页面「还活着」的窗口。
     *
     * 这里踩过坑：原来设 12 秒，结果**切到别的窗口**（标签页进后台）时，
     * 浏览器会把定时器节流到一分钟甚至更久，ping 跟不上，
     * 服务就以为页面关了 → 15 秒后自动退出 → 控制台直接「消失」。
     *
     * 现在改成 5 分钟：
     *   · 正常关页面靠 sendBeacon 的 bye，立刻生效（不等这个超时）
     *   · 后台节流期间 ping 一分钟一次也够用，不会被误判成关闭
     *   · 浏览器崩溃这种「没有 bye 也没有 ping」的情况，5 分钟后照样兜住
     */
    this.pageTtlMs = 5 * 60 * 1000;
  }

  /** 「关网页即停服务」现在生效吗（开关 + 未被 keep-alive 压制）。 */
  #autoStopWanted() {
    if (this.config.server?.stopWhenNoConsole !== true) return false;
    // 硬退路：这个文件存在就一律不停，方便出问题时一行命令救回来
    try {
      if (fs.existsSync(path.join(__dirname, '..', 'data', 'keep-alive'))) return false;
    } catch {}
    return true;
  }

  /** 清掉过期页面。@returns 还活着的页面数 */
  #livePages() {
    const now = Date.now();
    for (const [id, at] of this.consolePages) {
      if (now - at > this.pageTtlMs) this.consolePages.delete(id);
    }
    return this.consolePages.size;
  }

  /** 记录一次页面心跳。 */
  touchPage(pageId) {
    const id = String(pageId || '').slice(0, 64) || 'anonymous';
    const first = !this.consolePages.has(id);
    this.consolePages.set(id, Date.now());
    this.sawConsolePage = true;
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
      this.log.info?.('[web] 控制台又连上了，取消自动停止');
    }
    if (first) this.log.info?.(`[web] 控制台页面连上（共 ${this.consolePages.size} 个）`);
  }

  /**
   * 页面主动说拜拜（关闭标签页/刷新时触发）。
   *
   * 这是「关网页即停服务」的主路径 —— 立刻把页面摘掉，
   * 不等 5 分钟的兜底超时，否则关个网页要等五分钟才停，体验很怪。
   */
  pageClosed(pageId) {
    const id = String(pageId || '').slice(0, 64) || 'anonymous';
    if (this.consolePages.delete(id)) {
      this.log.info?.(`[web] 控制台页面关闭（剩 ${this.consolePages.size} 个）`);
    }
  }

  /**
   * 定期检查：开关开着 + 页面都关了 → 停服务。
   *
   * 触发来源有两个：
   *   · 页面主动 bye（关标签页）→ livePages 立刻变 0，马上开始倒计时
   *   · ping 超时（浏览器崩溃/休眠）→ 等 pageTtlMs 之后才算「关」
   *
   * 倒计时期间只要再来一次 ping 就取消 —— 刷新页面会先 bye 再连上，
   * 15 秒足够它连回来，不会把自己刷没。
   */
  startPresenceWatch() {
    if (this.presenceTimer) return;
    this.presenceTimer = setInterval(() => {
      if (!this.#autoStopWanted()) return;
      if (!this.sawConsolePage) return; // 从来没人开过页面 → 不动
      if (this.#livePages() > 0) {
        if (this.stopTimer) {
          clearTimeout(this.stopTimer);
          this.stopTimer = null;
        }
        return;
      }
      if (this.stopTimer) return; // 已经在倒计时了

      this.log.info?.(`[web] 控制台页面已全部关闭，${Math.round(this.idleMs / 1000)} 秒后停止服务`);
      this.stopTimer = setTimeout(() => {
        this.stopTimer = null;
        if (!this.#autoStopWanted()) return;
        if (this.#livePages() > 0) return;
        this.log.info?.('[web] 关网页即停服务已生效，正在退出');
        try {
          const lock = path.join(__dirname, '..', 'data', 'app.lock');
          if (fs.existsSync(lock)) {
            const cur = fs.readFileSync(lock, 'utf8').trim();
            if (cur === String(process.pid)) fs.unlinkSync(lock);
          }
        } catch {}
        process.exit(0);
      }, this.idleMs);
      this.stopTimer.unref?.();
    }, 3000);
    this.presenceTimer.unref?.();
  }

  /**
   * 取某个适配器的状态槽位（没有就建）。
   *
   * 同时接微信和 QQ 时，心跳和联系人必须分开存 ——
   * 只留一个槽位会互相覆盖，控制台就只显示最后一个报到的。
   */
  #adapterSlot(name) {
    const key = String(name || 'default').slice(0, 40);
    if (!this.engine.adapters) this.engine.adapters = new Map();
    let slot = this.engine.adapters.get(key);
    if (!slot) {
      slot = { name: key, platform: '', heartbeat: null, info: null, contacts: new Map() };
      this.engine.adapters.set(key, slot);
    }
    return slot;
  }

  /** 媒体库（懒加载，第一次用到才建） */
  #mediaLib() {
    if (!this._mediaLib) {
      this._mediaLib = new MediaLibrary({
        root: path.join(__dirname, '..'),
        ffmpeg: this.config.vision?.ffmpeg || this.config.imagegen?.ffmpeg || null,
        log: (m) => this.log.info?.('[media] ' + m),
      });
    }
    return this._mediaLib;
  }

  async start() {
    const { host, port } = this.config.server;
    const autoPort = this.config.server.autoPort !== false;

    // 依次尝试端口，占用则往后找
    const candidates = autoPort
      ? Array.from({ length: 20 }, (_, i) => port + i)
      : [port];

    let lastErr = null;
    for (const p of candidates) {
      this.server = http.createServer((req, res) => this.#route(req, res));
      try {
        await new Promise((resolve, reject) => {
          const onError = (e) => {
            this.server.removeListener('listening', onListening);
            this.server.close();
            reject(e);
          };
          const onListening = () => {
            this.server.removeListener('error', onError);
            resolve();
          };
          this.server.once('error', onError);
          this.server.once('listening', onListening);
          this.server.listen(p, host);
        });

        // 启动成功
        this.port = p;
        if (p !== port) {
          this.log.warn?.(`[web] 端口 ${port} 不可用，改用 ${p}`);
        }

        // 把真实端口写出来给启动脚本用。
        //
        // 以前 start.ps1 是「从配置端口往上试探，第一个能连上的就开浏览器」——
        // 如果电脑上已经跑着另一份，它连上的是**旧实例**，浏览器打开的是旧控制台，
        // 新实例实际在 8900，用户看着就是「解压出来的这份不能用」。
        // 写个文件最省事，启动脚本直接读，不用猜。
        try {
          const f = path.join(this.dataDir, 'actual-port.txt');
          mkdirSync(path.dirname(f), { recursive: true });
          writeFileSync(f, String(p), 'utf8');
          // 注意：这里**故意不在退出时删这个文件**。
          // 试过删，结果有竞态：重启时新实例刚写进去，旧实例退出时又把它删了，
          // 启动脚本拿不到端口。反正 start.ps1 会验证端口是否真的能应答，
          // 留个过期文件也不会打开死链接。
        } catch (e) {
          this.log.warn?.(`[web] 端口文件写入失败: ${e.message}`);
        }

        // 开始盯着控制台页面在不在（「关网页即停服务」开关用到）
        this.startPresenceWatch();

        return `http://${host}:${p}`;
      } catch (e) {
        lastErr = e;
        this.server = null;
        // 只对端口占用重试，其他错误直接抛出
        if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') break;
      }
    }

    throw new Error(
      `无法监听端口 ${port}${autoPort ? `~${port + candidates.length - 1}` : ''}: ${lastErr?.message}`,
    );
  }

  async #route(req, res) {
    const url = new URL(req.url, 'http://localhost');

    try {
      // ===== 鉴权 =====
      // 管理接口必须带 token：防止本机其他程序（含浏览器里的恶意网页）
      // 通过 CSRF 读配置、改 baseUrl 窃取 API Key。
      if (this.admin && url.pathname.startsWith('/api/admin/')) {
        if (!checkToken(req, url, this.token)) {
          // 带时间戳：排查「保存没生效」时能对上用户操作的时间点
          const when = new Date().toTimeString().slice(0, 8);
          const got = req.headers['x-local-token'] ? '带了但不对' : '没带';
          this.log.warn?.(
            `[web] ${when} 拒绝未授权的管理请求: ${url.pathname}（令牌${got}）`,
          );
          return json(res, 403, { error: '未授权：缺少有效的本地令牌' });
        }

        // 除 GET/HEAD 外都要读 body —— DELETE 也可能带参数
        const hasBody = !['GET', 'HEAD'].includes(req.method);
        const body = hasBody ? await readJson(req).catch(() => null) : null;
        const r = await this.admin.handle(req.method, url.pathname, body);
        if (r) return json(res, r.code, r.body);
      }

      // 页面：把 token 注入进去，供前端后续调用接口
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return this.#serveWithToken(res, 'index.html', 200);
      }
      if (req.method === 'GET' && url.pathname === '/console') {
        return this.#serveWithToken(res, 'console.html', 200);
      }

      // 给前端取 token 的接口（同源才能读，跨域被浏览器拦）
      if (req.method === 'GET' && url.pathname === '/api/token') {
        // 只允许来自本机页面（Origin 校验）
        const origin = req.headers.origin || '';
        const sameOrigin =
          !origin ||
          origin === `http://127.0.0.1:${this.port}` ||
          origin === `http://localhost:${this.port}`;
        if (!sameOrigin) {
          return json(res, 403, { error: '跨域访问被拒绝' });
        }
        return json(res, 200, { token: this.token });
      }

      // 素材文件（表情包 / 图片，控制台预览用）
      //
      // 注意排除 policy / pick / file：这几个是同前缀的接口，不是文件名。
      // 不排除的话会被这里当成「读一个叫 policy 的文件」，直接 403/404。
      if (
        req.method === 'GET'
        && !url.pathname.startsWith('/api/media/policy')
        && !url.pathname.startsWith('/api/media/pick')
        && !url.pathname.startsWith('/api/media/file/')
        && (url.pathname.startsWith('/api/sticker/') || url.pathname.startsWith('/api/media/'))
      ) {
        if (!checkToken(req, url, this.token)) {
          return json(res, 403, { error: '未授权' });
        }

        let kind = 'stickers';
        let name = '';

        if (url.pathname.startsWith('/api/media/')) {
          const rest = url.pathname.slice('/api/media/'.length).split('/');
          const k = rest[0];
          kind = k === 'images' ? 'images' : k === 'generated' ? 'generated' : 'stickers';
          name = decodeURIComponent(rest.slice(1).join('/'));
        } else {
          name = decodeURIComponent(url.pathname.slice('/api/sticker/'.length));
        }

        if (!/^[\w.-]{1,100}$/.test(name)) return json(res, 400, { error: '非法文件名' });

        const file = path.join(__dirname, '..', 'data', kind, name);
        try {
          const buf = readFileSync(file);
          const ext = path.extname(name).toLowerCase();
          const mimes = {
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
          };
          res.writeHead(200, {
            'content-type': mimes[ext] || 'application/octet-stream',
            'content-length': buf.length,
            'cache-control': 'public, max-age=3600',
          });
          return res.end(buf);
        } catch {
          return json(res, 404, { error: '文件不存在' });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        return json(res, 200, this.engine.stats());
      }
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        return await this.#chat(req, res);
      }
      // 同步接口：给外部适配器用，返回普通 JSON（不是 SSE）
      //
      // /api/inbound 是平台无关的名字（QQ、Telegram 之类的适配器也用它，
      // 免得文档里写着「wechat」让人以为只能接微信）。
      // /api/wechat 保留为别名，老适配器不用改。
      if (req.method === 'POST' && (url.pathname === '/api/wechat' || url.pathname === '/api/inbound')) {
        return await this.#wechatSync(req, res);
      }

      // ===== 适配器配套：媒体入库 + 收藏策略 =====
      //
      // 为什么由核心来存：
      //   适配器是独立仓库、独立进程，它那边算出来的 data/ 不是核心的 data/。
      //   让适配器自己写目录，结果是「收藏了但控制台看不到」。
      //   所以统一改成：适配器把字节传过来，存哪、存不存、算不算重复，核心说了算。
      if (req.method === 'GET' && url.pathname === '/api/media/policy') {
        const w = this.config.wechat || {};
        return json(res, 200, {
          ok: true,
          collect: w.mediaCollect !== false,
          /** 收藏白名单：空 = 全收；填了 = 只收这些会话/发送者 */
          collectOnlyFrom: w.collectOnlyFrom || [],
          stickerChance: w.stickerChance ?? 0.3,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/media/ingest') {
        const body = await readJson(req).catch(() => null);
        if (!body || !body.data) {
          return json(res, 400, { ok: false, error: '缺少 data（base64）' });
        }

        // 和 /api/admin/* 不一样：适配器用的是 inboundToken，不是本地管理令牌
        const expect = this.config.gateway?.wechat?.inboundToken || '';
        const got = req.headers['x-adapter-token'] || '';
        if (expect && got !== expect) {
          return json(res, 403, { ok: false, error: '适配器令牌不对' });
        }

        const kind = body.kind === 'image' || body.kind === 'generated' ? body.kind : 'sticker';
        const senderId = String(body.senderId || '');
        const chatId = String(body.chatId || '');

        // 收藏策略在这里判一次，适配器不用再判
        const w = this.config.wechat || {};
        if (w.mediaCollect === false) {
          return json(res, 200, { ok: true, skipped: 'mediaCollect 关闭' });
        }
        if (!isCollectAllowed(w.collectOnlyFrom || [], chatId, senderId)) {
          return json(res, 200, { ok: true, skipped: '不在收藏白名单' });
        }

        let buf;
        try {
          buf = Buffer.from(String(body.data), 'base64');
        } catch {
          return json(res, 400, { ok: false, error: 'base64 解不开' });
        }
        if (!buf.length || buf.length > 12 * 1024 * 1024) {
          return json(res, 400, { ok: false, error: '数据为空或超过 12MB' });
        }

        const lib = this.#mediaLib();
        const r = await lib.save({ kind, data: buf, note: `（来自 ${senderId || chatId || '适配器'}）` });

        if (r.ok && r.name) {
          // 顺手给这张图打描述（异步，不阻塞适配器）
          this.admin?.describeMediaOne?.(r.name, kind).catch?.(() => {});
        }
        return json(res, 200, r);
      }

      if (req.method === 'POST' && url.pathname === '/api/adapter/contacts') {
        // 适配器上报它知道的会话/联系人，供控制台选「搭话发给谁」和「收藏白名单」
        const body = await readJson(req).catch(() => null);
        const list = Array.isArray(body?.contacts) ? body.contacts : [];

        // 按平台分开存：微信的 wxid 和 QQ 的号不该混在一张表里
        const platform = String(body?.platform || 'wechat').slice(0, 20);
        const slot = this.#adapterSlot(body?.name || 'default');
        slot.platform = platform;

        // 兼容旧代码（单平台时直接读这个）
        this.engine.adapterContacts = this.engine.adapterContacts || new Map();

        let n = 0;
        for (const c of list.slice(0, 200)) {
          const id = String(c?.id || c?.wxid || '').trim();
          const name = String(c?.name || '').trim();
          if (!name && !id) continue;

          const rec = {
            id,
            platform,
            name,
            chatName: String(c?.chatName || name).trim(),
            isGroup: Boolean(c?.isGroup),
            lastSeen: Date.now(),
          };
          // 槽位里按平台:id 存，避免跨平台撞号
          slot.contacts.set(`${platform}:${id || name}`, rec);
          // 旧的全局表也存一份（key 带平台前缀，同样不撞）
          this.engine.adapterContacts.set(`${platform}:${id || name}`, rec);
          n++;
        }
        return json(res, 200, { ok: true, stored: n, platform });
      }

      /**
       * 适配器要的用户设置（主人名单、主动功能、热点间隔）。
       *
       * 这些以前在适配器自己的 config.json 里也存一份，结果两边各改各的：
       * 控制台把「主动搭话」关了，适配器那边还开着；
       * 适配器的主人 wxids 是空的，每日热点就永远不发。
       * 现在统一由核心提供，适配器定时拉。
       */
      if (req.method === 'GET' && url.pathname === '/api/adapter/config') {
        const c = this.config;
        return json(res, 200, {
          ok: true,
          owner: {
            enabled: c.owner?.enabled !== false,
            wxids: c.owner?.wxids || [],
            names: c.owner?.names || [],
            displayName: c.owner?.displayName || '',
          },
          care: {
            enabled: Boolean(c.care?.enabled),
            targets: c.care?.targets || [],
            quietMinutes: c.care?.quietMinutes ?? 20,
          },
          share: {
            enabled: Boolean(c.share?.enabled),
            targets: c.share?.targets || [],
            everyMinutes: c.share?.everyMinutes ?? 120,
          },
          digest: {
            enabled: Boolean(c.learning?.digest?.enabled),
            intervalHours: c.learning?.digest?.intervalHours ?? 24,
          },
        });
      }

      // 适配器要发图：按语气挑一张（素材库在核心，适配器那边没有图）
      if (req.method === 'GET' && url.pathname === '/api/media/pick') {
        const text = url.searchParams.get('text') || '';
        const r = this.admin?.pickSticker?.(text) || { ok: false, reason: '核心未就绪' };
        return json(res, 200, r);
      }

      // 适配器下载素材文件（给 UIA 拿去发）
      if (req.method === 'GET' && url.pathname.startsWith('/api/media/file/')) {
        const rest = url.pathname.slice('/api/media/file/'.length).split('/');
        const kindMap = { stickers: 'stickers', images: 'images', generated: 'generated' };
        const kind = kindMap[rest[0]] || 'stickers';
        const name = decodeURIComponent(rest.slice(1).join('/'));

        // 本地令牌或适配器令牌都放行 —— 适配器没有本地令牌。
        // 核心没配 inboundToken 时同样放行（单机自用场景，和 /api/media/ingest 一致）
        const localOk = checkToken(req, url, this.token);
        const expect = this.config.gateway?.wechat?.inboundToken || '';
        const got = req.headers['x-adapter-token'] || '';
        const adapterOk = !expect || got === expect;
        if (!localOk && !adapterOk) {
          return json(res, 403, { ok: false, error: '未授权' });
        }

        const r = this.admin?.readMediaFile?.(kind, name) || { ok: false, error: '核心未就绪' };
        if (!r.ok) return json(res, 404, { ok: false, error: r.error });
        res.writeHead(200, {
          'content-type': name.endsWith('.gif') ? 'image/gif' : 'image/jpeg',
          'content-length': r.buf.length,
        });
        return res.end(r.buf);
      }

      // ===== 控制台页面在线状态（「关网页即停服务」用）=====
      if (req.method === 'POST' && url.pathname === '/api/console/ping') {
        const body = await readJson(req).catch(() => ({}));
        this.touchPage(body.pageId);
        return json(res, 200, { ok: true, live: this.#livePages() });
      }
      if (req.method === 'POST' && url.pathname === '/api/console/bye') {
        const body = await readJson(req).catch(() => ({}));
        this.pageClosed(body.pageId);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/console/presence') {
        return json(res, 200, {
          ok: true,
          stopWhenNoConsole: this.config.server?.stopWhenNoConsole === true,
          effective: this.#autoStopWanted(),
          keepAlive: !this.#autoStopWanted() && this.config.server?.stopWhenNoConsole === true,
          live: this.#livePages(),
          sawPage: this.sawConsolePage,
          idleSeconds: Math.round(this.idleMs / 1000),
        });
      }

      // ===== 适配器配套接口 =====
      // 适配器在 bot_base() 之后拼这些路径来调用

      // 心跳：适配器每 20 秒报一次「我还活着 + 发送通道状态」
      //
      // 注意要按**适配器名字**分开存：同时接微信和 QQ 时，
      // 只留一个槽位的话两边会互相覆盖，控制台只能看到最后报到那个。
      if (req.method === 'POST' && url.pathname === '/api/bridge/heartbeat') {
        const body = await readJson(req).catch(() => ({}));
        const name = String(body.name || 'default').slice(0, 40);
        const platform = String(body.platform || 'wechat').slice(0, 20);

        const hb = {
          at: Date.now(),
          name,
          platform,
          uia: Boolean(body.uia),
          rest: Boolean(body.rest),
          listener: Boolean(body.listener),
          ffmpeg: Boolean(body.ffmpeg),
          account: String(body.account || ''),
          recentMessages: Number(body.recentMessages) || 0,
        };

        this.#adapterSlot(name).heartbeat = hb;
        // 兼容旧代码：bridgeHeartbeat 指向最近一次心跳
        this.engine.bridgeHeartbeat = hb;
        this.lastHeartbeat = hb;
        return json(res, 200, { ok: true, heartbeat: true, name });
      }

      /**
       * 适配器报到：告诉我它是谁、什么版本、跑的哪份安装。
       *
       * 以前这里还要比对「适配器的 data 目录和核心是不是同一个」——
       * 因为那时候适配器自己写素材库，目录不一致就「收藏了但看不到」。
       * 现在素材统一由核心存（POST /api/media/ingest），目录不一致不影响功能，
       * 所以这里只记录信息，不再告警。
       */
      if (req.method === 'POST' && url.pathname === '/api/bridge/hello') {
        const body = await readJson(req).catch(() => ({}));
        const name = String(body.name || 'default').slice(0, 40);

        const info = {
          at: Date.now(),
          name,
          platform: String(body.platform || 'wechat').slice(0, 20),
          version: String(body.version || ''),
          root: String(body.root || ''),
          pid: Number(body.pid) || 0,
        };
        const slot = this.#adapterSlot(name);
        slot.info = info;
        slot.platform = info.platform;

        // 兼容旧字段
        this.bridgeInfo = info;
        this.engine.bridgeInfo = info;

        return json(res, 200, { ok: true, core: 'yf-robot', name });
      }

      // 看图：适配器收到图片/表情包后调这个识别
      if (req.method === 'POST' && url.pathname === '/api/vision') {
        return await this.#visionApi(req, res);
      }

      // 听语音：适配器收到语音后调这个转写
      if (req.method === 'POST' && url.pathname === '/api/voice') {
        return await this.#voiceApi(req, res);
      }
      // 主动搭话：问该不该发
      if (req.method === 'GET' && url.pathname === '/api/care/due') {
        const last = Number(url.searchParams.get('last') || 0);
        const sentToday = Number(url.searchParams.get('sentToday') || 0);
        const r = checkCareDue({
          lastTs: last,
          sentToday,
          cfg: this.engine.config.care || {},
        });
        return json(res, 200, r);
      }
      // 主动搭话：生成内容
      if (req.method === 'GET' && url.pathname === '/api/care') {
        const text = composeCare({
          persona: this.engine.config.__personaName || '鲸鲸',
        });
        return json(res, 200, { text });
      }
      // B站分享：拿一个视频
      if (req.method === 'GET' && url.pathname === '/api/share') {
        return await this.#shareApi(req, res);
      }

      if (req.method === 'POST' && url.pathname === '/api/reset') {
        const body = await readJson(req);
        this.engine.reset(body.sessionId || 'web');
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      this.log.error?.('[web] ' + e.message);
      return json(res, 500, { error: e.message });
    }
  }

  /**
   * 同步接口：给外部适配器用。
   *
   * 和 /api/chat 的区别：这个不走 SSE，一次返回完整 JSON，
   * 适配器用起来更简单。
   *
   * 请求：{ chat_id, chat_type, senderId, senderName, text, msg_id, at_me }
   * 响应：{ action: 'reply'|'ignore', bubbles: [...], reason }
   */
  async #wechatSync(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return json(res, 400, { action: 'ignore', reason: 'invalid body' });
    }

    const chatId = body.chat_id || '';
    const isGroup = body.chat_type === 'group';
    const senderName = body.senderName || '群友';
    const text = body.text || '';

    if (!chatId || !text) {
      return json(res, 200, { action: 'ignore', reason: 'missing chat_id or text' });
    }

    try {
      // 主人身份识别（不再硬编码，防止任何人私聊都被当主人）
      const senderId = body.senderId || body.sender_id || '';
      const ownerCheck = this.engine.owner?.check({
        senderId,
        senderName,
        isGroup,
      }) || { isOwner: !isGroup, reason: '无主人模块' };

      // 记录见过的发送者，控制台「主人设置」可以直接选，不用手抄 wxid
      if (senderId && /^wxid_/.test(senderId)) {
        this.engine.knownSenders = this.engine.knownSenders || new Map();
        this.engine.knownSenders.set(senderId, {
          wxid: senderId,
          name: senderName,
          isGroup,
          lastSeen: Date.now(),
        });
      }

      // 群聊走策略，私聊直接回
      if (isGroup) {
        const result = await this.engine.handle({
          sessionId: `group:${chatId}`,
          text,
          speakerName: senderName,
          isOwner: ownerCheck.isOwner,
          ownerCheck,
        });

        if (!result.bubbles?.length) {
          return json(res, 200, { action: 'ignore', reason: result.reason || 'no_reply' });
        }
        // reply 是 适配器要求的主字段（它用 data["reply"] 判断是否发送），
        // bubbles 是完整气泡列表，两者都给
        return json(res, 200, {
          action: 'reply',
          reply: result.bubbles.join(''),
          bubbles: result.bubbles,
          images: result.images || [],
        });
      }

      const result = await this.engine.handle({
        sessionId: `private:${chatId}`,
        text,
        speakerName: senderName,
        isOwner: ownerCheck.isOwner,
        ownerCheck,
      });

      if (!result.bubbles?.length) {
        // 只有图没有文字时也要发出去
        if (result.images?.length) {
          return json(res, 200, {
            action: 'reply',
            reply: '',
            bubbles: [],
            images: result.images,
          });
        }
        return json(res, 200, { action: 'ignore', reason: result.reason || 'no_reply' });
      }
      return json(res, 200, {
        action: 'reply',
        reply: result.bubbles.join(''),
        bubbles: result.bubbles,
        // 她画的图，适配器会发到微信
        images: result.images || [],
      });
    } catch (e) {
      this.log.error?.('[wechat] ' + e.message);
      return json(res, 200, { action: 'ignore', reason: 'error: ' + e.message });
    }
  }

  /**
   * 看图接口：适配器收到图片/表情包后调这里识别。
   *
   * 请求：{ image: base64, mime: 'image/jpeg' }
   * 响应：{ ok, text }
   */
  async #visionApi(req, res) {
    let body;
    try {
      body = await readJson(req, res, 20 * 1024 * 1024);
    } catch {
      return json(res, 400, { ok: false, text: '', error: 'invalid body' });
    }

    const b64 = body.image || '';
    const mime = body.mime || 'image/jpeg';

    if (!b64) return json(res, 400, { ok: false, text: '', error: '缺少 image' });
    if (!this.engine.vision?.enabled) {
      return json(res, 200, { ok: false, text: '', error: '看图未启用' });
    }

    try {
      // 写临时文件，复用 VisionClient（它接受路径）
      const tmpDir = path.join(process.cwd(), '.tmp');
      const fs = await import('node:fs');
      fs.mkdirSync(tmpDir, { recursive: true });
      const ext = mime.includes('png') ? 'png' : 'jpg';
      const file = path.join(tmpDir, `viz-${Date.now()}.${ext}`);
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));

      const desc = await this.engine.vision.describe(file);
      try {
        fs.unlinkSync(file);
      } catch {}

      const text = typeof desc === 'string' ? desc : desc?.description || '';
      this.log.info?.(`[vision] ${text.slice(0, 60)}`);
      return json(res, 200, { ok: Boolean(text), text });
    } catch (e) {
      this.log.error?.('[vision] ' + e.message);
      return json(res, 200, { ok: false, text: '', error: e.message });
    }
  }

  /**
   * 语音转写：适配器收到语音后调这个。
   *
   * 适配器不自己实现识别，统一走这里 —— 只需在控制台配一处 Key，
   * 也不会出现「服务端能识别、适配器识别不了」的两套配置。
   */
  async #voiceApi(req, res) {
    let body;
    try {
      body = await readJson(req, res, 30 * 1024 * 1024);
    } catch {
      return json(res, 400, { ok: false, text: '', error: 'invalid body' });
    }

    const b64 = body.audio || '';
    if (!b64) return json(res, 400, { ok: false, text: '', error: '缺少 audio' });

    if (!this.engine.voice?.enabled) {
      return json(res, 200, { ok: false, text: '', error: '语音识别未启用' });
    }

    try {
      const buf = Buffer.from(b64, 'base64');
      if (buf.length < 100) {
        return json(res, 200, { ok: false, text: '', error: '音频太小' });
      }

      const r = await this.engine.voice.transcribe(buf);
      const text = typeof r === 'string' ? r : String(r?.text || '');

      this.log.info?.(`[voice] ${text ? text.slice(0, 60) : '（空）'}`);

      return json(res, 200, {
        ok: Boolean(text),
        text,
        format: r?.format,
        duration: r?.duration,
        error: text ? undefined : '识别结果为空',
      });
    } catch (e) {
      this.log.error?.('[voice] ' + e.message);
      return json(res, 200, { ok: false, text: '', error: e.message });
    }
  }

  /**
   * B站分享接口：拿一个视频。
   *
   * 响应：{ video: { title, url }, comment, topic }
   */
  async #shareApi(req, res) {
    const cfg = this.engine.config.share || {};
    if (!cfg.enabled) {
      return json(res, 200, { error: '分享未启用' });
    }

    try {
      const { BilibiliClient } = await import('../core/share.mjs');
      const client = new BilibiliClient({ logger: this.log });
      // 方法名是 pick（不是 pickOne）
      const video = await client.pick({ keywords: cfg.keywords || [] });

      if (!video) return json(res, 200, { error: '没找到视频' });

      // 让模型写一句评论
      let comment = '';
      try {
        const r = await this.engine.handle({
          sessionId: `share-${Date.now()}`,
          text: `看到一个B站视频《${video.title}》，用一句话说说你的看法，20字以内，像平时聊天那样，不要客套。`,
          speakerName: '系统',
          isOwner: true,
        });
        comment = (r.bubbles || []).join('') || '';
      } catch {}

      return json(res, 200, {
        video: { title: video.title, url: video.url },
        comment: comment || '刷到这个，你可能感兴趣',
        topic: video.title,
      });
    } catch (e) {
      this.log.error?.('[share] ' + e.message);
      return json(res, 200, { error: e.message });
    }
  }

  async #chat(req, res) {
    const body = await readJson(req, res, 12 * 1024 * 1024); // 图片体积大，放宽上限
    const sessionId = body.sessionId || 'web';
    const text = body.text || '';
    const images = body.images || []; // base64 data URL 数组
    const audio = body.audio || null; // base64 data URL

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    // 把 data URL 还原成 Buffer
    const imageBuffers = [];
    for (const item of images) {
      if (typeof item !== 'string') continue;
      const m = /^data:([^;]+);base64,(.+)$/.exec(item);
      if (!m) continue;
      try {
        imageBuffers.push(Buffer.from(m[2], 'base64'));
      } catch {}
    }

    try {
      if (imageBuffers.length && !this.engine.vision.enabled) {
        send('error', { message: '未启用看图功能，请先在 config.json 配置 vision' });
        return res.end();
      }

      // 语音：还原成 Buffer
      let audioBuf = null;
      if (typeof audio === 'string') {
        const am = /^data:([^;]+);base64,(.+)$/.exec(audio);
        if (am) {
          if (!this.engine.voice.enabled) {
            send('error', { message: '未启用语音转文字，请先在 config.json 配置 voice' });
            return res.end();
          }
          try {
            audioBuf = Buffer.from(am[2], 'base64');
          } catch {}
        }
      }

      const result = await this.engine.handle({
        sessionId,
        text,
        images: imageBuffers.length ? imageBuffers : undefined,
        audio: audioBuf || undefined,
        speakerName: body.name || '你',
        isOwner: true,
        onDelta: (chunk) => {
          if (!closed) send('delta', { text: chunk });
        },
      });

      if (closed) return res.end();

      if (result.reason === 'llm_error') {
        send('error', { message: result.error });
      } else {
        send('done', { bubbles: result.bubbles, reason: result.reason });
      }
    } catch (e) {
      if (!closed) send('error', { message: e.message });
    }

    res.end();
  }

  /**
   * 返回页面，并把 token 注入到 <head> 里。
   *
   * 前端从 window.__TOKEN__ 读取，之后每次管理接口调用都带上。
   * 这样恶意网页即使伪造请求，也拿不到 token。
   */
  #serveWithToken(res, fileName, code = 200) {
    const file = path.join(__dirname, '..', 'web', fileName);
    try {
      let html = readFileSync(file, 'utf8');

      // 注入 token（放在 head 最前面，确保脚本能用）
      // 注入 token，外加页面自身的构建时间 —— 用户能一眼看出是不是旧缓存
      const builtAt = new Date().toLocaleString('zh-CN');
      const inject =
        `<script>window.__TOKEN__=${JSON.stringify(this.token)};` +
        `window.__PAGE_BUILT__=${JSON.stringify(builtAt)};</script>`;
      if (html.includes('<head>')) {
        html = html.replace('<head>', '<head>\n' + inject);
      } else {
        html = inject + html;
      }

      res.writeHead(code, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        // 禁止被其他站点内嵌，防点击劫持
        'x-frame-options': 'DENY',
        // 不泄露 referrer
        'referrer-policy': 'no-referrer',
        // 不缓存：改完前端刷新就能生效，避免旧页面把 Key 之类的设置写坏
        'cache-control': 'no-store, no-cache, must-revalidate',
        pragma: 'no-cache',
        expires: '0',
      });
      res.end(html);
    } catch {
      json(res, 404, { error: `${fileName} 不存在` });
    }
  }

  #servePage(res) {
    return this.#serveWithToken(res, 'index.html');
  }

  #serveConsole(res) {
    return this.#serveWithToken(res, 'console.html');
  }

  async stop() {
    if (this.server) {
      await new Promise((r) => this.server.close(r));
      this.server = null;
    }
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req, _res, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}
