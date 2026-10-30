/**
 * 配置声明表（单一事实来源）。
 *
 * 为什么要有这个东西 —— 说个真实的故事：
 *   这个项目在一天之内修了 4 个同一类 bug：
 *     · 「工具能力 / 调用 DSH」开关：读接口不返回、写接口不合并 → 改了没反应
 *     · 「情绪开关」：同样两头都没接
 *     · 「语音概率」：适配器侧的配置接口漏了这个字段
 *     · 「气泡节奏 pace」：回复里没带
 *   全是「同一个配置项要在两个地方各写一遍，漏了一边就静默失效」。
 *
 * AstrBot / Koishi 这类框架的做法是「配置由 schema 生成」：
 *   默认值、校验、对外展示（脱敏）、写入合并，四种行为都从同一份声明推出来，
 *   加一个新配置项只改一处，四处自动跟着变，漏不了。
 *
 * 这里就照这个思路做：SECTION_SCHEMA 声明一遍，
 *   defaults()     → 默认值
 *   fillDefaults() → 补缺（一键修复用）
 *   applyPatch()   → 合并写入（/api/admin/config 用）
 *   toPublic()     → 脱敏展示（GET 用）
 * 全部自动，不用手写一遍。
 *
 * 刻意没做的事：
 *   · 不引入第三方校验库（这个项目零依赖）
 *   · 不接管 apiKey（Key 有归档/守卫/掩码规则，还是由 admin 管）
 *   · 不接管 channels / owner / card 这类有自定义逻辑的段落
 */

/** 字段类型：string / number / boolean / array / object */
const F = (type, def, extra = {}) => ({ type, default: def, ...extra });

