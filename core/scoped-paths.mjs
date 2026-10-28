/**
 * 按角色卡隔离的数据路径。
 *
 * 为什么需要：
 *   以前知识库、逻辑库、记忆都是全局一份 —— 换角色卡只换了 system 提示词，
 *   上一个角色的资料、经验、记忆全都还在，直接串味。
 *   比如客服卡会继承「被骂先别软」这条海王经验，一上来就开喷。
 *
 * 现在的布局：
 *
 *   data/
 *     dafeiyu/            ← 一张卡一个作用域
 *       kb/               知识库文档
 *       logic.json        经验
 *       memory/           记忆（每个会话一个文件）
 *     jingjing-wg/
 *       …
 *     _shared/            ← 所有卡共用（比如表情包素材、日志）
 *
 * 兼容老数据：启动时如果发现旧的全局目录还在、而当前卡的作用域还没有，
 * 就把老数据搬进当前卡，只搬一次。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 作用域目录名：卡 id 里可能有奇怪字符，清洗一下 */
export function scopeName(card) {
  const s = String(card || '')
    .replace(/[^\w.-]/g, '_')
    .trim();
  return s || 'default';
}

/** 某个作用域的根目录 */
export function scopeDir(root, card) {
  return path.join(root, 'data', scopeName(card));
}

/** 知识库目录 */
export function kbDir(root, card) {
  return path.join(scopeDir(root, card), 'kb');
}

/** 逻辑库文件 */
export function logicFile(root, card) {
  return path.join(scopeDir(root, card), 'logic.json');
}

/** 词库目录（按卡可以覆盖） */
export function wordsDir(root, card) {
  return path.join(scopeDir(root, card), 'words');
}

/**
 * 找词库目录：卡片自己有一份就用卡片的，没有就退回公共 resources/。
 *
 * 为什么这么设计：
 *   词库是「说话风格」。古风角色不该用「绝绝子」，
 *   但绝大多数人懒得为每张卡重写一遍 800 个词条 ——
 *   所以公共那份是默认，想改的卡自己覆盖。
 */
export function resolveWordsDir(root, card) {
  const scoped = wordsDir(root, card);
  try {
    const has = fs.existsSync(scoped) && fs.readdirSync(scoped).some((n) => n.endsWith('.txt'));
    if (has) return scoped;
  } catch {}
  return path.join(root, 'resources');
}

/**
 * 她画的图：按角色卡分开。
 *
 * 表情包和收到的图是共享的（换角色还能用同一批），
 * 但「她画的图」属于这个角色的创作，混在一起会很乱。
 */
export function generatedDir(root, card) {
  return path.join(scopeDir(root, card), 'generated');
}

/** 记忆目录 */
export function memoryDir(root, card) {
  return path.join(scopeDir(root, card), 'memory');
}

/** 老版本（全局）的那几个位置 */
export const LEGACY = {
  kb: (root) => path.join(root, 'data', 'kb'),
  logic: (root) => path.join(root, 'data', 'logic.json'),
  memory: (root) => path.join(root, 'data', 'memory'),
};

/**
 * 把老数据搬进指定卡片的作用域（只搬一次）。
 *
 * 规则：
 *   · 目标已存在 → 什么都不做（避免覆盖用户后来的数据）
 *   · 源不存在 → 什么都不做
 *   · 都是目录 → 整个目录改名过去
 *   · 是单文件 → 改名过去
 *
 * @returns {{moved:string[], skipped:string[]}}
 */
export function migrateLegacyToScope(root, card) {
  const moved = [];
  const skipped = [];
  const check = [
    ['kb', LEGACY.kb(root), kbDir(root, card)],
    ['logic', LEGACY.logic(root), logicFile(root, card)],
    ['memory', LEGACY.memory(root), memoryDir(root, card)],
    ['generated', path.join(root, 'data', 'generated'), generatedDir(root, card)],
    /**
     * 会话历史（老版本一直是全局 data/sessions）。
     *
     * 换卡串历史就是因为它没跟着卡走：新角色能答出上一个角色聊过的内容。
     * 升级时把旧的搬进当前卡，之后按卡分开存。
     */
    ['sessions', path.join(root, 'data', 'sessions'), path.join(scopeDir(root, card), 'sessions')],
  ];

  for (const [name, from, to] of check) {
    try {
      if (!fs.existsSync(from)) continue;
      if (fs.existsSync(to)) {
        skipped.push(`${name}（目标已有数据，保留原样）`);
        continue;
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      moved.push(name);
    } catch (e) {
      // 跨盘改名会失败，退回复制
      try {
        const [from2, to2] = [from, to];
        fs.cpSync(from2, to2, { recursive: true });
        fs.rmSync(from2, { recursive: true, force: true });
        moved.push(`${name}（复制）`);
      } catch (e2) {
        skipped.push(`${name}（迁移失败：${e2.message}）`);
      }
    }
  }

  return { moved, skipped };
}
