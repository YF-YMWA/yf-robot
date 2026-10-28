/**
 * 配置层：分层默认值 + 校验 + 环境变量覆盖。
 *
 * 设计原则：
 *   - 每个模块的配置有独立的默认值，不散落在各处
 *   - 用户配置只需写想改的字段，未写的自动继承默认
 *   - 环境变量优先级最高，方便临时覆盖而不改文件
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 默认配置。修改这里等于修改「出厂设置」。 */
export const DEFAULTS = {
  server: {
    host: '127.0.0.1',
    port: 8899,
    /** 端口被占用时自动往后找可用端口 */
    autoPort: true,
    /**
     * 关掉网页就停服务（默认关）。
     *
     * 打开后：控制台页面全部关闭约 15 秒，服务自动退出。
     * 适合「我只在电脑前用，用完就关」的人；接微信时不要开 ——
     * 页面一关服务就停，微信那边立刻不回话了。
     *
     * 有三道退路，万一开了又想关掉：
     *   1. 控制台「总览」页的开关（服务还在跑时）
     *   2. YF-Robot.bat 菜单里的「关掉『关网页即停服务』」（服务已经停了也能用）
     *   3. 直接改 config.json：server.stopWhenNoConsole = false
     * 另外 data/keep-alive 这个文件存在时，这个开关一律不生效。
     */
    stopWhenNoConsole: false,
  },

  /** 模型服务。默认走 OpenAI 兼容接口。 */
  llm: {
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 1.0,
    maxTokens: 800,
    timeoutMs: 60000,
    /** 失败时的备用服务商列表，按顺序尝试 */
    fallbacks: [],
  },

  /** 视觉模型（看图）。留空则关闭看图能力。 */
  vision: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    timeoutMs: 45000,
    /** 图片长边上限，超出等比缩小 */
    maxEdge: 1568,
    /** 识别输出的 token 上限 */
    maxTokens: 1024,
    /** 长截图切段数 */
    segments: 3,
    /** ffmpeg 路径，留空自动查找 */
    ffmpeg: '',
  },

  /** 语音转文字（语音消息）。留空则关闭。 */
  voice: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    /**
     * 接口模式：
     *   chat        —— OpenAI 兼容 chat/completions + input_audio（qwen3-asr-flash）
     *   transcriptions —— 传统 /audio/transcriptions（whisper）
     */
    mode: 'chat',
    language: '',
    enableItn: true,
    timeoutMs: 60000,
    maxSeconds: 120,
    ffmpeg: '',
  },

  /** 联网搜索。 */
  search: {
    enabled: false,
    /** bocha | serper | tavily | custom */
    provider: 'bocha',
    baseUrl: '',
    apiKey: '',
    maxResults: 5,
    timeoutMs: 15000,
    /** custom 模式的字段映射 */
    fieldMap: null,
    /** 是否只在关键词命中时才搜 */
    autoDetect: true,
  },

  /** 情绪状态：影响回复长短、发不发语音。 */
  mood: { enabled: true },

  /**
   * 逻辑库：她「怎么想」的经验，和知识库（知道什么）分开。
   */
  logic: {
    /** 聊天时自动检索并参考以往经验 */
    enabled: true,
    /** 联网学习：默认关闭，要用得在控制台手动打开 */
    autoLearn: {
      enabled: false,
      /** 每天最多学几条（防止失控烧 token） */
      maxPerDay: 10,
      /** active = 学完直接用；pending = 进待审，等主人确认 */
      mode: 'pending',
      /** 单个页面抓取超时 */
      timeoutMs: 15000,
    },
  },

  /** B站分享。 */
  share: {
    enabled: false,
    /** 分享间隔（小时） */
    intervalHours: 2,
    /** 一次拉取多少条热门 */
    count: 20,
    /** 优先匹配的关键词 */
    keywords: [],
    /** 已分享过的 bvid，用于去重 */
    recentIds: [],
  },

  /** 群聊策略。 */
  group: {
    /** 必须 @ 或叫名字才回 */
    requireAt: true,
    /** 是否允许低概率主动接话 */
    freeChat: false,
    freeChatChance: 0.06,
    /** 两次回复的最小间隔（秒） */
    cooldownSec: 0,
    /** 主人说话是否必回 */
    masterAlwaysReply: true,
    /** 接话后保持参与多少分钟 */
    engagedMinutes: 6,
    /** 每小时最多回几条 */
    maxRepliesPerHour: 1000,
    /** 免打扰默认时长（分钟） */
    muteDefaultMinutes: 30,
    /** 机器人的名字/别名，用于判断「叫名字」 */
    aliases: [],
    /** 主人 wxid 列表 */
    ownerIds: [],
    /** 群消息历史保留轮数 */
    historyTurns: 10,
  },

  /** 会话与记忆 */
  session: {
    /** 保留多少轮对话作为上下文 */
    historyTurns: 20,
    /** 多少分钟无活动后回收会话 */
    idleMinutes: 120,
    /** 累计多少轮强制压缩历史 */
    compressAfter: 40,
    /** 单会话最多同时排队多少条消息 */
    maxQueue: 5,
  },

  /** 回复整形 */
  reply: {
    /** 单条消息最大字数，超出则分段 */
    maxChars: 300,
    /** 一条回复最多拆成几个气泡 */
    maxBubbles: 3,
    /** 气泡之间的间隔（毫秒），模拟打字 */
    bubbleDelayMs: 400,
    // 每条气泡按字数再等一会儿，模拟打字
    perCharMs: 45,
    // 节奏随机抖动（0~1），太规律就像机器
    jitter: 0.35,
    // 单条气泡最多等多久
    maxDelayMs: 6000,
    // 偶尔打错字再改口的概率（0 = 关）
    typoChance: 0.04,
    // 偶尔只回一句（真人不会每轮都发两三条）
    terseChance: 0.15,
    // 短句结尾的句号删掉（微信聊天很少有人打句号）
    loosePunctuation: 0.75,
    /** 是否移除 Markdown 标记 */
    stripMarkdown: true,
    /** 表情装饰 */
    emoji: {
      /** 是否启用 */
      enabled: true,
      /** 添加概率 0~1 */
      chance: 0.35,
      /** 是否允许颜文字 */
      kaomoji: true,
    },
  },

  /** 人设文件路径（相对项目根） */
  personaFile: 'persona.json',

  /** 工具能力（让助手能干活） */
  tools: {
    /**
     * 是否启用工具。默认关闭。
     *
     * 开启后助手可以：
     *   - 读写 sandbox 目录内的文件
     *   - 执行白名单命令（ffmpeg / python / node 等）
     *   - 联网搜索
     *
     * 安全边界：
     *   - 所有文件操作限制在 sandbox 内，路径穿越会被拒绝
     *   - 命令走白名单，危险参数会被拦截
     *   - 有超时和输出上限
     */
    enabled: false,
    /** 沙箱目录，相对项目根 */
    sandbox: 'agent-workspace',
    /** 单文件读写上限（字节） */
    maxFileSize: 524288,
    /** 命令超时（毫秒） */
    cmdTimeout: 30000,
    /** DSH 调用（让助手能反向调用 DSH） */
    dsh: {
      enabled: false,
      /** DSH 执行的工作目录，留空用项目根 */
      cwd: '',
      /** 单次调用超时 */
      timeoutMs: 180000,
    },
  },

  /** 通道配置 */
  channels: {
    web: { enabled: true },
    /** 群聊通道 */
    'wechat-group': {
      enabled: false,
      listenHost: '127.0.0.1',
      listenPort: 8898,
      /** 桥接鉴权 token，留空则不校验 */
      token: '',
    },
  },

  log: {
    level: 'info',
    file: 'data/app.log',
  },
};