export const SECTION_SCHEMA = {
  mood: {
    label: '情绪状态',
    fields: {
      enabled: F('boolean', true, { label: '启用情绪' }),
    },
  },

  tools: {
    label: '工具能力',
    fields: {
      enabled: F('boolean', true, { label: '启用工具' }),
      /**
       * 权限档位（参照智能体框架的通行做法）：
       *   read-only 只能读；workspace 能写沙箱内的文件；full 额外放开管理类工具
       * 默认 workspace —— 聊天场景够用，又不会让陌生人的一句话删掉真实文件。
       */
      permission: F('string', 'workspace', {
        enum: ['read-only', 'workspace', 'full'],
        label: '权限档位',
      }),
      sandbox: F('string', '', { label: '工作目录' }),
      maxFileSize: F('number', 524288, { min: 1024, max: 50 * 1024 * 1024, label: '单文件上限' }),
      cmdTimeout: F('number', 30000, { min: 1000, max: 600000, label: '命令超时(ms)' }),
      off: F('array', [], { label: '被关掉的工具' }),
    },
    nested: {
      dsh: {
        label: 'DSH',
        fields: {
          enabled: F('boolean', false),
          cwd: F('string', ''),
          timeoutMs: F('number', 180000, { min: 5000, max: 3600000 }),
        },
      },
    },
  },

  reply: {
    label: '回复风格',
    fields: {
      maxChars: F('number', 500, { min: 50, max: 2000 }),
      maxBubbles: F('number', 3, { min: 1, max: 6 }),
      bubbleDelayMs: F('number', 400, { min: 0, max: 5000 }),
      perCharMs: F('number', 45, { min: 0, max: 300 }),
      jitter: F('number', 0.35, { min: 0, max: 1 }),
      maxDelayMs: F('number', 6000, { min: 0, max: 30000 }),
      typoChance: F('number', 0.04, { min: 0, max: 0.5 }),
      terseChance: F('number', 0.15, { min: 0, max: 1 }),
      loosePunctuation: F('number', 0.75, { min: 0, max: 1 }),
    },
    nested: {
      emoji: {
        label: 'emoji',
        fields: {
          enabled: F('boolean', true),
          chance: F('number', 0.35, { min: 0, max: 1 }),
        },
      },
    },
  },

  wechat: {
    label: '微信',
    fields: {
      stickerChance: F('number', 0, { min: 0, max: 1, label: '表情包概率' }),
      voiceChance: F('number', 0, { min: 0, max: 1, label: '语音概率' }),
      mediaCollect: F('boolean', true, { label: '收藏素材' }),
      collectOnlyFrom: F('array', [], { label: '只收这些' }),
      collectScope: F('string', 'all', { enum: ['all', 'custom'] }),
    },
  },

  vision: {
    label: '看图',
    fields: {
      enabled: F('boolean', false),
      baseUrl: F('string', ''),
      model: F('string', ''),
      timeoutMs: F('number', 60000, { min: 5000, max: 300000 }),
      maxEdge: F('number', 1280, { min: 256, max: 4096 }),
      maxTokens: F('number', 1024, { min: 64, max: 8192 }),
      provider: F('string', ''),
    },
  },

  voice: {
    label: '语音',
    fields: {
      enabled: F('boolean', true),
      baseUrl: F('string', ''),
      model: F('string', 'qwen3-asr-flash'),
      mode: F('string', ''),
      language: F('string', ''),
      enableItn: F('boolean', true),
      timeoutMs: F('number', 60000, { min: 5000, max: 300000 }),
      maxSeconds: F('number', 120, { min: 5, max: 600 }),
      ttsModel: F('string', 'qwen3-tts-flash', { label: '合成模型' }),
      ttsVoice: F('string', 'Cherry', { label: '合成音色' }),
    },
  },

  search: {
    label: '联网',
    fields: {
      enabled: F('boolean', false),
      provider: F('string', 'bocha', { enum: ['bocha', 'serper', 'tavily', 'zhipu'] }),
      baseUrl: F('string', ''),
      maxResults: F('number', 5, { min: 1, max: 20 }),
      timeoutMs: F('number', 20000, { min: 3000, max: 120000 }),
      autoDetect: F('boolean', true, { label: '自动判断要不要联网' }),
      maxPerHour: F('number', 10, { min: 0, max: 200, label: '每小时上限' }),
    },
  },

  imagegen: {
    label: '画图',
    fields: {
      enabled: F('boolean', false),
      provider: F('string', ''),
      baseUrl: F('string', ''),
      model: F('string', 'cogview-3-flash'),
      size: F('string', '1024x1024'),
      saveDir: F('string', 'data/generated'),
      maxPerCall: F('number', 2, { min: 1, max: 8 }),
    },
    nested: {
      proactive: {
        label: '主动画图',
        fields: {
          enabled: F('boolean', false),
          chance: F('number', 0.05, { min: 0, max: 1 }),
          minIntervalMinutes: F('number', 60, { min: 5, max: 1440 }),
          maxPerDay: F('number', 2, { min: 0, max: 50 }),
        },
      },
    },
  },

  care: {
    label: '主动搭话',
    fields: {
      enabled: F('boolean', true),
      minIntervalMinutes: F('number', 120, { min: 10, max: 1440 }),
      maxPerDay: F('number', 3, { min: 0, max: 50 }),
      idleMinutes: F('number', 60, { min: 5, max: 1440 }),
      targets: F('array', []),
      quietHours: F('object', { start: 23, end: 9 }),
    },
  },

  learning: {
    label: '联网学习',
    fields: {
      enabled: F('boolean', false),
      maxPerRun: F('number', 20, { min: 1, max: 200 }),
      queries: F('array', []),
      sites: F('array', []),
      mediaSites: F('array', []),
      rssFeeds: F('array', []),
      autoMerge: F('boolean', false),
    },
    nested: {
      auto: {
        label: '自动学习',
        fields: {
          enabled: F('boolean', false),
          intervalHours: F('number', 12, { min: 1, max: 168 }),
          maxPerDay: F('number', 10, { min: 1, max: 100 }),
          mode: F('string', 'pending', { enum: ['pending', 'auto'] }),
        },
      },
      digest: {
        label: '热点摘要',
        fields: {
          enabled: F('boolean', false),
          intervalHours: F('number', 24, { min: 1, max: 168 }),
          topics: F('array', []),
        },
      },
    },
  },

  logic: {
    label: '逻辑库',
    fields: {
      enabled: F('boolean', true),
    },
    nested: {
      autoLearn: {
        label: '自动学习',
        fields: {
          enabled: F('boolean', false),
          maxPerDay: F('number', 10, { min: 0, max: 100 }),
          mode: F('string', 'pending', { enum: ['pending', 'auto'] }),
        },
      },
    },
  },

  memory: {
    label: '记忆',
    fields: {
      maxFacts: F('number', 50, { min: 5, max: 500 }),
      maxSummaries: F('number', 10, { min: 1, max: 100 }),
    },
  },

  group: {
    label: '群聊',
    fields: {
      requireAt: F('boolean', true),
      freeChat: F('boolean', false),
      freeChatChance: F('number', 0.1, { min: 0, max: 1 }),
      cooldownSec: F('number', 3, { min: 0, max: 600 }),
      masterAlwaysReply: F('boolean', true),
      engagedMinutes: F('number', 5, { min: 0, max: 120 }),
      /** 接话窗口内、没明确点名时还接的概率（防群里误触发） */
      engagedReplyChance: F('number', 0.35, { min: 0, max: 1 }),
      maxRepliesPerHour: F('number', 20, { min: 0, max: 500 }),
      aliases: F('array', []),
      ownerIds: F('array', []),
    },
  },

  session: {
    label: '会话',
    fields: {
      historyTurns: F('number', 20, { min: 1, max: 200 }),
      idleMinutes: F('number', 60, { min: 1, max: 10080 }),
      compressAfter: F('number', 40, { min: 5, max: 500 }),
      maxQueue: F('number', 5, { min: 1, max: 100 }),
      persist: F('boolean', true),
    },
  },
};

