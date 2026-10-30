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

    /**
     * 管理能力回调（仅主人工具用）。
     *
     * 之前没赋值，工具执行时 this.adminSaveConfig 是 undefined，
     * 于是「对话里改设置」报「adminSaveConfig 不是一个函数」。
     */
    this.adminSaveConfig = opts.adminSaveConfig || null;
    this.adminCleanMedia = opts.adminCleanMedia || null;

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
      /**
       * ===== 主人专用：远程管理 =====
       *
       * 这些工具会改真实设置/删真实文件，所以只对主人开放（run() 里二次校验）。
       * 限制成「白名单字段」，避免模型把任意配置改坏。
       */
      {
        type: 'function',
        function: {
          name: 'admin_config',
          description:
            '读取或修改控制台的设置（仅主人）。可改的字段有限：' +
            'voiceChance（发语音概率 0~1）、stickerChance（表情包概率 0~1）、' +
            'maxBubbles（每条回复最多几句 1~6）、maxChars（单条字数 50~2000）、' +
            'toolsEnabled（工具总开关 true/false）、careEnabled（主动搭话开关）。' +
            '不带 key 就是读取当前值。',
          parameters: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                enum: [
                  'voiceChance',
                  'stickerChance',
                  'maxBubbles',
                  'maxChars',
                  'toolsEnabled',
                  'careEnabled',
                  'all',
                ],
                description: '要改哪个；填 all 表示读全部',
              },
              value: { type: 'string', description: '新值（读取时不用填）' },
            },
            required: [],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'admin_media',
          description:
            '管理素材库（仅主人）：clean=清理不合格的图（太小的、网页抓来的），' +
            'dryRun=只预览不真清，stats=看库里有几张。清理只是挪到回收目录，不会直接删。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['stats', 'dryRun', 'clean'] },
              kind: { type: 'string', enum: ['stickers', 'images'], description: '默认 stickers' },
            },
            required: ['action'],
          },
        },
      },
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
      {
        type: 'function',
        function: {
          name: 'read_url',
          /**
           * 只给链接、不打开正文 = 「只能看外表」。
           *
           * 用户原话：「无法打开你给的 http 链接，依旧只能看外表不能读取内容」。
           * 以前没有这个工具，对方发链接过来她只能说「你发我看看」，看完也只有标题。
           * 现在能读正文（去脚本、去标签的纯文本）。
           */
          description:
            '打开一个网页链接，读它的正文内容。对方发来链接、或你想确认某个页面写了什么时用。' +
            '返回去掉网页标签后的正文，最多 4000 字。',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'http 或 https 链接' },
            },
            required: ['url'],
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
  /**
   * 这个操作要不要先问主人？
   *
   * @returns {string} 需要审批时返回一句理由；空字符串表示直接做
   */
  needsApproval(name, args = {}) {
    // 开关：tools.approval 默认开（关掉就回到「按档位直接执行」）
    if (this.config?.tools?.approval === false) return '';

    const NEED = {
      write_file: '要往磁盘写文件',
      run_command: '要执行命令',
      admin_config: '要改设置',
      admin_media: '要动素材库',
      save_sticker: '要把图存进素材库',
    };
    const reason = NEED[name];
    if (!reason) return '';

    // 读操作、空操作别烦人
    if (name === 'run_command') {
      const cmd = String(args.command || '').toLowerCase();
      const READONLY = ['ffprobe', 'ffmpeg -version', 'node -v', 'python -v'];
      if (READONLY.some((x) => cmd.includes(x))) return '';
    }

    return reason;
  }

  /** 当前权限档位：read-only / workspace / full */
  #permissionMode() {
    const raw = String(this.config?.tools?.permission || 'workspace').toLowerCase();
    if (raw === 'read-only' || raw === 'readonly' || raw === 'read') return 'read-only';
    if (raw === 'full' || raw === 'all') return 'full';
    return 'workspace';
  }

  /**
   * 检查这次调用是否被允许。
   *
   * @returns {string} 拒绝原因；空字符串表示放行
   */
  #checkPermission(name, args = {}) {
    const mode = this.#permissionMode();

    /** 只读工具：任何档位都放行 */
    const READ_ONLY = new Set([
      'list_files',
      'read_file',
      'search_web',
      'read_url',
      'list_stickers',
      'recall_logic',
    ]);

    if (READ_ONLY.has(name)) return '';

    /** 会产生副作用的（写文件、发消息、画图、执行命令） */
    const WRITE = new Set([
      'write_file',
      'run_command',
      'save_sticker',
      'send_image',
      'draw_image',
      'learn_from_web',
      'admin_config',
      'admin_media',
    ]);

    /** 只有 full 档才给的管理动作 */
    const ADMIN = new Set(['admin_config', 'admin_media']);

    if (mode === 'read-only' && WRITE.has(name)) {
      return `（现在是「只读」模式，不能${name}。要让主人把权限调高才行）`;
    }
    if (mode !== 'full' && ADMIN.has(name)) {
      return `（${name} 需要「完全」权限；现在是${mode}）`;
    }

    /**
     * 命令破坏性检查：档位允许也不等于什么都能跑。
     * 这些模式一旦出现，说明它想删东西/改系统，直接挡。
     */
    if (name === 'run_command') {
      const cmd = String(args.command || '');
      const joined = [cmd, ...(Array.isArray(args.args) ? args.args.map(String) : [])].join(' ');
      const DANGER = [
        /rmtree/i,
        // node / 通用删除（rmSync、unlink、rmdir）也算破坏性操作
        /rmSync|rmdirSync|unlinkSync|unlink|removeSync/i,
        /os\.remove/i,
        /shutil\.rmtree/i,
        /\brm\s+-rf?\b/i,
        /\bdel\s+\/[fqs]/i,
        /\brd\s+\/s/i,
        /format\s+[a-z]:/i,
        /shutdown|reboot|poweroff/i,
        />\s*\/dev\/sd/i,
      ];
      const hit = DANGER.find((re) => re.test(joined));
      if (hit) {
        return '（这条命令像在删东西或改系统，我不执行）';
      }
    }

    return '';
  }

  async run(name, args, ctx = {}) {
    try {
      // 关掉的工具即使被硬调也不执行（模型偶尔会照着历史记录瞎调）
      if (this.isToolOff(name)) {
        this.log.info?.(`[tool] ${name} 已被关闭，拒绝执行`);
        return `（${name} 这个功能被主人关掉了）`;
      }

      // 权限闸门：不满足当前档位就直接拒绝（返回给模型一句人话，它自己会圆）
      const deny = this.#checkPermission(name, args);
      if (deny) {
        this.log.info?.(`[tool] ${name} 被权限挡住（${this.#permissionMode()}）`);
        return deny;
      }

      /**
       * 审批闸门：档位允许，但这一个操作要不要人点头。
       *
       * 档位是「事先定死」的，真正危险的是「这一次」——
       * 她突然要写文件、跑命令。这里登记一条待审批，
       * 由通道去问主人；主人回「允许」才真的执行。
       */
      const need = this.needsApproval(name, args);
      if (need && ctx?.askApproval) {
        const req = await ctx.askApproval({ tool: name, args, reason: need });
        if (req && req.pending) {
          this.log.info?.(`[tool] ${name} 已挂起等主人批准（${req.id}）`);
          return `（${need}。我已经问主人了，等他回「允许」再做）`;
        }
        if (req && req.approved === true) {
          // 刚批准过，直接往下走
        } else if (req && req.approved === false) {
          return '（主人没同意，这次不做了）';
        }
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
        case 'read_url':
          return await this.#readUrl(args);
        case 'save_sticker':
          return await this.#saveSticker(args);
        case 'admin_config': {
          if (ctx?.isOwner === false) return '（这个只有主人能改）';
          return await this.#adminConfig(args);
        }
        case 'admin_media': {
          if (ctx?.isOwner === false) return '（这个只有主人能操作）';
          return await this.#adminMedia(args);
        }
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

  /**
   * 读/改控制台设置（仅主人）。
   *
   * 只开放少数几个字段：概率、气泡数、字数、两个总开关。
   * 别的配置（Key、主人名单、沙箱路径）不给改 —— 模型不该碰这些。
   */
  /**
   * 打开网页读正文。
   *
   * 为什么要有：以前她只能「看图」和「搜索」，对方甩一个链接过来，
   * 她只能回复「你发我看看」—— 因为根本没有抓网页的能力。
   * 这里抓下来、去掉脚本/样式/标签，给模型一段纯文本。
   *
   * 安全边界：
   *   · 只允许 http/https
   *   · 禁止本机地址（防止拿她当内网探针）
   *   · 限制 1.5MB、15 秒，防止一个页面把内存和上下文吃光
   */
  async #readUrl(args = {}) {
    const raw = String(args.url || '').trim();
    if (!raw) return '（要读哪个链接？）';

    let u;
    try {
      u = new URL(raw);
    } catch {
      return '（这个链接格式不对）';
    }
    if (!/^https?:$/.test(u.protocol)) return '（只支持 http/https 链接）';

    // 挡掉本机/内网地址：不要把机器人变成内网扫描器
    const host = u.hostname.toLowerCase();
    const isLocal =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);
    if (isLocal) return '（这个地址在本机/内网，我不去读）';

    let html = '';
    try {
      const r = await fetch(raw, {
        headers: {
          // 有些站点对没有 UA 的请求直接 403
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
      });
      if (!r.ok) return `（打不开：HTTP ${r.status}）`;

      const ctype = r.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml|text\/plain/i.test(ctype)) {
        return `（这个不是网页，是 ${ctype || '未知类型'}，读不了正文）`;
      }

      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 1.5 * 1024 * 1024) {
        return '（页面太大了，可能有 1.5MB 以上，读不了）';
      }
      html = buf.toString('utf8');
    } catch (e) {
      return `（打开失败：${e.message}）`;
    }

    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
    const text = this.#htmlToText(html);

    if (!text || text.length < 20) {
      return `（${title || '这个页面'} 里没读到正文，可能是要靠脚本加载的）`;
    }

    const body = text.slice(0, 4000);
    return (
      (title ? `【${title}】\n` : '') +
      body +
      (text.length > 4000 ? `\n…（后面还有 ${text.length - 4000} 字，没全读）` : '')
    );
  }

  /** 粗略去标签取正文（不引第三方库，够用就行） */
  #htmlToText(html) {
    let t = String(html || '');

    // 整段丢掉不产生正文的部分
    t = t
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      // 结尾可能写成 </style >（带空格），所以允许 \s*
      .replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');

    // 块级标签换行，避免整页挤成一行
    t = t.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer)[^>]*>/gi, '\n');
    t = t.replace(/<[^>]+>/g, ' ');

    // 实体
    t = t
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

    return t
      .replace(/[ \t\u00a0]+/g, ' ')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      /**
       * 有些页面（比如百度）的 <style> 没有闭合标签，
       * 上面按整块删删不掉，CSS 正文就混进了正文里。
       * 这里把「像 CSS 规则的行」丢掉：含属性名 + 花括号那段。
       */
      .filter((line) => !/\{[^{}]*:[^{}]*\}/.test(line) && !/^(html|body|\.|#|@media)[\s\S]{0,40}\{/.test(line))
      .join('\n')
      .trim();
  }

  async #adminConfig(args = {}) {
    const key = String(args.key || 'all');
    const raw = args.value;

    const c = this.config || {};
    const snapshot = () => ({
      voiceChance: c.wechat?.voiceChance ?? 0,
      stickerChance: c.wechat?.stickerChance ?? 0,
      maxBubbles: c.reply?.maxBubbles,
      maxChars: c.reply?.maxChars,
      toolsEnabled: c.tools?.enabled !== false,
      careEnabled: c.care?.enabled !== false,
    });

    if (!key || key === 'all' || raw === undefined || raw === null || String(raw).trim() === '') {
      const s = snapshot();
      return (
        `语音概率 ${Math.round(s.voiceChance * 100)}%，表情包概率 ${Math.round(s.stickerChance * 100)}%，` +
        `每条最多 ${s.maxBubbles} 句、${s.maxChars} 字，工具${s.toolsEnabled ? '开' : '关'}，` +
        `主动搭话${s.careEnabled ? '开' : '关'}`
      );
    }

    const value = String(raw).trim();
    const patch = {};

    if (key === 'voiceChance' || key === 'stickerChance') {
      // 既接受 0.2，也接受「20%」「20」
      let num = Number(value.replace('%', ''));
      if (!Number.isFinite(num)) return '（数值看不懂，给个 0~1 或百分数）';
      if (num > 1) num /= 100;
      num = Math.max(0, Math.min(1, num));
      patch.wechat = { [key]: num };
    } else if (key === 'maxBubbles') {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return '（要个 1~6 的整数）';
      patch.reply = { maxBubbles: Math.max(1, Math.min(6, n)) };
    } else if (key === 'maxChars') {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return '（要个 50~2000 的整数）';
      patch.reply = { maxChars: Math.max(50, Math.min(2000, n)) };
    } else if (key === 'toolsEnabled') {
      patch.tools = { enabled: !/^(false|0|off|关|不)$/i.test(value) };
    } else if (key === 'careEnabled') {
      patch.care = { enabled: !/^(false|0|off|关|不)$/i.test(value) };
    } else {
      return `（${key} 不给改，只能改：voiceChance / stickerChance / maxBubbles / maxChars / toolsEnabled / careEnabled）`;
    }

    try {
      const r = await this.adminSaveConfig(patch);
      if (r && r.ok === false) return `（没改成：${r.error || '未知原因'}）`;
    } catch (e) {
      return `（没改成：${e.message}）`;
    }

    const s = snapshot();
    return (
      `改好了。现在：语音 ${Math.round(s.voiceChance * 100)}%，表情包 ${Math.round(s.stickerChance * 100)}%，` +
      `每条最多 ${s.maxBubbles} 句、${s.maxChars} 字，工具${s.toolsEnabled ? '开' : '关'}，主动搭话${s.careEnabled ? '开' : '关'}`
    );
  }

  /** 素材库统计 / 清理（仅主人） */
  async #adminMedia(args = {}) {
    const action = String(args.action || 'stats');
    const kind = args.kind === 'images' ? 'images' : 'stickers';
    const dir = path.join(this.#mediaRoot(), 'data', kind);

    if (action === 'stats' || !this.adminCleanMedia) {
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((n) => /\.(jpe?g|png|gif|webp)$/i.test(n));
      } catch {}
      const gifs = files.filter((n) => /\.gif$/i.test(n)).length;
      return `素材库（${kind}）：${files.length} 张，其中动图 ${gifs} 张`;
    }

    try {
      const dry = action === 'dryRun';
      const r = await this.adminCleanMedia({ kind, dryRun: dry });
      if (!r || r.ok === false) return `（没成功：${r?.error || '未知'}）`;
      if (dry) {
        if (!r.count) return '没有不合格的素材，都挺好的';
        const list = (r.items || []).slice(0, 6).map((x) => x.name + '：' + x.reason).join('；');
        return `会清理 ${r.count} 张 —— ${list}`;
      }
      return `清理完成，挪走 ${r.moved || 0} 张（在 data/${kind}-trash/ 里，不是删掉）`;
    } catch (e) {
      return `（清理失败：${e.message}）`;
    }
  }

  /** 项目根目录（素材库在 <root>/data 下） */
  #mediaRoot() {
    const root = this.config?.root || path.join(this.sandbox, '..');
    return root;
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
