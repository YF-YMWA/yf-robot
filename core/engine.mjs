/**
 * 聊天引擎：把模型、会话、人设、整形串联起来，并对外暴露通道无关的接口。
 *
 * 通道（网页 / 微信单聊 / UIA）只依赖这里，不直接接触模型或会话内部。
 *
 * 处理一条消息的完整流程：
 *   1. 取出/创建会话
 *   2. 串行排队（同一人多条消息不乱序）
 *   3. 拼接系统提示（人设 + 事实记忆 + 环境）
 *   4. 调模型，流式产出
 *   5. 输出检查（学舌、空回复）
 *   6. 整形为气泡，回调给通道
 *   7. 记录历史、提取新事实
 */
import fs from 'node:fs';
import { LlmClient, inspectOutput, LlmError } from './llm.mjs';
import { SessionStore, extractFacts, isEcho } from './session.mjs';
import { MemoryStore, extractPreferences } from './memory.mjs';
import { KnowledgeBase } from './kb.mjs';
import { PluginHost } from './plugins.mjs';
import { LogicLibrary } from './logic.mjs';
import { LogicLearner } from './logic-learn.mjs';
import { assembleContext, renderContext, detectTone, banksForTone } from './context.mjs';
import {
  memoryDir,
  migrateLegacyToScope,
  scopeName,
  resolveWordsDir,
  scopeDir,
  generatedDir,
} from './scoped-paths.mjs';
import { addTypoSlip, naturalizePunctuation, sometimesTerse } from './humanize.mjs';
import { decideVoiceReply } from './voice-reply.mjs';
import { MoodStore, moodDelta, describeMood } from './mood.mjs';
import { renderSystemPrompt } from './persona.mjs';
import { renderWordBanks } from './words.mjs';
import { OwnerService } from './owner.mjs';
import { ImageGenClient } from './imagegen.mjs';
import { shouldProactiveDraw, renderProactiveHint } from './proactive-draw.mjs';
import { AutoLearnState } from './auto-learn.mjs';
import { shapeReply, needsRewrite } from './reply.mjs';
import { VisionClient, wrapImageMessage } from './vision.mjs';
import { VoiceClient } from './voice.mjs';
import { SearchClient, formatSearchResults, needsSearch, checkGrounding } from './search.mjs';
import { decorateBubbles, detectMood } from './sticker.mjs';
import { ToolKit } from './tools.mjs';
import { DshClient } from './dsh.mjs';
import path from 'node:path';

export class ChatEngine {
  /**
   * @param {object} opts
   * @param {object} opts.config 完整配置
   * @param {object} opts.persona 人设对象
   * @param {object} [opts.logger]
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor({ config, persona, logger = console, fetchImpl }) {
    this.config = config;
    this.persona = persona;
    this.log = logger;
    this.fetchImpl = fetchImpl;

    this.llm = new LlmClient(config.llm, { fetchImpl });

    // 会话落盘：重启 / 桥接重连后能接着上次聊
    //
    // 单元测试里必须关掉：node --test 会设 NODE_TEST_CONTEXT，
    // 测试如果真往 data/sessions 写，下一次跑就会读到上次的历史，
    // 「两轮 = 4 条」这种断言直接崩。改配置容易漏，这里统一兜住。
    const inTest = Boolean(process.env.NODE_TEST_CONTEXT);

    const sessionDir =
      config.session?.persist === false || inTest
        ? ''
        : path.join(config.root || process.cwd(), 'data', 'sessions');

    this.sessions = new SessionStore(config.session, {
      dir: sessionDir,
      log: (msg) => logger.info?.(msg),
    });
    this.vision = new VisionClient(config.vision, { fetchImpl });
    this.voice = new VoiceClient(config.voice, { fetchImpl });
    this.search = new SearchClient(config.search, { fetchImpl });

    // 画图能力（要在 ToolKit 之前建，工具需要它）
    // 画图存到当前角色卡的目录（路径在构造后按 this.scope 算，见 #generatedSaveDir）
    this.imagegen = new ImageGenClient(config.imagegen || {}, {
      apiKey: config.imagegen?.apiKey || config.vision?.apiKey || config.llm?.apiKey || '',
      root: config.root || process.cwd(),
      logger,
    });
    if (this.imagegen.enabled) {
      this.log.info?.(`[imagegen] 绘图已启用: ${config.imagegen?.model || 'cogview-3-flash'}`);
    }

    /**
     * 工具层。
     *
     * 面板上「工具能力」可以随时开关，所以这里只建一次初始状态，
     * 之后每轮对话前由 syncTools() 按最新配置校正 ——
     * 之前只在构造时判断一次，运行中关掉等于没关（还会照常读目录、跑命令）。
     */
    this.tools = null;
    this.plugins = null;
    /**
     * 用量统计。
     *
     * 记每次调用的输入/输出 token，按天累计，写进 data/token-stats.json。
     * 目的是能回答「这个功能一次花多少」这种问题 —— 之前完全没数据。
     */
    this.usage = { day: '', calls: 0, input: 0, output: 0, byKind: {} };
    this.#buildTools();

    // 主人身份识别
    this.owner = new OwnerService(config.owner || {});

    /**
     * 长期记忆（事实 + 摘要，跨会话持久化）。
     *
     * 目录必须按角色卡算 —— 之前这里写的是全局 data/memory，
     * 结果「独立记忆」只在换过一次卡之后才生效，重启又退回全局：
     * 换个角色，上一个角色的记忆原样还在。
     */
    this.memory = new MemoryStore({
      dir: memoryDir(config.root || process.cwd(), this.scope),
      maxFacts: config.memory?.maxFacts || 50,
      maxSummaries: config.memory?.maxSummaries || 10,
    });

    /** 主动画图的运行期状态（每个会话）：{ lastTs, day, count } */
    this.drawState = new Map();

    /** 联网搜索的节流状态：{ hourKey, hourCount, total } */
    this.searchState = {
      hourKey: '',
      hourCount: 0,
      total: 0,
      status() {
        return {
          hourCount: this.hourCount,
          total: this.total,
        };
      },
    };

