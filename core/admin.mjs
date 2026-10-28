/**
 * 管理接口：给控制台用的 API。
 *
 * 职责：
 *   - 查看服务状态（通道、端口、会话数）
 *   - 读写配置（模型、功能开关、群聊策略）
 *   - 查看日志
 *   - 测试连通性（模型/视觉/语音/搜索）
 *   - 管理人物卡
 *
 * 所有写操作都要校验，避免控制台把配置改坏。
 */
import { resolveWordsDir, scopeName, generatedDir } from './scoped-paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import cryptoMod from 'node:crypto';
import { ROOT } from './config.mjs';
import { listCards, loadAnyPersona } from './card.mjs';
import {
  LEARNING_DEFAULTS,
  readPending,
  savePending,
  extractWords,
  extractFromText,
  fetchSiteText,
  fetchSiteImages,
  mergeIntoBank,
} from './learning.mjs';
import { clearCache as clearWordCache, DEFAULT_BANKS } from './words.mjs';
import { fetchFeed } from './rss.mjs';
import { shouldRunDigest, collectFeedItems, summarizeDigest, DIGEST_DEFAULTS } from './digest.mjs';

/** PNG 分块用的 CRC32。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/**
 * 备份 config.json。
 *
 * 除了 config.json.bak（上一版），还留最近 5 个带时间戳的副本 ——
 * 万一连着改错好几次，也能翻回去。
 */
function backupConfig(file) {
  try {
    if (!fs.existsSync(file)) return;

    fs.copyFileSync(file, file + '.bak');

    // 带时间戳的轮转副本
    const dir = path.dirname(file);
    const base = path.basename(file);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(dir, `${base}.${stamp}.bak`));

    // 只留最近 5 个
    const olds = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(base + '.') && n.endsWith('.bak') && n !== base + '.bak')
      .sort();

    for (const n of olds.slice(0, Math.max(0, olds.length - 5))) {
      try {
        fs.unlinkSync(path.join(dir, n));
      } catch {}
    }
  } catch {}
}

/**
 * 写 config.json 的统一入口（带审计）。
 *
 * 为什么要包一层：
 *   Key 被莫名清空过好几次，查不出是谁干的。
 *   现在每次写盘都记一行日志，包含「哪个操作」和「Key 长度变化」，
 *   出事直接翻日志就能定位。
 */
function writeConfig(file, cfg, tag = 'unknown', logger = console) {
  /**
   * 读磁盘现值。
   *
   * 这里必须区分「文件不存在」和「文件存在但读不出来」：
   *   前者是首次运行，正常；
   *   后者说明文件正被别的进程写、或者已经损坏 ——
   *   这种情况下如果照常往下写，Key 守卫拿不到 before，会被静默跳过，
   *   结果就是拿一份没有 Key 的对象覆盖掉真实配置。
   *
   * 实测 Key 反复丢失就是这个原因：整个函数最后没有兜底。
   */
  let before = null;
  let beforeBroken = '';

  if (fs.existsSync(file)) {
    try {
      before = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      beforeBroken = e.message;
    }

    // 读坏了就试 .bak —— writeConfig 每次写前都会留一份
    if (!before) {
      try {
        before = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
      } catch {}
    }
  }

  const SECTIONS = ['llm', 'vision', 'voice', 'search', 'imagegen'];

  const keyLen = (o) => {
    if (!o) return -1;
    const parts = [];
    for (const k of SECTIONS) {
      const v = o[k]?.apiKey;
      parts.push(`${k}=${v ? v.length : 0}`);
    }
    return parts.join(',');
  };

  /**
   * Key 守卫：磁盘上已有的 Key，绝不被"不小心传了空值"覆盖。
   *
   * 为什么放在这一层：
   *   Key 丢过好几次，每次都是某个调用方构造的 cfg 对象里少了 apiKey。
   *   与其在每个调用方盯着，不如在唯一写盘出口兜住 ——
   *   只要磁盘上有，写的对象里没有/为空，就自动补回磁盘的值。
   *
   * 真想删 Key 的话，调用方传 clearKeys: ['voice'] 显式声明。
   */
  const guard = cfg.__guardKeys !== false;
  const clearList = Array.isArray(cfg.__clearKeys) ? cfg.__clearKeys : [];
  const restored = [];

  if (guard && before) {
    for (const k of SECTIONS) {
      if (clearList.includes(k)) continue;

      const oldKey = before[k]?.apiKey;
      const newKey = cfg[k]?.apiKey;

      if (oldKey && !newKey) {
        cfg[k] = cfg[k] || {};
        cfg[k].apiKey = oldKey;
        restored.push(k);
      }
    }
  }

  /**
   * 兜底：文件存在却读不出内容（不是首次运行），就直接拒绝写。
   *
   * 宁可能这次保存失败、让用户重试，也不能拿一份没守卫过的对象
   * 覆盖掉真实配置 —— 那等于所有 Key 一起丢。
   */
  if (!before && fs.existsSync(file) && guard) {
    const msg =
      `[config] 拒绝写入 by=${tag}：config.json 存在但读不出来` +
      `（${beforeBroken || '内容为空'}），`.replace('，', '，') +
      '此时写盘会丢掉所有 Key。请检查文件是否被占用或已损坏。';
    logger.error?.(msg);
    try {
      fs.appendFileSync(
        path.join(path.dirname(file), 'data', 'key-audit.log'),
        `${new Date().toISOString()} 拒绝写入 by=${tag} reason=${beforeBroken || 'unreadable'}\n`,
        'utf8',
      );
    } catch {}
    throw new Error('config.json 读不出来，已放弃本次保存以免丢失 Key（详见 data/key-audit.log）');
  }

  // 守卫字段不能写进文件
  delete cfg.__guardKeys;
  delete cfg.__clearKeys;

  // 备份：写前把当前文件存档
  try {
    if (fs.existsSync(file) && before) fs.copyFileSync(file, file + '.bak');
  } catch {}

  /**
   * 原子写：先写临时文件，再改名覆盖。
   *
   * 以前直接 writeFileSync 到 config.json —— 万一写到一半进程被杀、
   * 或者另一个进程正好在读，就会留下半个 JSON。
   * 下一次写入时 before 解析失败 → 守卫被跳过 → Key 全丢。
   * （Key 反复消失就是这么来的）
   */
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, file);

  const b = keyLen(before);
  const a = keyLen(cfg);
  const changed = b !== a;

  const line =
    `[config] 写入 by=${tag} ` +
    (changed ? `Key 变化: ${b} → ${a}` : `Key 未变 (${a})`) +
    (restored.length ? ` （守卫恢复: ${restored.join(',')}）` : '');

  if (changed) logger.warn?.(line);
  else logger.info?.(line);

  /**
   * Key 变更审计。
   *
   * 单独记一个文件，因为 Key 丢失这种问题事后要靠它定位：
   * 哪一次写入、哪个调用方、把哪个 Key 从多长变成了多长。
   * 光靠控制台日志翻不到（会被别的输出冲掉）。
   */
  try {
    if (changed || restored.length) {
      const ts = new Date().toISOString();
      const detail = SECTIONS.map((k) => {
        const o = before?.[k]?.apiKey ? before[k].apiKey.length : 0;
        const n = cfg[k]?.apiKey ? cfg[k].apiKey.length : 0;
        return o === n ? null : `${k}:${o}→${n}`;
      })
        .filter(Boolean)
        .join(' ');
      const auditDir = path.join(path.dirname(file), 'data');
      fs.mkdirSync(auditDir, { recursive: true });
      fs.appendFileSync(
        path.join(auditDir, 'key-audit.log'),
        `${ts} by=${tag} ${detail}${restored.length ? ` 守卫恢复=${restored.join(',')}` : ''}\n`,
        'utf8',
      );
    }
  } catch {}

  // 关键 Key 被清空时额外告警
  try {
    for (const k of SECTIONS) {
      if (before?.[k]?.apiKey && !cfg?.[k]?.apiKey) {
        logger.error?.(`[config] ⚠ ${k}.apiKey 被清空！by=${tag}`);
      }
    }
  } catch {}

  return { changed, before: b, after: a, restored };
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// 导出给单元测试用：Key 守卫和原子写是「丢了很难查」的那种逻辑，
// 必须能直接测，不然只能等它出事。
export { writeConfig };

export class AdminApi {
  /**
   * @param {object} opts
   * @param {import('./engine.mjs').ChatEngine} opts.engine
   * @param {object} opts.config
   * @param {string[]} [opts.channels] 已启用的通道名
   * @param {object} [opts.logger]
   */
  constructor({ engine, config, channels = [], logger = console, root = ROOT }) {
    this.engine = engine;
    this.config = config;
    this.channels = channels;
    this.log = logger;
    this.startedAt = Date.now();

    /**
     * 数据根目录。
     *
     * 默认是项目根，但**测试必须能改**：
     * 单元测试里的管理接口会用假 Key 调 /api/admin/config，
     * 如果写盘目标是真实 ROOT，就会把用户的 config.json 覆盖掉
     * （真实踩过：voice Key 被测试值盖掉再清空）。
     */
    this.root = root;

    // 把「自动学习」的执行器注入引擎，引擎负责调度、这里负责干活
    if (engine) {
      engine.autoLearnRunner = (cfg) => this.#runAutoLearn(cfg);
    }
  }

  /**
   * 自动学习的实际执行：跑一次常规联网学习。
   *
   * 由引擎在后台调用，不能抛错影响对话。
   */
  async #runAutoLearn(cfg = {}) {
    const mode = cfg.mode === 'media' ? 'media' : 'words';

