/**
 * 工具层：让助手能真正干活，但限制在沙箱内。
 *
 * 设计原则（安全优先）：
 *   1. 所有文件操作必须落在 sandbox 目录内，路径穿越一律拒绝
 *   2. 命令执行用白名单，不是黑名单
 *   3. 有超时、有输出上限
 *   4. 每个操作都记日志，可追溯
 *
 * 这不是「全能 agent」——是有边界的助手。
 */
import fs from 'node:fs';
import { generatedDir, scopeName } from './scoped-paths.mjs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** 命令白名单：只允许这些程序 */
const ALLOWED_COMMANDS = new Set([
  'ffmpeg', 'ffprobe',  // 音视频处理
  'python', 'python3', 'py',  // 脚本
  'node',               // 本项目的 node
  'dir', 'ls',          // 列目录
  'type', 'cat',        // 看文件
]);

/** 危险参数模式：即使命令在白名单，这些参数也拒绝 */
const DANGEROUS_ARGS = [
  /[;&|`$]/,        // shell 注入
  /\.\.\//,         // 路径穿越
  /^-rf?,?\s*\//,   // rm -rf /
  /format\s+[a-z]:/i, // 格式化磁盘
  /del\s+\/[sq]/i,
  /rd\s+\/s/i,
  /shutdown/i,
  /reg\s+delete/i,
];

export class ToolKit {
  /**
   * @param {object} opts
   * @param {string} opts.sandbox 沙箱根目录
   * @param {object} [opts.logger]
   * @param {number} [opts.maxFileSize] 单文件读取上限
   * @param {number} [opts.cmdTimeout] 命令超时（毫秒）
   */
  constructor(opts) {
    /** 核心配置（读 tools.off 白名单用） */
    this.config = opts.config || {};
    this.sandbox = path.resolve(opts.sandbox);
    this.log = opts.logger || console;
    this.maxFileSize = opts.maxFileSize || 512 * 1024;
    this.cmdTimeout = opts.cmdTimeout || 30000;
    this.maxOutput = opts.maxOutput || 8000;

    /** 插件宿主（可选，由外部注入）——插件提供的工具从这里来 */
    this.plugins = opts.plugins || null;

    /** 逻辑库（查以往经验）与联网学习器，可选 */
    this.logic = opts.logic || null;
    this.learner = opts.learner || null;

    /** DSH 客户端（可选，由外部注入） */
    this.dsh = opts.dsh || null;
    this.dshEnabled = Boolean(opts.dsh);
    /** DSH 单次超时 */
    this.dshTimeout = opts.dshTimeout || 180000;
    /** DSH 工作目录（可以和沙箱不同） */
    this.dshCwd = opts.dshCwd || this.sandbox;

    /**
     * DSH 那边要复用的会话 id。
     * 存起来下次 session/resume，DSH 就能记住之前几轮聊了什么。
     */
    this.dshSessionId = opts.dshSessionId || '';

    // 从磁盘捡回上次的 DSH 会话号（重启后 DSH 也能接着聊）
    if (!this.dshSessionId) {
      try {
        const f = path.join(this.sandbox, '..', 'data', 'dsh-session.json');
        if (fs.existsSync(f)) {
          const j = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (j?.sessionId) {
            this.dshSessionId = String(j.sessionId);
            this.log?.info?.(`[tool] 恢复 DSH 会话 ${this.dshSessionId.slice(0, 8)}…`);
          }
        }
      } catch {}
    }

    /** 绘图客户端（可选，由外部注入） */
    this.imagegen = opts.imagegen || null;

    fs.mkdirSync(this.sandbox, { recursive: true });
  }

  /**
   * 把相对路径解析成沙箱内的绝对路径，越界则抛错。
   * @param {string} rel
   * @returns {string}
   */
  resolveSafe(rel) {
    const cleaned = String(rel || '').replace(/^[/\\]+/, '');
    const abs = path.resolve(this.sandbox, cleaned);

    // 必须在沙箱内
    const relative = path.relative(this.sandbox, abs);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('路径越界：只能操作工作目录内的文件');
    }

    return abs;
  }

  /**
   * 全部工具定义（包括被关掉的）。
   *
   * 控制台的「工具」页要用它：关掉的工具也得列出来，否则一关就从列表里消失，
   * 想再打开都找不到。
   */
  allDefinitions() {
    const saved = this.config?.tools?.off;
    this.config.tools = { ...(this.config.tools || {}), off: [] };
    try {
      return this.definitions();
    } finally {
      this.config.tools = { ...(this.config.tools || {}), off: saved };
    }
  }

  /**
   * 素材目录（按角色卡解析）。
   *
   * 「她画的图」跟卡走，表情包和收到的图共享 ——
   * 和 admin 里 #mediaDirs 用的是同一套规则，别两边不一致。
   */
  #mediaDir(kind) {
    const root = this.config?.root || path.join(this.sandbox, '..');
    const card = scopeName(this.config?.card || 'default');
    if (kind === 'generated') return generatedDir(root, card);
    return path.join(root, 'data', kind);
  }

  /** 工具定义（给模型看的）。 */
  definitions() {
    const defs = [
      {
        type: 'function',
        function: {
          name: 'list_files',
          description: '列出工作目录下的文件和文件夹',
          parameters: {
            type: 'object',
            properties: {
              dir: { type: 'string', description: '相对路径，留空表示根目录' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: '读取工作目录里的文本文件内容',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件相对路径' },
            },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: '在工作目录里创建或覆盖文件',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件相对路径' },
              content: { type: 'string', description: '文件内容' },
            },
            required: ['path', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'run_command',
          description: `执行命令。只允许：${[...ALLOWED_COMMANDS].join('、')}`,
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: '命令名' },
              args: {
                type: 'array',
                items: { type: 'string' },
                description: '参数列表',
              },
            },
            required: ['command'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'search_web',
          description: '联网搜索实时信息（新闻、天气、股价等）',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '搜索关键词' },
            },
            required: ['query'],
          },
        },
      },
    ];

    // DSH 工具（需要运行环境就绪才提供）
    if (this.dshEnabled) {
      defs.push({
        type: 'function',
        function: {
          name: 'ask_dsh',
          description:
            '调用 DSH（DeepSeek Harness）处理复杂任务。' +
            'DSH 是运行在本机的 AI 编程智能体，能读写文件、跑命令、调试代码。' +
            '适合：写代码、改文件、分析数据、排查问题。' +
            '注意：DSH 运行在另一个目录，不共享你的工作目录。',
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: '要交给 DSH 的完整任务描述，说清楚目标和期望结果',
              },
            },
            required: ['question'],
          },
        },
      });
    }

    // 收藏图片（需要主人权限，由 engine 统一拦截）
    defs.push({
      type: 'function',
      function: {
        name: 'save_sticker',
        description:
          '把图片收藏成表情包，或把素材库里的图转存到另一个库。\n' +
          '常见用法：对方发来一张图（系统会告诉你文件名 img_xxx.jpg），' +
          '对方说「收藏这张」「做成表情包」时，用那个文件名调用本工具。',
        parameters: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description:
                '图片来源：素材库里的文件名（如 img_ab12cd34.jpg）/ http(s) 链接 / base64',
            },
            kind: {
              type: 'string',
              enum: ['stickers', 'images'],
              description: '目标库：stickers=表情包（默认），images=普通图片',
            },
          },
          required: ['source'],
        },
      },
    });

    // 查看素材库（她需要知道有哪些图可以发）
    defs.push({
      type: 'function',
      function: {
        name: 'list_stickers',
        description: '查看素材库里有哪些表情包/图片，用于挑一个发给对方。',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['stickers', 'images'],
              description: '看哪个库，默认 stickers',
            },
          },
        },
      },
    });

    // 逻辑库：查以往的处理经验 / 从网页学新经验
    defs.push({
      type: 'function',
      function: {
        name: 'recall_logic',
        description:
          '查「以往遇到类似情况是怎么处理的」。碰到拿不准怎么回、或者之前学过相关做法时用。' +
          '查到的只是参考经验，不一定适用，自己判断要不要照着做。',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: '想问哪方面，比如「对方生气」「讨价还价」' },
          },
          required: ['topic'],
        },
      },
    });

    defs.push({
      type: 'function',
      function: {
        name: 'learn_from_web',
        description:
          '从一个网址学「遇到某类情况该怎么做」，提炼成经验存进逻辑库。' +
          '只有主人能用；联网学习总开关关着时会直接失败。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要学的网页地址（http/https）' },
            topic: { type: 'string', description: '想学哪方面，可选' },
          },
          required: ['url'],
        },
      },
    });

    // 画图（需要绘图 API，由外部注入）
    if (this.imagegen) {
      defs.push({
        type: 'function',
        function: {
          name: 'draw_image',
          description:
            '画一张**新**的图并发给对方。对方说「画一个」「帮我画」「生成一张图」时用。\n' +
            '⚠ 如果对方要的是「刚才那张」「之前画的」，不要重画，用 send_image 发已有的。',
          parameters: {
            type: 'object',
            properties: {
              prompt: {
                type: 'string',
                description: '画面描述，越具体越好。比如「一只蓝色胖鲸鱼，卡通风格，白底」',
              },
              size: {
                type: 'string',
                description: '尺寸，默认 1024x1024',
              },
            },
            required: ['prompt'],
          },
        },
      });
    }

    // 发已有的图（不重画）
    defs.push({
      type: 'function',
      function: {
        name: 'send_image',
        description:
          '把素材库里**已有**的图发给对方（不重新画）。\n' +
          '对方说「刚才那张发我」「之前画的再发一遍」「把那张表情包发出来」时用。\n' +
          '不知道文件名时，先调 list_stickers(kind="generated") 看看有哪些。',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: '文件名，比如 gen_abc123.jpg。不填则发最新的一张。',
            },
            kind: {
              type: 'string',
              enum: ['generated', 'stickers', 'images'],
              description: '从哪个库发，默认 generated（她画的图）',
            },
          },
        },
      },
    });

    // 插件提供的工具（别人给她加的功能）
    if (this.plugins) {
      try {
        defs.push(...this.plugins.definitions());
      } catch (e) {
        this.log.warn?.(`[tool] 插件工具加载失败: ${e.message}`);
      }
    }

    // 白名单：只把开着的工具给模型（关掉的既不发定义，也不让调）
    const off = this.disabledTools();
    if (!off.size) return defs;
    return defs.filter((d) => !off.has(d.function?.name));
  }

  /**
   * 被关掉的工具集合。
   *
   * 配置长这样（默认空 = 全开）：
   *   "tools": { "off": ["run_command", "ask_dsh"] }
   *
   * 用「关掉哪些」而不是「只开哪些」，是为了以后新增工具默认可用，
   * 不用回来改白名单。
   */
  disabledTools() {
    const list = this.config?.tools?.off;
    if (!Array.isArray(list)) return new Set();
    return new Set(list.map((x) => String(x)));
  }

  /** 这个工具是不是被关了 */
  isToolOff(name) {
    return this.disabledTools().has(String(name));
  }

  /**
   * 执行工具。
   * @param {string} name
   * @param {object} args
   * @param {object} [ctx] 额外上下文（如搜索客户端）
   * @returns {Promise<string>} 结果文本
   */
  async run(name, args, ctx = {}) {
    try {
      // 关掉的工具即使被硬调也不执行（模型偶尔会照着历史记录瞎调）
      if (this.isToolOff(name)) {
        this.log.info?.(`[tool] ${name} 已被关闭，拒绝执行`);
        return `（${name} 这个功能被主人关掉了）`;
      }

      switch (name) {
        case 'list_files':
          return this.listFiles(args.dir || '');
        case 'read_file':
          return this.readFile(args.path);
        case 'write_file':
          return this.writeFile(args.path, args.content);
        case 'run_command':
          return await this.runCommand(args.command, args.args || []);
        case 'search_web':
          if (!ctx.search) return '（搜索功能未启用）';
          {
            const results = await ctx.search.search(args.query);
            if (!results.length) return '（没有搜到结果）';
            return results
              .slice(0, 5)
              .map((r, i) => `${i + 1}. ${r.title}\n   ${(r.snippet || '').slice(0, 150)}`)
              .join('\n');
          }
        case 'save_sticker':
          return await this.#saveSticker(args);
        case 'list_stickers':
          return this.#listStickers(args);
        case 'draw_image':
          return await this.#drawImage(args);
        case 'send_image':
          return this.#sendImage(args);
        case 'recall_logic': {
          if (!this.logic) return '（逻辑库未启用）';
          const topic = String(args.topic || '').trim();
          if (!topic) return '（要查什么？）';
          const hits = await this.logic.search(topic);
          if (!hits.length) return `（没有关于「${topic}」的经验记录）`;
          return hits.map((h, i) => `${i + 1}. ${h.title}：${h.rule}`).join('\n');
        }
        case 'learn_from_web': {
          if (!this.learner) return '（联网学习未启用）';
          const url = String(args.url || '').trim();
          if (!url) return '（要学哪个网址？）';
          const r = await this.learner.learnFromUrl(url, {
            topic: String(args.topic || '').trim(),
            mode: this.config?.logic?.autoLearn?.mode === 'pending' ? 'pending' : 'active',
          });
          if (!r.ok) return `（学习失败：${r.error}）`;
          if (!r.added?.length) return '（这个页面没提炼出可用的经验）';
          return (
            `学到 ${r.added.length} 条：\n` + r.added.map((x) => `· ${x.title}：${x.rule}`).join('\n')
          );
        }
        case 'ask_dsh':
          if (!this.dsh) return '（DSH 调用未启用）';
          {
            const q = String(args.question || '').trim();
            if (!q) return '（问题为空）';

            this.log.info?.(`[tool] 调用 DSH: ${q.slice(0, 60)}`);

            const t0 = Date.now();
            // DSH 处理复杂任务可能要 1-2 分钟，期间给个进度提示
            const hint = setTimeout(() => {
              this.log.info?.('[tool] DSH 仍在处理（超过 30 秒）…');
            }, 30000);
            hint.unref?.();

            try {
              // 带上上次的 sessionId：DSH 那边就能接着之前的上下文，
              // 而不是每次从失忆状态重新开始
              const res = await this.dsh.ask(q, {
                cwd: this.dshCwd,
                sessionId: this.dshSessionId || '',
                wantSessionId: true,
              });

              const answer = typeof res === 'string' ? res : res.text;
              if (res && res.sessionId) {
                this.dshSessionId = res.sessionId;
                // 落盘：服务重启后还能接着用同一个 DSH 会话
                try {
                  const f = path.join(this.sandbox, '..', 'data', 'dsh-session.json');
                  fs.mkdirSync(path.dirname(f), { recursive: true });
                  fs.writeFileSync(
                    f,
                    JSON.stringify({ sessionId: this.dshSessionId, at: Date.now() }, null, 2),
                    'utf8',
                  );
                } catch (e) {
                  this.log.warn?.(`[tool] DSH 会话号保存失败: ${e.message}`);
                }
              }

              const secs = ((Date.now() - t0) / 1000).toFixed(1);

              this.log.info?.(`[tool] DSH 返回 ${answer.length} 字（${secs}s）`);
              return `DSH 的回答（耗时 ${secs} 秒）：\n${answer.slice(0, this.maxOutput)}`;
            } finally {
              clearTimeout(hint);
            }
          }
        default:
          // 内置里没有 → 问插件（别人给她加的功能）
          if (this.plugins?.hasTool?.(name)) {
            return await this.plugins.runTool(name, args);
          }
          return `（未知工具：${name}）`;
      }    } catch (e) {
      this.log.warn?.(`[tool] ${name} 失败: ${e.message}`);
      return `（执行失败：${e.message}）`;
    }
  }

  /** 列出目录。 */
  listFiles(rel) {
    const dir = this.resolveSafe(rel);
    if (!fs.existsSync(dir)) return '（目录不存在）';

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.length === 0) return '（空目录）';

    const lines = entries.slice(0, 100).map((e) => {
      const stat = fs.statSync(path.join(dir, e.name));
      const size = e.isDirectory() ? '' : ` (${formatSize(stat.size)})`;
      return `${e.isDirectory() ? '[目录]' : '[文件]'} ${e.name}${size}`;
    });

    if (entries.length > 100) lines.push(`…还有 ${entries.length - 100} 项`);

    this.log.info?.(`[tool] 列出 ${rel || '.'}: ${entries.length} 项`);
    return lines.join('\n');
  }

  /** 读文件。 */
  readFile(rel) {
    const file = this.resolveSafe(rel);
    if (!fs.existsSync(file)) return `（文件不存在：${rel}）`;

    const stat = fs.statSync(file);
    if (stat.isDirectory()) return '（这是一个目录，不是文件）';
    if (stat.size > this.maxFileSize) {
      return `（文件太大：${formatSize(stat.size)}，上限 ${formatSize(this.maxFileSize)}）`;
    }

    // 只读文本
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return '（二进制文件，无法读取）';

    this.log.info?.(`[tool] 读取 ${rel}: ${formatSize(stat.size)}`);
    return buf.toString('utf8').slice(0, this.maxOutput);
  }

  /** 写文件。 */
  writeFile(rel, content) {
    const file = this.resolveSafe(rel);
    const text = String(content || '');

    if (text.length > this.maxFileSize) {
      return `（内容太大：${formatSize(text.length)}）`;
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');

    this.log.info?.(`[tool] 写入 ${rel}: ${formatSize(text.length)}`);
    return `（已写入 ${rel}，${formatSize(text.length)}）`;
  }

  /** 执行命令（白名单 + 参数检查）。 */
  async runCommand(cmd, args) {
    const raw = String(cmd || '');
    const name = path.basename(raw).toLowerCase().replace(/\.exe$/, '');

    if (!ALLOWED_COMMANDS.has(name)) {
      throw new Error(`命令「${name}」不在白名单内。允许的：${[...ALLOWED_COMMANDS].join('、')}`);
    }

    const argList = (args || []).map(String);
    for (const a of argList) {
      for (const re of DANGEROUS_ARGS) {
        if (re.test(a)) throw new Error(`参数含危险字符：${a}`);
      }
    }

    // node 用当前进程的可执行文件，避免 PATH 里找不到
    const exe = name === 'node' ? process.execPath : name;

    this.log.info?.(`[tool] 执行 ${name} ${argList.join(' ')}`);

    const { stdout, stderr } = await exec(exe, argList, {
      cwd: this.sandbox,
      timeout: this.cmdTimeout,
      maxBuffer: this.maxOutput * 4,
      windowsHide: true,
    });

    const out = (stdout || '').slice(0, this.maxOutput);
    const err = (stderr || '').slice(0, 2000);

    return [
      out && `输出：\n${out}`,
      err && `错误：\n${err}`,
    ]
      .filter(Boolean)
      .join('\n\n') || '（命令执行完成，无输出）';
  }

  /**
   * 收藏一张图片/表情包到素材库。
   */
  async #saveSticker(args = {}) {
    const src = String(args.source || '').trim();
    const kind = args.kind === 'images' ? 'images' : 'stickers';

    if (!src) return '（没有给图片来源）';

    const dataDir = path.join(this.sandbox, '..', 'data');
    const dir = path.join(dataDir, kind);
    fs.mkdirSync(dir, { recursive: true });

    let buf = null;

    try {
      // 1. base64
      if (/^data:image\//.test(src) || /^[A-Za-z0-9+/]{100,}={0,2}$/.test(src)) {
        const b64 = src.includes(',') ? src.slice(src.indexOf(',') + 1) : src;
        buf = Buffer.from(b64, 'base64');
      }
      // 2. http(s) 链接
      else if (/^https?:\/\//i.test(src)) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15000);
        timer.unref?.();

        const res = await fetch(src, {
          signal: ac.signal,
          headers: { 'user-agent': 'Mozilla/5.0' },
        });
        clearTimeout(timer);

        if (!res.ok) return `（下载失败：HTTP ${res.status}）`;
        buf = Buffer.from(await res.arrayBuffer());
      }
      // 3. 素材库里的文件名（收到的图在 images/，她画的在 generated/）
      else if (/^[\w.-]+\.(jpg|jpeg|png|gif|webp)$/i.test(src)) {
        const candidates = [
          path.join(this.#mediaDir('images'), src),
          path.join(this.#mediaDir('stickers'), src),
          path.join(this.#mediaDir('generated'), src),
          path.join(dataDir, 'tmp', src),
        ];
        const hit = candidates.find((p) => fs.existsSync(p));

        if (!hit) {
          return `（素材库里没找到 ${src}。可以先 list_stickers 看看有哪些）`;
        }
        buf = fs.readFileSync(hit);
      }
      // 4. 沙箱内文件
      else {
        const file = this.resolveSafe(src);
        if (!fs.existsSync(file)) return `（文件不存在：${src}）`;
        buf = fs.readFileSync(file);
      }
    } catch (e) {
      return `（读取失败：${e.message}）`;
    }

    if (!buf || buf.length < 256) return '（内容太小，不像图片）';
    if (buf.length > 8 * 1024 * 1024) return '（图片太大，上限 8MB）';

    // 判格式
    let ext = '';
    if (buf[0] === 0x89 && buf[1] === 0x50) ext = '.png';
    else if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
    else if (buf.slice(0, 3).toString() === 'GIF') ext = '.gif';
    else if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') ext = '.webp';

    if (!ext) return '（不认识的图片格式，只支持 png/jpg/gif/webp）';

    const crypto = await import('node:crypto');
    const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12);
    const name = `${kind === 'stickers' ? 'sticker' : 'img'}_ai_${hash}${ext}`;
    const full = path.join(dir, name);

    if (fs.existsSync(full)) {
      return `（这张图已经在素材库里了：${name}）`;
    }

    fs.writeFileSync(full, buf);
    this.log.info?.(`[tool] 收藏图片 ${name}（${(buf.length / 1024).toFixed(0)}KB）`);

    // 数一下现有数量
    let total = 0;
    try {
      total = fs.readdirSync(dir).filter((n) => /\.(jpg|jpeg|png|gif|webp)$/i.test(n)).length;
    } catch {}

    return `已收藏到${kind === 'stickers' ? '表情包' : '图片'}库：${name}（${(buf.length / 1024).toFixed(0)}KB）。现在共 ${total} 个。`;
  }

  /**
   * 列出素材库内容（她用来挑图发）。
   */
  /**
   * 发一张已有的图（不重画）。
   */
  #sendImage(args = {}) {
    const want = String(args.name || '').trim();

    // 给了具体文件名：在所有库里找，别只限 kind 指定的那个
    if (want) {
      const dirs = {
        generated: this.#mediaDir('generated'),
        stickers: this.#mediaDir('stickers'),
        images: this.#mediaDir('images'),
      };

      const IMG_RE = /\.(jpg|jpeg|png|gif|webp)$/i;
      const all = [];
      for (const [k, d] of Object.entries(dirs)) {
        try {
          if (!fs.existsSync(d)) continue;
          for (const n of fs.readdirSync(d)) {
            if (!IMG_RE.test(n)) continue;
            const full = path.join(d, n);
            const st = fs.statSync(full);
            if (st.size < 256) continue;
            all.push({ name: n, kind: k, full, size: st.size, mtime: st.mtimeMs });
          }
        } catch {}
      }

      // 精确 > 前缀 > 包含 > 哈希包含
      const hit =
        all.find((f) => f.name === want) ||
        all.find((f) => f.name.startsWith(want)) ||
        all.find((f) => f.name.includes(want)) ||
        all.find((f) => want.includes(f.name.replace(/\.[^.]+$/, '')));

      if (hit) {
        this.lastDrawn = [hit.name];
        this.log.info?.(`[tool] 发送已有图片 ${hit.kind}/${hit.name}`);
        return (
          `已把 ${hit.name}（${(hit.size / 1024).toFixed(0)}KB）发出去。\n` +
          `简单说一句就行，不用解释文件名。`
        );
      }

      // 没找到 → 告诉她有哪些，让她自己决定
      this.log.warn?.(`[tool] 找不到 ${want}`);
      const sample = all
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 8)
        .map((f) => f.name);
      return (
        `（素材库里没有「${want}」。` +
        (sample.length ? `现有的有：${sample.join('、')}` : '素材库是空的') +
        `。要新画就用 draw_image。）`
      );
    }

    // 没给名字：从指定库（默认 generated）挑最新的
    const kind = ['generated', 'stickers', 'images'].includes(args.kind) ? args.kind : 'generated';
    const dir = path.join(this.sandbox, '..', 'data', kind);

    if (!fs.existsSync(dir)) {
      return `（${kind} 素材库是空的）`;
    }

    const IMG_RE = /\.(jpg|jpeg|png|gif|webp)$/i;
    const files = fs
      .readdirSync(dir)
      .filter((n) => IMG_RE.test(n))
      .map((n) => ({
        name: n,
        mtime: fs.statSync(path.join(dir, n)).mtimeMs,
        size: fs.statSync(path.join(dir, n)).size,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (!files.length) {
      return `（${kind} 素材库里没有图片）`;
    }

    const picked = files[0];

    // 记下来，engine 会塞进回复的 images 字段
    this.lastDrawn = [picked.name];

    this.log.info?.(`[tool] 发送最新图片 ${kind}/${picked.name}`);

    return (
      `已把 ${picked.name}（${(picked.size / 1024).toFixed(0)}KB）发出去。\n` +
      `简单说一句就行，不用解释文件名。`
    );
  }

  /**
   * 画一张图。
   */
  async #drawImage(args = {}) {
    if (!this.imagegen) return '（绘图功能未启用）';

    const prompt = String(args.prompt || '').trim();
    if (!prompt) return '（没有描述要画什么）';

    try {
      const images = await this.imagegen.generate(prompt, { size: args.size });

      if (!images.length) return '（没画出来，换个描述试试）';

      // 记下来，engine 会把它们塞进回复的 images 字段，桥接据此发出去
      this.lastDrawn = images.map((i) => i.name);

      const lines = images.map((img) => {
        const kb = (img.size / 1024).toFixed(0);
        return `${img.name}（${kb}KB）`;
      });

      this.log.info?.(`[tool] 画图完成: ${lines.join(', ')}`);

      return (
        `画好了：${lines.join('、')}\n` +
        `已经自动准备发送给对方。你现在可以简单说一句「画好了」之类的话，不用解释文件名。`
      );
    } catch (e) {
      this.log.warn?.(`[tool] 画图失败: ${e.message}`);
      return `（画图失败：${e.message}）`;
    }
  }

  #listStickers(args = {}) {
    const kind = ['generated', 'stickers', 'images'].includes(args.kind) ? args.kind : 'stickers';
    const LABEL = { generated: '她画的图', stickers: '表情包', images: '图片' };
    const dir = path.join(this.sandbox, '..', 'data', kind);

    if (!fs.existsSync(dir)) {
      return `${LABEL[kind]}库还是空的。`;
    }

    const files = fs
      .readdirSync(dir)
      .filter((n) => /\.(jpg|jpeg|png|gif|webp)$/i.test(n))
      .map((n) => {
        const stat = fs.statSync(path.join(dir, n));
        return { name: n, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 20);

    if (!files.length) {
      return `${LABEL[kind]}库还是空的。`;
    }

    const lines = files.map(
      (f, i) => `${i + 1}. ${f.name}（${(f.size / 1024).toFixed(0)}KB）`,
    );

    return (
      `${LABEL[kind]}共 ${files.length} 个最近文件：\n${lines.join('\n')}\n\n` +
      `（要发某个就用 send_image 带文件名；不发就只回答，别报文件名）`
    );
  }
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
