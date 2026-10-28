/**
 * 记忆备份 / 恢复。
 *
 * 为什么要做：更新时最怕「记忆没了」。用户实际踩过的场景 ——
 * 把新版本解压到**新文件夹**，新目录没有 data/，看起来就是谁都不认识了。
 * 参考 whale_gril 的 备份记忆.bat / 恢复记忆.bat，做成同一套能力。
 *
 * 设计取舍：
 *   · 只备份「记忆和设置」，不备份素材图片（动辄几百 MB，备份文件会没法用）
 *   · 配置里的 Key 会一起导出 —— 恢复时提醒用户别把这个文件发给别人
 *   · 恢复前自动存一份 before-restore 快照，手滑了还能回去
 *   · 启动时自动快照，保留最近 20 份（和它一样的策略）
 */
import fs from 'node:fs';
import path from 'node:path';

const SNAPSHOT_DIR = path.join('data', 'backups');
const KEEP = 20;

/** 不备份的东西 */
const SKIP = new Set(['stickers', 'images', 'generated', 'media-cache', 'tmp', 'backups', 'stickers-trash']);

function stamp() {
  /**
   * 精确到毫秒。
   *
   * 只到秒的话，同一秒内连点两次「备份」会写到同一个文件名 ——
   * 后一份把前一份盖掉，用户以为备份了其实只有一份（测试里就是这么发现的）。
   */
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    d.getFullYear() +
    '-' + p(d.getMonth() + 1) +
    '-' + p(d.getDate()) +
    '_' + p(d.getHours()) +
    '-' + p(d.getMinutes()) +
    '-' + p(d.getSeconds()) +
    '-' + p(d.getMilliseconds(), 3)
  );
}

function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function listCards(root) {
  const base = path.join(root, 'data');
  const out = [];
  try {
    for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (SKIP.has(ent.name)) continue;
      // 卡片目录里至少有 memory 或 sessions 才算
      const has = ['memory', 'sessions', 'logic.json', 'kb'].some((x) =>
        fs.existsSync(path.join(base, ent.name, x)),
      );
      if (has) out.push(ent.name);
    }
  } catch {}
  return out;
}

/**
 * 打包一份记忆备份。
 *
 * @param {string} root 项目根
 * @returns {{file:string, bytes:number, cards:string[], counts:object}}
 */
export function exportBundle(root) {
  const cards = listCards(root);
  const bundle = {
    kind: 'yf-robot-memory',
    version: 1,
    at: new Date().toISOString(),
    cards: {},
    config: readJsonSafe(path.join(root, 'config.json')),
    shared: {
      // 共享的记忆（老版本可能还在全局目录）
      memory: readJsonSafe(path.join(root, 'data', 'memory'), null),
    },
  };

  const counts = { memories: 0, sessions: 0, logic: 0, kb: 0 };

  for (const card of cards) {
    const dir = path.join(root, 'data', card);
    const entry = { memory: {}, sessions: {}, logic: null, kb: [] };

    // 记忆：每个会话一个 json
    const memDir = path.join(dir, 'memory');
    if (fs.existsSync(memDir)) {
      for (const f of fs.readdirSync(memDir)) {
        if (!f.endsWith('.json')) continue;
        const j = readJsonSafe(path.join(memDir, f));
        if (j) {
          entry.memory[f] = j;
          counts.memories++;
        }
      }
    }

    // 会话历史
    const sesDir = path.join(dir, 'sessions');
    if (fs.existsSync(sesDir)) {
      for (const f of fs.readdirSync(sesDir)) {
        if (!f.endsWith('.json')) continue;
        const j = readJsonSafe(path.join(sesDir, f));
        if (j) {
          entry.sessions[f] = j;
          counts.sessions++;
        }
      }
    }

    // 逻辑库
    const logicFile = path.join(dir, 'logic.json');
    if (fs.existsSync(logicFile)) {
      entry.logic = readJsonSafe(logicFile);
      if (entry.logic) counts.logic++;
    }

    // 知识库：只存文件名和大小，正文可能是几 MB 的文档，不塞进 json
    const kbDir = path.join(dir, 'kb');
    if (fs.existsSync(kbDir)) {
      try {
        for (const f of fs.readdirSync(kbDir)) {
          const st = fs.statSync(path.join(kbDir, f));
          entry.kb.push({ name: f, size: st.size });
          counts.kb++;
        }
      } catch {}
    }

    bundle.cards[card] = entry;
  }

  const dir = path.join(root, SNAPSHOT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'memory-' + stamp() + '.json');
  const text = JSON.stringify(bundle);
  fs.writeFileSync(file, text, 'utf8');

  return {
    file,
    bytes: Buffer.byteLength(text),
    cards,
    counts,
  };
}

/** 清理旧快照，只留最近 KEEP 份 */
export function pruneSnapshots(root, keep = KEEP) {
  const dir = path.join(root, SNAPSHOT_DIR);
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /^memory-.*\.json$/.test(f))
      .sort();
  } catch {
    return 0;
  }
  const extra = files.slice(0, Math.max(0, files.length - keep));
  let removed = 0;
  for (const f of extra) {
    try {
      fs.unlinkSync(path.join(dir, f));
      removed++;
    } catch {}
  }
  return removed;
}

/**
 * 从备份恢复。
 *
 * @param {string} root
 * @param {object} bundle exportBundle 产出的对象
 * @param {object} [opts] { dryRun }
 */
export function restoreBundle(root, bundle, opts = {}) {
  if (!bundle || bundle.kind !== 'yf-robot-memory') {
    throw new Error('这个文件不是 YF-Robot 的记忆备份');
  }

  const cards = Object.keys(bundle.cards || {});
  const plan = { cards, memories: 0, sessions: 0, logic: 0 };

  for (const card of cards) {
    const e = bundle.cards[card] || {};
    plan.memories += Object.keys(e.memory || {}).length;
    plan.sessions += Object.keys(e.sessions || {}).length;
    if (e.logic) plan.logic++;
  }

  if (opts.dryRun) return { ok: true, dryRun: true, plan };

  // 恢复前先存一份，手滑了能回去
  let safety = null;
  try {
    safety = exportBundle(root).file;
  } catch {}

  const write = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  };

  for (const card of cards) {
    const e = bundle.cards[card] || {};
    const dir = path.join(root, 'data', card);

    for (const [f, data] of Object.entries(e.memory || {})) {
      write(path.join(dir, 'memory', f), data);
    }
    for (const [f, data] of Object.entries(e.sessions || {})) {
      write(path.join(dir, 'sessions', f), data);
    }
    if (e.logic) write(path.join(dir, 'logic.json'), e.logic);
  }

  // 配置也一起恢复（Key、主人名单都在里面）
  if (bundle.config && typeof bundle.config === 'object') {
    const cfgFile = path.join(root, 'config.json');
    if (fs.existsSync(cfgFile)) {
      try {
        fs.copyFileSync(cfgFile, cfgFile + '.before-restore');
      } catch {}
    }
    fs.writeFileSync(cfgFile, JSON.stringify(bundle.config, null, 2), 'utf8');
  }

  return { ok: true, plan, safety };
}

/** 列出现有快照 */
export function listSnapshots(root) {
  const dir = path.join(root, SNAPSHOT_DIR);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^memory-.*\.json$/.test(f))
      .sort()
      .reverse()
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, bytes: st.size, at: st.mtime.toISOString() };
      });
  } catch {
    return [];
  }
}