    if (mode === 'media') {
      const r = await this.#learnMedia({
        kind: 'stickers',
        limit: Math.min(Number(cfg.maxPerRun) || 5, 10),
      });
      return { mode, words: 0, images: r?.downloaded?.length || 0, ok: r?.ok };
    }

    // 默认学词
    const r = await this.#learnWords();
    return { mode: 'words', words: r?.learned || 0, images: 0, ok: r?.ok };
  }

  /** 路由分发。返回 { code, body }。 */
  async handle(method, pathname, body) {
    try {
      // 状态
      if (method === 'GET' && pathname === '/api/admin/status') {
        return { code: 200, body: this.#status() };
      }

      // 词库列表
      if (method === 'GET' && pathname === '/api/admin/words') {
        const banks = this.#listWordBanks();
        // scoped = 当前用角色卡自己的一份（而不是公共 resources/）
        return {
          code: 200,
          body: { ...banks, scoped: this.#wordsDir() !== path.join(this.root, 'resources') },
        };
      }

      // 词库：手动添加词条
      if (method === 'POST' && pathname === '/api/admin/words/add') {
        return { code: 200, body: this.#addWordEntry(body) };
      }
      // 词库：删除某条
      if (method === 'POST' && pathname === '/api/admin/words/remove') {
        return { code: 200, body: this.#removeWordEntry(body) };
      }
      // 词库：开关
      if (method === 'POST' && pathname === '/api/admin/words/toggle') {
        return { code: 200, body: this.#toggleWordBank(body) };
      }

      // 词库内容
      if (method === 'GET' && pathname.startsWith('/api/admin/words/')) {
        const name = decodeURIComponent(pathname.slice('/api/admin/words/'.length));
        return { code: 200, body: this.#readWordBank(name) };
      }

      // 保存词库
      if (method === 'POST' && pathname === '/api/admin/words/save') {
        return { code: 200, body: this.#saveWordBank(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/words/read') {
        return { code: 200, body: this.#readWordBank(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/words/create') {
        return { code: 200, body: this.#createWordBank(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/words/delete') {
        return { code: 200, body: this.#deleteWordBank(body) };
      }

      // 桥接状态
      if (method === 'GET' && pathname === '/api/admin/bridge') {
        return { code: 200, body: await this.#bridgeStatus() };
      }

      // 微信会话列表（用于选择搭话/分享对象）
      if (method === 'GET' && pathname === '/api/admin/chats') {
        return { code: 200, body: this.#listChats() };
      }

      // 画图自检：让她画一张，验证 Key 能用
      if (method === 'POST' && pathname === '/api/admin/imagegen/test') {
        return { code: 200, body: await this.#testImageGen(body) };
      }

      // 记忆管理
      if (method === 'GET' && pathname === '/api/admin/memory') {
        return { code: 200, body: this.#listMemory() };
      }
      if (method === 'POST' && pathname === '/api/admin/memory/clear') {
        return { code: 200, body: this.#clearMemory(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/memory/fact') {
        return { code: 200, body: this.#addMemoryFact(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/memory/fact/remove') {
        return { code: 200, body: this.#removeMemoryFact(body) };
      }
      // 在系统里打开记忆文件/目录（本地工具用）
      if (method === 'POST' && pathname === '/api/admin/reveal') {
        return { code: 200, body: this.#revealPath(body) };
      }
      if (method === 'GET' && pathname.startsWith('/api/admin/memory/')) {
        const id = decodeURIComponent(pathname.slice('/api/admin/memory/'.length));
        return { code: 200, body: this.#readMemory(id) };
      }

      // 主人配置
      if (method === 'GET' && pathname === '/api/admin/owner') {
        return { code: 200, body: this.#getOwner() };
      }
      if (method === 'POST' && pathname === '/api/admin/owner') {
        return { code: 200, body: this.#setOwner(body) };
      }
      if (method === 'GET' && pathname === '/api/admin/owner/candidates') {
        return { code: 200, body: this.#ownerCandidates() };
      }

      if (method === 'GET' && pathname === '/api/admin/stickers') {
        return { code: 200, body: this.#listStickers() };
      }

      // 表情包描述索引：面板里查看/编辑/重建
      if (method === 'GET' && pathname === '/api/admin/sticker-index') {
        return { code: 200, body: this.#stickerIndexStatus() };
      }
      if (method === 'POST' && pathname === '/api/admin/sticker-index/save') {
        return { code: 200, body: this.#saveStickerIndex(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/sticker-index/rebuild') {
        return { code: 200, body: await this.#rebuildStickerIndex(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/sticker-index/clear') {
        return { code: 200, body: this.#clearStickerIndex(body) };
      }
      // 素材库查重/清理
      if (method === 'POST' && pathname === '/api/admin/media/dedupe') {
        return { code: 200, body: await this.#dedupeMedia(body) };
      }

      // 停止服务（面板上的「停止服务」按钮）
      if (method === 'POST' && pathname === '/api/admin/shutdown') {
        return { code: 200, body: this.#shutdown() };
      }

      // 重启服务
      if (method === 'POST' && pathname === '/api/admin/restart') {
        return { code: 200, body: this.#restart() };
      }
      if (method === 'GET' && pathname.startsWith('/api/admin/media/')) {
        const kind = pathname.slice('/api/admin/media/'.length).split('/')[0];
        return { code: 200, body: this.#listMedia(kind) };
      }
      // 删除：优先用路径参数（DELETE 带 body 在某些客户端会丢）
      if (method === 'DELETE' && pathname.startsWith('/api/admin/media/')) {
        const rest = pathname.slice('/api/admin/media/'.length).split('/');
        const kind = rest[0];
        const name = decodeURIComponent(rest.slice(1).join('/'));

        if (!name) {
          return { code: 400, body: { ok: false, error: '缺少文件名' } };
        }
        return { code: 200, body: this.#deleteMedia(kind, name) };
      }
      if (method === 'DELETE' && pathname === '/api/admin/media') {
        return { code: 200, body: this.#deleteMedia(body?.kind, body?.name) };
      }
      if (method === 'DELETE' && pathname === '/api/admin/stickers') {
        return { code: 200, body: this.#deleteMedia('stickers', body?.name) };
      }
      /**
       * 批量删除：选中哪几张删哪几张。
       *
       * 单张删除的接口还在（兼容旧前端），但一张张点太难受了 ——
       * 试画完一次几十张，得点几十次。
       */
      if (method === 'POST' && pathname === '/api/admin/media/delete-batch') {
        const kind = String(body?.kind || 'generated');
        const names = Array.isArray(body?.names) ? body.names.map(String) : [];
        if (!names.length) return { code: 200, body: { ok: false, error: '没有选中任何文件' } };
        if (names.length > 500) {
          return { code: 200, body: { ok: false, error: '一次最多删 500 张' } };
        }

        const deleted = [];
        const failed = [];
        for (const n of names) {
          const r = this.#deleteMedia(kind, n);
          if (r.ok) deleted.push(n);
          else failed.push({ name: n, error: r.error });
        }
        this.log.info?.(`[admin] 批量删除 ${kind}：成功 ${deleted.length}，失败 ${failed.length}`);
        return { code: 200, body: { ok: true, deleted: deleted.length, failed } };
      }

      /**
       * 按类型清空：试画完想一键清掉自己画的图。
       */
      if (method === 'POST' && pathname === '/api/admin/media/delete-all') {
        const kind = String(body?.kind || 'generated');
        const only = String(body?.only || 'all');

        const dirs = this.#mediaDirs();
        const dir = dirs[kind];
        if (!dir) return { code: 200, body: { ok: false, error: '未知类型' } };

        let files = [];
        try {
          files = fs.readdirSync(dir).filter((n) => /^[\w.-]{1,100}$/.test(n));
        } catch {
          return { code: 200, body: { ok: false, error: '目录读不到' } };
        }

        const match = (n) => {
          if (only === 'all') return true;
          if (only === 'generated') return n.startsWith('gen_');
          if (only === 'sticker') return n.startsWith('stk_') || n.startsWith('sticker_');
          if (only === 'upload') return n.startsWith('img_');
          return false;
        };

        const targets = files.filter(match);

        // 先预览：只报数量，前端弹确认后再真删
        if (body?.dryRun === true) {
          return { code: 200, body: { ok: true, dryRun: true, count: targets.length, kind, only } };
        }

        let deleted = 0;
        for (const n of targets) {
          if (this.#deleteMedia(kind, n).ok) deleted++;
        }
        this.log.info?.(`[admin] 清空 ${kind}（${only}）：删除 ${deleted} 张`);
        return { code: 200, body: { ok: true, dryRun: false, deleted } };
      }

      // 上传图片
      if (method === 'POST' && pathname === '/api/admin/media/upload') {
        return { code: 200, body: this.#uploadMedia(body) };
      }

      // 语音合成测试：现场合成一句，返回音频信息
      if (method === 'POST' && pathname === '/api/admin/test/tts') {
        const text = String(body?.text || '主人好，我是大肥鱼，语音测试。').slice(0, 200);
        const voice = body?.voice || this.config.voice?.ttsVoice || undefined;
        const { synthesize } = await import('./tts.mjs');
        const r = await synthesize({
          text,
          voice,
          config: this.config,
          log: (m) => this.log.info?.('[tts] ' + m),
        });
        if (!r.ok) return { code: 200, body: { ok: false, error: r.error } };
        return {
          code: 200,
          body: {
            ok: true,
            chars: r.chars,
            bytes: r.buf.length,
            voice: voice || 'Cherry',
            model: this.config.voice?.ttsModel || 'qwen3-tts-flash',
            preview: 'data:audio/wav;base64,' + r.buf.toString('base64'),
          },
        };
      }

      // ===== 情绪状态 =====
      if (method === 'GET' && pathname === '/api/admin/mood') {
        try {
          return { code: 200, body: { ok: true, list: this.engine.mood().list() } };
        } catch (e) {
          return { code: 200, body: { ok: false, error: e.message, list: [] } };
        }
      }

      // ===== 语音包 =====
      if (method === 'GET' && pathname === '/api/admin/voice/packs') {
        const { allVoices, readPacks } = await import('./voice-packs.mjs');
        return {
          code: 200,
          body: {
            voices: allVoices(this.root),
            packs: readPacks(this.root),
            current: this.config.voice?.ttsVoice || 'Cherry',
          },
        };
      }

      if (method === 'POST' && pathname === '/api/admin/voice/packs/import') {
        const { importPack } = await import('./voice-packs.mjs');
        const payload = body?.pack ?? body;
        const r = importPack(this.root, payload);
        return { code: 200, body: r };
      }

      if (method === 'POST' && pathname === '/api/admin/voice/packs/remove') {
        const { removePack } = await import('./voice-packs.mjs');
        return { code: 200, body: removePack(this.root, String(body?.name || '')) };
      }

      // ===== 工具列表（内置 + 插件，各自独立开关） =====
      if (method === 'GET' && pathname === '/api/admin/tools') {
        const kit = this.engine.tools;
        const off = kit?.disabledTools?.() || new Set();
        const pluginOf = new Map();
        for (const p of this.engine.plugins?.list?.() || []) {
          for (const t of p.tools || []) pluginOf.set(t, p.name);
        }

        // 用「全部定义」列出（包括关掉的，否则关了就从列表里消失，没法再打开）
        const all = kit?.allDefinitions?.() || [];
        const tools = all.map((d) => {
          const name = d.function?.name || '';
          return {
            name,
            description: d.function?.description || '',
            enabled: !off.has(name),
            source: pluginOf.has(name) ? 'plugin' : 'builtin',
            plugin: pluginOf.get(name) || '',
          };
        });

        return {
          code: 200,
          body: {
            enabled: this.config.tools?.enabled !== false,
            sandbox: this.config.tools?.sandbox || '',
            count: tools.length,
            offCount: tools.filter((t) => !t.enabled).length,
            tools,
          },
        };
      }

      if (method === 'POST' && pathname === '/api/admin/tools/toggle') {
        const name = String(body?.name || '');
        const on = Boolean(body?.enabled);
        if (!name) return { code: 200, body: { ok: false, error: '缺少工具名' } };

        const file = path.join(this.root, 'config.json');
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        current.tools = current.tools || {};
        const off = new Set(Array.isArray(current.tools.off) ? current.tools.off.map(String) : []);

        if (on) off.delete(name);
        else off.add(name);

        current.tools.off = [...off];
        writeConfig(file, current, 'tools/toggle', this.log);

        // 同步内存（引擎每轮读 this.config.tools.off）
        this.config.tools = { ...(this.config.tools || {}), ...current.tools };
        return { code: 200, body: { ok: true, name, enabled: on, off: current.tools.off } };
      }

      // ===== 逻辑库 =====
      if (method === 'GET' && pathname === '/api/admin/logic') {
        const lib = this.engine.logic();
        return {
          code: 200,
          body: {
            enabled: this.config.logic?.enabled !== false,
            autoLearn: this.config.logic?.autoLearn || {},
            stats: lib.stats(),
            rules: lib.list(),
          },
        };
      }

      if (method === 'POST' && pathname === '/api/admin/logic/add') {
        const lib = this.engine.logic();
        const r = lib.add({
          title: body?.title,
          rule: body?.rule,
          tags: Array.isArray(body?.tags) ? body.tags : String(body?.tags || '').split(/[,，\s]+/).filter(Boolean),
          source: 'manual',
          status: body?.status === 'pending' ? 'pending' : 'active',
        });
        return { code: 200, body: r };
      }

      if (method === 'POST' && pathname === '/api/admin/logic/update') {
        const lib = this.engine.logic();
        const id = String(body?.id || '');
        const rule = lib.rules.find((x) => x.id === id);
        if (!rule) return { code: 200, body: { ok: false, error: '没有这条' } };

        // 走一遍校验，别把注入内容改进去
        const { sanitizeRule, rejectReason } = await import('./logic.mjs');
        const nextRule = sanitizeRule(body?.rule ?? rule.rule);
        const bad = rejectReason(nextRule);
        if (bad) return { code: 200, body: { ok: false, error: bad } };

        rule.rule = nextRule;
        if (typeof body?.title === 'string') rule.title = sanitizeRule(body.title).slice(0, 60) || rule.title;
        if (Array.isArray(body?.tags)) rule.tags = body.tags.slice(0, 6).map((t) => sanitizeRule(t).slice(0, 16));
        if (['active', 'pending', 'disabled'].includes(body?.status)) rule.status = body.status;
        lib.save();
        return { code: 200, body: { ok: true, rule: { ...rule, grams: undefined, vec: undefined } } };
      }

      if (method === 'POST' && pathname === '/api/admin/logic/delete') {
        return { code: 200, body: this.engine.logic().remove(String(body?.id || '')) };
      }

      if (method === 'POST' && pathname === '/api/admin/logic/status') {
        return {
          code: 200,
          body: this.engine.logic().setStatus(String(body?.id || ''), String(body?.status || '')),
        };
      }

      if (method === 'POST' && pathname === '/api/admin/logic/learn') {
        const url = String(body?.url || '').trim();
        if (!url) return { code: 200, body: { ok: false, error: '要学哪个网址？' } };
        const learner = this.engine.learner();
        const r = await learner.learnFromUrl(url, {
          topic: String(body?.topic || '').trim(),
          mode: this.config.logic?.autoLearn?.mode === 'active' ? 'active' : 'pending',
        });
        return { code: 200, body: r };
      }

      // ===== 用量统计 =====
      if (method === 'GET' && pathname === '/api/admin/usage') {
        return { code: 200, body: this.engine.usage || { calls: 0, input: 0, output: 0 } };
      }

      // ===== 一键修复 =====
      if (method === 'POST' && pathname === '/api/admin/repair') {
        const { runRepair } = await import('./repair.mjs');
        const r = await runRepair({
          root: this.root,
          config: this.config,
          writeConfig,
          log: this.log,
        });
        this.log.info?.('[repair] 修了 ' + r.fixed.length + ' 项，剩 ' + r.problems.length + ' 个问题');
        return { code: 200, body: r };
      }

      // ===== 检查更新 =====
      if (method === 'GET' && pathname === '/api/admin/update/check') {
        const local = this.#version();
        const repo = this.config.repo || 'YF-YMWA/yf-robot';

        try {
          const { latest, versions } = await this.#latestTag(repo);
          return {
            code: 200,
            body: {
              ok: true,
              local,
              latest,
              versions: versions.slice(0, 5),
              hasUpdate: this.#cmpVersion(latest, local) > 0,
              url: 'https://github.com/' + repo + '/releases',
            },
          };
        } catch (e) {
          return {
            code: 200,
            body: {
              ok: false,
              local,
              error: '查不到最新版本（' + e.message + '）',
              url: 'https://github.com/' + repo + '/releases',
            },
          };
        }
      }

      // ===== 一键更新（下载新版本、覆盖代码、保留配置和数据）=====
      if (method === 'POST' && pathname === '/api/admin/update/apply') {
        const local = this.#version();
        const repo = this.config.repo || 'YF-YMWA/yf-robot';

        // 先查最新版本（复用检查更新的逻辑）
        let latest = '';
        try {
          const check = await this.#latestTag(repo);
          latest = check.latest || '';
        } catch (e) {
          return { code: 200, body: { ok: false, steps: [], error: '查不到最新版本：' + e.message } };
        }

        const { applyUpdate } = await import('./updater.mjs');
        const r = await applyUpdate({
          root: this.root,
          repo,
          latest,
          local,
          log: (m) => this.log.info?.(m),
        });
        return { code: 200, body: { ...r, local, latest } };
      }

      // ===== 插件 =====
      if (method === 'GET' && pathname === '/api/admin/plugins') {
        return {
          code: 200,
          body: {
            plugins: this.engine.plugins?.list?.() || [],
            tools: this.engine.plugins?.definitions?.().map((d) => d.function.name) || [],
          },
        };
      }
      if (method === 'POST' && pathname === '/api/admin/plugins/toggle') {
        const id = String(body?.id || '');
        const enabled = Boolean(body?.enabled);
        const r = this.engine.plugins?.setEnabled?.(id, enabled) || { ok: false, error: '插件未启用' };
        return { code: 200, body: r };
      }

      // ===== 知识库 =====
      if (method === 'GET' && pathname === '/api/admin/kb') {
        return {
          code: 200,
          body: {
            docs: this.engine.kbList?.() || [],
            enabled: this.config.kb?.enabled !== false,
          },
        };
      }
      if (method === 'POST' && pathname === '/api/admin/kb/upload') {
        return { code: 200, body: await this.#kbUpload(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/kb/delete') {
        return { code: 200, body: this.#kbDelete(body) };
      }
      // 从免费源下载
      if (method === 'POST' && pathname === '/api/admin/media/fetch') {
        return { code: 200, body: await this.#fetchFreeImages(body) };
      }

      // 联网学习：词库
      if (method === 'GET' && pathname === '/api/admin/learning') {
        return { code: 200, body: this.#learningStatus() };
      }
      if (method === 'POST' && pathname === '/api/admin/learning/words') {
        return { code: 200, body: await this.#learnWords() };
      }
      if (method === 'POST' && pathname === '/api/admin/learning/media') {
        return { code: 200, body: await this.#learnMedia(body) };
      }

      // 定向网站学习
      if (method === 'POST' && pathname === '/api/admin/learning/site') {
        return { code: 200, body: await this.#learnFromSite(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/learning/sites') {
        return { code: 200, body: this.#saveSites(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/learning/site/preview') {
        return { code: 200, body: await this.#previewSite(body) };
      }

      // 定向网站抓图
      if (method === 'POST' && pathname === '/api/admin/learning/media/sites') {
        return { code: 200, body: this.#saveMediaSites(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/learning/media/site/preview') {
        return { code: 200, body: await this.#previewMediaSite(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/learning/media/site') {
        return { code: 200, body: await this.#learnMediaFromSite(body) };
      }

      // RSS 订阅
      if (method === 'POST' && pathname === '/api/admin/learning/rss/feeds') {
        return { code: 200, body: this.#saveRssFeeds(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/learning/rss/preview') {
        return { code: 200, body: await this.#previewRss(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/learning/rss') {
        return { code: 200, body: await this.#learnFromRss(body) };
      }

      // 每日热点摘要
      if (method === 'GET' && pathname === '/api/admin/learning/digest') {
        return { code: 200, body: this.#digestStatus() };
      }
      if (method === 'POST' && pathname === '/api/admin/learning/digest') {
        return { code: 200, body: this.#saveDigest(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/learning/digest/run') {
        return { code: 200, body: await this.#runDigest(body) };
      }
      // 供 app.mjs 定时器调用
      // tick 也接受 GET：调试时用浏览器/curl 直接打开就能看，不用构造 POST
      if ((method === 'POST' || method === 'GET') && pathname === '/api/admin/learning/digest/tick') {
        return { code: 200, body: await this.#digestTick() };
      }
      if (method === 'POST' && pathname === '/api/admin/learning/apply') {
        return { code: 200, body: this.#applyLearned(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/learning/discard') {
        return { code: 200, body: this.#discardLearned() };
      }

      // 配置读取
      if (method === 'GET' && pathname === '/api/admin/config') {
        return { code: 200, body: this.#publicConfig() };
      }

      // 配置写入
      if (method === 'POST' && pathname === '/api/admin/config') {
        return { code: 200, body: this.#saveConfig(body) };
      }

      // 日志
      if (method === 'GET' && pathname === '/api/admin/logs') {
        return { code: 200, body: this.#logs() };
      }

      // 人物卡列表
      if (method === 'GET' && pathname === '/api/admin/cards') {
        return { code: 200, body: { cards: listCards(this.root), current: this.config.card || null } };
      }

      // 读取单张卡片完整内容
      if (method === 'GET' && pathname.startsWith('/api/admin/card/')) {
        const id = decodeURIComponent(pathname.slice('/api/admin/card/'.length));
        return { code: 200, body: this.#readCard(id) };
      }

      // 保存卡片
      if (method === 'POST' && pathname === '/api/admin/card/save') {
        return { code: 200, body: this.#saveCard(body) };
      }

      // 删除卡片
      if (method === 'POST' && pathname === '/api/admin/card/delete') {
        return { code: 200, body: this.#deleteCard(body) };
      }

      // 切换角色
      if (method === 'POST' && pathname === '/api/admin/card') {
        return { code: 200, body: this.#switchCard(body) };
      }

      // 连通性测试
      if (method === 'POST' && pathname === '/api/admin/test') {
        return { code: 200, body: await this.#test(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/test/llm') {
        return { code: 200, body: await this.#testLlm(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/test/vision') {
        return { code: 200, body: await this.#testVision(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/test/search') {
        return { code: 200, body: await this.#testSearch(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/test/voice') {
        return { code: 200, body: await this.#testVoice(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/test/imagegen') {
        return { code: 200, body: await this.#testImageGen(body) };
      }
      if (method === 'POST' && pathname === '/api/admin/test/all') {
        return { code: 200, body: await this.#testAll() };
      }

      // 会话管理
      if (method === 'GET' && pathname === '/api/admin/sessions') {
        return { code: 200, body: this.engine.sessions.stats() };
      }
      if (method === 'POST' && pathname === '/api/admin/sessions/reset') {
        if (body?.id) this.engine.reset(body.id);
        return { code: 200, body: { ok: true, sessions: this.engine.sessions.stats() } };
      }

      return null; // 不是管理接口
    } catch (e) {
      this.log.error?.('[admin] ' + e.message);
      return { code: 500, body: { ok: false, error: e.message } };
    }
  }

  // ===== 能力测试 =====

  /**
   * 测试对话模型。
   * 支持临时传 apiKey / baseUrl / model 做「先测后存」。
   */
  async #testLlm(body = {}) {
    const cfg = this.engine.config.llm;
    const baseUrl = (body.baseUrl || cfg.baseUrl || '').trim();
    const apiKey = (body.apiKey || cfg.apiKey || '').trim();
    const model = (body.model || cfg.model || '').trim();

    if (!apiKey) return { ok: false, error: '没有 API Key' };
    if (!baseUrl) return { ok: false, error: '没有接口地址' };

    const t0 = Date.now();
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30000);
      timer.unref?.();

      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: '用一句话介绍你自己' }],
          max_tokens: 100,
        }),
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }

      const j = await res.json();
      const reply = j.choices?.[0]?.message?.content || '';
      return {
        ok: Boolean(reply),
        ms: Date.now() - t0,
        model,
        reply: reply.slice(0, 150),
        usage: j.usage,
      };
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? '超时（30秒）' : e.message };
    }
  }

  /**
   * 测试看图。
   * 生成一张纯色测试图，让模型说出颜色。
   */
  async #testVision(body = {}) {
    const cfg = this.engine.config.vision;
    const apiKey = (body.apiKey || cfg.apiKey || this.engine.config.llm?.apiKey || '').trim();
    const model = (body.model || cfg.model || '').trim();
    const baseUrl = (body.baseUrl || cfg.baseUrl || this.engine.config.llm?.baseUrl || '').trim();

    if (!apiKey) return { ok: false, error: '没有 API Key' };

    // 生成一张 64x64 纯红色 PNG（内置，不依赖文件）
    const png = this.#makeTestPng();
    const b64 = png.toString('base64');

    const t0 = Date.now();
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60000);
      timer.unref?.();

      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '这张图是什么颜色？只回答颜色名，两个字以内。' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
              ],
            },
          ],
          // 各家上限不同：智谱 1024，DeepSeek 可到 2048+
          // 取配置值，默认 1024（兼容性最好）
          max_tokens: Math.min(Number(cfg.maxTokens) || 1024, 1024),
        }),
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }

      const j = await res.json();
      const msg = j.choices?.[0]?.message || {};
      const answer = (msg.content || '').trim();

      if (!answer) {
        const hasReasoning = Boolean(msg.reasoning_content);
        return {
          ok: false,
          error: hasReasoning
            ? '模型只输出了思考过程（reasoning_content），content 为空。可尝试调大 max_tokens'
            : '模型返回空内容',
        };
      }

      const isRed = /红|red/i.test(answer);
      return {
        ok: true,
        ms: Date.now() - t0,
        model,
        answer: answer.slice(0, 100),
        correct: isRed,
        hint: isRed ? '识别正确（红色）' : `模型说是「${answer}」，标准答案是红色`,
      };
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? '超时（60秒）' : e.message };
    }
  }

  /** 生成一张 64x64 纯红 PNG（手写 PNG 字节，不依赖图形库）。 */
  #makeTestPng() {
    const W = 64;
    const H = 64;

    // 每行：1 字节 filter + W*3 字节 RGB
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
      const row = y * (W * 3 + 1);
      raw[row] = 0; // filter: none
      for (let x = 0; x < W; x++) {
        const p = row + 1 + x * 3;
        raw[p] = 220; // R
        raw[p + 1] = 40; // G
        raw[p + 2] = 60; // B
      }
    }

    const idat = zlib.deflateSync(raw);

    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const typeBuf = Buffer.from(type, 'ascii');
      const body = Buffer.concat([typeBuf, data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body) >>> 0);
      return Buffer.concat([len, body, crc]);
    };

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type: RGB
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  }

  /** 测试联网搜索。 */
  async #testSearch(body = {}) {
    const cfg = this.engine.config.search;
    const query = (body.query || '今天的日期').trim();

    if (!this.engine.search) return { ok: false, error: '搜索未启用' };

    const t0 = Date.now();
    try {
      const results = await this.engine.search.search(query);
      return {
        ok: results.length > 0,
        ms: Date.now() - t0,
        provider: cfg.provider,
        query,
        count: results.length,
        samples: results.slice(0, 3).map((r) => ({
          title: r.title,
          snippet: (r.snippet || '').slice(0, 100),
        })),
        error: results.length ? undefined : '没有搜到结果',
      };
    } catch (e) {
      return { ok: false, error: e.message, provider: cfg.provider, query };
    }
  }

  /**
   * 测试语音识别。
   *
   * 语音识别需要一个音频文件，这里用最小的 WAV 头做探活：
   * 只要接口连通、鉴权通过，就算可用（内容识别结果不重要）。
   */
  async #testVoice(body = {}) {
    const cfg = this.engine.config.voice || {};

    if (cfg.enabled !== true) {
      return {
        ok: false,
        skipped: true,
        error: '语音识别未启用（在下面打开「启用」并填 Key）',
        model: cfg.model,
      };
    }

    if (!this.engine.voice) {
      return { ok: false, error: '语音客户端未初始化', model: cfg.model };
    }

    const t0 = Date.now();

    // 没 Key 时给明确指引，别让用户对着一串 401 发懵
    if (!cfg.apiKey) {
      return {
        ok: false,
        error:
          '还没填 API Key。在下面那个 Key 输入框粘贴阿里云百炼的 Key（sk- 开头），' +
          '然后点「保存」，再点「测试」。',
        model: cfg.model,
      };
    }

    // 优先用真实语音样本（能听到实际识别效果），没有就用静音探活
    const samplePath = path.join(this.root, 'data', 'test-media', 'speech-1.wav');
    let buf;
    let isSilence = true;

    if (fs.existsSync(samplePath)) {
      try {
        buf = fs.readFileSync(samplePath);
        isSilence = false;
      } catch {}
    }

    if (!buf) {
      // 生成 0.3 秒静音 WAV 作为探活信号
      const sampleRate = 16000;
      const seconds = 0.3;
      const numSamples = Math.floor(sampleRate * seconds);
      const dataSize = numSamples * 2;
      buf = Buffer.alloc(44 + dataSize);

      buf.write('RIFF', 0);
      buf.writeUInt32LE(36 + dataSize, 4);
      buf.write('WAVE', 8);
      buf.write('fmt ', 12);
      buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(1, 20);
      buf.writeUInt16LE(1, 22);
      buf.writeUInt32LE(sampleRate, 24);
      buf.writeUInt32LE(sampleRate * 2, 28);
      buf.writeUInt16LE(2, 32);
      buf.writeUInt16LE(16, 34);
      buf.write('data', 36);
      buf.writeUInt32LE(dataSize, 40);
    }

    try {
      const fn = this.engine.voice.transcribe?.bind(this.engine.voice);
      if (typeof fn !== 'function') {
        return { ok: false, error: '语音客户端没有 transcribe 方法', model: cfg.model };
      }

      const result = await fn(buf, { mime: 'audio/wav' });

      // transcribe 返回 { text, format, converted, duration }，不是裸字符串
      const text =
        typeof result === 'string' ? result : String(result?.text || '');

      return {
        ok: true,
        ms: Date.now() - t0,
        model: cfg.model,
        format: result?.format,
        duration: result?.duration,
        // 静音通常识别为空串（或一个语气词），这本身不算失败
        text: text.slice(0, 80) || (isSilence ? '（静音，识别为空是正常的）' : '（识别为空）'),
        sample: isSilence ? 'silence' : 'speech',
      };
    } catch (e) {
      return { ok: false, error: e.message, model: cfg.model, ms: Date.now() - t0 };
    }
  }

  /** 一次性测试全部能力。 */
  async #testAll() {
    const [llm, vision, search, voice, imagegen] = await Promise.all([
      this.#testLlm().catch((e) => ({ ok: false, error: e.message })),
      this.#testVision().catch((e) => ({ ok: false, error: e.message })),
      this.#testSearch().catch((e) => ({ ok: false, error: e.message })),
      this.#testVoice().catch((e) => ({ ok: false, error: e.message })),
      this.#testImageGen({ prompt: '一只蓝色胖鲸鱼，卡通风格，白底' }).catch((e) => ({
        ok: false,
        error: e.message,
      })),
    ]);

    return { llm, vision, search, voice, imagegen, at: Date.now() };
  }

  // ===== 词库管理 =====

  /** 词库目录（按角色卡解析：卡内有就用自己的，否则用公共的）。 */
  #wordsDir() {
    return resolveWordsDir(this.root, scopeName(this.config.card || 'default'));
  }

  /** 列出词库文件。 */
  #listWordBanks() {
    const dir = this.#wordsDir();
    if (!fs.existsSync(dir)) return { banks: [], dir };

    const banks = [];
    const wordCfg = this.config.words || {};

    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.txt')) continue;
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
      const key = name.replace('.txt', '');

      banks.push({
        name: key,
        file: name,
        entries: lines.length,
        size: stat.size,
        // 默认启用，除非配置里明确关了
        enabled: wordCfg[key]?.enabled !== false,
        label: DEFAULT_BANKS[key]?.label || key,
      });
    }

    // 固定顺序：网络用语 → 回怼 → 缩写
    const order = ['slang', 'clapback', 'abbrev'];
    banks.sort((a, b) => {
      const ia = order.indexOf(a.name);
      const ib = order.indexOf(b.name);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    return { banks, dir };
  }

  /** 读一个词库（编辑用）。 */
  #readWordBank(nameOrBody) {
    const name =
      typeof nameOrBody === 'string'
        ? nameOrBody.trim()
        : String(nameOrBody?.name || '').trim();

    if (!name) return { ok: false, error: '缺少词库名' };
    if (!/^[\w-]{1,40}$/.test(name)) return { ok: false, error: '词库名不合法' };

    const file = path.join(this.#wordsDir(), name + '.txt');
    if (!fs.existsSync(file)) return { ok: false, error: `词库不存在: ${name}` };

    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    const entries = [];
    const comments = [];

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('#')) {
        comments.push(t.replace(/^#+\s*/, ''));
        continue;
      }
      entries.push(t);
    }

    return {
      ok: true,
      name,
      content,
      entries: entries.length,
      comments,
      bytes: Buffer.byteLength(content),
    };
  }

  /**
   * 手动添加一条词条。
   *
   * @param {object} body { bank, word, explain }
   */
  #addWordEntry(body = {}) {
    const bank = String(body.bank || 'slang').trim();
    const word = String(body.word || '').trim();
    const explain = String(body.explain || '').trim();

    if (!/^[\w-]{1,40}$/.test(bank)) {
      return { ok: false, error: '词库名不合法' };
    }
    if (!word) return { ok: false, error: '词条不能为空' };
    if (word.length > 30) return { ok: false, error: '词条太长（上限 30 字）' };
    if (explain.length > 100) return { ok: false, error: '解释太长（上限 100 字）' };

    const file = path.join(this.#wordsDir(), bank + '.txt');
    if (!fs.existsSync(file)) return { ok: false, error: `词库 ${bank} 不存在` };

    const content = fs.readFileSync(file, 'utf8');

    // 查重：按「词条｜」前缀匹配
    const exists = content
      .split('\n')
      .some((l) => {
        const t = l.trim();
        if (!t || t.startsWith('#')) return false;
        const sep = t.includes('｜') ? '｜' : '|';
        return t.split(sep)[0].trim() === word;
      });

    if (exists) return { ok: false, error: `「${word}」已存在` };

    // 追加到末尾（带标记区，方便识别来源）
    const marker = '## 手动添加';
    let next = content;
    if (!next.includes(marker)) next = next.trimEnd() + `\n\n${marker}\n`;
    next += `${word}｜${explain}\n`;

    // 备份
    backupConfig(file);

    fs.writeFileSync(file, next, 'utf8');
    clearWordCache();

    return { ok: true, bank, word, message: `已添加「${word}」到 ${bank}` };
  }

  /** 删除一条词条。 */
  #removeWordEntry(body = {}) {
    const bank = String(body.bank || 'slang').trim();
    const word = String(body.word || '').trim();

    if (!/^[\w-]{1,40}$/.test(bank)) return { ok: false, error: '词库名不合法' };
    if (!word) return { ok: false, error: '词条不能为空' };

    const file = path.join(this.#wordsDir(), bank + '.txt');
    if (!fs.existsSync(file)) return { ok: false, error: `词库 ${bank} 不存在` };

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const kept = [];
    let removed = 0;

    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) {
        kept.push(line);
        continue;
      }

      const sep = t.includes('｜') ? '｜' : '|';
      const w = t.split(sep)[0].trim();

      if (w === word) {
        removed++;
        continue;
      }
      kept.push(line);
    }

    if (!removed) return { ok: false, error: `没找到「${word}」` };

    backupConfig(file);

    fs.writeFileSync(file, kept.join('\n'), 'utf8');
    clearWordCache();

    return { ok: true, bank, word, removed, message: `已删除「${word}」` };
  }

  /** 开关某个词库。 */
  #toggleWordBank(body = {}) {
    const bank = String(body.bank || '').trim();
    if (!bank) return { ok: false, error: '缺少词库名' };

    const enabled = Boolean(body.enabled);

    const file = path.join(this.root, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

    cfg.words = cfg.words || {};
    cfg.words[bank] = { ...(cfg.words[bank] || {}), enabled };

    writeConfig(file, cfg, 'words/toggle', this.log);

    // 同步内存
    this.config.words = { ...(this.config.words || {}), ...cfg.words };
    clearWordCache();

    return { ok: true, bank, enabled, message: `${bank} 已${enabled ? '启用' : '关闭'}` };
  }

  /** 保存词库。 */
  #saveWordBank(body) {
    const name = String(body?.name || '').trim();
    const content = String(body?.content || '');

    if (!name) return { ok: false, error: '缺少词库名' };

    if (!/^[\w-]{1,40}$/.test(name)) {
      return { ok: false, error: '词库名只能用英文、数字、下划线、短横线' };
    }
    if (content.length > 500 * 1024) {
      return { ok: false, error: '内容太大（上限 500KB）' };
    }

    const dir = this.#wordsDir();
    fs.mkdirSync(dir, { recursive: true });

    const file = path.join(dir, name + '.txt');
    const backup = file + '.bak';
    if (fs.existsSync(file)) {
      try {
        fs.copyFileSync(file, backup);
      } catch {}
    }

    fs.writeFileSync(file, content, 'utf8');
    clearWordCache();

    const entries = content.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
    this.log.info?.(`[words] 保存 ${name}.txt（${entries} 条）`);

    return { ok: true, name, entries, message: `已保存，共 ${entries} 条` };
  }

  /** 新建词库。 */
  #createWordBank(body = {}) {
    const name = String(body.name || '').trim();
    if (!name) return { ok: false, error: '缺少词库名' };
    if (!/^[\w-]{1,40}$/.test(name)) {
      return { ok: false, error: '词库名只能用英文、数字、下划线、短横线' };
    }

    const file = path.join(this.#wordsDir(), name + '.txt');
    if (fs.existsSync(file)) return { ok: false, error: `词库 ${name} 已存在` };

    const title = String(body.title || name).slice(0, 40);
    const content = `# ${title}\n# 格式：词条｜一句话解释\n\n`;

    fs.mkdirSync(this.#wordsDir(), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    clearWordCache();

    return { ok: true, name, message: `已创建词库 ${name}` };
  }

  /** 删除词库。 */
  #deleteWordBank(body = {}) {
    const name = String(body.name || '').trim();
    if (!name) return { ok: false, error: '缺少词库名' };
    if (!/^[\w-]{1,40}$/.test(name)) return { ok: false, error: '词库名不合法' };

    // 内置的别删，删了提示词会缺东西
    if (['slang', 'clapback', 'abbrev'].includes(name)) {
      return { ok: false, error: '内置词库不能删除（可以关闭）' };
    }

    const file = path.join(this.#wordsDir(), name + '.txt');
    if (!fs.existsSync(file)) return { ok: false, error: `词库 ${name} 不存在` };

    try {
      fs.unlinkSync(file);
      clearWordCache();
      return { ok: true, name, message: `已删除词库 ${name}` };
    } catch (e) {
      return { ok: false, error: `删除失败：${e.message}` };
    }
  }

  // ===== 素材库（图片 / 表情包） =====

  /**
   * 统一管理收到的图片和表情包。
   *
   * 目录结构：
   *   data/stickers/   表情包（gif/png/jpg，来自表情消息）
   *   data/images/     普通图片（收到的照片/截图）
   */
  #mediaDirs() {
    return {
      // 表情包和收到的图是共享的：换角色还能用同一批
      stickers: path.join(this.root, 'data', 'stickers'),
      images: path.join(this.root, 'data', 'images'),
      // 她画的图按角色卡分开（data/<卡片>/generated）
      generated: generatedDir(this.root, scopeName(this.config.card || 'default')),
    };
  }

  #listMedia(kind) {
    const dirs = this.#mediaDirs();
    const dir = dirs[kind] || dirs.stickers;

    // 目录不存在时也返回一致的字段（否则前端拿到 undefined）
    if (!fs.existsSync(dir)) {
      return { items: [], dir, kind, count: 0 };
    }

    const items = [];
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(name)) continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      items.push({
        name,
        size: stat.size,
        added: stat.mtime.toISOString(),
        url: `/api/media/${kind}/${encodeURIComponent(name)}`,
      });
    }
    items.sort((a, b) => new Date(b.added) - new Date(a.added));
    return { items, dir, kind, count: items.length };
  }

  #deleteMedia(kind, name) {
    const safe = String(name || '').trim();
    if (!safe) return { ok: false, error: '缺少文件名' };
    if (!/^[\w.-]{1,100}$/.test(safe)) return { ok: false, error: '文件名不合法' };

    const dirs = this.#mediaDirs();
    const dir = dirs[kind];
    if (!dir) {
      return { ok: false, error: `未知类型「${kind}」，可选：${Object.keys(dirs).join(' / ')}` };
    }

    const full = path.join(dir, safe);

    // 防目录穿越（虽然正则已限制，再保险一次）
    if (!path.resolve(full).startsWith(path.resolve(dir) + path.sep)) {
      return { ok: false, error: '路径越界' };
    }

    if (!fs.existsSync(full)) {
      return { ok: false, error: `文件不存在：${safe}` };
    }

    try {
      fs.unlinkSync(full);
      this.log.info?.(`[admin] 删除素材 ${kind}/${safe}`);
      return { ok: true, message: `已删除 ${safe}` };
    } catch (e) {
      return { ok: false, error: `删除失败：${e.message}` };
    }
  }

  // ===== 表情包（兼容旧接口） =====

  #listStickers() {
    const r = this.#listMedia('stickers');
    return {
      stickers: r.items,
      dir: r.dir,
      enabled: this.config.sticker?.enabled !== false,
    };
  }

  // ===== 表情包描述索引 =====

  /** 索引文件路径。 */
  #stickerIndexFile() {
    return path.join(this.root, 'data', 'stickers', 'index.json');
  }

  #readStickerIndex() {
    try {
      const raw = fs.readFileSync(this.#stickerIndexFile(), 'utf8');
      const j = JSON.parse(raw);
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }

  #writeStickerIndex(index) {
    const file = this.#stickerIndexFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  /**
   * 给一张图算 dHash 指纹（8x8 灰度相邻比较，64 位）。
   *
   * 为什么不用 md5：同一张表情包截两次图，JPEG 头差几十字节，
   * md5 完全不同但人眼看是一张 —— 素材库就会越攒越多。
   *
   * 两条路：
   *   1. ffmpeg（快、不用起进程池、跟 media-ingest 用的是同一套算法）
   *   2. Python + Pillow（有些机器没装 ffmpeg，随包带的 Python 里一定有 Pillow）
   * 两条都不通就返回空串，调用方退回「只按 md5 去重」。
   */
  async #dHashOf(file) {
    // 优先 ffmpeg：和 media-ingest 保持同一套算法，两处算出来的指纹才能互相比
    try {
      const { perceptualHash } = await import('./media-ingest.mjs');
      const buf = fs.readFileSync(file);
      const ffmpeg = this.config.vision?.ffmpeg || this.config.imagegen?.ffmpeg || 'ffmpeg';
      const h = await perceptualHash(buf, ffmpeg);
      if (h) return h;
    } catch {}

    // 兜底：随包的 Python + Pillow
    try {
      const { execFile } = await import('node:child_process');
      const py = path.join(this.root, 'runtime', 'python', 'python.exe');
      if (!fs.existsSync(py)) return '';

      const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(this.root, 'runtime', 'python', 'Lib', 'site-packages'))})
from PIL import Image
img = Image.open(sys.argv[1]).convert('L').resize((9, 8), Image.LANCZOS)
px = list(img.getdata())
bits = 0
for r in range(8):
    for c in range(8):
        bits = (bits << 1) | (1 if px[r*9+c] > px[r*9+c+1] else 0)
print('%016x' % bits)
`;
      const tmpPy = path.join(this.root, 'data', 'tmp', 'dhash-once.py');
      fs.mkdirSync(path.dirname(tmpPy), { recursive: true });
      fs.writeFileSync(tmpPy, code, 'utf8');

      return await new Promise((resolve) => {
        execFile(py, [tmpPy, file], { timeout: 20000 }, (err, stdout) => {
          resolve(err ? '' : String(stdout).trim());
        });
      });
    } catch {
      return '';
    }
  }

  /**
   * 体检 + 清理素材库的重复。
   *
   * dryRun=true 只报告不删（面板上先给用户看一眼）。
   */
  async #dedupeMedia(body = {}) {
    const dryRun = body.dryRun !== false;
    const dirs = this.#mediaDirs();
    const KINDS = ['stickers', 'images', 'generated'];

    const items = [];
    for (const kind of KINDS) {
      const dir = dirs[kind];
      if (!dir || !fs.existsSync(dir)) continue;
      for (const n of fs.readdirSync(dir)) {
        if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(n)) continue;
        const full = path.join(dir, n);
        try {
          items.push({ kind, name: n, full, size: fs.statSync(full).size });
        } catch {}
      }
    }

    // 算指纹（同一个文件只算一次）
    for (const it of items) {
      it.hash = await this.#dHashOf(it.full);
    }

    const valid = items.filter((i) => i.hash);

    const hamming = (a, b) => {
      try {
        let x = BigInt('0x' + a) ^ BigInt('0x' + b);
        let n = 0;
        while (x) {
          n += Number(x & 1n);
          x >>= 1n;
        }
        return n;
      } catch {
        return 64;
      }
    };

    // 分组：差 6 位以内算同一张
    const groups = [];
    const used = new Set();

    for (let i = 0; i < valid.length; i++) {
      if (used.has(valid[i].full)) continue;
      const g = [valid[i]];
      for (let j = i + 1; j < valid.length; j++) {
        if (used.has(valid[j].full)) continue;
        if (hamming(valid[i].hash, valid[j].hash) <= 6) {
          g.push(valid[j]);
          used.add(valid[j].full);
        }
      }
      if (g.length > 1) {
        used.add(valid[i].full);
        groups.push(g);
      }
    }

    const removed = [];

    if (!dryRun) {
      for (const g of groups) {
        // 保留规则：优先留在 stickers（正牌表情包），其次 generated，最后 images；
        // 同一类里保留文件最大的（通常质量最好）
        const rank = { stickers: 0, generated: 1, images: 2 };
        g.sort((a, b) => {
          const ra = rank[a.kind] ?? 9;
          const rb = rank[b.kind] ?? 9;
          if (ra !== rb) return ra - rb;
          return b.size - a.size;
        });

        const keep = g[0];
        for (const it of g.slice(1)) {
          try {
            fs.unlinkSync(it.full);
            removed.push({ kind: it.kind, name: it.name, kept: keep.name });

            // 索引里的一起删
            const idx = this.#readStickerIndex();
            if (idx[it.name]) {
              delete idx[it.name];
              this.#writeStickerIndex(idx);
            }
          } catch (e) {
            this.log.warn?.(`[media] 删除 ${it.name} 失败: ${e.message}`);
          }
        }
      }
    }

    return {
      ok: true,
      dryRun,
      total: items.length,
      scanned: valid.length,
      groups: groups.map((g) => ({
        files: g.map((i) => ({ kind: i.kind, name: i.name, size: i.size })),
        keep: g[0] ? { kind: g[0].kind, name: g[0].name } : null,
      })),
      duplicateGroups: groups.length,
      duplicateFiles: groups.reduce((s, g) => s + g.length - 1, 0),
      removed: removed.length,
      removedList: removed,
      message: dryRun
        ? `发现 ${groups.length} 组重复（可清理 ${groups.reduce((s, g) => s + g.length - 1, 0)} 个文件）`
        : `已清理 ${removed.length} 个重复文件`,
    };
  }

  /**
   * 索引状态：有哪些图、哪些还没描述。
   *
   * 「按语气挑图」能不能生效，全靠这个索引 ——
   * 没描述的图只能随机发，有描述才能挑到贴合当前情绪的那张。
   */
  #stickerIndexStatus() {
    const index = this.#readStickerIndex();
    const entries = [];

    for (const kind of ['stickers', 'images', 'generated']) {
      const r = this.#listMedia(kind);
      for (const it of r.items || []) {
        const meta = index[it.name];
        entries.push({
          name: it.name,
          kind,
          size: it.size,
          desc: meta?.desc || '',
          tags: meta?.tags || [],
          indexed: Boolean(meta?.desc),
        });
      }
    }

    const total = entries.length;
    const indexed = entries.filter((e) => e.indexed).length;
    // 有描述但抽不出情绪词 —— 看着「已收录」，实际按语气挑不中
    const untagged = entries.filter((e) => e.indexed && !e.tags.length).length;

    // 标签分布，面板上显示用
    const tagCount = {};
    for (const e of entries) {
      for (const t of e.tags) tagCount[t] = (tagCount[t] || 0) + 1;
    }

    return {
      ok: true,
      total,
      indexed,
      missing: total - indexed,
      untagged,
      entries,
      tagCount,
      autoIndex: this.config.sticker?.autoIndex !== false,
    };
  }

  /** 手动改某张图的描述/标签。 */
  #saveStickerIndex(body = {}) {
    const name = String(body.name || '').trim();
    if (!name) return { ok: false, error: '缺少文件名' };
    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
      return { ok: false, error: '文件名不合法' };
    }

    const desc = String(body.desc || '').trim().slice(0, 300);
    const tags = Array.isArray(body.tags)
      ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10)
      : [];

    const index = this.#readStickerIndex();

    if (!desc && !tags.length) {
      delete index[name];
    } else {
      index[name] = {
        desc,
        tags,
        addedAt: Math.floor(Date.now() / 1000),
        source: 'manual',
      };
    }

    try {
      this.#writeStickerIndex(index);
      return { ok: true, name, message: desc ? '已保存描述' : '已清除描述' };
    } catch (e) {
      return { ok: false, error: `保存失败：${e.message}` };
    }
  }

  /** 清空索引（全部重新来）。 */
  #clearStickerIndex() {
    try {
      this.#writeStickerIndex({});
      return { ok: true, message: '索引已清空' };
    } catch (e) {
      return { ok: false, error: `清空失败：${e.message}` };
    }
  }

  /**
   * 重建索引：给素材跑一次视觉模型，生成描述 + 情绪标签。
   *
   * 两种模式：
   *   mode='missing'（默认）—— 只处理**还没有描述**的
   *   mode='untagged'        —— 处理**没有情绪标签**的（哪怕已有描述也重来）
   *
   * 为什么要 untagged 模式：
   *   早期截图会把「引用缩略图 + 表情包」一起截进去，视觉模型就描述成
   *   「这张图片包含两个部分」—— 有描述，但一个情绪词都抽不出来。
   *   这种图在素材库里看着是「已收录」，实际按语气挑图永远挑不中。
   *   光看「有没有描述」是发现不了它们的，得按标签判断。
   *
   * 一次最多处理 limit 张，避免上百张图把接口和额度打爆。
   */
  /**
   * 给刚入库的一张图补描述。
   *
   * 适配器上传图片后由 web 通道调用（异步，不阻塞上传）。
   * 以前这件事是桥接里的后台线程干的，现在适配器独立出去了，
   * 描述和索引归核心管，所以搬到这里。
   *
   * @param {string} name 文件名
   * @param {string} [kind] stickers | images | generated
   */
  /**
   * 按语气挑一张表情包。
   *
   * 素材库在核心这边 —— 适配器是独立仓库，它自己的 data/ 里没有图。
   * 适配器要发图时调这个拿文件名，再去 /api/media/file/ 下载字节。
   *
   * @param {string} text 刚回复的内容，用来判断语气
   * @returns {{ok:boolean, name?:string, tags?:string[], mood?:string[], reason?:string}}
   */
  pickSticker(text = '') {
    const dirs = this.#mediaDirs();
    const dir = dirs.stickers;
    if (!fs.existsSync(dir)) return { ok: false, reason: '素材库目录不存在' };

    // 只发真实存在的文件（索引里可能留着已经删掉的）
    const files = fs.readdirSync(dir).filter((n) => /\.(jpe?g|png|gif)$/i.test(n));
    if (!files.length) return { ok: false, reason: '素材库里没有图' };

    const index = this.#readStickerIndex();
    const t = String(text || '');

    // 先看这句回复是什么语气
    const tagWords = this.#emojiTags();
    const mood = [];
    for (const [tag, words] of Object.entries(tagWords)) {
      if (words.some((w) => w && t.includes(w))) mood.push(tag);
    }

    // 有语气就优先挑同标签的，没有就全池随机
    let pool = files;
    if (mood.length) {
      const matched = files.filter((n) => {
        const tags = index[n]?.tags || [];
        return tags.some((tag) => mood.includes(tag));
      });
      if (matched.length) pool = matched;
    }

    const name = pool[Math.floor(Math.random() * pool.length)];
    return { ok: true, name, tags: index[name]?.tags || [], mood };
  }

  /**
   * 给适配器下载素材文件。
   *
   * @param {string} kind stickers | images | generated
   * @param {string} name 文件名
   * @returns {{ok:boolean, buf?:Buffer, error?:string}}
   */
  readMediaFile(kind, name) {
    const dirs = this.#mediaDirs();
    const dir = dirs[kind] || dirs.stickers;
    if (!/^[\w.\-]{1,120}$/.test(String(name || ''))) {
      return { ok: false, error: '非法文件名' };
    }
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return { ok: false, error: '文件不存在' };
    try {
      return { ok: true, buf: fs.readFileSync(file) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * 上传文档到知识库。
   *
   * body: { name, data(base64) }
   * 前端读文件成 base64 传上来；这里落盘到 data/kb/src/ 再解析入库。
   */
  async #kbUpload(body = {}) {
    const name = String(body.name || '').trim();
    const raw = String(body.data || '');
    if (!name || !raw) return { ok: false, error: '缺少文件名或内容' };

    const ext = path.extname(name).toLowerCase();
    const { SUPPORTED } = await import('./kb.mjs');
    if (!SUPPORTED.includes(ext)) {
      return {
        ok: false,
        error: `不支持的格式 ${ext}。支持：${SUPPORTED.join(' / ')}` +
          (ext === '.pdf' ? '（PDF 请先转成 docx 或 txt）' : ''),
      };
    }

    let buf;
    try {
      buf = Buffer.from(raw, 'base64');
    } catch {
      return { ok: false, error: 'base64 解不开' };
    }
    if (!buf.length) return { ok: false, error: '文件是空的' };
    if (buf.length > 30 * 1024 * 1024) return { ok: false, error: '文件太大（上限 30MB）' };

    // 落盘（保留原文件，方便以后重新导入）
    const dir = path.join(this.root, 'data', 'kb', 'src');
    let file;
    try {
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, `${Date.now()}_${path.basename(name)}`);
      fs.writeFileSync(file, buf);
    } catch (e) {
      return { ok: false, error: `存文件失败：${e.message}` };
    }

    const r = await this.engine.addKbFile?.(file);
    if (!r) return { ok: false, error: '引擎还没提供知识库接口' };
    if (!r.ok) return r;
    this.log.info?.(`[kb] 已导入 ${r.name}（${r.chunks} 块）`);
    return r;
  }

  /** 从知识库删一份文档 */
  #kbDelete(body = {}) {
    const id = String(body.id || '').trim();
    if (!id) return { ok: false, error: '缺少 id' };
    const r = this.engine.removeKbFile?.(id) || { ok: false, error: '引擎还没提供接口' };
    if (r.ok) this.log.info?.(`[kb] 已删除 ${id}`);
    return r;
  }

  async describeMediaOne(name, kind = 'stickers') {
    if (!name) return { ok: false, error: '缺少文件名' };
    if (!this.engine?.vision?.enabled) return { ok: false, error: '视觉模型未启用' };

    const dirs = this.#mediaDirs();
    const dir = dirs[kind] || dirs.stickers;
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return { ok: false, error: '文件不存在' };

    // 已经有带标签的描述就不用再花一次额度
    const index = this.#readStickerIndex();
    const old = index[name];
    if (old?.desc && Array.isArray(old.tags) && old.tags.length) {
      return { ok: true, skipped: true };
    }

    const PROMPT = this.#describePrompt();

    try {
      const buf = fs.readFileSync(file);
      const r = await this.engine.vision.describe(buf, { prompt: this.#describePrompt() });
      let desc = String(r?.description || '').trim();
      desc = this.#cleanDesc(desc);

      if (!desc || desc.includes('看不清')) return { ok: false, error: '看不清' };
      if (this.#looksLikeBadDesc(desc)) return { ok: false, error: '描述像截歪了' };

      const tags = [];
      for (const [tag, words] of Object.entries(this.#emojiTags())) {
        if (words.some((w) => desc.includes(w))) tags.push(tag);
      }

      const idx = this.#readStickerIndex();
      const oldTags = idx[name]?.tags || [];
      idx[name] = {
        desc: desc.slice(0, 200),
        tags: tags.length ? tags : oldTags,
        addedAt: Math.floor(Date.now() / 1000),
        source: 'ingest',
      };
      this.#writeStickerIndex(idx);
      this.log.info?.(`[media] ${name} → [${(tags.length ? tags : oldTags).join(',') || '无标签'}]`);
      return { ok: true, desc, tags: idx[name].tags };
    } catch (e) {
      this.log.warn?.(`[media] ${name} 描述失败: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  /** 给素材图打描述的提示词（入库和重建共用同一段） */
  #describePrompt() {
    return (
      '这是一张表情包截图。画面里可能混进了聊天界面元素：' +
      '旁边的小头像、引用的缩略图、气泡边框、空白。\n' +
      '请只看**最大、最居中**的那个主体 —— 那才是表情包本身，' +
      '忽略旁边的小图和边框，不要把画面说成「分成几个部分」。\n' +
      '\n' +
      '用一句话回答，格式固定：\n' +
      '「<主体是什么>，<情绪>，<主色调>，<风格>」\n' +
      '\n' +
      '**情绪**必须从下面这些词里选一个最接近的，不许省略、不许自己造词：\n' +
      '开心 / 难过 / 生气 / 惊讶 / 无语 / 害羞 / 困倦 / 得意 / 安慰 / 吃饭 / 可爱 / 普通\n' +
      '\n' +
      '（这个情绪是用来给表情包分类的，缺了就分不了类。）不超过 40 字。'
    );
  }

  /** 这条描述是不是「截歪了」——描述的是聊天界面而不是表情包本身 */
  #looksLikeBadDesc(s) {
    const t = String(s || '');
    if (!t) return true;
    const bad = [
      '分为左右', '分成两个部分', '分成几个部分', '两个部分', '分为两部',
      '聊天界面', '聊天窗口', '界面截图', '屏幕截图', '桌面',
      '左侧部分', '右侧部分', '左半边', '右半边',
    ];
    const hit = bad.some((w) => t.includes(w));
    return hit && (t.includes('部分') || t.includes('界面') || t.includes('截图'));
  }

  /** 描述清洗：去引号、去模板残留、去掉「主体是XXX」这种空话 */
  #cleanDesc(s) {
    let t = String(s || '').trim();
    t = t.replace(/^[“”"'‘’\s]+|[“”"'‘’\s]+$/g, '');
    t = t.replace(/<[^>]{0,40}>/g, '');
    t = t.replace(/主体是[^，,。；;]{0,20}[，,]?/g, '');
    t = t
      .replace(/\s+/g, ' ')
      .replace(/^[“”"'‘’，,。；;、\s]+|[“”"'‘’，,。；;、\s]+$/g, '')
      .trim();
    return t;
  }

  /** 情绪 → 关键词词表 */
  #emojiTags() {
    return {
      开心: ['开心', '高兴', '笑', '哈哈', '快乐', '兴奋', '棒', '赞', '喜欢', '滑稽', '欢'],
      难过: ['难过', '伤心', '哭', '委屈', '失落', '郁闷', '流泪', '沮丧'],
      生气: ['生气', '愤怒', '怒', '火大', '不爽', '凶', '瞪', '翻脸'],
      惊讶: ['惊讶', '震惊', '吃惊', '哇', '竟然', '没想到', '睁大', '瞪大', '懵'],
      无语: ['无语', '无奈', '服了', '算了', '离谱', '沉默', '翻白眼', '普通', '面无表情'],
      害羞: ['害羞', '脸红', '不好意思', '撒娇', '羞', '腮红', '腼腆'],
      困倦: ['困', '累', '睡', '疲惫', '晚安', '打哈欠', '躺', '懒'],
      得意: ['得意', '骄傲', '厉害', '牛', '叉腰', '坏笑', '自信'],
      安慰: ['安慰', '抱抱', '摸头', '摸', '拍拍', '温柔'],
      吃饭: ['吃', '饭', '饿', '美食', '馋', '喝', '西瓜', '零食'],
      可爱: ['可爱', '萌', '软乎', '毛绒', '玩偶', '小猫', '猫咪', '小鲸'],
    };
  }

  async #rebuildStickerIndex(body = {}) {
    const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50);
    const mode = body.mode === 'untagged' ? 'untagged' : 'missing';

    const status = this.#stickerIndexStatus();
    const todo = status.entries
      .filter((e) => (mode === 'untagged' ? !e.tags.length : !e.indexed))
      .slice(0, limit);

    if (!todo.length) {
      return {
        ok: true,
        done: 0,
        mode,
        message: mode === 'untagged' ? '所有素材都已经有情绪标签了' : '所有素材都已经有描述了',
      };
    }

    const dirs = this.#mediaDirs();
    const index = this.#readStickerIndex();
    let done = 0;
    let tagged = 0;
    const failed = [];

    for (const item of todo) {
      const file = path.join(dirs[item.kind] || dirs.stickers, item.name);
      if (!fs.existsSync(file)) continue;

      try {
        const buf = fs.readFileSync(file);
        const r = await this.engine.vision.describe(buf, { prompt: this.#describePrompt() });

        let desc = String(r?.description || '').trim();
        desc = this.#cleanDesc(desc);

        if (!desc || desc.includes('看不清')) {
          failed.push(item.name);
          continue;
        }

        /**
         * 截歪了的描述直接丢弃。
         *
         * 这类描述说的是「这张图分为左右两部分 / 聊天界面截图」——
         * 一个情绪词都抽不出来，存进索引只会占位，
         * 看起来「已收录」，实际按语气永远挑不中。
         * 留着空白反而诚实，等下次重拍。
         */
        if (this.#looksLikeBadDesc(desc)) {
          this.log.warn?.(`[sticker-index] ${item.name} 描述像截歪了，跳过`);
          failed.push(item.name);
          continue;
        }

        const TAGS = this.#emojiTags();

        const tags = [];
        for (const [tag, words] of Object.entries(TAGS)) {
          if (words.some((w) => desc.includes(w))) tags.push(tag);
        }

        // 新描述没抽出标签、但旧条目有 → 沿用旧的，别把好东西覆盖没了
        // （桥接后台线程也会写这个索引，两边可能交叉覆盖）
        const oldTags = index[item.name]?.tags || [];
        const finalTags = tags.length ? tags : oldTags;

        index[item.name] = {
          desc: desc.slice(0, 200),
          tags: finalTags,
          addedAt: Math.floor(Date.now() / 1000),
          source: 'rebuild',
        };
        done++;
        if (finalTags.length) tagged++;
      } catch (e) {
        failed.push(item.name);
        this.log.warn?.(`[sticker-index] ${item.name} 描述失败: ${e.message}`);
      }
    }

    try {
      this.#writeStickerIndex(index);
    } catch (e) {
      return { ok: false, error: `写索引失败：${e.message}` };
    }

    const parts = [`已为 ${done} 张生成描述`];
    if (mode === 'untagged') parts.push(`其中 ${tagged} 张打上了标签`);
    if (failed.length) parts.push(`${failed.length} 张失败`);
    if (done && !tagged && mode === 'untagged') {
      parts.push('（这些图可能确实没有明显表情，只能随机挑）');
    }

    return {
      ok: true,
      done,
      tagged,
      failed: failed.length,
      mode,
      message: parts.join('，'),
    };
  }


  // ===== 画图 =====

  /** 试画一张，验证 Key 和模型可用。 */
  async #testImageGen(body = {}) {
    const gen = this.engine.imagegen;
    if (!gen) return { ok: false, error: '画图模块未初始化' };

    if (!gen.enabled) {
      return {
        ok: false,
        error: '画图未启用。先勾上「启用」并填 Key（或配置看图模型 Key）',
      };
    }

    const prompt = String(body.prompt || '').trim() || '一只蓝色胖鲸鱼，卡通风格，白底';

    try {
      const images = await gen.generate(prompt, { size: body.size });

      return {
        ok: true,
        names: images.map((i) => i.name),
        sizes: images.map((i) => i.size),
        // 控制台直接预览
        url: `/api/media/generated/${encodeURIComponent(images[0].name)}`,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ===== 记忆管理 =====

  /** 列出所有有记忆的会话。 */
  #listMemory() {
    const store = this.engine.memory;
    if (!store) return { sessions: [], enabled: false };

    const sessions = store.list();

    return {
      enabled: true,
      dir: store.dir,
      sessions: sessions.map((s) => {
        // 每个会话一个 json 文件，给出路径方便用户直接去看/备份
        const file = store.filePathFor ? store.filePathFor(s.id) : '';
        return {
          id: s.id,
          facts: s.facts,
          summaries: s.summaries,
          updatedAt: s.updatedAt,
          label: String(s.id).replace(/^(private|group):/, ''),
          file,
          fileExists: file ? fs.existsSync(file) : false,
        };
      }),
    };
  }

  /** 读某个会话的完整记忆。 */
  #readMemory(id) {
    const store = this.engine.memory;
    if (!store) return { error: '记忆未启用' };
    if (!id) return { error: '缺少会话 id' };

    const mem = store.load(id);
    const file = store.filePathFor ? store.filePathFor(id) : '';

    // 把事实整理成带时间/来源的列表，前端好逐条展示
    const factList = Object.entries(mem.facts || {}).map(([key, value]) => {
      // value 可能是字符串，也可能是 { value, at } 结构
      if (value && typeof value === 'object') {
        return {
          key,
          value: value.value ?? String(value),
          at: value.at || null,
          source: value.source || '',
        };
      }
      return { key, value: String(value), at: null, source: '' };
    });

    const summaryList = (mem.summaries || []).map((s, i) =>
      typeof s === 'string'
        ? { index: i + 1, text: s, at: null }
        : { index: i + 1, text: s.text || '', at: s.at || null },
    );

    return {
      id,
      facts: mem.facts,
      factList,
      summaries: mem.summaries,
      summaryList,
      createdAt: mem.createdAt,
      updatedAt: mem.updatedAt,
      rendered: store.render(id),
      file,
      fileExists: file ? fs.existsSync(file) : false,
      bytes: file && fs.existsSync(file) ? fs.statSync(file).size : 0,
    };
  }

  /**
   * 在系统文件管理器里定位一个路径（只允许项目内的目录）。
   *
   * 用途：控制台里点「打开文件」直接跳到 data/memory/xxx.json，
   * 不用用户自己去找。
   */
  async #revealPath(body = {}) {
    const target = String(body.path || '').trim();
    if (!target) return { ok: false, error: '缺少 path' };

    const abs = path.isAbsolute(target) ? target : path.join(this.root, target);

    // 只允许项目目录内，防止被拿来当通用文件浏览器
    const rootResolved = path.resolve(this.root);
    const p = path.resolve(abs);
    if (p !== rootResolved && !p.startsWith(rootResolved + path.sep)) {
      return { ok: false, error: '只能打开项目目录内的文件' };
    }

    if (!fs.existsSync(p)) {
      return { ok: false, error: `路径不存在：${p}` };
    }

    const isDir = fs.statSync(p).isDirectory();

    try {
      const { spawn } = await import('node:child_process');

      if (process.platform === 'win32') {
        if (isDir) {
          spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref();
        } else {
          // /select 让资源管理器打开并选中该文件
          spawn('explorer.exe', [`/select,${p}`], { detached: true, stdio: 'ignore' }).unref();
        }
      } else if (process.platform === 'darwin') {
        spawn('open', [isDir ? p : '-R', p], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [isDir ? p : path.dirname(p)], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      }

      return { ok: true, path: p, kind: isDir ? 'dir' : 'file', message: '已在文件管理器中打开' };
    } catch (e) {
      return { ok: false, error: `打开失败：${e.message}`, path: p };
    }
  }

  /** 清空某个会话的记忆。 */
  #clearMemory(body = {}) {
    const store = this.engine.memory;
    if (!store) return { ok: false, error: '记忆未启用' };

    const id = String(body.id || '').trim();
    if (!id) return { ok: false, error: '缺少会话 id' };

    store.clear(id);
    return { ok: true, message: `已清空 ${id} 的记忆` };
  }

  /** 删除单条事实（记忆优化：能逐条清，不用整个清空）。 */
  #removeMemoryFact(body = {}) {
    const store = this.engine.memory;
    if (!store) return { ok: false, error: '记忆未启用' };

    const id = String(body.id || '').trim();
    const key = String(body.key || '').trim();
    if (!id) return { ok: false, error: '缺少会话 id' };
    if (!key) return { ok: false, error: '缺少键名' };

    const mem = store.load(id);
    if (!mem.facts || !(key in mem.facts)) {
      return { ok: false, error: `没有「${key}」这条记忆` };
    }

    delete mem.facts[key];
    store.save(id, mem);

    return { ok: true, message: `已删除「${key}」` };
  }

  /** 手动添加一条记忆。 */
  #addMemoryFact(body = {}) {
    const store = this.engine.memory;
    if (!store) return { ok: false, error: '记忆未启用' };

    const id = String(body.id || '').trim();
    const key = String(body.key || '').trim();
    const value = String(body.value || '').trim();

    if (!id) return { ok: false, error: '缺少会话 id' };
    if (!key) return { ok: false, error: '缺少键名' };
    if (!value) return { ok: false, error: '缺少内容' };

    store.setFact(id, key, value);
    return { ok: true, message: `已记住：${key} = ${value}` };
  }

  // ===== 主人设置 =====

  /** 读主人配置。 */
  #getOwner() {
    const o = this.config.owner || {};
    return {
      enabled: o.enabled !== false,
      wxids: o.wxids || [],
      names: o.names || [],
      title: o.title || '主人',
      displayName: o.displayName || '',
      privileges: {
        tools: o.privileges?.tools !== false,
        dsh: o.privileges?.dsh !== false,
        admin: o.privileges?.admin !== false,
      },
      trustNicknameForTools: o.trustNicknameForTools === true,
      /** 是否有 wxid（安全等级提示） */
      hasWxid: Boolean(o.wxids?.length),
      securityLevel: o.wxids?.length
        ? 'high'
        : o.names?.length
          ? 'medium'
          : 'low',
      /** 图片收藏设置（也在这里读，省一次请求） */
      wechat: {
        mediaCollect: this.config.wechat?.mediaCollect !== false,
        collectOnlyFrom: this.config.wechat?.collectOnlyFrom || [],
        collectScope:
          this.config.wechat?.collectScope ||
          ((this.config.wechat?.collectOnlyFrom || []).length ? 'custom' : 'all'),
        stickerChance: this.config.wechat?.stickerChance ?? 0.3,
        voiceChance: this.config.wechat?.voiceChance ?? 0,
      },
    };
  }

  /** 保存主人配置。 */
  #setOwner(body = {}) {
    const file = path.join(this.root, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

    cfg.owner = cfg.owner || {};

    if (typeof body.enabled === 'boolean') cfg.owner.enabled = body.enabled;

    if (Array.isArray(body.wxids)) {
      cfg.owner.wxids = body.wxids
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 10);
    }

    if (Array.isArray(body.names)) {
      cfg.owner.names = body.names
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 10);
    }

    if (typeof body.title === 'string') cfg.owner.title = body.title.trim().slice(0, 20) || '主人';
    if (typeof body.displayName === 'string') cfg.owner.displayName = body.displayName.trim().slice(0, 30);
    if (typeof body.trustNicknameForTools === 'boolean') {
      cfg.owner.trustNicknameForTools = body.trustNicknameForTools;
    }

    if (body.privileges) {
      cfg.owner.privileges = {
        tools: body.privileges.tools !== false,
        dsh: body.privileges.dsh !== false,
        admin: body.privileges.admin !== false,
      };
    }

    // 图片收藏设置：谁能往素材库塞图
    if (body.wechat) {
      cfg.wechat = cfg.wechat || {};

      if (typeof body.wechat.mediaCollect === 'boolean') {
        cfg.wechat.mediaCollect = body.wechat.mediaCollect;
      }

      // collectScope 是给人看的简化选项，实际存的是 collectOnlyFrom 名单
      //   all    → 名单清空（谁发都收）
      //   owner  → 名单 = 主人 wxid（不用手填）
      //   custom → 用用户填的名单
      const scope = String(body.wechat.collectScope || '').trim();

      if (scope === 'all') {
        cfg.wechat.collectScope = 'all';
        cfg.wechat.collectOnlyFrom = [];
      } else if (scope === 'owner') {
        cfg.wechat.collectScope = 'owner';
        cfg.wechat.collectOnlyFrom = (cfg.owner?.wxids || [])
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (scope === 'custom') {
        cfg.wechat.collectScope = 'custom';
        if (Array.isArray(body.wechat.collectOnlyFrom)) {
          cfg.wechat.collectOnlyFrom = body.wechat.collectOnlyFrom
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 30);
        }
      } else if (Array.isArray(body.wechat.collectOnlyFrom)) {
        // 没给 scope 时按名单长度推断（兼容旧调用）
        cfg.wechat.collectOnlyFrom = body.wechat.collectOnlyFrom
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 30);
        cfg.wechat.collectScope = cfg.wechat.collectOnlyFrom.length ? 'custom' : 'all';
      }
    }

    writeConfig(file, cfg, 'owner', this.log);

    // 同步内存，立即生效
    this.config.owner = cfg.owner;
    if (cfg.wechat) {
      this.config.wechat = { ...(this.config.wechat || {}), ...cfg.wechat };
      // 收藏设置只存核心这份。适配器通过 GET /api/media/policy 来取，
      // 不再往它的配置文件里写 —— 它是独立仓库，路径和格式都不该由核心决定。
    }
    this.engine.updateOwner?.(cfg.owner);

    return { ok: true, message: '已保存', owner: this.#getOwner() };
  }

  /**
   * 候选主人列表：从桥接日志里提取出现过的发送者。
   *
   * 新格式：[12:00:00] 收到 私聊 显示名 ← 昵称（wxid_xxx）：消息
   * 老格式：[12:00:00] 收到 私聊 显示名 ← 昵称 ：消息
   */
  #ownerCandidates() {
    const out = [];
    const seen = new Set();

    // 1. 优先用运行期记录的发送者（最准，是真实收到消息的 wxid）
    try {
      const known = this.engine.knownSenders;
      if (known && known.size) {
        for (const [wxid, info] of known) {
          seen.add(wxid);
          out.push({
            chatName: info.name || wxid,
            senderName: info.name || '',
            wxid,
            label: info.name || wxid,
            verified: true,
            lastSeen: info.lastSeen,
          });
        }
      }
    } catch {}

    /**
     * 2. 适配器上报的联系人。
     *
     * 以前这里是从桥接日志里正则挖 wxid —— 但适配器已经独立成另一个仓库、
     * 另一个进程，日志不在核心目录下了，挖不到。
     * 改成让适配器通过 POST /api/adapter/contacts 主动上报，
     * 存在 engine.adapterContacts 里，这里直接读。
     */
    try {
      const reported = this.engine?.adapterContacts;
      if (reported && typeof reported.values === 'function') {
        for (const info of reported.values()) {
          const wxid = String(info?.wxid || '').trim();
          const senderName = String(info?.name || '').trim();
          const chatName = String(info?.chatName || senderName).trim();
          const key = wxid || `name|${chatName}|${senderName}`;
          if (!senderName || seen.has(key)) continue;
          seen.add(key);
          out.push({
            chatName,
            senderName,
            wxid,
            label: info.isGroup ? `${chatName} / ${senderName}` : senderName,
            verified: /^wxid_/.test(wxid),
          });
        }
      }
    } catch {}

    // 按是否为私聊 + 有无 wxid 排序
    out.sort((a, b) => Number(b.verified) - Number(a.verified));

    // 去重：同一个昵称，如果已经有带 wxid 的，就不要那条没 wxid 的
    const byName = new Map();
    const final = [];

    for (const c of out) {
      const key = `${c.senderName}|${c.chatName}`;
      const prev = byName.get(key);

      if (!prev) {
        byName.set(key, c);
        final.push(c);
        continue;
      }

      // 已有记录：优先保留带 wxid 的
      if (!prev.verified && c.verified) {
        const idx = final.indexOf(prev);
        if (idx >= 0) final[idx] = c;
        byName.set(key, c);
      }
    }

    return { candidates: final.slice(0, 20) };
  }

  // ===== 联网学习 =====

  /** 学习配置 + 待审词条 + 待审图片。 */
  // ===== 定向网站学习 =====

  /** 保存网站列表。 */
  #saveSites(body = {}) {
    const file = path.join(this.root, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

    cfg.learning = cfg.learning || {};

    if (Array.isArray(body.sites)) {
      cfg.learning.sites = body.sites
        .map((s) => {
          if (typeof s === 'string') return { url: s.trim(), note: '' };
          return {
            url: String(s?.url || '').trim(),
            note: String(s?.note || '').trim().slice(0, 60),
          };
        })
        .filter((s) => {
          if (!s.url) return false;
          try {
            const u = new URL(s.url);
            return /^https?:$/.test(u.protocol);
          } catch {
            return false;
          }
        })
        .slice(0, 30);
    }

    backupConfig(file);

    writeConfig(file, cfg, 'learning/sites', this.log);

    this.config.learning = { ...(this.config.learning || {}), sites: cfg.learning.sites };

    return {
      ok: true,
      count: cfg.learning.sites.length,
      sites: cfg.learning.sites,
      message: `已保存 ${cfg.learning.sites.length} 个网站`,
    };
  }

  /** 预览一个网站抓到的正文（不学词，只看看抓没抓到）。 */
  async #previewSite(body = {}) {
    const url = String(body.url || '').trim();
    if (!url) return { ok: false, error: '缺少 url' };

    const r = await fetchSiteText(url, { maxChars: 3000 });
    if (!r.ok) return { ok: false, error: r.error, url };

    return {
      ok: true,
      url: r.url,
      title: r.title,
      chars: r.text.length,
      preview: r.text.slice(0, 600),
    };
  }

  /**
   * 从指定网站学词。
   *
   * body.url 给单个网站；不给则学 sites 列表里的全部。
   */
  async #learnFromSite(body = {}) {
    const cfg = { ...LEARNING_DEFAULTS, ...(this.config.learning || {}) };

    if (!cfg.enabled) {
      return { ok: false, error: '联网学习未开启，请先打开开关' };
    }

    // 决定要抓哪些站
    let targets = [];
    const single = String(body.url || '').trim();

    if (single) {
      targets = [{ url: single, note: '' }];
    } else if (Array.isArray(body.urls) && body.urls.length) {
      targets = body.urls.map((u) => (typeof u === 'string' ? { url: u } : u));
    } else {
      targets = cfg.sites || [];
    }

    if (!targets.length) {
      return { ok: false, error: '还没有配置网站。先在下面添加要学习的网址。' };
    }

    const max = Math.min(Number(body.max) || cfg.maxPerRun, 60);
    const askLlm = this.#makeAskLlm();

    const details = [];
    const allWords = [];
    let totalChars = 0;

    for (const t of targets.slice(0, 5)) {
      const url = String(t?.url || '').trim();
      if (!url) continue;

      const page = await fetchSiteText(url, { maxChars: 12000 });
      if (!page.ok) {
        details.push({ url, ok: false, error: page.error });
        continue;
      }

      totalChars += page.text.length;

      // 每个站分 max/站点数 条，至少给 5 条
      const perSite = Math.max(5, Math.floor(max / Math.min(targets.length, 5)));

      const words = await extractFromText({
        text: page.text,
        title: page.title,
        source: url,
        askLlm,
        max: perSite,
      });

      // 词条带上来源，方便追溯
      for (const w of words) w.source = url;

      allWords.push(...words);
      details.push({
        url,
        ok: true,
        title: page.title,
        chars: page.text.length,
        learned: words.length,
      });
    }

    if (!allWords.length) {
      const errs = details.filter((d) => !d.ok).map((d) => `${d.url}: ${d.error}`);
      return {
        ok: false,
        error: errs.length ? `都没学成功：${errs.slice(0, 3).join('；')}` : '模型没提炼出词条',
        details,
      };
    }

    // 去重后存待审
    const dataDir = path.join(this.root, 'data');
    const uniq = [];
    const seen = new Set();
    for (const w of allWords) {
      if (seen.has(w.word)) continue;
      seen.add(w.word);
      uniq.push(w);
    }

    const saved = savePending(dataDir, uniq);

    // 自动整理进词库（开了就顺手做，不用手动点「合并」）
    const organized = this.#autoOrganize(uniq);

    return {
      ok: true,
      learned: uniq.length,
      total: saved.total,
      added: saved.added,
      organized,
      chars: totalChars,
      details,
      samples: uniq.slice(0, 6).map((w) => `${w.word}｜${w.explain}`),
    };
  }

  /**
   * 包一个 askLlm，供学习/摘要这类「提取型任务」用。
   *
   * 关键：必须走裸 LLM，不能走 engine.handle()。
   * 走 handle 会套上YF-Robot 的人设和回复规则（气泡切分、字数限制、口头禅），
   * 结果是模型不肯按格式输出 —— 实测「每条一行」的要求全被忽略，
   * 摘要挤成一段、词条解析失败都源于此。
   */
  #makeAskLlm() {
    return async (prompt) => {
      const messages = [
        {
          role: 'system',
          content:
            '你是一个严谨的信息提取器。只按用户要求的格式输出，不加任何解释、称呼或口语。',
        },
        { role: 'user', content: prompt },
      ];

      try {
        const text = await this.engine.llm.complete(messages, {
          temperature: 0.2,
          maxTokens: 1024,
        });
        return String(text || '');
      } catch (e) {
        this.log.warn?.(`[admin] 提取型 LLM 调用失败: ${e.message}`);
        throw e;
      }
    };
  }

  #learningStatus() {
    const cfg = this.config.learning || {};
    const dataDir = path.join(this.root, 'data');
    const pending = readPending(dataDir);

    const mediaFile = path.join(dataDir, 'learned-media.json');
    let pendingMedia = [];
    try {
      if (fs.existsSync(mediaFile)) {
        pendingMedia = JSON.parse(fs.readFileSync(mediaFile, 'utf8')).items || [];
      }
    } catch {}

    return {
      enabled: cfg.enabled === true,
      queries: cfg.queries || LEARNING_DEFAULTS.queries,
      maxPerRun: cfg.maxPerRun ?? LEARNING_DEFAULTS.maxPerRun,
      sites: cfg.sites || [],
      mediaSites: cfg.mediaSites || [],
      rssFeeds: cfg.rssFeeds || [],
      // 对话时自动学习
      auto: {
        enabled: cfg.auto?.enabled === true,
        everyNTurns: cfg.auto?.everyNTurns ?? 15,
        minIntervalMinutes: cfg.auto?.minIntervalMinutes ?? 30,
        maxPerDay: cfg.auto?.maxPerDay ?? 6,
        mode: cfg.auto?.mode || 'words',
        maxPerRun: cfg.auto?.maxPerRun ?? 10,
      },
      autoStatus: this.engine.autoLearn?.status?.() || null,
      // 学到的词自动整理进哪个库
      autoMerge: {
        enabled: cfg.autoMerge?.enabled === true,
        bank: cfg.autoMerge?.bank || 'learned',
      },
      digest: this.#digestStatus(),
      words: pending.words,
      wordsUpdatedAt: pending.updatedAt,
      media: pendingMedia,
      // 词库列表供选择合并到哪个
      banks: this.#listWordBanks().banks.map((b) => b.name),
    };
  }

  /** 联网学习词库。 */
  async #learnWords() {
    const cfg = { ...LEARNING_DEFAULTS, ...(this.config.learning || {}) };

    if (!cfg.enabled) {
      return { ok: false, error: '联网学习未开启，请先在控制台打开开关' };
    }
    if (!this.engine.search?.enabled) {
      return { ok: false, error: '搜索未启用' };
    }

    const queries = cfg.queries?.length ? cfg.queries : LEARNING_DEFAULTS.queries;

    // 1. 搜集资料
    const results = [];
    for (const q of queries.slice(0, 3)) {
      try {
        const r = await this.engine.search.search(q, { limit: 5 });
        results.push(...r);
      } catch {}
    }

    if (!results.length) {
      return { ok: false, error: '没搜到结果，检查搜索 Key' };
    }

    // 2. 让模型提炼
    const askLlm = this.#makeAskLlm();

    const words = await extractWords({
      results,
      askLlm,
      max: cfg.maxPerRun,
    });

    if (!words.length) {
      return { ok: false, error: '模型没提炼出词条，可稍后重试', searchCount: results.length };
    }

    // 3. 存入待审
    const dataDir = path.join(this.root, 'data');
    const r = savePending(dataDir, words);

    // 自动整理进词库
    const organized = this.#autoOrganize(words);

    return {
      ok: true,
      searchCount: results.length,
      learned: words.length,
      total: r.total,
      added: r.added,
      organized,
      samples: words.slice(0, 5).map((w) => `${w.word}｜${w.explain}`),
    };
  }

  /**
   * 联网学习图片 / 表情包。
   *
   * 做法：搜索图片关键词 → 从结果里找图片直链 → 下载 → 存到 data/stickers 或 data/images
   * 安全：只允许 http(s)，限制大小和数量
   */
  async #learnMedia(body = {}) {
    const cfg = { ...LEARNING_DEFAULTS, ...(this.config.learning || {}) };
    if (!cfg.enabled) {
      return { ok: false, error: '联网学习未开启' };
    }

    const kind = body.kind === 'images' ? 'images' : 'stickers';
    const query = String(body.query || (kind === 'stickers' ? '表情包 搞笑 gif' : '壁纸 图片')).trim();
    const limit = Math.min(Number(body.limit) || 5, 10);

    const dataDir = path.join(this.root, 'data');
    const dirs = this.#mediaDirs();
    const dir = dirs[kind];
    fs.mkdirSync(dir, { recursive: true });

    // 搜图：优先用图片搜索接口，拿真正的图片直链
    let urls = [];
    if (this.engine.search?.enabled) {
      try {
        const found = await this.engine.search.searchImages(query, 10);
        urls = (found || []).map((x) => x.url).filter(Boolean);
      } catch (e) {
        return { ok: false, error: '图片搜索失败: ' + e.message };
      }
    }

    /**
     * 第三层兜底：搜网页 → 抓页面 → 从 <img> 里抠图。
     *
     * 前两层分别是「图片搜索接口」（要单独开通权限，没开通就静默 401）
     * 和「从搜索摘要里正则抠直链」（摘要里几乎不含直链）。
     * 所以「下载图片素材」以前一直是坏的，永远报「没找到可用的图片链接」。
     * 这条路实测有效：cnblogs 首页能抠出 44 张。
     */
    if (!urls.length && this.engine.search?.enabled) {
      try {
        const pages = await this.engine.search.search(query, { limit: 6 });
        const { fetchSiteImages } = await import('./learning.mjs');

        for (const p of pages || []) {
          if (urls.length >= limit * 2) break;
          try {
            const r = await fetchSiteImages(p.url);
            if (r && r.ok && Array.isArray(r.images)) urls.push(...r.images);
          } catch {
            // 单个页面失败不影响别的
          }
        }

        if (urls.length) {
          this.log.info?.(
            '[learn] 图片搜索接口不可用，改从 ' + pages.length + ' 个网页里抠到 ' + urls.length + ' 张',
          );
        }
      } catch (e) {
        this.log.warn?.('[learn] 网页抠图失败：' + e.message);
      }
    }

    if (!urls.length) {
      return {
        ok: false,
        error: '没找到可用的图片：图片搜索接口没权限，网页里也没抠到图。换个关键词试试。',
        foundUrls: 0,
      };
    }

    // 下载
    const downloaded = [];
    const failed = [];
    /** 下载成功但「不适合当表情包」的，单独记，不算失败 */
    const skipped = [];

    for (const u of urls) {
      if (downloaded.length >= limit) break;
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15000);
        timer.unref?.();

        const res = await fetch(u, {
          signal: ac.signal,
          headers: { 'user-agent': 'Mozilla/5.0', accept: 'image/*' },
        });
        clearTimeout(timer);

        if (!res.ok) {
          failed.push(`${u.slice(0, 40)} HTTP ${res.status}`);
          continue;
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1024 || buf.length > 5 * 1024 * 1024) {
          failed.push(`${u.slice(0, 40)} 大小不合适(${buf.length})`);
          continue;
        }

        /**
         * 适不适合当表情包。
         *
         * 从网页抠下来的图大半是横幅、文章配图、网站图标 ——
         * 存进素材库只会让她发出去时很奇怪。
         * 这里按格式/尺寸/比例挡掉，后面会把跳过原因一起返回，
         * 让用户知道「不是功能坏了，是这些图确实不像表情」。
         */
        const { suitableAsSticker, suitableAsImage } = await import('./media-suit.mjs');
        const verdict =
          kind === 'stickers' ? suitableAsSticker(buf) : suitableAsImage(buf);
        if (!verdict.ok) {
          skipped.push(`${u.slice(0, 40)} ${verdict.reason}`);
          continue;
        }

        // 按文件头判断真实格式
        let ext = '';
        if (buf[0] === 0x89 && buf[1] === 0x50) ext = '.png';
        else if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
        else if (buf.slice(0, 3).toString() === 'GIF') ext = '.gif';
        else if (buf.slice(8, 12).toString() === 'WEBP') ext = '.webp';

        if (!ext) {
          failed.push(`${u.slice(0, 40)} 不是图片`);
          continue;
        }

        const crypto = await import('node:crypto');
        const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12);
        const name = `${kind === 'stickers' ? 'sticker' : 'img'}_web_${hash}${ext}`;
        const full = path.join(dir, name);

        if (!fs.existsSync(full)) {
          fs.writeFileSync(full, buf);
        }

        downloaded.push({ name, size: buf.length, from: u.slice(0, 120) });
      } catch (e) {
        failed.push(`${u.slice(0, 40)} ${e.message}`);
      }
    }

    const usable = downloaded.length;
    return {
      ok: usable > 0,
      kind,
      foundUrls: urls.length,
      downloaded,
      failed: failed.slice(0, 5),
      // 下载成功但不像表情包被挡掉的，单独告诉用户，免得以为是功能坏了
      skipped: skipped.slice(0, 8),
      skippedCount: skipped.length,
      error: usable
        ? undefined
        : skipped.length
          ? `抓到 ${urls.length} 张，但都不像表情包（${skipped[0]}）`
          : '下载失败，可能站点防盗链',
    };
  }

  // ===== 定向网站抓图 =====

  /** 保存抓图网站列表。 */
  #saveMediaSites(body = {}) {
    const file = path.join(this.root, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

    cfg.learning = cfg.learning || {};

    const clean = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .map((s) => {
          if (typeof s === 'string') return { url: s.trim(), note: '' };
          return {
            url: String(s?.url || '').trim(),
            note: String(s?.note || '').trim().slice(0, 60),
          };
        })
        .filter((s) => {
          if (!s.url) return false;
          try {
            return /^https?:$/.test(new URL(s.url).protocol);
          } catch {
            return false;
          }
        })
        .slice(0, 30);

    if (Array.isArray(body.sites)) {
      cfg.learning.mediaSites = clean(body.sites);
    }

    backupConfig(file);

    writeConfig(file, cfg, 'learning/media/sites', this.log);

    this.config.learning = {
      ...(this.config.learning || {}),
      mediaSites: cfg.learning.mediaSites || [],
    };

    return {
      ok: true,
      count: (cfg.learning.mediaSites || []).length,
      sites: cfg.learning.mediaSites || [],
      message: `已保存 ${(cfg.learning.mediaSites || []).length} 个图片站点`,
    };
  }

  /** 预览一个网页里有多少张图（不下载）。 */
  async #previewMediaSite(body = {}) {
    const url = String(body.url || '').trim();
    if (!url) return { ok: false, error: '缺少 url' };

    const r = await fetchSiteImages(url);
    if (!r.ok) return { ok: false, error: r.error, url };

    return {
      ok: true,
      url: r.url,
      count: r.images.length,
      // 前 12 张给前端展示
      samples: r.images.slice(0, 12),
    };
  }

  /**
   * 从指定网页下载图片。
   *
   * body.url 给单个网页；不给则用 mediaSites 列表。
   */
  async #learnMediaFromSite(body = {}) {
    const cfg = { ...LEARNING_DEFAULTS, ...(this.config.learning || {}) };

    if (!cfg.enabled) return { ok: false, error: '联网学习未开启' };

    const kind = body.kind === 'images' ? 'images' : 'stickers';
    const limit = Math.min(Number(body.limit) || 5, 20);

    // 决定抓哪些页
    let pages = [];
    const single = String(body.url || '').trim();

    if (single) {
      pages = [{ url: single, note: '' }];
    } else if (Array.isArray(body.urls) && body.urls.length) {
      pages = body.urls.map((u) => (typeof u === 'string' ? { url: u } : u));
    } else {
      pages = cfg.mediaSites || [];
    }

    if (!pages.length) {
      return { ok: false, error: '还没有配置图片站点，先在上面添加网址' };
    }

    const dirs = this.#mediaDirs();
    const dir = dirs[kind];
    fs.mkdirSync(dir, { recursive: true });

    // 1. 收集所有页面里的图片链接
    const candidates = [];
    const pageDetails = [];

    for (const p of pages.slice(0, 5)) {
      const url = String(p?.url || '').trim();
      if (!url) continue;

      const r = await fetchSiteImages(url);
      if (!r.ok) {
        pageDetails.push({ url, ok: false, error: r.error });
        continue;
      }

      pageDetails.push({ url, ok: true, found: r.images.length });
      for (const img of r.images) candidates.push({ url: img, from: url });
    }

    if (!candidates.length) {
      const errs = pageDetails.filter((d) => !d.ok).map((d) => `${d.url}: ${d.error}`);
      return {
        ok: false,
        error: errs.length ? `没抓到图：${errs.slice(0, 3).join('；')}` : '页面里没有图片',
        details: pageDetails,
      };
    }

    // 2. 下载（跳过小图标）
    const crypto = await import('node:crypto');
    const downloaded = [];
    const failed = [];
    const seenHash = new Set();

    for (const c of candidates) {
      if (downloaded.length >= limit) break;

      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15000);
        timer.unref?.();

        let pageOrigin = '';
        try {
          pageOrigin = new URL(c.from).origin;
        } catch {}

        const res = await fetch(c.url, {
          signal: ac.signal,
          headers: {
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            accept: 'image/*,*/*',
            // 防盗链：不少图床只认自己站点来的 referer
            ...(pageOrigin ? { referer: pageOrigin + '/' } : {}),
          },
        });
        clearTimeout(timer);

        if (!res.ok) {
          failed.push(`${c.url.slice(0, 50)} HTTP ${res.status}`);
          continue;
        }

        const buf = Buffer.from(await res.arrayBuffer());

        // 跳过 icon / 占位图：小于 3KB 的基本是图标或 1x1 占位
        if (buf.length < 3 * 1024) {
          failed.push(`${c.url.slice(0, 50)} 太小(${buf.length}B)`);
          continue;
        }
        if (buf.length > 6 * 1024 * 1024) {
          failed.push(`${c.url.slice(0, 50)} 太大`);
          continue;
        }

        let ext = '';
        if (buf[0] === 0x89 && buf[1] === 0x50) ext = '.png';
        else if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
        else if (buf.slice(0, 3).toString() === 'GIF') ext = '.gif';
        else if (buf.slice(8, 12).toString() === 'WEBP') ext = '.webp';

        if (!ext) {
          failed.push(`${c.url.slice(0, 50)} 不是图片`);
          continue;
        }

        const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12);
        if (seenHash.has(hash)) continue;
        seenHash.add(hash);

        const name = `${kind === 'stickers' ? 'sticker' : 'img'}_site_${hash}${ext}`;
        const full = path.join(dir, name);

        if (!fs.existsSync(full)) fs.writeFileSync(full, buf);

        downloaded.push({
          name,
          size: buf.length,
          from: c.from.slice(0, 100),
          url: c.url.slice(0, 120),
        });
      } catch (e) {
        failed.push(`${c.url.slice(0, 50)} ${e.message}`);
      }
    }

    return {
      ok: downloaded.length > 0,
      kind,
      candidates: candidates.length,
      downloaded,
      details: pageDetails,
      failed: failed.slice(0, 8),
      error: downloaded.length ? undefined : '一张都没下下来，站点可能防盗链',
    };
  }

  // ===== RSS 订阅学习 =====

  /** 保存 RSS 列表。 */
  #saveRssFeeds(body = {}) {
    const file = path.join(this.root, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

    cfg.learning = cfg.learning || {};

    const clean = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .map((s) => {
          if (typeof s === 'string') return { url: s.trim(), note: '' };
          return {
            url: String(s?.url || '').trim(),
            note: String(s?.note || '').trim().slice(0, 60),
          };
        })
        .filter((s) => {
          if (!s.url) return false;
          try {
            return /^https?:$/.test(new URL(s.url).protocol);
          } catch {
            return false;
          }
        })
        .slice(0, 30);

    if (Array.isArray(body.feeds)) {
      cfg.learning.rssFeeds = clean(body.feeds);
    }

    backupConfig(file);

    writeConfig(file, cfg, 'learning/rss/feeds', this.log);

    this.config.learning = {
      ...(this.config.learning || {}),
      rssFeeds: cfg.learning.rssFeeds || [],
    };

    return {
      ok: true,
      count: (cfg.learning.rssFeeds || []).length,
      feeds: cfg.learning.rssFeeds || [],
      message: `已保存 ${(cfg.learning.rssFeeds || []).length} 个订阅`,
    };
  }

  /** 预览一个 RSS 源（看看有几个条目）。 */
  async #previewRss(body = {}) {
    const url = String(body.url || '').trim();
    if (!url) return { ok: false, error: '缺少 url' };

    const r = await fetchFeed(url);
    if (!r.ok) {
      return { ok: false, error: r.error, url, bytes: r.bytes };
    }

    return {
      ok: true,
      url: r.url,
      title: r.title,
      count: r.items.length,
      // 前 8 条给前端展示
      samples: r.items.slice(0, 8).map((it) => ({
        title: it.title,
        text: it.text.slice(0, 150),
        date: it.date,
        images: it.images.length,
      })),
    };
  }

  /**
   * 从 RSS 订阅学习。
   *
   * mode:
   *   'words'  → 提炼词条（默认）
   *   'media'  → 只下载条目里的图片
   *   'both'   → 两个都做
   */
  async #learnFromRss(body = {}) {
    const cfg = { ...LEARNING_DEFAULTS, ...(this.config.learning || {}) };

    if (!cfg.enabled) return { ok: false, error: '联网学习未开启' };

    const mode = ['words', 'media', 'both'].includes(body.mode) ? body.mode : 'words';
    const max = Math.min(Number(body.max) || cfg.maxPerRun, 40);
    const kind = body.kind === 'images' ? 'images' : 'stickers';
    const imgLimit = Math.min(Number(body.imgLimit) || 5, 20);

    // 决定要抓哪些源
    let feeds = [];
    const single = String(body.url || '').trim();
    if (single) {
      feeds = [{ url: single, note: '' }];
    } else if (Array.isArray(body.urls) && body.urls.length) {
      feeds = body.urls.map((u) => (typeof u === 'string' ? { url: u } : u));
    } else {
      feeds = cfg.rssFeeds || [];
    }

    if (!feeds.length) {
      return { ok: false, error: '还没有配置 RSS 订阅，先在上面添加' };
    }

    // 1. 抓所有源
    const allItems = [];
    const feedDetails = [];

    for (const f of feeds.slice(0, 8)) {
      const url = String(f?.url || '').trim();
      if (!url) continue;

      const r = await fetchFeed(url);
      if (!r.ok) {
        feedDetails.push({ url, ok: false, error: r.error });
        continue;
      }

      feedDetails.push({
        url,
        ok: true,
        title: r.title,
        items: r.items.length,
      });

      for (const it of r.items) allItems.push({ ...it, feed: url, feedTitle: r.title });
    }

    if (!allItems.length) {
      const errs = feedDetails.filter((d) => !d.ok).map((d) => `${d.url}: ${d.error}`);
      return {
        ok: false,
        error: errs.length ? `都没抓到：${errs.slice(0, 3).join('；')}` : '订阅里没有条目',
        details: feedDetails,
      };
    }

    const result = {
      ok: true,
      mode,
      items: allItems.length,
      details: feedDetails,
      words: 0,
      images: 0,
    };

    // 2. 学词
    if (mode === 'words' || mode === 'both') {
      const corpus = allItems
        .slice(0, 20)
        .map((it, i) => `[${i + 1}] ${it.title}\n${it.text.slice(0, 300)}`)
        .join('\n\n');

      const askLlm = this.#makeAskLlm();
      const words = await extractFromText({
        text: corpus,
        title: 'RSS 订阅内容',
        source: 'rss',
        askLlm,
        max,
      });

      if (words.length) {
        const dataDir = path.join(this.root, 'data');
        const saved = savePending(dataDir, words);
        result.words = words.length;
        result.wordsTotal = saved.total;
        result.samples = words.slice(0, 6).map((w) => `${w.word}｜${w.explain}`);
        // 自动整理进词库
        result.organized = this.#autoOrganize(words);
      } else {
        result.wordsError = '模型没提炼出词条';
      }
    }

    // 3. 下图片
    if (mode === 'media' || mode === 'both') {
      const dirs = this.#mediaDirs();
      const dir = dirs[kind];
      fs.mkdirSync(dir, { recursive: true });

      const urls = [];
      for (const it of allItems) {
        for (const u of it.images) urls.push({ url: u, from: it.link || it.feed });
      }

      const crypto = await import('node:crypto');
      const downloaded = [];
      const failed = [];
      const seenHash = new Set();

      for (const c of urls) {
        if (downloaded.length >= imgLimit) break;

        try {
          let ref = '';
          try {
            ref = new URL(c.from).origin + '/';
          } catch {}

          const res = await fetch(c.url, {
            headers: {
              'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
              accept: 'image/*,*/*',
              ...(ref ? { referer: ref } : {}),
            },
            signal: AbortSignal.timeout(15000),
          });

          if (!res.ok) {
            failed.push(`${c.url.slice(0, 50)} HTTP ${res.status}`);
            continue;
          }

          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 3 * 1024) continue;
          if (buf.length > 6 * 1024 * 1024) continue;

          let ext = '';
          if (buf[0] === 0x89 && buf[1] === 0x50) ext = '.png';
          else if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
          else if (buf.slice(0, 3).toString() === 'GIF') ext = '.gif';
          else if (buf.slice(8, 12).toString() === 'WEBP') ext = '.webp';
          if (!ext) continue;

          const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12);
          if (seenHash.has(hash)) continue;
          seenHash.add(hash);

          const name = `${kind === 'stickers' ? 'sticker' : 'img'}_rss_${hash}${ext}`;
          const full = path.join(dir, name);
          if (!fs.existsSync(full)) fs.writeFileSync(full, buf);

          downloaded.push({ name, size: buf.length, from: c.from.slice(0, 100) });
        } catch (e) {
          failed.push(`${c.url.slice(0, 50)} ${e.message}`);
        }
      }

      result.images = downloaded.length;
      result.imageTotal = urls.length;
      result.downloaded = downloaded;
      result.failed = failed.slice(0, 5);
    }

    result.ok = result.words > 0 || result.images > 0;
    if (!result.ok) result.error = '既没学到词也没下到图';

    return result;
  }

  // ===== 每日热点摘要 =====

  /**
   * 跑一次热点摘要，结果写进长期记忆。
   *
   * 由 app.mjs 的定时器或控制台手动触发。
   */
  async #runDigest(body = {}) {
    const cfg = this.config.learning || {};
    const dCfg = { ...DIGEST_DEFAULTS, ...(cfg.digest || {}) };

    const feeds = Array.isArray(body.feeds) && body.feeds.length
      ? body.feeds
      : cfg.rssFeeds || [];

    if (!feeds.length) {
      return { ok: false, error: '还没有配置 RSS 订阅，先去添加几个源' };
    }

    // 1. 抓素材
    const { items, feeds: feedDetails } = await collectFeedItems(feeds, dCfg);

    if (!items.length) {
      const errs = feedDetails.filter((d) => !d.ok).map((d) => `${d.url}: ${d.error}`);
      return {
        ok: false,
        error: errs.length ? `没抓到内容：${errs.slice(0, 3).join('；')}` : '订阅里没有条目',
        details: feedDetails,
      };
    }

    // 2. 总结
    const askLlm = this.#makeAskLlm();
    const points = await summarizeDigest(items, askLlm, dCfg.maxPoints);

    if (!points.length) {
      return { ok: false, error: '模型没总结出内容', items: items.length };
    }

    // 3. 写进记忆
    //    存在一个固定的「公共记忆」会话里，所有对话都能看到
    const store = this.engine.memory;
    const MEM_ID = 'shared:daily-digest';

    if (store) {
      const dateStr = new Date().toLocaleDateString('zh-CN');
      store.addSummary(MEM_ID, `${dateStr} 的热点：${points.join('；')}`);
      this.engine.digestState = this.engine.digestState || {};
      this.engine.digestState.lastTs = Date.now();
      this.engine.digestState.lastPoints = points;
    }

    this.log.info?.(`[digest] 摘要完成：${points.length} 条`);

    return {
      ok: true,
      items: items.length,
      points,
      details: feedDetails,
      savedTo: MEM_ID,
    };
  }

  /**
   * 定时检查：到点了就跑一次摘要。
   *
   * 由 app.mjs 每隔一段时间调，不要求精确到点 ——
   * 服务半夜没开也不会错过，起来后补上。
   */
  async #digestTick() {
    const cfg = this.config.learning || {};
    const dCfg = { ...DIGEST_DEFAULTS, ...(cfg.digest || {}) };
    const st = this.engine.digestState || {};

    const decision = shouldRunDigest({ cfg: dCfg, lastTs: st.lastTs });
    if (!decision.want) {
      return { ok: true, skipped: true, reason: decision.reason };
    }

    if (this.engine.digestRunning) {
      return { ok: true, skipped: true, reason: '上一次还在跑' };
    }

    const feeds = cfg.rssFeeds || [];
    if (!feeds.length) {
      return { ok: true, skipped: true, reason: '还没有订阅源' };
    }

    this.engine.digestRunning = true;
    try {
      const r = await this.#runDigest({});
      return r;
    } finally {
      this.engine.digestRunning = false;
    }
  }

  /** 每日摘要状态。 */
  #digestStatus() {
    const cfg = this.config.learning || {};
    const dCfg = { ...DIGEST_DEFAULTS, ...(cfg.digest || {}) };
    const st = this.engine.digestState || {};

    const store = this.engine.memory;
    const MEM_ID = 'shared:daily-digest';
    let saved = { facts: 0, summaries: 0 };
    try {
      const mem = store?.load(MEM_ID);
      saved = {
        facts: Object.keys(mem?.facts || {}).length,
        summaries: (mem?.summaries || []).length,
      };
    } catch {}

    return {
      enabled: dCfg.enabled === true,
      intervalHours: dCfg.intervalHours,
      maxPoints: dCfg.maxPoints,
      feeds: (cfg.rssFeeds || []).length,
      lastTs: st.lastTs || null,
      lastPoints: st.lastPoints || [],
      saved,
    };
  }

  /** 保存每日摘要配置。 */
  #saveDigest(body = {}) {
    const file = path.join(this.root, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

    cfg.learning = cfg.learning || {};
    cfg.learning.digest = cfg.learning.digest || {};

    const d = body.digest || body;
    if (typeof d.enabled === 'boolean') cfg.learning.digest.enabled = d.enabled;
    if (Number.isFinite(d.intervalHours)) {
      cfg.learning.digest.intervalHours = clamp(d.intervalHours, 1, 168);
    }
    if (Number.isFinite(d.maxPoints)) cfg.learning.digest.maxPoints = clamp(d.maxPoints, 1, 10);
    if (Number.isFinite(d.maxFeeds)) cfg.learning.digest.maxFeeds = clamp(d.maxFeeds, 1, 10);

    backupConfig(file);
    writeConfig(file, cfg, 'learning/digest', this.log);

    this.config.learning = {
      ...(this.config.learning || {}),
      digest: cfg.learning.digest,
    };

    return { ok: true, digest: this.#digestStatus() };
  }

  /**
   * 把学习到的词条自动整理进词库。
   *
   * 为什么要单独一个库：
   *   学习的词质量参差，塞进 slang 会污染人工精选的内容；
   *   单独放 learned.txt 里，出问题直接关掉或清空，不影响别的。
   *
   * @param {Array<{word,explain}>} words
   * @param {object} [opts]
   * @param {string} [opts.bank] 目标词库名
   * @param {boolean} [opts.enabled] 覆盖配置
   */
  #autoOrganize(words, opts = {}) {
    const cfg = this.config.learning?.autoMerge || {};
    const enabled = opts.enabled !== undefined ? opts.enabled : cfg.enabled === true;

    if (!enabled || !words?.length) {
      return { ok: false, skipped: true, reason: enabled ? '没有词条' : '自动整理未开启' };
    }

    // 目标词库：learned 是默认，独立于内置库
    const bankName = String(opts.bank || cfg.bank || 'learned');

    if (!/^[\w-]{1,40}$/.test(bankName)) {
      return { ok: false, error: '词库名不合法' };
    }

    const dir = this.#wordsDir();
    fs.mkdirSync(dir, { recursive: true });

    const bankFile = path.join(dir, bankName + '.txt');

    // 没这个库就先建一个，带上说明头
    if (!fs.existsSync(bankFile)) {
      const header =
        `# 联网学到的词（自动整理，可手动编辑）\n` +
        `# 来源：搜索 / 定向网站 / RSS\n` +
        `# 格式：词条｜一句话解释\n\n`;
      fs.writeFileSync(bankFile, header, 'utf8');
    }

    // 备份再写
    try {
      fs.copyFileSync(bankFile, bankFile + '.bak');
    } catch {}

    const merged = mergeIntoBank(bankFile, words);
    clearWordCache();

    // 新库要确保在配置里是启用的，否则拼不进提示词
    if (merged.added > 0) {
      try {
        const cfgFile = path.join(this.root, 'config.json');
        const cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        cur.words = cur.words || {};

        if (cur.words[bankName]?.enabled === undefined) {
          cur.words[bankName] = { ...(cur.words[bankName] || {}), enabled: true };
          backupConfig(cfgFile);
          writeConfig(cfgFile, cur, 'words/auto-organize', this.log);
          this.config.words = cur.words;
        }
      } catch (e) {
        this.log.warn?.(`[words] 自动启用词库失败: ${e.message}`);
      }
    }

    this.log.info?.(
      `[words] 自动整理 ${merged.added} 条到 ${bankName}.txt（跳过重复 ${merged.skipped}）`,
    );

    return {
      ok: true,
      bank: bankName,
      added: merged.added,
      skipped: merged.skipped,
      message: `自动整理 ${merged.added} 条到 ${bankName}（跳过重复 ${merged.skipped}）`,
    };
  }

  /** 把待审词条合并进词库。 */
  #applyLearned(body = {}) {
    const dataDir = path.join(this.root, 'data');
    const pending = readPending(dataDir);

    if (!pending.words.length) {
      return { ok: false, error: '没有待审词条' };
    }

    // 指定目标词库，默认 slang
    const bankName = String(body.bank || 'slang');
    if (!/^[\w-]{1,40}$/.test(bankName)) {
      return { ok: false, error: '词库名不合法' };
    }

    const bankFile = path.join(this.#wordsDir(), bankName + '.txt');
    if (!fs.existsSync(bankFile)) {
      return { ok: false, error: `词库 ${bankName} 不存在` };
    }

    // 可选：只合并选中的词
    let words = pending.words;
    if (Array.isArray(body.words) && body.words.length) {
      const picked = new Set(body.words.map(String));
      words = pending.words.filter((w) => picked.has(w.word));
    }

    const r = mergeIntoBank(bankFile, words);

    // 清空待审
    try {
      fs.unlinkSync(path.join(dataDir, 'learned-words.json'));
    } catch {}

    return {
      ok: true,
      bank: bankName,
      added: r.added,
      skipped: r.skipped,
      message: `已合并 ${r.added} 条到 ${bankName}（跳过重复 ${r.skipped} 条）`,
    };
  }

  /** 丢弃待审词条。 */
  #discardLearned() {
    try {
      fs.unlinkSync(path.join(this.root, 'data', 'learned-words.json'));
    } catch {}
    return { ok: true, message: '已丢弃' };
  }

  /**
   * 保存上传的图片（base64）。
   *
   * @param {object} body { kind: 'stickers'|'images', name, data: 'base64' }
   */
  #uploadMedia(body = {}) {
    const kind = body.kind === 'images' ? 'images' : 'stickers';
    const b64 = String(body.data || '');

    if (!b64) return { ok: false, error: '没有图片数据' };

    // 限制 8MB
    const approxSize = Math.floor((b64.length * 3) / 4);
    if (approxSize > 8 * 1024 * 1024) {
      return { ok: false, error: '图片太大（上限 8MB）' };
    }

    let buf;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      return { ok: false, error: 'base64 解码失败' };
    }

    // 按文件头判断格式（不信任扩展名）
    let ext = '';
    if (buf[0] === 0x89 && buf[1] === 0x50) ext = '.png';
    else if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
    else if (buf.slice(0, 3).toString() === 'GIF') ext = '.gif';
    else if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') ext = '.webp';

    if (!ext) return { ok: false, error: '不是支持的图片格式（支持 png/jpg/gif/webp）' };

    // 生成文件名（内容哈希，天然去重）
    const crypto = cryptoMod;
    const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12);
    const prefix = kind === 'stickers' ? 'sticker' : 'img';
    const name = `${prefix}_up_${hash}${ext}`;

    const dirs = this.#mediaDirs();
    const dir = dirs[kind];
    fs.mkdirSync(dir, { recursive: true });

    const full = path.join(dir, name);
    if (!fs.existsSync(full)) {
      fs.writeFileSync(full, buf);
    }

    return {
      ok: true,
      name,
      size: buf.length,
      kind,
      message: `已上传（${(buf.length / 1024).toFixed(0)}KB）`,
    };
  }

  /**
   * 从免费图片源下载（不需要 Key）。
   *
   * 支持的源：
   *   picsum   - 随机照片
   *   cataas   - 猫咪图
   *   dicebear - 像素头像
   *   robohash - 机器人头像
   */
  async #fetchFreeImages(body = {}) {
    const source = String(body.source || 'picsum');
    const count = Math.min(Number(body.count) || 3, 10);
    const kind = body.kind === 'images' ? 'images' : 'stickers';

    const SOURCES = {
      picsum: (i) => `https://picsum.photos/400/300?random=${Date.now() + i}`,
      cataas: (i) => `https://cataas.com/cat?${Date.now() + i}`,
      dicebear: (i) => `https://api.dicebear.com/7.x/pixel-art/png?seed=${Date.now() + i}`,
      robohash: (i) => `https://robohash.org/${Date.now() + i}.png?size=200x200`,
    };

    const maker = SOURCES[source];
    if (!maker) return { ok: false, error: `未知来源: ${source}` };

    const dirs = this.#mediaDirs();
    const dir = dirs[kind];
    fs.mkdirSync(dir, { recursive: true });

    const crypto = cryptoMod;
    const downloaded = [];
    const failed = [];

    for (let i = 0; i < count; i++) {
      const url = maker(i);
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15000);
        timer.unref?.();

        const res = await fetch(url, {
          signal: ac.signal,
          headers: { 'user-agent': 'Mozilla/5.0' },
        });
        clearTimeout(timer);

        if (!res.ok) {
          failed.push(`${source} #${i + 1}: HTTP ${res.status}`);
          continue;
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 512) {
          failed.push(`${source} #${i + 1}: 文件太小`);
          continue;
        }

        let ext = '';
        if (buf[0] === 0x89 && buf[1] === 0x50) ext = '.png';
        else if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
        else if (buf.slice(0, 3).toString() === 'GIF') ext = '.gif';
        else if (buf.slice(0, 4).toString() === 'RIFF') ext = '.webp';

        if (!ext) {
          failed.push(`${source} #${i + 1}: 不是图片`);
          continue;
        }

        const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12);
        const prefix = kind === 'stickers' ? 'sticker' : 'img';
        const name = `${prefix}_${source}_${hash}${ext}`;
        const full = path.join(dir, name);

        if (!fs.existsSync(full)) fs.writeFileSync(full, buf);

        downloaded.push({ name, size: buf.length });
      } catch (e) {
        failed.push(`${source} #${i + 1}: ${e.message}`);
      }
    }

    return {
      ok: downloaded.length > 0,
      source,
      kind,
      downloaded,
      failed: failed.slice(0, 3),
      error: downloaded.length ? undefined : failed[0] || '全部失败',
    };
  }

  // ===== 会话列表 =====

  /**
   * 列出会话（用于「搭话 / 分享发给谁」）。
   *
   * 数据来源改成适配器上报：适配器知道自己的会话列表，
   * 通过 POST /api/adapter/contacts 报上来，存在 engine.adapterContacts。
   * 以前是正则挖桥接日志，适配器独立成仓库之后日志不在核心目录下，挖不到了。
   */
  #listChats() {
    const chats = new Map();

    const addChat = (name, ts = '') => {
      const n = String(name || '').trim();
      if (!n || n.length > 40) return;
      if (/^(微信团队|微信支付|服务通知|文件传输助手|newsapp|weixin)$/.test(n)) return;

      const cur = chats.get(n) || { name: n, count: 0, lastSeen: '' };
      cur.count++;
      if (ts && ts > cur.lastSeen) cur.lastSeen = ts;
      chats.set(n, cur);
    };

    // 适配器上报的会话（它知道自己的聊天列表）
    try {
      const reported = this.engine?.adapterContacts;
      if (reported && typeof reported.values === 'function') {
        for (const info of reported.values()) {
          addChat(info?.chatName || info?.name);
        }
      }
    } catch {}

    const careTargets = this.config.care?.targets || [];
    const shareTargets = this.config.share?.targets || [];
    for (const t of [...careTargets, ...shareTargets]) addChat(t);

    const list = Array.from(chats.values()).sort((a, b) => b.count - a.count);

    return { chats: list, selected: { care: careTargets, share: shareTargets } };
  }

  // ===== 适配器状态 =====

  async #bridgeStatus() {
    /**
     * 适配器在线状态（可能有好几个）。
     *
     * 只看心跳，不读日志 —— 适配器是独立进程、独立仓库，
     * 核心读不到它的日志，所以心跳必须带够信息：
     * 名字、平台、账号、能不能发、最近有没有消息。
     */
    const now = Date.now();
    const slots = this.engine?.adapters instanceof Map ? [...this.engine.adapters.values()] : [];

    // 心跳 20 秒一次，超过 60 秒没收到就算掉线
    const FRESH_MS = 60000;

    const list = slots.map((s) => {
      const hb = s.heartbeat || null;
      const info = s.info || null;
      const fresh = Boolean(hb && now - hb.at < FRESH_MS);
      return {
        name: s.name || hb?.name || info?.name || 'default',
        platform: s.platform || hb?.platform || info?.platform || '',
        online: fresh,
        account: hb?.account || '',
        uiaOk: Boolean(hb?.uia),
        listening: Boolean(hb?.listener),
        resting: Boolean(hb?.rest),
        ffmpeg: Boolean(hb?.ffmpeg),
        heartbeatAgo: hb ? Math.round((now - hb.at) / 1000) : null,
        recentMessages: Number(hb?.recentMessages) || 0,
        version: info?.version || '',
        contacts: s.contacts ? s.contacts.size : 0,
      };
    });

    // 最近报到的排前面
    list.sort((a, b) => (a.heartbeatAgo ?? 1e9) - (b.heartbeatAgo ?? 1e9));

    const primary = list[0] || null;
    const anyOnline = list.some((a) => a.online);

    // 兜底：只有 engine.bridgeHeartbeat（老的单槽位写法）时也能显示
    if (!primary) {
      const hb = this.engine?.bridgeHeartbeat || null;
      const info = this.engine?.bridgeInfo || null;
      const fresh = Boolean(hb && now - hb.at < FRESH_MS);
      return {
        online: fresh,
        bridgeOnline: fresh,
        source: 'heartbeat',
        account: hb?.account || '',
        lastActivity: hb ? new Date(hb.at).toLocaleString('zh-CN') : '',
        heartbeatAgo: hb ? Math.round((now - hb.at) / 1000) : null,
        stats: { recentMessages: Number(hb?.recentMessages) || 0 },
        adapters: [],
        adapter: { name: '', version: '', root: info?.root || '', reportedAt: info?.at || 0 },
        error: hb ? `适配器心跳已停止（最后 ${Math.round((now - hb.at) / 1000)} 秒前）`
                   : '还没收到过适配器心跳（没有适配器在跑，或者它连不上这个服务）',
        hint: '启动你的适配器；不接平台也能用网页聊天',
      };
    }

    const offline = list.filter((a) => !a.online);

    return {
      // ===== 兼容旧前端：顶层字段取「最近那个适配器」=====
      online: anyOnline,
      bridgeOnline: anyOnline,
      source: 'heartbeat',
      account: primary.account,
      listening: primary.listening,
      uiaOk: primary.uiaOk,
      resting: primary.resting,
      ffmpeg: primary.ffmpeg,
      lastActivity: primary.heartbeatAgo != null
        ? new Date(now - primary.heartbeatAgo * 1000).toLocaleString('zh-CN')
        : '',
      heartbeatAgo: primary.heartbeatAgo,
      stats: { recentMessages: primary.recentMessages },
      adapter: { name: primary.name, version: primary.version, root: '', reportedAt: 0 },

      // ===== 新：完整列表 =====
      adapters: list,
      error: anyOnline
        ? ''
        : offline.map((a) => `${a.name}（心跳停了 ${a.heartbeatAgo ?? '?'} 秒）`).join('、'),
      hint: anyOnline ? '' : '启动你的适配器；不接平台也能用网页聊天',
    };
  }

  /**
   * 停掉服务。
   *
   * 为什么要在面板上放这个：关掉网页并不会让服务退出（它是个后台进程），
   * 用户想停只能去任务管理器找 node.exe，根本找不到是哪个。
   * 这里给一个明确入口，点完服务就退，锁文件也清掉。
   */
  #shutdown() {
    this.log.info?.('[admin] 收到停止请求，服务将在 1 秒后退出');

    // 先回包再退出，否则前端拿不到响应只会看到连接断开
    setTimeout(() => {
      try {
        const lock = path.join(this.root, 'data', 'app.lock');
        if (fs.existsSync(lock)) {
          const cur = fs.readFileSync(lock, 'utf8').trim();
          if (cur === String(process.pid)) fs.unlinkSync(lock);
        }
      } catch {}

      process.exit(0);
    }, 1000).unref?.();

    return { ok: true, message: '服务正在停止，可以关掉这个页面了' };
  }

  /**
   * 重启服务。
   *
   * 做法：spawn 一个「等当前进程退出 → 拉新的」的看护进程，然后自己退出。
   * 为什么要看护进程：如果直接杀掉自己，没人负责再拉起来。
   * 不能用 detached 的 node 直连 console（Windows 下窗口会跟着关），
   * 所以用一个极简的 node -e 脚本做看护。
   */
  #restart() {
    this.log.info?.('[admin] 收到重启请求');

    const root = this.root;
    const lock = path.join(root, 'data', 'app.lock');

    // 看护脚本：等旧进程退掉（锁文件消失）→ 用 launch_background 重开
    const guard =
      `const{spawn}=require('node:child_process');` +
      `const fs=require('node:fs');` +
      `const lock=${JSON.stringify(lock)};` +
      `let n=0;` +
      `const t=setInterval(()=>{n++;` +
      `const alive=fs.existsSync(lock);` +
      `if(!alive||n>40){clearInterval(t);` +
      `try{spawn(process.execPath,['launch_background.mjs'],{cwd:${JSON.stringify(
        root,
      )},detached:true,stdio:'ignore',windowsHide:true}).unref();}catch(e){}` +
      `}},500);`;

    setTimeout(() => {
      import('node:child_process')
        .then(({ spawn }) => {
          spawn(process.execPath, ['-e', guard], {
            cwd: root,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          }).unref();
        })
        .catch((e) => {
          this.log.warn?.(`[admin] 拉起看护进程失败: ${e.message}`);
        })
        .finally(() => {
          // 清锁并退出，让看护进程接手
          try {
            if (fs.existsSync(lock)) {
              const cur = fs.readFileSync(lock, 'utf8').trim();
              if (cur === String(process.pid)) fs.unlinkSync(lock);
            }
          } catch {}

          process.exit(0);
        });
    }, 800).unref?.();

    return { ok: true, message: '服务正在重启，稍等约 15 秒' };
  }

  /** 服务状态。 */
  /**
   * 查仓库最新的 tag 版本号。
   *
   * 项目只打 tag 没发 Release，所以用 /tags 而不是 /releases/latest。
   * TLS 被代理拦截时退回不校验证书的请求 —— 只查版本号，不涉及凭证。
   */
  async #latestTag(repo) {
    const fetchJSON = async (p) => {
      const url = 'https://api.github.com/repos/' + repo + p;
      const headers = { 'user-agent': 'YF-Robot', accept: 'application/vnd.github+json' };

      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) {
        if (!/certificate|CERT|SSL|TLS|fetch failed/i.test(String(e.message))) throw e;

        const https = await import('node:https');
        const body = await new Promise((resolve, reject) => {
          const req = https.request(
            url,
            { headers, rejectUnauthorized: false, timeout: 8000 },
            (res) => {
              if (res.statusCode !== 200) {
                reject(new Error('HTTP ' + res.statusCode));
                res.resume();
                return;
              }
              let data = '';
              res.setEncoding('utf8');
              res.on('data', (c) => (data += c));
              res.on('end', () => resolve(data));
            },
          );
          req.on('error', reject);
          req.on('timeout', () => req.destroy(new Error('超时')));
          req.end();
        });
        return JSON.parse(body);
      }
    };

    const tags = await fetchJSON('/tags?per_page=50');
    const versions = (Array.isArray(tags) ? tags : [])
      .map((t) => String(t.name || '').replace(/^v/, ''))
      .filter((v) => /^\d+\.\d+/.test(v))
      .sort((a, b) => this.#cmpVersion(b, a));

    return { latest: versions[0] || '', versions };
  }

  /** 语义化版本比较：返回 >0 表示 a 更新 */
  #cmpVersion(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  #version() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.root, 'package.json'), 'utf8')).version || '';
    } catch {
      return '';
    }
  }

  #status() {
    const uptimeSec = Math.floor((Date.now() - this.startedAt) / 1000);
    return {
      ok: true,
      uptime: uptimeSec,
      uptimeText: formatUptime(uptimeSec),
      persona: this.config.__personaName || '',
      version: this.#version(),
      model: this.config.llm.model,
      channels: this.channels,
      ports: {
        web: this.config.server.port,
        group: this.config.channels['wechat-group']?.listenPort || null,
      },
      features: {
        vision: Boolean(this.config.vision?.enabled),
        voice: Boolean(this.config.voice?.enabled),
        search: Boolean(this.config.search?.enabled),
        share: Boolean(this.config.share?.enabled),
        emoji: this.config.reply?.emoji?.enabled !== false,
      },
      sessions: this.engine.sessions.stats(),
      hasKey: Boolean(this.config.llm.apiKey),
    };
  }

  /** 对外暴露的配置（脱敏）。 */
  #publicConfig() {
    const mask = (s) => (s ? s.slice(0, 4) + '****' + s.slice(-4) : '');
    const c = this.config;
    return {
      /** 后台运行相关 */
      server: {
        port: c.server?.port,
        stopWhenNoConsole: c.server?.stopWhenNoConsole === true,
        /** data/keep-alive 存在时，上面那个开关会被压制 */
        keepAliveFile: fs.existsSync(path.join(this.root, 'data', 'keep-alive')),
        pid: process.pid,
      },
      llm: {
        baseUrl: c.llm.baseUrl,
        model: c.llm.model,
        apiKeyMasked: mask(c.llm.apiKey),
        hasKey: Boolean(c.llm.apiKey),
        temperature: c.llm.temperature,
        maxTokens: c.llm.maxTokens,
      },
      vision: {
        enabled: c.vision.enabled,
        baseUrl: c.vision.baseUrl,
        model: c.vision.model,
        hasKey: Boolean(c.vision.apiKey),
        apiKeyMasked: mask(c.vision.apiKey),
      },
      logic: {
        enabled: c.logic?.enabled !== false,
        autoLearn: {
          enabled: c.logic?.autoLearn?.enabled === true,
          maxPerDay: c.logic?.autoLearn?.maxPerDay ?? 10,
          mode: c.logic?.autoLearn?.mode || 'pending',
        },
      },
      voice: {
        enabled: c.voice.enabled,
        baseUrl: c.voice.baseUrl,
        model: c.voice.model,
        hasKey: Boolean(c.voice.apiKey),
        apiKeyMasked: mask(c.voice.apiKey),

        // 语音合成（可以和转写分开配）
        ttsHasKey: Boolean(c.voice?.ttsApiKey),
        ttsApiKeyMasked: mask(c.voice?.ttsApiKey),
        ttsKeyIsShared: !c.voice?.ttsApiKey && Boolean(c.voice?.apiKey),
        ttsModel: c.voice?.ttsModel || 'qwen3-tts-flash',
        ttsVoice: c.voice?.ttsVoice || 'Cherry',
      },
      search: {
        enabled: c.search.enabled,
        provider: c.search.provider,
        hasKey: Boolean(c.search.apiKey),
        apiKeyMasked: mask(c.search.apiKey),
        // 对话时自动判断要不要联网
        autoDetect: c.search.autoDetect !== false,
        maxResults: c.search.maxResults ?? 5,
        // 每小时最多自动搜几次（防烧额度）
        maxPerHour: c.search.maxPerHour ?? 10,
        searchStatus: this.engine.searchState?.status?.() || null,
      },
      share: {
        enabled: c.share.enabled,
        intervalHours: c.share.intervalHours,
        keywords: c.share.keywords || [],
        targets: c.share.targets || [],
        source: c.share.source || { type: 'bilibili', url: '', categories: [] },
      },
      care: {
        enabled: c.care?.enabled !== false,
        minIntervalMinutes: c.care?.minIntervalMinutes ?? 120,
        maxPerDay: c.care?.maxPerDay ?? 3,
        quietHours: c.care?.quietHours || { start: 23, end: 9 },
        idleMinutes: c.care?.idleMinutes ?? 60,
        targets: c.care?.targets || [],
      },
      learning: {
        enabled: c.learning?.enabled === true,
        maxPerRun: c.learning?.maxPerRun ?? 20,
        queries: c.learning?.queries || [],
      },
      wechat: {
        stickerChance: c.wechat?.stickerChance ?? 0,
        voiceChance: c.wechat?.voiceChance ?? 0,
        mediaCollect: c.wechat?.mediaCollect !== false,
        /**
         * 收藏白名单。
         *
         * 空数组 = 全收（默认）；填了 wxid = 只收这些会话/发送者发的图。
         * 以前这里没暴露，界面上既看不到也改不了，
         * 于是「为什么别人的图也被收进来了」只能去翻配置文件。
         */
        collectOnlyFrom: c.wechat?.collectOnlyFrom || [],
        collectScope:
          c.wechat?.collectScope ||
          ((c.wechat?.collectOnlyFrom || []).length ? 'custom' : 'all'),
      },
      imagegen: {
        enabled: c.imagegen?.enabled === true,
        baseUrl: c.imagegen?.baseUrl || 'https://open.bigmodel.cn/api/paas/v4',
        model: c.imagegen?.model || 'cogview-3-flash',
        size: c.imagegen?.size || '1024x1024',
        hasKey: Boolean(c.imagegen?.apiKey),
        apiKeyMasked: mask(c.imagegen?.apiKey),
        maxPerCall: c.imagegen?.maxPerCall ?? 2,
        // 主动画图
        proactive: {
          enabled: c.imagegen?.proactive?.enabled === true,
          chance: c.imagegen?.proactive?.chance ?? 0.05,
          minIntervalMinutes: c.imagegen?.proactive?.minIntervalMinutes ?? 60,
          maxPerDay: c.imagegen?.proactive?.maxPerDay ?? 2,
        },
      },
      reply: {
        maxChars: c.reply.maxChars,
        maxBubbles: c.reply.maxBubbles,
        bubbleDelayMs: c.reply.bubbleDelayMs,
        emoji: c.reply.emoji || {},
      },
      group: {
        requireAt: c.group.requireAt,
        masterAlwaysReply: c.group.masterAlwaysReply !== false,
        engagedMinutes: c.group.engagedMinutes,
        cooldownSec: c.group.cooldownSec,
        maxRepliesPerHour: c.group.maxRepliesPerHour,
        aliases: c.group.aliases || [],
        ownerIds: c.group.ownerIds || [],
      },
      card: c.card || null,
    };
  }

  /** 保存配置。只接受白名单字段。 */
  #saveConfig(patch) {
    if (!patch || typeof patch !== 'object') {
      throw new Error('请求体格式错误');
    }

    const file = path.join(this.root, 'config.json');
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));

    // 逐项白名单合并
    /**
     * 安全地处理 Key 更新。
     *
     * 规则（重要）：
     *   · 传掩码（含 ****）→ 不改
     *   · 传空字符串 / undefined → **不改**（防止前端空输入框把 Key 抹掉）
     *   · 传非空字符串 → 更新
     *   · clearApiKey === true → 明确删除（记进 clearKeys，写盘守卫才放行）
     */
    const clearKeys = [];

    const applyKey = (target, patchObj, clearFlag, name) => {
      if (!target || !patchObj) return;

      if (clearFlag === true) {
        target.apiKey = '';
        if (name) clearKeys.push(name);
        return;
      }

      if (!Object.prototype.hasOwnProperty.call(patchObj, 'apiKey')) return;

      const raw = patchObj.apiKey;
      if (raw === null || raw === undefined) return;

      const s = String(raw);
      if (s.includes('****')) return; // 掩码，不是真 Key
      if (!s.trim()) return; // 空字符串视为「不修改」

      const next = s.trim();
      const prev = String(target.apiKey || '');

      /**
       * 明显更短的 Key 不覆盖长的。
       *
       * 真实事故：单元测试往真实配置里写了 `test-voice-key-abcdef`（21 字符），
       * 把用户 117 字符的语音 Key 覆盖掉，紧接着又被清空 ——
       * 审计日志 voice:117→21→0。
       *
       * 真 Key 一般都比占位串长得多；真要换短的，传 forceApiKey: true 放行。
       */
      if (prev.length >= 40 && next.length < 40 && patchObj.forceApiKey !== true) {
        this.log.warn?.(
          `[admin] ${name || 'Key'} 新值只有 ${next.length} 字符，比现有 ${prev.length} 字符短太多，` +
            '拒绝覆盖（确实要换请传 forceApiKey: true）',
        );
        return;
      }

      target.apiKey = next;
    };

    if (patch.llm) {
      if (patch.llm.baseUrl) current.llm.baseUrl = String(patch.llm.baseUrl);
      if (patch.llm.model) current.llm.model = String(patch.llm.model);
      applyKey(current.llm, patch.llm, patch.llm.clearApiKey, 'llm');
      if (Number.isFinite(patch.llm.temperature)) current.llm.temperature = clamp(patch.llm.temperature, 0, 2);
      if (Number.isFinite(patch.llm.maxTokens)) current.llm.maxTokens = clamp(patch.llm.maxTokens, 64, 8192);
    }

    if (patch.vision) {
      if (typeof patch.vision.enabled === 'boolean') current.vision.enabled = patch.vision.enabled;
      if (patch.vision.baseUrl) current.vision.baseUrl = String(patch.vision.baseUrl);
      if (patch.vision.model) current.vision.model = String(patch.vision.model);
      applyKey(current.vision, patch.vision, patch.vision.clearApiKey, 'vision');
    }

    // 逻辑库开关（联网学习默认关闭，得主人手动打开）
    if (patch.logic) {
      current.logic = current.logic || {};
      if (typeof patch.logic.enabled === 'boolean') current.logic.enabled = patch.logic.enabled;

      if (patch.logic.autoLearn && typeof patch.logic.autoLearn === 'object') {
        const al = (current.logic.autoLearn = current.logic.autoLearn || {});
        const p2 = patch.logic.autoLearn;
        if (typeof p2.enabled === 'boolean') al.enabled = p2.enabled;
        if (p2.maxPerDay !== undefined) {
          const n = Number(p2.maxPerDay);
          if (Number.isFinite(n)) al.maxPerDay = Math.min(Math.max(Math.trunc(n), 1), 100);
        }
        if (p2.mode === 'active' || p2.mode === 'pending') al.mode = p2.mode;
      }
    }

    if (patch.voice) {
      if (typeof patch.voice.enabled === 'boolean') current.voice.enabled = patch.voice.enabled;
      if (patch.voice.baseUrl) current.voice.baseUrl = String(patch.voice.baseUrl);
      if (patch.voice.model) current.voice.model = String(patch.voice.model);
      applyKey(current.voice, patch.voice, patch.voice.clearApiKey, 'voice');
      if (patch.voice.mode) current.voice.mode = String(patch.voice.mode);

      // 语音合成：可以单独配 Key / 模型 / 音色
      if (Object.prototype.hasOwnProperty.call(patch.voice, 'ttsApiKey')) {
        const v = String(patch.voice.ttsApiKey || '').trim();
        // 掩码和空串都不改（和主 Key 同样的规则）
        if (v && !v.includes('****')) {
          const prevT = String(current.voice?.ttsApiKey || '');
          if (!(prevT.length >= 40 && v.length < 40)) current.voice.ttsApiKey = v;
        }
      }
      if (patch.voice.clearTtsApiKey === true) current.voice.ttsApiKey = '';
      if (patch.voice.ttsModel) current.voice.ttsModel = String(patch.voice.ttsModel);
      if (patch.voice.ttsVoice) current.voice.ttsVoice = String(patch.voice.ttsVoice);
    }

    if (patch.search) {
      if (typeof patch.search.enabled === 'boolean') current.search.enabled = patch.search.enabled;
      if (patch.search.provider) current.search.provider = String(patch.search.provider);
      if (typeof patch.search.autoDetect === 'boolean') {
        current.search.autoDetect = patch.search.autoDetect;
      }
      if (Number.isFinite(patch.search.maxResults)) {
        current.search.maxResults = clamp(patch.search.maxResults, 1, 20);
      }
      if (Number.isFinite(patch.search.maxPerHour)) {
        current.search.maxPerHour = clamp(patch.search.maxPerHour, 1, 200);
      }
      applyKey(current.search, patch.search, patch.search.clearApiKey, 'search');
    }

    if (patch.reply) {
      if (Number.isFinite(patch.reply.maxChars)) current.reply.maxChars = clamp(patch.reply.maxChars, 50, 2000);
      if (Number.isFinite(patch.reply.maxBubbles)) current.reply.maxBubbles = clamp(patch.reply.maxBubbles, 1, 6);
      if (Number.isFinite(patch.reply.bubbleDelayMs)) current.reply.bubbleDelayMs = clamp(patch.reply.bubbleDelayMs, 0, 5000);
      if (patch.reply.emoji) {
        current.reply.emoji = { ...(current.reply.emoji || {}), ...sanitizeEmoji(patch.reply.emoji) };
      }
    }

    if (patch.group) {
      const g = patch.group;
      if (typeof g.requireAt === 'boolean') current.group.requireAt = g.requireAt;
      if (typeof g.masterAlwaysReply === 'boolean') current.group.masterAlwaysReply = g.masterAlwaysReply;
      if (Number.isFinite(g.engagedMinutes)) current.group.engagedMinutes = clamp(g.engagedMinutes, 1, 120);
      if (Number.isFinite(g.cooldownSec)) current.group.cooldownSec = clamp(g.cooldownSec, 0, 3600);
      if (Number.isFinite(g.maxRepliesPerHour)) current.group.maxRepliesPerHour = clamp(g.maxRepliesPerHour, 1, 10000);
      if (Array.isArray(g.aliases)) current.group.aliases = g.aliases.map(String).filter(Boolean).slice(0, 10);
      if (Array.isArray(g.ownerIds)) current.group.ownerIds = g.ownerIds.map(String).filter(Boolean).slice(0, 50);
    }

    // 联网学习
    if (patch.learning) {
      const l = patch.learning;
      current.learning = current.learning || {};
      if (typeof l.enabled === 'boolean') current.learning.enabled = l.enabled;
      if (Number.isFinite(l.maxPerRun)) current.learning.maxPerRun = clamp(l.maxPerRun, 1, 50);
      if (Array.isArray(l.queries)) {
        current.learning.queries = l.queries
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 10);
      }
      // 定向网站列表
      if (Array.isArray(l.sites)) {
        current.learning.sites = l.sites
          .map((s) => {
            if (typeof s === 'string') return { url: s.trim(), note: '' };
            return {
              url: String(s?.url || '').trim(),
              note: String(s?.note || '').trim().slice(0, 60),
            };
          })
          .filter((s) => {
            if (!s.url) return false;
            try {
              return /^https?:$/.test(new URL(s.url).protocol);
            } catch {
              return false;
            }
          })
          .slice(0, 30);
      }

      // 定向抓图站点列表
      if (Array.isArray(l.mediaSites)) {
        current.learning.mediaSites = l.mediaSites
          .map((s) => {
            if (typeof s === 'string') return { url: s.trim(), note: '' };
            return {
              url: String(s?.url || '').trim(),
              note: String(s?.note || '').trim().slice(0, 60),
            };
          })
          .filter((s) => {
            if (!s.url) return false;
            try {
              return /^https?:$/.test(new URL(s.url).protocol);
            } catch {
              return false;
            }
          })
          .slice(0, 30);
      }

      // RSS 订阅列表
      if (Array.isArray(l.rssFeeds)) {
        current.learning.rssFeeds = l.rssFeeds
          .map((s) => {
            if (typeof s === 'string') return { url: s.trim(), note: '' };
            return {
              url: String(s?.url || '').trim(),
              note: String(s?.note || '').trim().slice(0, 60),
            };
          })
          .filter((s) => {
            if (!s.url) return false;
            try {
              return /^https?:$/.test(new URL(s.url).protocol);
            } catch {
              return false;
            }
          })
          .slice(0, 30);
      }

      // 对话时自动学习
      if (l.auto) {
        const a = l.auto;
        current.learning.auto = current.learning.auto || {};
        if (typeof a.enabled === 'boolean') current.learning.auto.enabled = a.enabled;
        if (Number.isFinite(a.everyNTurns)) {
          current.learning.auto.everyNTurns = clamp(a.everyNTurns, 1, 500);
        }
        if (Number.isFinite(a.minIntervalMinutes)) {
          current.learning.auto.minIntervalMinutes = clamp(a.minIntervalMinutes, 1, 1440);
        }
        if (Number.isFinite(a.maxPerDay)) {
          current.learning.auto.maxPerDay = clamp(a.maxPerDay, 1, 100);
        }
        if (a.mode === 'words' || a.mode === 'media') current.learning.auto.mode = a.mode;
        if (Number.isFinite(a.maxPerRun)) {
          current.learning.auto.maxPerRun = clamp(a.maxPerRun, 1, 50);
        }
      }

      // 学到的词自动整理进词库
      if (l.autoMerge) {
        const m = l.autoMerge;
        current.learning.autoMerge = current.learning.autoMerge || {};
        if (typeof m.enabled === 'boolean') current.learning.autoMerge.enabled = m.enabled;
        if (m.bank) {
          const bank = String(m.bank).trim();
          if (/^[\w-]{1,40}$/.test(bank)) current.learning.autoMerge.bank = bank;
        }
      }
    }

    // 微信桥接相关（表情包概率、是否收藏图片、收藏白名单）
    if (patch.wechat) {
      const w = patch.wechat;
      current.wechat = current.wechat || {};
      if (Number.isFinite(w.stickerChance)) {
        current.wechat.stickerChance = clamp(w.stickerChance, 0, 1);
      }
      if (Number.isFinite(w.voiceChance)) {
        current.wechat.voiceChance = clamp(w.voiceChance, 0, 1);
      }
      if (typeof w.mediaCollect === 'boolean') current.wechat.mediaCollect = w.mediaCollect;

      /**
       * 收藏白名单。
       *
       * 支持两种写法，前端给哪个都能用：
       *   collectOnlyFrom: ['wxid_a', ...]   —— 直接给名单
       *   collectScope: 'all' | 'custom'     —— all 视为清空名单
       */
      if (Array.isArray(w.collectOnlyFrom)) {
        current.wechat.collectOnlyFrom = w.collectOnlyFrom
          .map((s) => String(s).trim())
          .filter(Boolean)
          .slice(0, 100);
      }
      if (w.collectScope === 'all') {
        current.wechat.collectOnlyFrom = [];
      }

      // 这些设置只存在核心：适配器通过 GET /api/media/policy 读取。
      // 不再往 bridge/config.json 写 —— 那是独立仓库，格式该由它自己决定。
    }

    // 画图
    if (patch.imagegen) {
      const g = patch.imagegen;
      current.imagegen = current.imagegen || {};

      if (typeof g.enabled === 'boolean') current.imagegen.enabled = g.enabled;
      if (g.baseUrl) current.imagegen.baseUrl = String(g.baseUrl).trim();
      if (g.model) current.imagegen.model = String(g.model).trim();
      if (g.size) current.imagegen.size = String(g.size).trim();
      if (Number.isFinite(g.maxPerCall)) current.imagegen.maxPerCall = clamp(g.maxPerCall, 1, 4);

      // key：空值视为「不修改」，只有 clearApiKey 才真的删
      applyKey(current.imagegen, g, g.clearApiKey, 'imagegen');

      // 主动画图
      if (g.proactive) {
        const p = g.proactive;
        current.imagegen.proactive = current.imagegen.proactive || {};
        if (typeof p.enabled === 'boolean') current.imagegen.proactive.enabled = p.enabled;
        if (Number.isFinite(p.chance)) current.imagegen.proactive.chance = clamp(p.chance, 0, 1);
        if (Number.isFinite(p.minIntervalMinutes)) {
          current.imagegen.proactive.minIntervalMinutes = clamp(p.minIntervalMinutes, 5, 1440);
        }
        if (Number.isFinite(p.maxPerDay)) {
          current.imagegen.proactive.maxPerDay = clamp(p.maxPerDay, 1, 20);
        }
      }
    }

    // 主动搭话
    if (patch.care) {
      const c = patch.care;
      current.care = current.care || {};
      if (typeof c.enabled === 'boolean') current.care.enabled = c.enabled;
      if (Number.isFinite(c.minIntervalMinutes)) current.care.minIntervalMinutes = clamp(c.minIntervalMinutes, 15, 1440);
      if (Number.isFinite(c.maxPerDay)) current.care.maxPerDay = clamp(c.maxPerDay, 1, 20);
      if (Number.isFinite(c.idleMinutes)) current.care.idleMinutes = clamp(c.idleMinutes, 5, 1440);
      // 搭话对象：空数组表示「所有会话」，非空表示只发这些
      if (Array.isArray(c.targets)) {
        current.care.targets = c.targets.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20);
      }
      if (c.quietHours) {
        const qs = Number(c.quietHours.start);
        const qe = Number(c.quietHours.end);
        current.care.quietHours = {
          start: Number.isFinite(qs) ? clamp(qs, 0, 23) : current.care.quietHours?.start ?? 23,
          end: Number.isFinite(qe) ? clamp(qe, 0, 23) : current.care.quietHours?.end ?? 9,
        };
      }
    }

    // B站分享
    if (patch.share) {
      const s = patch.share;
      current.share = current.share || {};
      if (typeof s.enabled === 'boolean') current.share.enabled = s.enabled;
      if (Number.isFinite(s.intervalHours)) current.share.intervalHours = clamp(s.intervalHours, 1, 24);
      if (Array.isArray(s.keywords)) current.share.keywords = s.keywords.map(String).filter(Boolean).slice(0, 10);
      // 分享对象
      if (Array.isArray(s.targets)) {
        current.share.targets = s.targets.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 20);
      }
      // 分享来源：允许用户自己填站点和分类
      if (s.source) {
        const src = s.source;
        current.share.source = current.share.source || {};
        if (typeof src.type === 'string') {
          const allowed = ['bilibili', 'custom'];
          current.share.source.type = allowed.includes(src.type) ? src.type : 'bilibili';
        }
        if (typeof src.url === 'string') {
          // 只允许 http(s)，防止填成 file:// 之类
          const u = src.url.trim();
          current.share.source.url = /^https?:\/\//i.test(u) ? u.slice(0, 300) : '';
        }
        if (Array.isArray(src.categories)) {
          current.share.source.categories = src.categories.map(String).filter(Boolean).slice(0, 10);
        }
      }
    }

    /**
     * 后台运行：关掉网页就停服务。
     *
     * 旁边那个 keepAlive 是应急开关 —— 万一开了收不了场，
     * 勾上它（或直接建 data/keep-alive 空文件）就立刻失效，
     * 不用改配置也能把服务留住。
     */
    if (patch.server) {
      const s = patch.server;
      current.server = current.server || {};

      if (typeof s.stopWhenNoConsole === 'boolean') {
        current.server.stopWhenNoConsole = s.stopWhenNoConsole;
      }
      if (typeof s.keepAlive === 'boolean') {
        const flag = path.join(this.root, 'data', 'keep-alive');
        try {
          if (s.keepAlive) {
            fs.mkdirSync(path.dirname(flag), { recursive: true });
            fs.writeFileSync(flag, '存在这个文件时，「关网页即停服务」一律不生效\n', 'utf8');
          } else if (fs.existsSync(flag)) {
            fs.unlinkSync(flag);
          }
        } catch (e) {
          this.log.warn?.(`[admin] keep-alive 标记写入失败: ${e.message}`);
        }
      }

      // 同步内存，热生效（在线检测每次都会读 this.config）
      this.config.server = { ...(this.config.server || {}), ...current.server };
    }

    if (patch.channels) {
      // 通道开关需要重启才生效，这里只记录
      for (const name of ['web', 'wechat-group']) {
        if (typeof patch.channels[name]?.enabled === 'boolean') {
          current.channels[name].enabled = patch.channels[name].enabled;
        }
      }
    }

    // 写之前先备份：万一 Key 被误清空，还能从 config.json.bak 找回
    backupConfig(file);

    // 显式删除的 Key 才允许被清空，其他情况由 writeConfig 的守卫兜住
    if (clearKeys.length) current.__clearKeys = clearKeys;

    writeConfig(file, current, 'config', this.log);

    // 同步更新内存中的配置，让控制台立即看到新值
    // （部分配置如通道开关仍需重启才真正生效）
    Object.assign(this.config.llm, current.llm);
    Object.assign(this.config.vision, current.vision);
    Object.assign(this.config.voice, current.voice);
    Object.assign(this.config.search, current.search);
    Object.assign(this.config.share, current.share);
    // care 可能原本不存在，要整体替换（不能 Object.assign 到 undefined）
    this.config.care = { ...(this.config.care || {}), ...(current.care || {}) };
    this.config.learning = { ...(this.config.learning || {}), ...(current.learning || {}) };
    // 逻辑库：autoLearn 是嵌套对象，要深合并一层，否则改了一半会丢
    this.config.logic = {
      ...(this.config.logic || {}),
      ...(current.logic || {}),
      autoLearn: {
        ...(this.config.logic?.autoLearn || {}),
        ...(current.logic?.autoLearn || {}),
      },
    };
    this.config.wechat = { ...(this.config.wechat || {}), ...(current.wechat || {}) };

    // 画图：客户端持有自己的 cfg 副本，要重建才认新 Key/模型
    this.config.imagegen = {
      ...(this.config.imagegen || {}),
      ...(current.imagegen || {}),
      proactive: {
        ...(this.config.imagegen?.proactive || {}),
        ...(current.imagegen?.proactive || {}),
      },
    };

    // 任何 Key / 地址 / 模型改动都要重建客户端，否则改了不生效
    const touchedApi =
      patch.llm || patch.vision || patch.voice || patch.search || patch.imagegen;

    if (touchedApi && this.engine?.reloadClients) {
      try {
        this.engine.reloadClients();
      } catch (e) {
        this.log.warn?.(`[admin] 重建客户端失败: ${e.message}`);
      }
    }

    Object.assign(this.config.reply, current.reply);
    Object.assign(this.config.group, current.group);
    for (const name of Object.keys(current.channels || {})) {
      if (this.config.channels[name]) {
        Object.assign(this.config.channels[name], current.channels[name]);
      }
    }
    if (current.card !== undefined) this.config.card = current.card;

    return {
      ok: true,
      saved: true,
      // API 类改动已即时重建客户端；只有通道开关这类才真的要重启
      needsRestart: Boolean(patch.channels),
      message: touchedApi
        ? '已保存，立即生效'
        : patch.channels
          ? '已保存，通道开关需重启服务'
          : '已保存',
    };
  }

  /** 读取日志尾部。 */
  #logs(lines = 120) {
    const logFile = path.join(this.root, 'data', 'app.out.log');
    const errFile = path.join(this.root, 'data', 'app.err.log');

    const readTail = (file) => {
      try {
        if (!fs.existsSync(file)) return '';
        const content = fs.readFileSync(file, 'utf8');
        const all = content.split('\n');
        return all.slice(-lines).join('\n');
      } catch {
        return '';
      }
    };

    return {
      ok: true,
      out: readTail(logFile),
      err: readTail(errFile),
    };
  }

  /** 读取单张卡片完整内容。 */
  #readCard(id) {
    if (!id || !/^[\w\u4e00-\u9fa5-]{1,40}$/.test(id)) {
      throw new Error('卡片 id 不合法');
    }

    const dir = path.join(this.root, 'cards');
    for (const ext of ['.json', '.md']) {
      const file = path.join(dir, id + ext);
      if (!fs.existsSync(file)) continue;

      const raw = fs.readFileSync(file, 'utf8');

      // JSON 卡片
      if (ext === '.json') {
        const j = JSON.parse(raw);
        const data = j?.spec?.includes('chara_card') && j.data ? j.data : j;
        return {
          ok: true,
          id,
          format: 'json',
          data: {
            name: data.name || '',
            speaker: data.speaker || '',
            description: data.description || '',
            personality: data.personality || '',
            scenario: data.scenario || '',
            first_mes: data.first_mes || data.firstMessage || '',
            mes_example: data.mes_example || '',
            system_prompt: data.system_prompt || '',
          },
        };
      }

      // Markdown 卡片：解析 front-matter
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
      const meta = {};
      if (m) {
        for (const line of m[1].split(/\r?\n/)) {
          const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
          if (kv) meta[kv[1]] = kv[2].trim();
        }
      }
      return {
        ok: true,
        id,
        format: 'md',
        data: {
          name: meta.name || id,
          speaker: meta.speaker || '',
          description: m ? m[2].trim() : raw.trim(),
          personality: meta.personality || '',
          scenario: meta.scenario || '',
          first_mes: meta.first_message || '',
          mes_example: '',
          system_prompt: '',
        },
      };
    }

    throw new Error(`找不到卡片「${id}」`);
  }

  /** 保存卡片（新建或覆盖）。 */
  #saveCard(body) {
    const data = body?.data;
    const id = String(body?.id || '').trim();

    if (!data) throw new Error('缺少卡片内容');
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) {
      throw new Error('id 只能用英文、数字、下划线、短横线（1-40 位）');
    }
    if (!data.name || !String(data.name).trim()) {
      throw new Error('角色名不能为空');
    }

    // 统一存成 Character Card V2 格式
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: String(data.name).trim(),
        speaker: String(data.speaker || '').trim(),
        description: String(data.description || ''),
        personality: String(data.personality || ''),
        scenario: String(data.scenario || ''),
        first_mes: String(data.first_mes || ''),
        mes_example: String(data.mes_example || ''),
        system_prompt: String(data.system_prompt || ''),
        creator_notes: '',
        tags: [],
      },
    };

    const dir = path.join(this.root, 'cards');
    fs.mkdirSync(dir, { recursive: true });

    // 如果已有同名 md 卡片，删掉避免冲突
    const mdFile = path.join(dir, id + '.md');
    if (fs.existsSync(mdFile)) fs.unlinkSync(mdFile);

    const file = path.join(dir, id + '.json');
    const isNew = !fs.existsSync(file);
    fs.writeFileSync(file, JSON.stringify(card, null, 2), 'utf8');

    return {
      ok: true,
      id,
      isNew,
      message: isNew ? `已创建角色「${card.data.name}」` : `已更新角色「${card.data.name}」`,
      needsRestart: this.config.card === id,
    };
  }

  /** 删除卡片。 */
  #deleteCard(body) {
    const id = String(body?.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw new Error('id 不合法');

    const dir = path.join(this.root, 'cards');
    let deleted = false;
    for (const ext of ['.json', '.md']) {
      const file = path.join(dir, id + ext);
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        deleted = true;
      }
    }

    if (!deleted) throw new Error(`找不到卡片「${id}」`);
    if (this.config.card === id) {
      throw new Error('不能删除当前正在使用的角色，请先切换到其他角色');
    }

    return { ok: true, message: `已删除「${id}」` };
  }

  /** 切换角色。 */
  #switchCard(body) {
    const id = body?.id;
    if (!id) throw new Error('缺少卡片 id');

    const cards = listCards(this.root);
    if (!cards.some((c) => c.id === id)) {
      throw new Error(`找不到角色「${id}」`);
    }

    const file = path.join(this.root, 'config.json');
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    current.card = id;
    writeConfig(file, current, 'card/switch', this.log);

    // 同步内存
    this.config.card = id;

    /**
     * 热加载人设 —— 以前这里只写配置、要求重启。
     *
     * 用户点了「切换」却什么都没变，还得关掉黑窗口重开，体感很差。
     * 人设只是一个纯数据对象，引擎每轮都从 this.engine.persona 读，
     * 直接换掉就行，不需要重启。
     */
    let hot = false;
    try {
      const who = loadAnyPersona({
        root: this.root,
        personaFile: current.personaFile,
        card: id,
      });

      if (who && this.engine) {
        this.engine.persona = who;
        this.config.__personaName = who.name || id;
        // 数据也按卡隔离：换卡后重新指向新卡的知识库/逻辑库/记忆
        this.engine.reloadScopedStores();
        hot = true;
      }
    } catch (e) {
      this.log.warn?.(`[card] 热加载人设失败（重启后仍会生效）：${e.message}`);
    }

    return {
      ok: true,
      card: id,
      name: cards.find((c) => c.id === id)?.name || id,
      needsRestart: !hot,
      message: hot
        ? `已切换到「${cards.find((c) => c.id === id)?.name || id}」，立即生效`
        : `已切换到「${id}」，重启后生效`,
    };
  }

  /** 连通性测试。 */
  async #test(body) {
    const target = body?.target || 'llm';

    if (target === 'llm') {
      const t0 = Date.now();
      try {
        let out = '';
        for await (const chunk of this.engine.llm.stream([
          { role: 'user', content: '回复两个字：正常' },
        ], { maxTokens: 20 })) {
          out += chunk;
          if (out.length > 50) break;
        }
        return { ok: true, target, ms: Date.now() - t0, reply: out.trim().slice(0, 50) };
      } catch (e) {
        return { ok: false, target, error: e.message };
      }
    }

    if (target === 'vision') {
      if (!this.engine.vision.enabled) return { ok: false, target, error: '未启用' };
      return { ok: true, target, message: '已配置（实际识别需要发一张图测试）' };
    }

    if (target === 'voice') {
      if (!this.engine.voice.enabled) return { ok: false, target, error: '未启用' };
      return { ok: true, target, message: '已配置（实际识别需要发一段语音测试）' };
    }

    if (target === 'search') {
      if (!this.engine.search.enabled) return { ok: false, target, error: '未启用' };
      try {
        const t0 = Date.now();
        const results = await this.engine.search.search('今天天气');
        return { ok: true, target, ms: Date.now() - t0, count: results.length };
      } catch (e) {
        return { ok: false, target, error: e.message };
      }
    }

    throw new Error(`未知测试目标: ${target}`);
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Number(n)));
}

function sanitizeEmoji(e) {
  const out = {};
  if (typeof e.enabled === 'boolean') out.enabled = e.enabled;
  if (Number.isFinite(e.chance)) out.chance = clamp(e.chance, 0, 1);
  if (typeof e.kaomoji === 'boolean') out.kaomoji = e.kaomoji;
  return out;
}

function formatUptime(sec) {
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h} 小时 ${rm} 分钟`;
}