/** 这些字段是密钥：不回显、不直接覆盖（交给 admin 的归档/守卫逻辑） */
export const SECRET_FIELDS = {
  llm: ['apiKey'],
  vision: ['apiKey'],
  voice: ['apiKey', 'ttsApiKey'],
  search: ['apiKey'],
  imagegen: ['apiKey'],
};

/** 取某个字段的默认值（深拷贝，数组/对象不会共享引用） */
function cloneDefault(v) {
  if (Array.isArray(v)) return [...v];
  if (v && typeof v === 'object') return { ...v };
  return v;
}

/**
 * 生成一份完整的默认配置（只含 schema 里的段落）。
 */
export function defaults() {
  const out = {};
  for (const [section, def] of Object.entries(SECTION_SCHEMA)) {
    out[section] = {};
    for (const [key, f] of Object.entries(def.fields)) {
      out[section][key] = cloneDefault(f.default);
    }
    for (const [child, cdef] of Object.entries(def.nested || {})) {
      out[section][child] = {};
      for (const [key, f] of Object.entries(cdef.fields)) {
        out[section][child][key] = cloneDefault(f.default);
      }
    }
  }
  return out;
}

/**
 * 补缺：把配置里缺的字段填上默认值（已在的不动）。
 *
 * @returns {string[]} 补了哪些路径，例如 ['tools.dsh.timeoutMs']
 */
export function fillDefaults(config) {
  const added = [];

  for (const [section, def] of Object.entries(SECTION_SCHEMA)) {
    if (!config[section] || typeof config[section] !== 'object') {
      config[section] = {};
      added.push(section);
    }

    for (const [key, f] of Object.entries(def.fields)) {
      if (config[section][key] === undefined) {
        config[section][key] = cloneDefault(f.default);
        added.push(section + '.' + key);
      }
    }

    for (const [child, cdef] of Object.entries(def.nested || {})) {
      if (!config[section][child] || typeof config[section][child] !== 'object') {
        config[section][child] = {};
      }
      for (const [key, f] of Object.entries(cdef.fields)) {
        if (config[section][child][key] === undefined) {
          config[section][child][key] = cloneDefault(f.default);
          added.push(section + '.' + child + '.' + key);
        }
      }
    }
  }

  return added;
}

/** 按声明校验一个值，返回修正后的值（不合法就退回原值/默认值） */
function coerce(field, value, fallback) {
  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
  }

  if (field.type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    let out = n;
    if (Number.isFinite(field.min)) out = Math.max(field.min, out);
    if (Number.isFinite(field.max)) out = Math.min(field.max, out);
    return out;
  }

  if (field.type === 'string') {
    if (typeof value !== 'string') return fallback;
    if (Array.isArray(field.enum) && field.enum.length && !field.enum.includes(value)) {
      return fallback;
    }
    return value;
  }

  if (field.type === 'array') {
    if (!Array.isArray(value)) return fallback;
    return value;
  }

  if (field.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    return { ...value };
  }

  return fallback;
}

