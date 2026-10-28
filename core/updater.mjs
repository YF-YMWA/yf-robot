/**
 * 一键更新：下载新版本、覆盖代码、保留配置和数据。
 *
 * 设计原则（很重要）：
 *   · **只覆盖代码**，绝不碰 config.json 和 data/ —— 那里面是你的 Key 和记忆
 *   · 动手之前先备份（配置 + 数据里的 json，不含图片视频）
 *   · 只在「确实有新版本」时才动手
 *   · 更新完不自动重启（重启会断微信），只告诉你「重启后生效」
 *
 * 不支持的情况会明确拒绝，而不是装作成功：
 *   · git 工作副本里跑（有本地提交，覆盖会丢东西）→ 让你自己 git pull
 *   · 没有可下载的源码包 → 给你链接
 */
import fs from 'node:fs';
import path from 'node:path';
import { unzipAll, stripRootDir } from './zip.mjs';

/** 更新时允许覆盖的「代码」路径（其余一律不动） */
const CODE_ENTRIES = [
  'app.mjs',
  'menu.mjs',
  'setup.mjs',
  'launch_background.mjs',
  'package.json',
  'core',
  'channels',
  'web',
  'tools',
  'scripts',
  'docs',
  'examples',
  'resources',
  'tests',
  'plugins',
  'cards',
  'persona.json',
  'config.example.json',
  'README.md',
  'CHANGELOG.md',
  'NOTICE',
  'LICENSE',
  'YF-Robot.bat',
  '启动服务.bat',
  '工具菜单.bat',
  '状态面板.bat',
  '桌面控制台.bat',
  '桌面聊天.bat',
];

/** 备份时排除的重目录（图片/缓存/临时） */
const BACKUP_SKIP = new Set([
  'stickers',
  'images',
  'generated',
  'media-cache',
  'tmp',
  'app-profile',
  'app-profile-chat',
  'backup',
]);

/** 递归复制，跳过 BACKUP_SKIP 里的目录 */
function copyShallow(src, dst, depth = 0) {
  fs.mkdirSync(dst, { recursive: true });
  let count = 0;
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (depth === 0 && BACKUP_SKIP.has(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      count += copyShallow(s, d, depth + 1);
    } else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

/** 写文件（自动建目录，防止 zip 里的路径穿越） */
function writeInside(root, rel, data) {
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root) + path.sep)) return false;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  return true;
}

/**
 * 执行更新。
 *
 * @param {object} opts
 * @param {string} opts.root 项目根
 * @param {string} opts.repo GitHub 仓库（owner/name）
 * @param {string} opts.latest 目标版本（不带 v）
 * @param {string} opts.local 当前版本
 * @param {Function} [opts.log]
 * @returns {Promise<{ok:boolean, steps:string[], error?:string}>}
 */
export async function applyUpdate({ root, repo, latest, local, log = () => {} }) {
  const steps = [];

  if (!latest || latest === local) {
    return { ok: false, steps, error: '已经是最新版（' + local + '），不需要更新' };
  }

  // git 工作副本：不动，让用户自己 pull（本地可能有提交）
  if (fs.existsSync(path.join(root, '.git'))) {
    return {
      ok: false,
      steps,
      error:
        '这是 git 工作副本，里面有你的提交。请自己在目录里执行 git pull（或 git checkout v' +
        latest +
        '），别用面板覆盖。',
    };
  }

  // ===== 1. 备份 =====
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(root, 'data', 'backup', 'update-' + stamp);
  try {
    const cfgFile = path.join(root, 'config.json');
    if (fs.existsSync(cfgFile)) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(cfgFile, path.join(backupDir, 'config.json'));
      steps.push('已备份 config.json');
    }
    const dataDir = path.join(root, 'data');
    if (fs.existsSync(dataDir)) {
      const n = copyShallow(dataDir, path.join(backupDir, 'data'));
      steps.push('已备份数据 ' + n + ' 个文件（不含图片/缓存）');
    }
  } catch (e) {
    return { ok: false, steps, error: '备份失败，已中止更新：' + e.message };
  }

  // ===== 2. 下载源码包 =====
  const url = 'https://github.com/' + repo + '/archive/refs/tags/v' + latest + '.zip';
  let buf;
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': 'YF-Robot' },
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    buf = Buffer.from(await r.arrayBuffer());
    steps.push('已下载 v' + latest + '（' + Math.round(buf.length / 1024) + ' KB）');
  } catch (e) {
    return { ok: false, steps, error: '下载失败：' + e.message + '（可以手动去 ' + url + '）' };
  }

  // ===== 3. 解压 + 只覆盖代码 =====
  let files;
  try {
    const all = unzipAll(buf);
    const { files: stripped } = stripRootDir(all);
    files = stripped;
    steps.push('解压出 ' + files.length + ' 个文件');
  } catch (e) {
    return { ok: false, steps, error: '解压失败：' + e.message };
  }

  let written = 0;
  let skipped = 0;
  for (const f of files) {
    const top = f.name.split('/')[0];
    if (!CODE_ENTRIES.includes(top)) {
      skipped++;
      continue;
    }
    try {
      if (writeInside(root, f.name, f.data)) written++;
    } catch (e) {
      return { ok: false, steps, error: '写入 ' + f.name + ' 失败：' + e.message };
    }
  }
  steps.push('覆盖了 ' + written + ' 个代码文件（跳过 ' + skipped + ' 个非代码文件）');

  // ===== 4. 版本号 =====
  try {
    const pkgFile = path.join(root, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    steps.push('版本号：' + local + ' → ' + pkg.version);
  } catch {}

  steps.push('配置和数据都保留了，备份在 data/backup/update-' + stamp);
  steps.push('重启服务后生效');

  log('[update] 更新到 ' + latest + '，覆盖 ' + written + ' 个文件');
  return { ok: true, steps };
}
