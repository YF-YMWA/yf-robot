/**
 * 多适配器：发现 + 选择 + 单个管理。
 *
 * 约定（按优先级找）：
 *   1. `<项目>/adapters/<名字>/`        —— 推荐放法，一个适配器一个文件夹
 *        里面要有 `adapter.json`（清单，可选）和入口脚本
 *   2. `<项目>/adapter/`                —— 打包时的单适配器位置
 *   3. 隔壁 `../yf-robot-wechat-adapter` —— 开发时的位置
 *
 * 为什么用「文件夹 + 清单」：
 *   以前只有一个适配器，路径是写死的两个候选。要同时接微信和别的平台，
 *   就得让每个适配器自报家门（名字、入口、要不要管理员、说明），
 *   面板才能列出可选项 —— 这也正是用户要的「选择功能」。
 *
 * adapter.json 示例：
 *   {
 *     "name": "微信（UIA）",
 *     "entry": "wechatauto_bridge.py",
 *     "needsAdmin": true,
 *     "description": "操作微信窗口收发消息，需要管理员权限"
 *   }
 */
import fs from 'node:fs';
import path from 'node:path';

/** 常见的入口文件名（没写清单时按这个顺序猜） */
const ENTRY_CANDIDATES = ['wechatauto_bridge.py', 'adapter.py', 'main.py', 'bridge.py'];

/**
 * 列出一个适配器目录的元信息。
 *
 * @param {object} opts
 * @param {string} opts.dir 目录
 * @param {string} opts.id 标识（文件夹名）
 * @param {'adapters'|'bundled'|'sibling'} opts.mode 来源
 * @returns {object|null}
 */
function describe({ dir, id, mode }) {
  let manifest = {};
  const mf = path.join(dir, 'adapter.json');
  if (fs.existsSync(mf)) {
    try {
      manifest = JSON.parse(fs.readFileSync(mf, 'utf8')) || {};
    } catch {
      manifest = {};
    }
  }

  // 入口：清单优先，否则按候选名猜
  const entry =
    (manifest.entry && String(manifest.entry)) ||
    ENTRY_CANDIDATES.find((n) => fs.existsSync(path.join(dir, n))) ||
    '';

  if (!entry || !fs.existsSync(path.join(dir, entry))) return null;

  return {
    id,
    name: String(manifest.name || id),
    entry,
    dir,
    mode,
    description: String(manifest.description || ''),
    // 需要管理员权限才能操作别的程序的窗口（微信就是）
    needsAdmin: manifest.needsAdmin !== false,
    // git 副本：更新时不去覆盖它
    hasGit: fs.existsSync(path.join(dir, '.git')),
    // 有没有随包的 python（没有就用项目运行时的）
    hasRuntime: fs.existsSync(path.join(dir, 'runtime', 'python', 'python.exe')),
  };
}

/**
 * 找出所有能用的适配器。
 *
 * @param {string} root 项目根
 * @returns {Array<object>}
 */
export function listAdapters(root) {
  const out = [];
  const seen = new Set();

  const push = (item) => {
    if (!item) return;
    const key = fs.realpathSync.native
      ? safeReal(item.dir)
      : path.resolve(item.dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  // 1. adapters/<名字>/
  const base = path.join(root, 'adapters');
  try {
    if (fs.existsSync(base)) {
      for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const dir = path.join(base, ent.name);
        push(describe({ dir, id: ent.name, mode: 'adapters' }));
      }
    }
  } catch {}

  // 2. adapter/（打包形态）
  const bundled = path.join(root, 'adapter');
  if (fs.existsSync(bundled)) push(describe({ dir: bundled, id: 'adapter', mode: 'bundled' }));

  // 3. 隔壁仓库（开发形态）
  const sibling = path.join(path.dirname(root), 'yf-robot-wechat-adapter');
  if (fs.existsSync(sibling)) {
    push(describe({ dir: sibling, id: 'wechat-adapter', mode: 'sibling' }));
  }

  return out;
}

function safeReal(p) {
  try {
    return fs.realpathSync.native(p).toLowerCase();
  } catch {
    return path.resolve(p).toLowerCase();
  }
}

/**
 * 按 id 找适配器；不传 id 时返回第一个（保持旧的单适配器行为）。
 */
export function getAdapter(root, id) {
  const all = listAdapters(root);
  if (!all.length) return null;
  if (!id) return all[0];
  return all.find((a) => a.id === id) || null;
}