/**
 * 把一个 patch 合并进配置（就地修改）。
 *
 * 只认 schema 里声明过的字段 —— 前端传错名字会被忽略并记录下来，
 * 而不是像以前那样「传了但没人处理，静默丢字段」。
 *
 * @param {object} config 目标配置（会被修改）
 * @param {object} patch 前端传来的部分
 * @returns {{applied:string[], ignored:string[]}}
 */
export function applyPatch(config, patch) {
  const applied = [];
  const ignored = [];

  if (!patch || typeof patch !== 'object') return { applied, ignored };

  for (const [section, incoming] of Object.entries(patch)) {
    const def = SECTION_SCHEMA[section];

    if (!def) {
      ignored.push(section + '（没有这个段落）');
      continue;
    }
    if (!incoming || typeof incoming !== 'object') continue;

    config[section] = config[section] || {};

    for (const [key, value] of Object.entries(incoming)) {
      // 嵌套段
      const cdef = def.nested?.[key];
      if (cdef) {
        if (!value || typeof value !== 'object') continue;
        config[section][key] = config[section][key] || {};

        for (const [childKey, childValue] of Object.entries(value)) {
          const f = cdef.fields[childKey];
          if (!f) {
            ignored.push(section + '.' + key + '.' + childKey);
            continue;
          }
          const before = config[section][key][childKey];
          const next = coerce(f, childValue, before ?? cloneDefault(f.default));
          if (next !== before) {
            config[section][key][childKey] = next;
            applied.push(section + '.' + key + '.' + childKey);
          }
        }
        continue;
      }

      const f = def.fields[key];
      if (!f) {
        // Key 之类的特殊字段交给 admin 处理，不算「ignored」
        if ((SECRET_FIELDS[section] || []).includes(key)) continue;
        ignored.push(section + '.' + key);
        continue;
      }

      const before = config[section][key];
      const next = coerce(f, value, before ?? cloneDefault(f.default));
      if (JSON.stringify(next) !== JSON.stringify(before)) {
        config[section][key] = next;
        applied.push(section + '.' + key);
      }
    }
  }

  return { applied, ignored };
}

/**
 * 生成对外展示的配置（脱敏 + 只含声明过的字段）。
 *
 * @param {object} config
 * @param {object} [opts]
 * @param {(s:string)=>string} [opts.mask]
 * @param {object} [opts.extra] 额外要合并进去的（例如 hasKey 这类派生值）
 */
export function toPublic(config, opts = {}) {
  const mask = opts.mask || ((s) => (s ? s.slice(0, 4) + '****' + s.slice(-4) : ''));
  const out = {};

  for (const [section, def] of Object.entries(SECTION_SCHEMA)) {
    const src = config[section] || {};
    out[section] = {};

    for (const [key, f] of Object.entries(def.fields)) {
      out[section][key] = src[key] === undefined ? cloneDefault(f.default) : src[key];
    }

    for (const [child, cdef] of Object.entries(def.nested || {})) {
      out[section][child] = {};
      for (const [key, f] of Object.entries(cdef.fields)) {
        const v = src[child]?.[key];
        out[section][child][key] = v === undefined ? cloneDefault(f.default) : v;
      }
    }

    // 密钥只给「有没有」和掩码
    for (const key of SECRET_FIELDS[section] || []) {
      const v = src[key];
      out[section][key + 'Masked'] = mask(v);
      out[section][key + 'Present'] = Boolean(v);
    }
  }

  /**
   * 有些段落只声明了密钥、不在 SECTION_SCHEMA 里（例如 llm 的字段由客户端自己管）。
   * 这些也要输出脱敏信息，否则面板拿不到「配没配」。
   */
  for (const [section, keys] of Object.entries(SECRET_FIELDS)) {
    if (out[section]) continue;
    const src = config[section] || {};
    out[section] = {};
    for (const key of keys) {
      out[section][key + 'Masked'] = mask(src[key]);
      out[section][key + 'Present'] = Boolean(src[key]);
    }
  }

  return out;
}

/** 给文档/面包屑用：所有声明的路径 */
export function paths() {
  const out = [];
  for (const [section, def] of Object.entries(SECTION_SCHEMA)) {
    for (const key of Object.keys(def.fields)) out.push(section + '.' + key);
    for (const [child, cdef] of Object.entries(def.nested || {})) {
      for (const key of Object.keys(cdef.fields)) out.push(section + '.' + child + '.' + key);
    }
  }
  return out;
}
