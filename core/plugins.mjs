/**
 * 插件系统：让别人也能给她加功能，不用改核心代码。
 *
 * 一个插件就是一个目录：
 *
 *   plugins/
 *     my-plugin/
 *       plugin.json     ← 清单（名字、版本、提供哪些工具、挂了哪些钩子）
 *       index.mjs       ← 入口（导出工具实现和钩子）
 *
 * 能做的事：
 *   · 提供工具（模型可以调用，像 search_web 一样）
 *   · 挂 onMessage 钩子（消息进模型之前，可以改写、补充或拦下）
 *   · 挂 afterReply 钩子（回复之后，可以再做点事）
 *   · 读写自己的数据目录（互相隔离，不会串）
 *
 * 安全边界（重要，文档里也写了）：
 *   插件和核心在**同一个进程**里跑，能碰 Node 的一切。
 *   所以「只能装你信任的插件」——这里不做沙箱，做不到也不该假装能做到。
 *   能做的是：出错不影响别人、超时自动放弃、禁用后不再加载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 单个工具调用的默认超时 */
const DEFAULT_TOOL_TIMEOUT = 20000;
/** 钩子的默认超时（钩子挡在主流程上，不能让它拖太久） */
const DEFAULT_HOOK_TIMEOUT = 8000;

/**
 * 把 Promise 包一层超时。
 * 超时不代表对方停了 —— 只是我们不等了，免得整个聊天卡死。
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms).unref?.(),
    ),
  ]);
}

export class PluginHost {
  /**
   * @param {object} opts
   * @param {string} opts.root 项目根目录
   * @param {object} opts.config 核心配置
   * @param {Function} [opts.log]
   */
  constructor({ root, config, log = () => {} }) {
    this.root = path.join(root, 'plugins');
    this.stateFile = path.join(root, 'data', 'plugins.json');
    this.config = config;
    this.log = log;
    /** id → { manifest, module, state, error } */
    this.plugins = new Map();
    /** 工具全名 → { pluginId, toolId, schema } */
    this.toolIndex = new Map();
    this.loaded = false;
  }

  /** 读「启用/禁用」状态 */
  #readState() {
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }

  #writeState(state) {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, this.stateFile);
    } catch (e) {
      this.log(`[plugin] 保存状态失败：${e.message}`);
    }
  }

  /** 插件自己的数据目录 */
  dataDirOf(id) {
    return path.join(this.root, '..', 'data', 'plugin-data', id);
  }

  /**
   * 给插件用的上下文。
   *
   * 只暴露「够用且不容易出事」的东西：
   * 日志、配置里自己的那一段、自己的数据目录、fetch。
   * 不直接给 engine —— 那等于把内部结构全抖出去，插件会写得很脆。
   */
  #makeContext(id) {
    const dataDir = this.dataDirOf(id);
    const cfg = (this.config.plugins?.items || {})[id] || {};

    return {
      id,
      log: (...a) => this.log(`[plugin:${id}]`, ...a),
      config: cfg,
      dataDir,
      /** 读自己的 JSON 数据（不存在返回 fallback） */
      loadData(name, fallback = null) {
        try {
          const file = path.join(dataDir, `${name}.json`);
          return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          return fallback;
        }
      },
      /** 写自己的 JSON 数据 */
      saveData(name, value) {
        try {
          fs.mkdirSync(dataDir, { recursive: true });
          const file = path.join(dataDir, `${name}.json`);
          const tmp = file + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
          fs.renameSync(tmp, file);
          return true;
        } catch (e) {
          this.log(`[plugin:${id}] 写数据失败：${e.message}`);
          return false;
        }
      },
      /** 网络请求（直接给全局 fetch） */
      fetch: (...a) => fetch(...a),
      /** 当前时间，方便做「今天」「几点」这类 */
      now: () => new Date(),
    };
  }

  /** 扫描并加载所有插件 */
  async load() {
    if (this.loaded) return this;
    this.loaded = true;

    if (!fs.existsSync(this.root)) {
      try {
        fs.mkdirSync(this.root, { recursive: true });
      } catch {}
      this.log('[plugin] 还没有 plugins/ 目录，跳过');
      return this;
    }

    const state = this.#readState();
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (e) {
      this.log(`[plugin] 读目录失败：${e.message}`);
      return this;
    }

    for (const id of dirs) {
      const dir = path.join(this.root, id);
      const manifestFile = path.join(dir, 'plugin.json');
      const entryFile = path.join(dir, 'index.mjs');

      if (!fs.existsSync(manifestFile)) {
        this.log(`[plugin] ${id} 缺 plugin.json，跳过`);
        continue;
      }

      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      } catch (e) {
        this.plugins.set(id, { id, error: `plugin.json 解析失败：${e.message}`, state: 'error' });
        continue;
      }

      // 默认启用；state 里明确 false 才关
      const enabled = state[id]?.enabled !== false;
      const rec = { id, manifest, state: enabled ? 'loaded' : 'disabled', dir };
      this.plugins.set(id, rec);
      if (!enabled) {
        this.log(`[plugin] ${id} 已禁用`);
        continue;
      }

      if (!fs.existsSync(entryFile)) {
        rec.state = 'error';
        rec.error = '缺 index.mjs';
        continue;
      }

      try {
        const mod = await import(pathToFileURL(entryFile).href);
        rec.module = mod.default || mod;
        // 生命周期：onLoad
        if (typeof rec.module.onLoad === 'function') {
          await withTimeout(
            Promise.resolve(rec.module.onLoad(this.#makeContext(id))),
            DEFAULT_HOOK_TIMEOUT,
            `${id}.onLoad`,
          );
        }
        this.#indexTools(rec);
        this.log(`[plugin] ${id} 已加载（${Object.keys(rec.toolImpls || {}).length} 个工具）`);
      } catch (e) {
        rec.state = 'error';
        rec.error = e.message;
        this.log(`[plugin] ${id} 加载失败：${e.message}`);
      }
    }

    return this;
  }

  /**
   * 收集插件里的工具实现。
   *
   * 三种写法都认，插件作者怎么顺手怎么来：
   *   1. export const tools = { foo, bar }
   *   2. export function tools_foo() {}  /  tools_bar() {}
   *   3. 直接导出和工具同名的函数：export function foo() {}
   */
  #collectImpls(rec) {
    const mod = rec.module || {};
    const impls = {};

    if (mod.tools && typeof mod.tools === 'object') {
      for (const [k, v] of Object.entries(mod.tools)) {
        if (typeof v === 'function') impls[k] = v;
      }
    }
    for (const [k, v] of Object.entries(mod)) {
      if (typeof v !== 'function') continue;
      if (k.startsWith('tools_')) impls[k.slice('tools_'.length)] = v;
      else if (!impls[k] && k !== 'default') impls[k] = v;
    }
    return impls;
  }

  /** 把插件声明的工具登记到索引里 */
  #indexTools(rec) {
    const manifestTools = rec.manifest.tools || [];
    const impls = (rec.toolImpls = this.#collectImpls(rec));

    for (const t of manifestTools) {
      const toolName = String(t.name || '').trim();
      if (!toolName) continue;
      if (typeof impls[toolName] !== 'function') {
        this.log(`[plugin] ${rec.id} 的清单里声明了 ${toolName}，但没实现，跳过`);
        continue;
      }

      // 名字冲突就加前缀，避免覆盖内置工具（search_web 之类）
      let full = toolName;
      if (this.toolIndex.has(full)) full = `${rec.id}_${toolName}`;
      if (this.toolIndex.has(full)) {
        this.log(`[plugin] ${rec.id}.${toolName} 名字冲突，跳过`);
        continue;
      }

      this.toolIndex.set(full, {
        pluginId: rec.id,
        toolId: toolName,
        schema: {
          type: 'function',
          function: {
            name: full,
            description: String(t.description || '').slice(0, 200),
            parameters: t.parameters || { type: 'object', properties: {} },
          },
        },
      });
    }
  }

  /** 给模型看的工具定义 */
  definitions() {
    return [...this.toolIndex.values()].map((t) => t.schema);
  }

  /** 这个名字是不是插件工具 */
  hasTool(name) {
    return this.toolIndex.has(name);
  }

  /**
   * 执行插件工具。
   * @returns {Promise<string>} 结果文本（永远不抛，出错也变成一句话）
   */
  async runTool(name, args = {}) {
    const entry = this.toolIndex.get(name);
    if (!entry) return `（没有这个工具：${name}）`;

    const rec = this.plugins.get(entry.pluginId);
    const fn = rec?.toolImpls?.[entry.toolId];
    if (typeof fn !== 'function') return `（插件 ${entry.pluginId} 的工具不可用）`;

    try {
      const out = await withTimeout(
        Promise.resolve(fn(args, this.#makeContext(entry.pluginId))),
        DEFAULT_TOOL_TIMEOUT,
        `${name}`,
      );
      return typeof out === 'string' ? out : JSON.stringify(out ?? '');
    } catch (e) {
      this.log(`[plugin] ${name} 执行失败：${e.message}`);
      return `（工具 ${name} 出错了：${e.message}）`;
    }
  }

  /**
   * 跑一组钩子。
   *
   * 每个插件都可能挂同一个钩子；一个出错不影响下一个。
   * @returns {Promise<Array<{id:string, result:any}>>}
   */
  async runHook(hookName, payload) {
    const results = [];
    for (const rec of this.plugins.values()) {
      if (rec.state !== 'loaded') continue;
      const fn = rec.module?.[hookName];
      if (typeof fn !== 'function') continue;
      try {
        const r = await withTimeout(
          Promise.resolve(fn(payload, this.#makeContext(rec.id))),
          DEFAULT_HOOK_TIMEOUT,
          `${rec.id}.${hookName}`,
        );
        results.push({ id: rec.id, result: r });
      } catch (e) {
        this.log(`[plugin] ${rec.id}.${hookName} 出错：${e.message}`);
      }
    }
    return results;
  }

  /** 控制台用的清单 */
  list() {
    return [...this.plugins.values()].map((r) => ({
      id: r.id,
      name: r.manifest?.name || r.id,
      version: r.manifest?.version || '',
      description: r.manifest?.description || '',
      author: r.manifest?.author || '',
      state: r.state,
      error: r.error || '',
      tools: (r.manifest?.tools || []).map((t) => t.name),
      hooks: Object.keys(r.module || {}).filter(
        (k) => typeof r.module[k] === 'function' && k.startsWith('on'),
      ),
    }));
  }

  /** 启用/禁用（下次启动生效） */
  setEnabled(id, enabled) {
    if (!this.plugins.has(id)) return { ok: false, error: '没有这个插件' };
    const state = this.#readState();
    state[id] = { ...(state[id] || {}), enabled: Boolean(enabled) };
    this.#writeState(state);
    const rec = this.plugins.get(id);
    return {
      ok: true,
      note: '已保存，重启服务后生效',
      id,
      willBe: enabled ? 'enabled' : 'disabled',
      current: rec.state,
    };
  }
}