/** 环境变量映射：ENV 名 → 配置路径 */
const ENV_MAP = {
  LLM_BASE_URL: 'llm.baseUrl',
  LLM_API_KEY: 'llm.apiKey',
  LLM_MODEL: 'llm.model',
  VISION_BASE_URL: 'vision.baseUrl',
  VISION_API_KEY: 'vision.apiKey',
  VISION_MODEL: 'vision.model',
  VOICE_BASE_URL: 'voice.baseUrl',
  VOICE_API_KEY: 'voice.apiKey',
  VOICE_MODEL: 'voice.model',
  PORT: 'server.port',
  HOST: 'server.host',
};

/** 深度合并，后者覆盖前者，数组直接替换。 */
export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (k.startsWith('_')) continue; // 忽略注释字段
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 按点号路径取值。 */
export function getByPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

/** 按点号路径设值（就地修改）。 */
export function setByPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isPlainObject(cur[keys[i]])) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * 加载配置：默认值 ← config.json ← 环境变量。
 * @param {object} [opts]
 * @param {string} [opts.root] 项目根目录
 * @param {object} [opts.env] 环境变量对象
 * @param {object} [opts.override] 直接注入的配置（测试用）
 */
export function loadConfig(opts = {}) {
  const root = opts.root || ROOT;
  const env = opts.env || process.env;

  let user = {};
  const file = path.join(root, 'config.json');
  const fileExists = fs.existsSync(file);
  if (fileExists) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`config.json 解析失败: ${e.message}`);
    }
  }

  let cfg = deepMerge(DEFAULTS, user);
  cfg = deepMerge(cfg, opts.override || {});
  /** 标记配置文件是否真实存在，供启动器判断是否需要引导 */
  cfg.__configMissing__ = !fileExists && !opts.override;

  // 环境变量覆盖
  for (const [envKey, dotted] of Object.entries(ENV_MAP)) {
    const v = env[envKey];
    if (v === undefined || v === '') continue;
    setByPath(cfg, dotted, coerce(getByPath(cfg, dotted), v));
  }

  validate(cfg);

  // 相对路径统一转绝对
  cfg.root = root;
  cfg.personaFile = path.isAbsolute(cfg.personaFile)
    ? cfg.personaFile
    : path.join(root, cfg.personaFile);
  if (cfg.log?.file && !path.isAbsolute(cfg.log.file)) {
    cfg.log.file = path.join(root, cfg.log.file);
  }
  if (cfg.tools?.sandbox && !path.isAbsolute(cfg.tools.sandbox)) {
    cfg.tools.sandbox = path.join(root, cfg.tools.sandbox);
  }

  return cfg;
}