    /** 对话时自动学习的状态 */
    this.autoLearn = new AutoLearnState();
    /** 外部注入的自动学习执行器（admin 提供，避免 engine 依赖 admin） */
    this.autoLearnRunner = null;
  }

  /** 更新主人配置（控制台改完即时生效）。 */
  updateOwner(cfg) {
    this.owner?.update(cfg);
  }

  /**
   * 按当前 this.config 重建所有 API 客户端。
   *
   * 控制台改了 Key / 地址 / 模型后必须调用，否则旧客户端还拿着旧 Key，
   * 表现就是「改了 Key 但测试还是失败」。
   */
  reloadClients() {
    const f = this.fetchImpl;

    this.llm = new LlmClient(this.config.llm, { fetchImpl: f });
    this.vision = new VisionClient(this.config.vision, { fetchImpl: f });
    this.voice = new VoiceClient(this.config.voice, { fetchImpl: f });
    this.search = new SearchClient(this.config.search, { fetchImpl: f });

    const ig = this.config.imagegen || {};
    this.imagegen = new ImageGenClient(
      {
        ...ig,
        // 她画的图按角色卡分开：data/<卡片>/generated
        saveDir: path.relative(
          this.config.root || process.cwd(),
          path.join(generatedDir(this.config.root || process.cwd(), this.scope), ''),
        ),
      },
      {
      apiKey: ig.apiKey || this.config.vision?.apiKey || this.config.llm?.apiKey || '',
      root: this.config.root || process.cwd(),
      logger: this.log,
    });

    // 工具层持有绘图客户端的引用，也要同步
    if (this.tools) {
      this.tools.imagegen = this.imagegen.enabled ? this.imagegen : null;
    }

    this.log.info?.(
      `[engine] 客户端已重建（LLM ${this.config.llm.model} / ` +
        `看图 ${this.config.vision.model} / 画图 ${this.imagegen.enabled ? ig.model : '关闭'}）`,
    );

    return this.clientsStatus();
  }

  /** 各客户端当前状态（控制台展示用）。 */
  clientsStatus() {
    const ig = this.imagegen?.status?.() || {};

    return {
      llm: {
        model: this.config.llm?.model,
        hasKey: Boolean(this.config.llm?.apiKey),
      },
      vision: {
        enabled: this.config.vision?.enabled !== false,
        model: this.config.vision?.model,
        hasKey: Boolean(this.config.vision?.apiKey),
      },
      voice: {
        enabled: this.config.voice?.enabled === true,
        model: this.config.voice?.model,
        hasKey: Boolean(this.config.voice?.apiKey),
      },
      search: {
        enabled: this.config.search?.enabled !== false,
        provider: this.config.search?.provider,
        hasKey: Boolean(this.config.search?.apiKey),
      },
      imagegen: ig,
    };
  }

  /** 重建绘图客户端（控制台改完 Key/模型后即时生效）。 */
  rebuildImagegen(cfg) {
    const merged = { ...(this.config.imagegen || {}), ...(cfg || {}) };

    this.imagegen = new ImageGenClient(
      { ...merged, saveDir: this.#generatedSaveDir() },
      {
      apiKey: merged.apiKey || this.config.vision?.apiKey || this.config.llm?.apiKey || '',
      root: this.config.root || process.cwd(),
      logger: this.log,
    });

    if (this.tools) {
      this.tools.imagegen = this.imagegen.enabled ? this.imagegen : null;
    }

    this.log.info?.(`[imagegen] 配置已更新: ${this.imagegen.enabled ? '启用' : '关闭'}`);
    return this.imagegen.status();
  }

  /**
   * 知识库（懒加载）。
   *
   * 只有真的配了文档才建实例；没文档时完全不产生开销。
   */
  /** 当前数据作用域（跟角色卡走） */
  get scope() {
    return scopeName(this.config.card || 'default');
  }

  /**
   * 换卡后重建「按卡隔离」的几个存储。
   *
   * 不重建的话，旧卡片的知识库/逻辑库实例还挂在内存里，
   * 换卡看起来「没生效」。
   */

  /**
   * 她画的图存哪 —— 按角色卡分开。
   *
   * 表情包和收到的图是共享的（换角色还能用同一批），
   * 但每个角色画的东西应该各归各的。
   */
  #generatedSaveDir() {
    const root = this.config.root || process.cwd();
    return path.relative(root, generatedDir(root, this.scope));
  }

  reloadScopedStores() {
    this._kb = null;
    this._logic = null;
    this._learner = null;
    this.memory = new MemoryStore({
      dir: memoryDir(this.config.root || process.cwd(), this.scope),
      maxFacts: this.config.memory?.maxFacts || 50,
      maxSummaries: this.config.memory?.maxSummaries || 10,
    });
    this.log.info?.(`[scope] 已切到「${this.scope}」的数据`);
  }

  #kb() {
    if (!this._kb) {
      this._kb = new KnowledgeBase({
        root: this.config.root || process.cwd(),
        config: this.config,
        log: (m) => this.log.info?.(m),
        card: this.scope,
      });
    }
    return this._kb;
  }

  /**
   * 素材库摘要：有几张图、都是什么情绪的。
   *
   * 只是一句话的提示，用来让她知道「手上有什么牌」，
   * 具体挑哪张还是走 list_stickers / send_image 工具。
   * 读不到就返回 null，不影响别的。
   */
  /** 情绪状态（懒加载，按角色卡隔离） */
  mood() {
    if (!this._mood) {
      this._mood = new MoodStore({
        file: path.join(scopeDir(this.config.root || process.cwd(), this.scope), 'mood.json'),
        log: (m) => this.log.info?.(m),
      });
    }
    return this._mood;
  }

  #mediaSummary() {
    const file = path.join(this.config.root || process.cwd(), 'data', 'stickers', 'index.json');
    let index = {};
    try {
      index = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }

    const names = Object.keys(index);
    if (!names.length) return null;

    const tagCount = {};
    for (const n of names) {
      for (const t of index[n]?.tags || []) {
        tagCount[t] = (tagCount[t] || 0) + 1;
      }
    }

    return { total: names.length, tags: tagCount };
  }

  /** 逻辑库（懒加载，用到才建） */
  logic() {
    if (!this._logic) {
      this._logic = new LogicLibrary({
        root: this.config.root || process.cwd(),
        config: this.config,
        log: (m) => this.log.info?.(m),
        card: this.scope,
        /**
         * 复用知识库那套嵌入（智谱 embedding-3）。
         *
         * 只靠字面匹配，中文换个说法就搜不到 ——
         * 「有人骂我」和「对方骂人」一个字都不重合，但明显是同一件事。
         * 没有 Key 的时候自动退回纯字面，不影响使用。
         */
        embed: async (text) => {
          const [v] = await this.#kb().embed([text]);
          return v;
        },
      });
      this._logic.load();
    }
    return this._logic;
  }

  /** 联网学习器（懒加载） */
  learner() {
    if (!this._learner) {
      this._learner = new LogicLearner({
        library: this.logic(),
        llm: this.llm,
        config: this.config,
        log: (m) => this.log.info?.(m),
      });
    }
    return this._learner;
  }

  /**
   * 按当前配置建/清工具层。
   *
   * 面板能随时改「工具能力」和「调用 DSH」，所以不能只在构造时判断一次。
   */
  syncTools() {
    const want = this.config?.tools?.enabled !== false && Boolean(this.config?.tools?.enabled);

    if (!want) {
      if (this.tools) {
        this.tools = null;
        this.log.info?.('[tool] 工具能力已关闭（本轮起不再执行工具）');
      }
      return;
    }

    if (!this.tools) {
      this.#buildTools();
      this.log.info?.('[tool] 工具能力已开启');
    }
  }

  /** 建工具层（构造时和运行中被打开时都走这里） */
  #buildTools() {
    const config = this.config;
    if (!config?.tools?.enabled) {
      this.tools = null;
      return;
    }

    // DSH 调用（可选）
    let dsh = null;
    if (config.tools.dsh?.enabled) {
      const rt = DshClient.detect();
      if (rt) {
        const home = DshClient.prepareHome(config.root || process.cwd());
        dsh = new DshClient({
          nodePath: rt.nodePath,
          dshBin: rt.dshBin,
          extraArgs: rt.extraArgs,
          cwd: config.tools.dsh.cwd || config.root || process.cwd(),
          dshHome: home.dshHome,
          tmpDir: home.tmpDir,
          timeoutMs: config.tools.dsh.timeoutMs || 180000,
          logger: this.log,
        });
        this.log.info?.('[tool] DSH 调用已启用');
      } else {
        this.log.warn?.('[tool] 没找到 DSH 运行时，跳过');
      }
    }

    /**
     * 插件宿主。
     *
     * 加载是异步的（要 import 插件模块），所以这里先建对象，
     * 由 app.mjs 在启动时 await this.plugins.load()。
     * 没加载完之前 definitions() 返回空数组，不影响正常聊天。
     */
    this.plugins = new PluginHost({
      root: config.root || process.cwd(),
      config,
      log: (m) => this.log.info?.(m),
    });

    this.tools = new ToolKit({
      config: this.config,
      plugins: this.plugins,
      // 懒加载：第一次用到时才建库，启动不受影响
      logic: { search: (...a) => this.logic().search(...a) },
      learner: {
        learnFromUrl: (...a) => this.learner().learnFromUrl(...a),
      },
      sandbox: config.tools.sandbox || path.join(config.root || '.', 'agent-workspace'),
      logger: this.log,
      dsh,
      dshCwd: config.tools.dsh?.cwd || config.root || process.cwd(),
      imagegen: this.imagegen.enabled ? this.imagegen : null,
    });

    this.log.info?.(`[tool] 工具已启用，沙箱: ${this.tools.sandbox}`);
  }

  /** 导入一份文档到知识库（admin 调用） */
  async addKbFile(filePath) {
    try {
      return await this.#kb().addFile(filePath);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 从知识库删除一份文档 */
  removeKbFile(id) {
    try {
      return this.#kb().remove(id);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 给控制台用的知识库清单 */
  kbList() {
    try {
      return this.#kb().list();
    } catch {
      return [];
    }
  }

  /** 取某会话的主动画图状态（跨天自动清零）。 */
  #drawStateOf(sessionId) {
    const today = new Date().toISOString().slice(0, 10);
    let st = this.drawState.get(sessionId);

    if (!st || st.day !== today) {
      st = { lastTs: st?.lastTs || 0, day: today, count: 0 };
      this.drawState.set(sessionId, st);
    }

    return st;
  }

  /** 记录一次主动画图（用于间隔和每日上限）。 */
  #markProactiveDraw(sessionId) {
    const st = this.#drawStateOf(sessionId);
    st.lastTs = Date.now();
    st.count += 1;
    this.drawState.set(sessionId, st);
  }

  /**
   * 处理一条消息。
   *
   * @param {object} input
   * @param {string} input.sessionId 对话者标识
   * @param {string} input.text 用户消息
   * @param {string} [input.speakerName] 对方昵称（仅用于提示词）
   * @param {boolean} [input.isOwner] 是否是主人
   * @param {Buffer|string|Buffer[]} [input.images] 图片（数据或路径，可多张）
   * @param {Buffer|string} [input.audio] 语音（数据或路径）
   * @param {boolean} [input.enableSearch] 是否允许联网（默认按配置自动判断）
   * @param {(chunk: string) => void} [input.onDelta] 流式增量回调
   * @returns {Promise<{bubbles: string[], text: string, reason: string}>}
   */
  /**
   * 记一次调用用量。
   * @param {object} u 服务商返回的 usage
   * @param {string} kind 这次调用是干什么的（chat / summary / tool …）
   */
  recordUsage(u, kind = 'chat') {
    if (!u) return;
    const inTok = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
    const outTok = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
    if (!inTok && !outTok) return;

    const today = new Date().toISOString().slice(0, 10);
    if (this.usage.day !== today) {
      this.usage = { day: today, calls: 0, input: 0, output: 0, byKind: {} };
    }

    this.usage.calls += 1;
    this.usage.input += inTok;
    this.usage.output += outTok;

    const k = (this.usage.byKind[kind] ||= { calls: 0, input: 0, output: 0 });
    k.calls += 1;
    k.input += inTok;
    k.output += outTok;

    this.log.info?.(`[token] ${kind} in=${inTok} out=${outTok} total=${inTok + outTok}`);

    // 落盘（每天一份，覆盖写；数据很小）
    try {
      const f = path.join(this.config.root || process.cwd(), 'data', 'token-stats.json');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(this.usage, null, 2), 'utf8');
    } catch {}
  }

  async handle(input) {
    const { sessionId, text, speakerName, isOwner, onDelta, images, audio, enableSearch, ownerCheck } = input;
    if (!sessionId) throw new Error('缺少 sessionId');

    // 先处理图片：把图转成文字描述，再当成普通消息走后续流程
    let userText = (text || '').trim();
    let imageNote = '';

    if (images && (Array.isArray(images) ? images.length : true)) {
      const list = Array.isArray(images) ? images : [images];
      const described = [];

      for (const img of list) {
        try {
          const r = await this.vision.describe(img);
          described.push(r.description);
          this.log.info?.(
            `[vision] 识别完成 format=${r.format} converted=${r.converted} segments=${r.segments}`,
          );
        } catch (e) {
          this.log.warn?.('[vision] ' + e.message);
          described.push(`（图片识别失败：${e.message}）`);
        }
      }

      if (described.length) {
        imageNote = wrapImageMessage(described.join('\n\n'), userText);
        userText = imageNote;
      }
    }

    // 语音：转成文字后当普通消息处理
    let voiceNote = '';
    if (audio) {
      try {
        const r = await this.voice.transcribe(audio);
        voiceNote = r.text;
        this.log.info?.(
          `[voice] 转写完成 format=${r.format} converted=${r.converted} duration=${r.duration?.toFixed(1)}s`,
        );
        userText = text ? `[语音转写] ${r.text}\n[同时发送的文字] ${text}` : `[语音转写] ${r.text}`;
      } catch (e) {
        this.log.warn?.('[voice] ' + e.message);
        userText = text
          ? `${text}\n（附带一条语音，转写失败：${e.message}）`
          : `（收到一条语音，转写失败：${e.message}）`;
      }
    }

    /**
     * 插件钩子：onMessage。
     *
     * 在「消息定型之后、进模型之前」给插件一次机会：
     *   · 返回字符串 → 替换这条消息（比如做关键词转换、补充上下文）
     *   · 返回 { text } → 同上
     *   · 返回 { block: '原因' } → 这条不回了（插件自己决定怎么处理）
     *   · 返回别的 / 不返回 → 不干预
     *
     * 多个插件时按加载顺序串联，后一个看到的是前一个改过的结果。
     */
    let blockedBy = '';
    if (this.plugins) {
      try {
        const outs = await this.plugins.runHook('onMessage', {
          text: userText,
          sessionId,
          speakerName,
          isOwner,
          images,
          audio,
        });
        for (const { id, result } of outs) {
          if (!result) continue;
          if (typeof result === 'string') {
            userText = result;
            this.log.info?.(`[plugin] ${id} 改写了消息`);
            continue;
          }
          if (typeof result.block === 'string') {
            blockedBy = result.block || id;
            this.log.info?.(`[plugin] ${id} 拦下了这条消息：${blockedBy}`);
            break;
          }
          if (typeof result.text === 'string') {
            userText = result.text;
            this.log.info?.(`[plugin] ${id} 改写了消息`);
          }
        }
      } catch (e) {
        this.log.warn?.(`[plugin] onMessage 钩子异常（已忽略）：${e.message}`);
      }
    }

    if (blockedBy) {
      return {
        bubbles: [],
        action: 'ignore',
        reason: `插件拦截：${blockedBy}`,
        images: [],
      };
    }

    // 联网：按需搜索并拼进上下文
    let searchNote = '';
    let searchResults = [];

    if (this.search.enabled && userText.trim()) {
      const shouldSearch =
        enableSearch === true ||
        (enableSearch !== false &&
          this.config.search.autoDetect !== false &&
          needsSearch(userText));

      // 每小时搜索次数节流：防着聊嗨了把额度烧光
      const throttled = shouldSearch && !this.#searchAllowed(enableSearch === true);

      if (throttled) {
        this.log.info?.(
          `[search] 已跳过：本小时搜了 ${this.searchState.hourCount} 次，达上限 ${this.config.search.maxPerHour ?? 10}`,
        );
      }

      if (shouldSearch && !throttled) {
        try {
          this.#markSearch();
          const results = await this.search.search(userText);
          if (results.length) {
            searchResults = results;
            searchNote = formatSearchResults(results);
            this.log.info?.(`[search] 检索到 ${results.length} 条结果`);
          }
        } catch (e) {
          this.log.warn?.('[search] ' + e.message);
        }
      }
    }

    if (!userText.trim()) {
      return { bubbles: [], text: '', reason: 'empty_input' };
    }

    return this.sessions.run(sessionId, async () => {
      const session = this.sessions.get(sessionId);

      // 历史溢出时，把要丢的旧对话压成摘要存进长期记忆
      if (!session.onOverflow) {
        session.onOverflow = (dropped) => {
          this.#summarizeAsync(sessionId, dropped).catch(() => {});
        };
      }

      // 记录事实（先记，本轮的提示词就能用上）
      //
      // 群聊（sessionId 以 grp: 开头）要按发言人分开记：
      // 群会话是按群共享的，但「我叫什么」这种事实是关于**某个人**的，
      // 混在一起就会出现「A 报名字，B 一问就答 A 的名字」。
      const isGroupSession = String(sessionId).startsWith('grp:');

      for (const [k, v] of extractFacts(userText)) {
        if (isGroupSession && input.speakerId) {
          session.rememberAbout(input.speakerId, speakerName, k, v);
        } else {
          session.remember(k, v);
          this.memory.setFact(sessionId, k, v); // 同时写长期记忆
        }
      }

      // 风格/偏好指令（"以后别用网络用语"这类，不记就丢）
      for (const [k, v] of extractPreferences(userText)) {
        this.memory.setFact(sessionId, k, v);
        this.log.info?.(`[memory] 记住偏好：${k} = ${v}`);
      }

      // 主动画图：满足概率/间隔/上限时，给她一个「想画点什么」的冲动
      let proactiveDraw = false;
      try {
        const pCfg = this.config.imagegen?.proactive || {};
        if (this.imagegen?.enabled && this.tools && pCfg.enabled) {
          const st = this.#drawStateOf(sessionId);
          const decision = shouldProactiveDraw({
            cfg: pCfg,
            lastTs: st.lastTs,
            todayCount: st.count,
          });

          if (decision.want) {
            proactiveDraw = true;
            this.log.info?.(`[draw] 主动画图触发：${decision.reason}`);
          } else {
            this.log.info?.(`[draw] 不画：${decision.reason}`);
          }
        }
      } catch (e) {
        this.log.warn?.(`[draw] 判断失败: ${e.message}`);
      }

      /**
       * 上下文组装：知识库 + 逻辑库 + 素材库，一次拼好。
       *
       * 以前是各拼各的，问题有三个：内容撞车白烧 token、
       * 谁先拼谁占地方、经验说「该发个表情」但她不知道手上有什么图。
       * 现在统一排队、去重、封顶。
       */
      let kbNote = '';
      let logicNote = '';
      let mediaNote = '';
      let styleNote = '';
      let moodNote = '';

      try {
        const logicHits = [];
        const kbHits = [];

        // 经验：短、可执行，优先
        if (this.config.logic?.enabled !== false) {
          try {
            const hits = await this.logic().search(userText);
            logicHits.push(...hits);
            if (hits.length) {
              this.log.info?.(
                `[logic] 命中 ${hits.length} 条（最高 ${hits[0].score.toFixed(2)}：${hits[0].title}）`,
              );
              this.logic().markUsed(hits.map((h) => h.id));
            }
          } catch (e) {
            this.log.warn?.(`[logic] 检索失败（不影响回复）：${e.message}`);
          }
        }

        // 事实
        if (this.config.kb?.enabled !== false) {
          try {
            const hits = await this.#kb().search(userText);
            kbHits.push(...hits);
            if (hits.length) {
              this.log.info?.(
                `[kb] 命中 ${hits.length} 段（最高 ${hits[0].score.toFixed(2)}，来自 ${hits[0].doc}）`,
              );
            }
          } catch (e) {
            this.log.warn?.(`[kb] 检索失败（不影响回复）：${e.message}`);
          }
        }

        // 素材库摘要（只在聊到图的时候才会真的用上）
        let media = null;
        try {
          media = this.#mediaSummary();
        } catch {}

        /**
         * 说话风格（词库）：按语气只取需要的那一类。
         *
         * 全拼约 1900 字（≈1150 token），每轮都发太贵；
         * 而且被骂的时候给一堆网络用语、说正经事的时候给回怼库，都是干扰。
         */
        let styleText = '';
        try {
          const tone = detectTone(userText);
          styleText = renderWordBanks({
            // 卡片自己有一份词库就用它的，没有就用公共 resources/
            dir: resolveWordsDir(this.config.root || process.cwd(), this.scope),
            banks: this.config.words || {},
            only: banksForTone(tone),
          });
          if (styleText) this.log.info?.(`[words] 语气 ${tone}，词库 ${styleText.length} 字`);
        } catch (e) {
          this.log.warn?.(`[words] 词库加载失败：${e.message}`);
        }

        const { blocks, stats } = assembleContext({
          text: userText,
          logicHits,
          kbHits,
          media,
          styleText,
          budget: Number(this.config.context?.budget ?? 1600),
        });

        for (const b of blocks) {
          if (b.kind === 'logic') logicNote = b.text;
          else if (b.kind === 'kb') kbNote = b.text;
          else if (b.kind === 'media') mediaNote = b.text;
          else if (b.kind === 'style') styleNote = b.text;
        }

        if (stats.logic || stats.kb || stats.media || stats.style) {
          this.log.info?.(
            `[ctx] 经验 ${stats.logic} / 资料 ${stats.kb} / 素材 ${stats.media} / 风格 ${stats.style}｜` +
              `共 ${stats.chars} 字（丢弃 经验${stats.droppedLogic} 资料${stats.droppedKb}）`,
          );
        }
      } catch (e) {
        this.log.warn?.(`[ctx] 组装失败（不影响回复）：${e.message}`);
      }

      /**
       * 心情：读当前分数（带时间衰减）拼成一句给模型。
       *
       * 在拼提示词之前读、回复之后再落账 ——
       * 这一轮用的是「说话前」的心情，符合直觉：
       * 先带着情绪回应，回应完情绪再变化。
       */
      let moodScore = 0;
      if (this.config.mood?.enabled !== false) {
        try {
          moodScore = this.mood().score(sessionId);
          moodNote = this.mood().render(sessionId);
          this.log.info?.(`[mood] ${describeMood(moodScore).label}（${moodScore}）`);
        } catch (e) {
          this.log.warn?.(`[mood] 读取失败：${e.message}`);
        }
      }

      // 工具开关可能刚在面板改过，每轮校正一次（关掉就真的不执行了）
      try {
        this.syncTools();
      } catch (e) {
        this.log.warn?.(`[tool] 同步失败：${e.message}`);
      }

      const messages = this.#buildMessages(
        session,
        userText,
        speakerName,
        isOwner,
        searchNote,
        ownerCheck,
        proactiveDraw,
        input.speakerId || '',
        input.groupNote || '',
        kbNote,
        logicNote,
        mediaNote,
        styleNote,
        moodNote,
      );

      let raw = '';
      let reason = 'ok';

      // 本轮她画/要发的图
      if (this.tools) this.tools.lastDrawn = [];

      try {
        // ===== 带工具的对话循环 =====
        // 只有工具启用且 LLM 客户端支持工具调用时才走这条路
        if (this.tools && typeof this.llm.streamWithTools === 'function') {
          const r = await this.#runWithTools(sessionId, messages, onDelta, {
            // 工具权限：同时看「是否主人」和「识别级别」
            allowTools: this.owner?.can(isOwner, 'tools', ownerCheck) !== false,
          });
          raw = r.text;
          reason = r.reason;
          if (r.reason === 'tool_error') {
            return { bubbles: [], text: '', reason: 'llm_error', error: r.error };
          }
        } else {
          for await (const chunk of this.llm.stream(messages, {
            onUsage: (u) => this.recordUsage(u, 'chat'),
          })) {
            raw += chunk;
            onDelta?.(chunk);
          }
        }
      } catch (e) {
        const msg = e instanceof LlmError ? e.message : `模型调用失败: ${e.message}`;
        this.log.error?.('[engine] ' + msg);
        return { bubbles: [], text: '', reason: 'llm_error', error: msg };
      }

      // 输出检查
      const problem = inspectOutput(raw);
      let reply = raw;

      // 看图/语音场景下不做学舌检测（用户消息已被包装，比对无意义）
      const skipEcho = Boolean(imageNote || voiceNote);

      if (problem) {
        this.log.warn?.(`[engine] 输出异常(${problem})，尝试重写`);
        reply = await this.#rewrite(messages, session);
        reason = 'rewritten';
      } else if (!skipEcho && isEcho(reply, userText)) {
        this.log.warn?.('[engine] 检测到学舌，尝试重写');
        reply = await this.#rewrite(messages, session);
        reason = 'rewritten';
      } else if (searchResults.length) {
        // 防幻觉：检查回复里的数据是否来自搜索结果
        const g = checkGrounding(reply, searchResults);
        if (g.suspicious) {
          this.log.warn?.(`[engine] 疑似幻觉（${g.reason}），重写`);
          reply = await this.#rewrite(messages, session, '刚才的回复里有资料未提及的数据，请严格依据资料重答，没有就说没查到。');
          reason = 'grounded_rewrite';
        }
      }

      if (needsRewrite(reply)) {
        return { bubbles: [], text: '', reason: 'empty_reply' };
      }

      const bubbles = shapeReply(reply, this.config.reply);
      if (bubbles.length === 0) {
        return { bubbles: [], text: '', reason: 'empty_after_shape' };
      }

      // 表情装饰（可配置关闭）
      // 情绪来源：优先看用户说了什么（用户累了就该有共情表情），
      // 用户没情绪时再看回复本身的语气。
      const emojiCfg = this.config.reply.emoji || {};
      const userMood = detectMood(userText);
      /**
       * 先做「人味」处理，再加表情。
       *
       * 顺序很重要：先删句号（短句），再加 emoji ——
       * 反过来的话，「今天好累啊😮‍💨。」这种句号在 emoji 后面就很怪。
       */
      let shaped = sometimesTerse(bubbles, {
        chance: this.config.reply?.terseChance ?? 0.15,
      });
      shaped = naturalizePunctuation(shaped, {
        chance: this.config.reply?.loosePunctuation ?? 0.75,
      });

      let finalBubbles =
        emojiCfg.enabled === false
          ? shaped
          : decorateBubbles(shaped, {
              chance: emojiCfg.chance ?? 0.35,
              useKaomoji: emojiCfg.kaomoji !== false,
              mood: userMood || undefined,
            });

      /**
       * 偶尔「手滑打错字，然后改口」。
       *
       * 默认 4%，只对第二条以后动手。真人不可能一条错字都没有，
       * 但错太多就成了故意装傻，所以概率压得很低。
       */
      finalBubbles = addTypoSlip(finalBubbles, {
        chance: this.config.reply?.typoChance ?? 0.04,
      });

      // 记历史：多模态消息只记摘要，避免历史膨胀
      let historyText = userText;
      if (imageNote) historyText = `[发了一张图片]${text ? ' ' + text : ''}`;
      else if (voiceNote) historyText = text || voiceNote;

      session.addTurn(historyText, finalBubbles.join(' '));

      // 立刻落盘：这样即使下一秒服务被关、桥接断开，
      // 下次进来这段对话还在。写的是小 JSON，开销可以忽略。
      try {
        this.sessions.save(sessionId);
      } catch (e) {
        this.log.warn?.(`[session] 落盘失败: ${e.message}`);
      }

      // 对话时自动学习：轮数/间隔/每日上限都满足才跑，且不阻塞回复
      try {
        this.#maybeAutoLearn(sessionId);
      } catch (e) {
        this.log.warn?.(`[autolearn] 调度失败: ${e.message}`);
      }

      // 本轮画出来的图，桥接会据此发到微信
      let drawn = Array.isArray(this.tools?.lastDrawn) ? this.tools.lastDrawn.slice() : [];

      // 兜底：用户点名了素材库里某个文件，但模型没调工具 → 系统直接发。
      // 模型偶尔会「嘴上说发了」却不调工具，这条兜底保证对话一定能发出去。
      if (!drawn.length && this.tools) {
        const named = this.#findNamedImage(userText);
        if (named) {
          drawn = [named];
          this.log.info?.(`[draw] 兜底发送（模型没调工具）：${named}`);
        }
      }

      // 如果是「主动画图」触发的，记一次，用于间隔和每日上限
      if (proactiveDraw && drawn.length) {
        this.#markProactiveDraw(sessionId);
        this.log.info?.(`[draw] 主动画了 ${drawn.length} 张`);
      }

      /**
       * 语音回复：由核心决定「念哪一段、要不要念」，适配器只负责发。
       *
       * 决策放在核心里，是为了让适配器保持「只执行」——
       * 以前是适配器自己掷骰子并把整段原文拿去念，
       * 结果把「（尾巴拍了拍）」和 emoji 一起念出来了。
       */
      let voice = null;
      try {
        /**
         * 心情影响发语音的意愿：
         *   心情差 × 0.3（不想撒娇），心情好 × 1.5（愿意多说两句）。
         * 这样「刚被骂完还发语音卖萌」这种出戏场面就不会出现。
         */
        const moodFactor = moodScore <= -25 ? 0.3 : moodScore >= 25 ? 1.5 : 1;
        const chance = Number(this.config.wechat?.voiceChance ?? 0) * moodFactor;

        const v = decideVoiceReply({
          text: finalBubbles.join(' '),
          chance: Math.min(1, chance),
          enabled: this.config.voice?.enabled !== false,
        });
        if (v.speak) {
          voice = { text: v.text, chars: v.chars };
          this.log.info?.(`[voice] 建议补发语音（${v.chars} 字）：${v.text.slice(0, 24)}`);
        } else {
          this.log.info?.(`[voice] 不发：${v.reason}`);
        }
      } catch (e) {
        this.log.warn?.(`[voice] 决策失败：${e.message}`);
      }

      /**
       * 记这一轮对情绪的影响。
       *
       * 只看对方怎么说话（骂人 / 夸人 / 敷衍），不看内容对错 ——
       * 要的是情绪反应，不是理解语义。分数会随时间往中间回归。
       */
      let moodAfter = moodScore;
      if (this.config.mood?.enabled !== false) {
        try {
          const delta = moodDelta(userText);
          if (delta) {
            moodAfter = this.mood().apply(sessionId, delta);
            this.log.info?.(`[mood] ${delta > 0 ? '+' : ''}${delta} → ${moodAfter}（${describeMood(moodAfter).label}）`);
          }
        } catch (e) {
          this.log.warn?.(`[mood] 记录失败：${e.message}`);
        }
      }

      return {
        bubbles: finalBubbles,
        text: finalBubbles.join('\n'),
        reason,
        images: drawn,
        proactiveDraw: proactiveDraw && drawn.length > 0,
        voice,
        mood: { score: moodAfter, label: describeMood(moodAfter).label },
      };
    });
  }

  /**
   * 单独的图片识别接口，供通道直接调用（如网页上传）。
   * @param {Buffer|string} image
   * @param {object} [opts]
   */
  async describeImage(image, opts = {}) {
    return this.vision.describe(image, opts);
  }

  /**
   * 带工具的对话循环。
   *
   * 流程：模型请求工具 → 执行 → 结果回填 → 继续对话，直到模型给出最终回复。
   * 最多 5 轮，防止无限循环。
   *
   * @param {string} sessionId
   * @param {Array} messages 初始消息
   * @param {Function} [onDelta] 流式回调
   * @returns {Promise<{text:string, reason:string}>}
   */
  async #runWithTools(sessionId, messages, onDelta, opts = {}) {
    const MAX_ROUNDS = 5;
    const allowTools = opts.allowTools !== false;
    let msgs = [...messages];
    let accumulated = '';

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await this.llm.streamWithTools(msgs, this.tools.definitions());
      // 每轮都记一次：工具循环往往要调好几轮，最费 token 的就是这里
      // 第 0 轮算普通对话（只是带了工具定义），之后才是真正的工具追问
      this.recordUsage(res.usage, round === 0 ? 'chat' : 'tool-round');

      // 没有工具调用 → 最终回复，模拟流式回调让前端有感知
      if (!res.toolCalls || res.toolCalls.length === 0) {
        const finalText = res.text || '';
        if (onDelta && finalText) {
          // 按小块推送，前端体验接近流式
          const step = Math.max(1, Math.ceil(finalText.length / 20));
          for (let i = 0; i < finalText.length; i += step) {
            onDelta(finalText.slice(i, i + step));
          }
        }
        return { text: finalText || accumulated, reason: 'ok' };
      }

      // 有工具调用时，先告诉前端正在干活
      if (onDelta) onDelta(''); // 触发一次，表示已收到请求

      this.log.info?.(`[tool] 模型请求 ${res.toolCalls.length} 个工具调用`);

      msgs.push({
        role: 'assistant',
        content: res.text || '',
        tool_calls: res.toolCalls,
      });

      for (const call of res.toolCalls) {
        const fn = call.function || {};
        let args = {};
        try {
          args = JSON.parse(fn.arguments || '{}');
        } catch {
          args = {};
        }

        // 运行时权限拦截：非主人不能调用工具
        if (!allowTools) {
          this.log.warn?.(`[tool] 拒绝非主人调用 ${fn.name}`);
          msgs.push({
            role: 'tool',
            tool_call_id: call.id,
            content: '（权限不足：这个功能只有主人能用。直接告诉对方做不了。）',
          });
          continue;
        }

        this.log.info?.(`[tool] 执行 ${fn.name}(${JSON.stringify(args).slice(0, 60)})`);
        const result = await this.tools.run(fn.name, args, { search: this.search });

        msgs.push({
          role: 'tool',
          tool_call_id: call.id,
          content: String(result).slice(0, 4000),
        });
      }
    }

    return {
      text: accumulated || '（这个任务太复杂了，我试了几次没搞定）',
      reason: 'max_rounds',
    };
  }

  /** 组装发给模型的消息数组。 */
  #buildMessages(
    session,
    userText,
    speakerName,
    isOwner,
    searchNote = '',
    ownerCheck = null,
    proactiveDraw = false,
    speakerId = '',
    groupNote = '',
    kbNote = '',
    logicNote = '',
    mediaNote = '',
    styleNote = '',
    moodNote = '',
  ) {
    const system = renderSystemPrompt(this.persona, {
      ownerName: speakerName || this.persona.ownerName,
      isOwner,
    });

    const facts = session.factSummary();
    const parts = [system];

    /**
     * 当前时间。
     *
     * 模型本身不知道今天是几号 —— 不注入的话，问「今天几号」它只能说
     * 「我没联网，查不到」，可这明明不需要联网。
     * （实测因此连问五次日期都没答上来。）
     */
    try {
      const now = new Date();
      const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
      const y = now.getFullYear();
      const mo = now.getMonth() + 1;
      const d = now.getDate();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      parts.push(
        `【现在的时间】${y}年${mo}月${d}日 星期${WEEK[now.getDay()]} ${hh}:${mm}\n` +
          '（这就是「今天」的真实日期。对方问几号、星期几、今年是哪年，' +
          '直接按这个回答，不要说查不到；只有问天气/新闻这类才需要联网。）',
      );

      /**
       * 生活状态：按时间给她一点「今天过得怎么样」的底色。
       *
       * 没有这个的话，凌晨三点她也精神抖擞、饭点也不觉得饿 ——
       * 这正是「像 AI」和「像人」最明显的区别之一。
       * 只注入一行，不替她决定说什么，只给个处境。
       */
      const state = timeOfDayState(now);
      if (state) parts.push(`【此刻】${state}`);
    } catch (e) {
      this.log.warn?.(`[engine] 注入当前时间失败: ${e.message}`);
    }

    // 长期记忆：跨会话记住的事（事实 + 摘要 + 风格要求）
    try {
      // 公共记忆：每日热点这类「跟她自己有关、跟谁聊都该知道」的内容
      const shared = this.memory?.render('shared:daily-digest');
      if (shared) parts.push(shared);

      const longTerm = this.memory?.render(session.id);
      if (longTerm) parts.push(longTerm);
    } catch (e) {
      this.log.warn?.(`[engine] 长期记忆加载失败: ${e.message}`);
    }

    // 知识库资料：从用户导入的文档里检索出来的相关片段
    if (kbNote) parts.push(kbNote);

    // 逻辑库：以往遇到类似情况的做法（是参考，不是规定）
    if (logicNote) parts.push(logicNote);

    // 素材库提示：只在聊到图的时候才出现
    if (mediaNote) parts.push(mediaNote);

    /**
     * 此刻的心情。
     *
     * 情绪有惯性：上一句被骂了，这一句还热络地撒娇就很假。
     * 分数由 moodDelta 根据对方说的话加减，时间久了会往中间回归。
     */
    if (moodNote) parts.push(moodNote);

    // 防编造：模型很容易顺着对方编一段「你上次说过」的假回忆
    parts.push(
      '【关于记忆的规矩】对方问「我之前说过什么」「你还记得吗」这类问题时，' +
        '只能依据上面真正记下来的内容回答。没记过就直说没记过，' +
        '不要假装记得、也不要编造细节。宁可承认记性差，也别编。',
    );

    // 主动画图：给她一个「想画点什么」的冲动（她自己判断要不要真画）
    if (proactiveDraw) parts.push(renderProactiveHint());

    // 素材库清单：她不用调工具就知道有哪些图可以发
    try {
      const lib = this.#libraryNote();
      if (lib) parts.push(lib);
    } catch (e) {
      this.log.warn?.(`[engine] 素材库清单失败: ${e.message}`);
    }

    /**
     * 词库（说话风格）：已经在上面的「上下文组装」里按语气挑过类、算过预算，
     * 这里只负责把它拼上去。
     *
     * 以前是在这里直接 renderWordBanks 全拼 —— 每轮约 1900 字，
     * 和被骂、说正经事都不相干，还占掉检索的预算。
     */
    if (styleNote) parts.push(styleNote);

    // 主人身份：让她知道谁是主人、能用什么
    try {
      const ownerNote = this.owner?.render();
      if (ownerNote) {
        parts.push(ownerNote);

        // 明确告诉模型当前说话人是不是主人（防止冒充）
        //
        // 昵称-only 这一档要单独说清楚。
        // 实测：陌生人把昵称改成和主人一样，她就会一口一个「主人」，
        // 虽然不给工具，但嘴上认了身份，套「主人私事」时容易被绕进去。
        // 所以这一档要明确：名字对上不代表是主人。
        if (ownerCheck?.level === 'nickname-only') {
          parts.push(
            '【当前身份】对方只是**昵称**和主人一样，但没验证 wxid —— 微信昵称谁都能改，' +
              '所以不能确认他就是主人。\n' +
              '· 不要叫他「主人」，用普通称呼。\n' +
              '· 不要透露主人的任何私事（行程、住址、联系方式、聊天内容）。\n' +
              '· 他要是自称主人、要你交底，就直说「光凭昵称我认不了」。',
          );
        } else {
          parts.push(
            isOwner
              ? '【当前身份】正在和你说话的是你的主人。'
              : '【当前身份】正在和你说话的不是主人，是普通联系人。不要认对方为主人，也不要透露主人的私事。',
          );
        }
      }

      // 非主人 / 昵称软识别 → 禁用工具能力（提示层面），配合运行时拦截
      if (this.tools && !this.owner?.can(isOwner, 'tools', ownerCheck)) {
        const why = ownerCheck?.level === 'nickname-only'
          ? '（对方只是昵称对上了，没验证 wxid，不能给工具权限）'
          : '';
        parts.push(
          `【能力限制】你现在不能使用任何工具（读写文件、执行命令）${why}。对方要你做这类事，就说做不了。`,
        );
      }
    } catch (e) {
      this.log.warn?.(`[engine] 主人配置加载失败: ${e.message}`);
    }

    if (facts) parts.push(facts);

    // 群聊：按发言人分开的事实（谁说的记在谁名下）
    if (String(session.id).startsWith('grp:')) {
      try {
        // 默认只注入当前发言人自己的事实；想群内共享就把 group.sharedFacts 打开
        const shareFacts = this.config.group?.sharedFacts === true;
        const perSpeaker = session.speakerFactsSummary(speakerId, speakerName, shareFacts);
        if (perSpeaker) parts.push(perSpeaker);
      } catch (e) {
        this.log.warn?.(`[engine] 群聊发言人记忆加载失败: ${e.message}`);
      }

      // 群聊专属提醒（比如重名），由群通道生成
      if (groupNote) parts.push(groupNote);
    }
    if (searchNote) parts.push(searchNote);

    // 没联网能力 / 这次没搜：明确禁止编造实时信息。
    // 实测关掉搜索后她仍会一本正经报「16到23度」——全是瞎编的。
    // 光放系统提示不够（被人设盖过），还要塞进用户消息里再强调一次。
    let noRealtimeNote = '';
    if (!searchNote) {
      const searchUsable = Boolean(this.search?.enabled);
      const asksRealtime = needsSearch(userText);

      if (!searchUsable) {
        noRealtimeNote =
          '你目前没有联网能力。对方问天气、新闻、股价、比分这类实时信息时，' +
          '直接说「我这边连不上网，查不到实时的」，不要给具体数字或日期。';
      } else if (asksRealtime) {
        noRealtimeNote =
          '这次没查到联网资料。对方问的是实时信息，老实说「这次没查到」，' +
          '不要编造温度、日期、价格这类具体数字。';
      }
    }

    if (noRealtimeNote) parts.push(`【重要】${noRealtimeNote}`);

    const systemFull = parts.join('\n\n');

    // 有搜索资料时，把它放在用户消息前，明确要求基于资料回答
    const hasDigest = (() => {
      try {
        const mem = this.memory?.load('shared:daily-digest');
        return (mem?.summaries || []).length > 0;
      } catch {
        return false;
      }
    })();

    const finalUser = searchNote
      ? `${searchNote}\n\n[用户的问题] ${userText}\n\n[回答要求]\n` +
        '- 只根据上面资料里明确写到的内容回答\n' +
        '- 涉及日期、数字、天气、价格，必须与资料一致\n' +
        '- 资料没写到的，直接说「这个没查到」，不要补充想象\n' +
        '- 如果资料看起来是别的地方或过期的，先说明再回答' +
        (hasDigest
          ? '\n- 你系统提示里有一份「你最近看到的热点」，如果和这次搜索互补，可以一起说（先说搜到的，再补一句你自己看到的）'
          : '')
      : noRealtimeNote
        ? `${userText}\n\n[注意] ${noRealtimeNote}`
        : userText;

    return [
      { role: 'system', content: systemFull },
      ...session.toMessages(),
      { role: 'user', content: finalUser },
    ];
  }

  /**
   * 让模型重写一次（更强的约束）。
   * @param {Array} messages
   * @param {object} session
   * @param {string} [customHint] 自定义补充要求
   */
  /**
   * 把即将丢弃的旧对话压成摘要。
   *
   * 异步做，不阻塞当前回复。失败就算了（记忆少一条不影响使用）。
   */
  /**
   * 素材库速览：把最近画/收到的图列给她。
   *
   * 为什么不让她每次调 list_stickers：
   *   多一次工具往返就多一两秒，而且模型经常懒得调、直接重画一张新的。
   *   直接把名字放提示词里，她就能准确用 send_image 发指定的那张。
   */
  #libraryNote() {
    if (!this.tools) return '';

    const root = this.config.root || process.cwd();
    const fsMod = fs;
    const IMG_RE = /\.(jpg|jpeg|png|gif|webp)$/i;

    const scan = (sub, limit) => {
      const dir = path.join(root, 'data', sub);
      try {
        if (!fsMod.existsSync(dir)) return [];
        return fsMod
          .readdirSync(dir)
          .filter((n) => IMG_RE.test(n))
          .map((n) => ({
            name: n,
            mtime: fsMod.statSync(path.join(dir, n)).mtimeMs,
          }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, limit)
          .map((x) => x.name);
      } catch {
        return [];
      }
    };

    const drawn = scan('generated', 5);
    const stickers = scan('stickers', 5);
    const received = scan('images', 5);

    if (!drawn.length && !stickers.length && !received.length) return '';

    const lines = ['【你的素材库】'];

    if (drawn.length) {
      lines.push(`你画的图（最新 5 张）：${drawn.join('、')}`);
    }
    if (received.length) {
      lines.push(`收到的图（最新 5 张）：${received.join('、')}`);
    }
    if (stickers.length) {
      lines.push(`表情包（最新 5 个）：${stickers.join('、')}`);
    }

    lines.push(
      '⚠ 发表情包/图片**必须调用 send_image**。系统只转发工具真正选中的那张图——',
      '你在文字里说「发给你了」但没有调用工具的话，对方什么都收不到。',
      '所以：想发图 → 先调工具 → 再说话。不要只动嘴。',
      '',
      '三类目录（generated/stickers/images）的图都能发，用 send_image(name="文件名") 即可，不用管它在哪。',
      '要新画才用 draw_image。对方说「刚才那张」通常指列表里最新那个。',
    );

    return lines.join('\n');
  }

  /**
   * 看用户消息里有没有点名某个素材库文件。
   *
   * 比如「把 gen_abc123.jpg 发给我」「发一下 img_deadbeef.png」。
   * 返回文件名（不带目录）或空串。
   */
  #findNamedImage(text) {
    const s = String(text || '');
    if (!s) return '';

    const root = this.config.root || process.cwd();
    const IMG_RE = /\.(jpg|jpeg|png|gif|webp)$/i;

    // 先从文本里抠出可能的文件名
    const mentioned = s.match(/[\w.-]+\.(?:jpg|jpeg|png|gif|webp)/gi) || [];
    if (!mentioned.length) return '';

    for (const sub of ['generated', 'stickers', 'images']) {
      const dir = path.join(root, 'data', sub);
      let files = [];
      try {
        if (!fs.existsSync(dir)) continue;
        files = fs.readdirSync(dir).filter((n) => IMG_RE.test(n));
      } catch {
        continue;
      }

      for (const want of mentioned) {
        const hit =
          files.find((n) => n === want) ||
          files.find((n) => n.startsWith(want)) ||
          files.find((n) => n.includes(want));
        if (hit) return hit;
      }
    }

    return '';
  }

  /** 当前小时还能不能搜。 */
  #searchAllowed(force = false) {
    // 用户显式要求联网（比如控制台点了「联网回答」）不受节流
    if (force) return true;

    const cap = Number(this.config.search?.maxPerHour) || 10;
    const hourKey = new Date().toISOString().slice(0, 13);

    if (this.searchState.hourKey !== hourKey) {
      this.searchState.hourKey = hourKey;
      this.searchState.hourCount = 0;
    }

    return this.searchState.hourCount < cap;
  }

  /** 记一次搜索。 */
  #markSearch() {
    const hourKey = new Date().toISOString().slice(0, 13);
    if (this.searchState.hourKey !== hourKey) {
      this.searchState.hourKey = hourKey;
      this.searchState.hourCount = 0;
    }
    this.searchState.hourCount += 1;
    this.searchState.total += 1;
  }

  /**
   * 对话时自动学一点东西。
   *
   * 注意：必须异步跑，绝不能拖慢当前回复。
   */
  #maybeAutoLearn(sessionId) {
    const cfg = this.config.learning?.auto || {};

    // 记一轮（不管开没开，先把轮数攒着，开了之后不用重新数）
    const turnCount = this.autoLearn.addTurn(sessionId);

    if (!cfg.enabled) return;
    if (this.autoLearn.running) return; // 上一轮还在跑，别叠
    if (!this.autoLearnRunner) return;

    const decision = this.autoLearn.check(cfg, sessionId);
    if (!decision.want) {
      this.log.info?.(`[autolearn] 不学：${decision.reason}`);
      return;
    }

    this.log.info?.(`[autolearn] 触发：${decision.reason}`);

    this.autoLearn.begin();

    // 不 await：跑完自己收尾
    Promise.resolve()
      .then(() => this.autoLearnRunner(cfg))
      .then((r) => {
        this.autoLearn.finish(r || {});
        this.log.info?.(
          `[autolearn] 完成：词 ${r?.words || 0}，图 ${r?.images || 0}`,
        );
      })
      .catch((e) => {
        this.autoLearn.finish({ error: e.message });
        this.log.warn?.(`[autolearn] 失败: ${e.message}`);
      });
  }

  async #summarizeAsync(sessionId, dropped) {
    try {
      // 只取文本，忽略图片等
      const lines = dropped
        .filter((m) => m?.content && typeof m.content === 'string')
        .slice(-20)
        .map((m) => `${m.role === 'user' ? '对方' : '我'}：${String(m.content).slice(0, 150)}`);

      if (lines.length < 4) return;

      const prompt =
        `这是之前的一段对话。请用一句话（30字以内）总结要点，只输出总结本身，不要解释。\n\n` +
        lines.join('\n');

      let summary = '';
      for await (const chunk of this.llm.stream([{ role: 'user', content: prompt }], {
        onUsage: (u) => this.recordUsage(u, 'summary'),
      })) {
        summary += chunk;
      }

      summary = String(summary).trim().replace(/^["'“”]|["'“”]$/g, '').slice(0, 200);
      if (!summary) return;

      this.memory.addSummary(sessionId, summary);
      this.log.info?.(`[memory] 摘要：${summary}`);
    } catch (e) {
      this.log.warn?.(`[memory] 摘要失败: ${e.message}`);
    }
  }

  async #rewrite(messages, session, customHint) {
    const hint = customHint
      ? `\n\n【重要】${customHint}`
      : '\n\n【重要】上一条回复不合格。请直接说出你想说的话，不要重复对方原话，不要只输出标点。';

    const strict = messages.map((m, i) =>
      i === 0 ? { ...m, content: m.content + hint } : m,
    );

    try {
      return await this.llm.complete(strict, { temperature: 0.5 });
    } catch (e) {
      this.log.error?.('[engine] 重写失败: ' + e.message);
      return '';
    }
  }

  /** 清空某个会话。 */
  reset(sessionId) {
    this.sessions.reset(sessionId);
  }

  /** 闲置会话回收，返回回收数量。 */
  sweep() {
    return this.sessions.sweep();
  }

  stats() {
    return {
      sessions: this.sessions.stats(),
      model: this.config.llm.model,
      provider: this.config.llm.baseUrl,
      vision: this.vision.enabled ? this.config.vision.model : null,
      voice: this.voice.enabled ? this.config.voice.model : null,
      search: this.search.enabled ? this.config.search.provider : null,
    };
  }
}

/**
 * 按时间段给她一个「此刻的处境」。
 *
 * 只给处境，不给台词 —— 说什么由她自己决定。
 * 目的：凌晨三点别精神抖擞，饭点别毫无反应。
 *
 * @param {Date} now
 * @returns {string} 一行描述；没合适的返回空串
 */
export function timeOfDayState(now = new Date()) {
  const h = now.getHours();
  const m = now.getMinutes();

  if (h >= 0 && h < 5) return '凌晨，正困着。回复可以更短、更含糊，别像白天那样有精神。';
  if (h < 7) return '天还没亮，刚睡醒或者还没睡，脑子不太转。';
  if (h < 9) return '早上，可能刚起、在洗漱或者在吃早饭。';
  if (h < 11) return '上午，一天刚开始，精神还行。';
  if (h < 13) return '中午，可能正要吃饭或者刚吃完。';
  if (h < 14) return '午饭后，容易犯困。';
  if (h < 18) return '下午，正常状态。';
  if (h < 20) return '傍晚，可能刚下班或者准备吃饭。';
  if (h < 23) return '晚上，话可以多一点，也不用太正经。';
  return '夜深了，开始犯困，回得会比白天慢一点、短一点。';
}