/** 按已有值的类型转换字符串。 */
function coerce(like, raw) {
  if (typeof like === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : like;
  }
  if (typeof like === 'boolean') return raw === 'true' || raw === '1';
  return raw;
}

/** 基本校验：尽早暴露明显错误。 */
export function validate(cfg) {
  const problems = [];

  if (cfg.server.port < 1 || cfg.server.port > 65535) {
    problems.push(`server.port 非法: ${cfg.server.port}`);
  }
  if (cfg.session.historyTurns < 0) problems.push('session.historyTurns 不能为负');
  if (cfg.reply.maxChars < 20) problems.push('reply.maxChars 太小');
  if (cfg.reply.maxBubbles < 1) problems.push('reply.maxBubbles 至少为 1');

  if (cfg.vision.enabled && (!cfg.vision.baseUrl || !cfg.vision.model)) {
    problems.push('vision.enabled 为 true 但缺少 baseUrl 或 model');
  }
  if (cfg.voice.enabled && (!cfg.voice.baseUrl || !cfg.voice.model)) {
    problems.push('voice.enabled 为 true 但缺少 baseUrl 或 model');
  }
  if (cfg.voice.enabled && !['chat', 'transcriptions'].includes(cfg.voice.mode)) {
    problems.push(`voice.mode 非法: ${cfg.voice.mode}（可选 chat / transcriptions）`);
  }
  if (cfg.search.enabled) {
    if (!['bocha', 'serper', 'tavily', 'custom'].includes(cfg.search.provider)) {
      problems.push(`search.provider 非法: ${cfg.search.provider}`);
    }
    if (cfg.search.provider === 'custom' && !cfg.search.baseUrl) {
      problems.push('search.provider 为 custom 时必须提供 baseUrl');
    }
    if (cfg.search.provider === 'custom' && !cfg.search.fieldMap) {
      problems.push('search.provider 为 custom 时必须提供 fieldMap');
    }
    // 内置默认地址的后端不强制要求 baseUrl
  }
  if (cfg.group.freeChatChance < 0 || cfg.group.freeChatChance > 1) {
    problems.push('group.freeChatChance 应在 0~1 之间');
  }

  const enabled = Object.entries(cfg.channels || {})
    .filter(([, v]) => v?.enabled)
    .map(([k]) => k);
  if (enabled.length === 0) problems.push('至少启用一个通道');

  if (problems.length) {
    throw new Error('配置有问题:\n  - ' + problems.join('\n  - '));
  }
  return true;
}

/** 诊断信息：不泄露密钥，只报告是否配置。 */
export function inspect(cfg) {
  const mask = (s) => (s ? `已配置(${s.length}字符)` : '未配置');
  return {
    server: `${cfg.server.host}:${cfg.server.port}`,
    llm: { baseUrl: cfg.llm.baseUrl, model: cfg.llm.model, apiKey: mask(cfg.llm.apiKey) },
    vision: cfg.vision.enabled
      ? { model: cfg.vision.model, apiKey: mask(cfg.vision.apiKey) }
      : '关闭',
    voice: cfg.voice.enabled ? { model: cfg.voice.model, apiKey: mask(cfg.voice.apiKey) } : '关闭',
    channels: Object.entries(cfg.channels)
      .filter(([, v]) => v?.enabled)
      .map(([k]) => k),
  };
}
