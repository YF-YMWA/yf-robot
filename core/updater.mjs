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
/**
 * 拉 URL 的二进制内容；证书类错误时降级重试一次。
 *
 * @param {string} url
 * @param {object} [opts] { headers, timeoutMs, log }
 * @returns {Promise<{ok:boolean, status:number, buf:Buffer, note?:string}>}
 */
async function fetchLoose(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const headers = opts.headers || {};

  try {
    const r = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, buf };
  } catch (e) {
    const certIssue = /certificate|CERT|SSL|TLS|self.signed|unable to verify/i.test(String(e.message));
    if (!certIssue) throw e;

    opts.log?.('[update] 证书校验失败，改用不校验证书的方式重试（本地代理/杀软的常见现象）');
    const https = await import('node:https');
    return await new Promise((resolve, reject) => {
      const req = https.get(
        url,
        { headers, rejectUnauthorized: false, timeout: timeoutMs },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              buf: Buffer.concat(chunks),
              note: '未校验证书',
            });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('超时')));
      req.on('error', reject);
    });
  }
}

export async function applyUpdate({
  root,
  repo,
  latest,
  local,
  includeAdapter = false,
  adapterRepo = 'YF-YMWA/yf-robot-wechat-adapter',
  log = () => {},
}) {
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
    // 先建目录：后面不管有没有东西要备份，位置总是确定的
    fs.mkdirSync(backupDir, { recursive: true });

    const cfgFile = path.join(root, 'config.json');
    if (fs.existsSync(cfgFile)) {
      fs.copyFileSync(cfgFile, path.join(backupDir, 'config.json'));
      steps.push('已备份 config.json');
    }

    /**
     * 适配器的配置也在这里备份，而不是等下载完再备 ——
     * 下载可能失败，但「先保住配置」不该依赖下载结果。
     */
    const acfgFile = path.join(root, 'adapter', 'config.json');
    if (fs.existsSync(acfgFile)) {
      fs.copyFileSync(acfgFile, path.join(backupDir, 'adapter-config.json'));
      steps.push('已备份 adapter/config.json');
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
    const r = await fetchLoose(url, {
      headers: { 'user-agent': 'YF-Robot' },
      timeoutMs: 120000,
      log: (m) => log(m),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    buf = r.buf;
    if (r.note) steps.push(r.note);
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

  // ===== 3.5 适配器（可选） =====
  if (includeAdapter) {
    const adapterDir = path.join(root, 'adapter');

    if (!fs.existsSync(adapterDir)) {
      steps.push('没有 adapter/ 目录，跳过适配器更新');
    } else if (fs.existsSync(path.join(adapterDir, '.git'))) {
      steps.push('adapter/ 是 git 副本，跳过（请自己 git pull）');
    } else {
      try {
        // 适配器仓库没有 tag 时退回 main 分支
        let ref = 'heads/main';
        let label = 'main（最新提交）';
        try {
          const tr = await fetch('https://api.github.com/repos/' + adapterRepo + '/tags?per_page=5', {
            headers: { 'user-agent': 'YF-Robot' },
            signal: AbortSignal.timeout(8000),
          });
          const tags = tr.ok ? await tr.json() : [];
          const first = Array.isArray(tags) && tags[0] ? String(tags[0].name || '') : '';
          if (first) {
            ref = 'tags/' + first;
            label = first;
          }
        } catch {
          // 查不到 tag 就用 main，不阻断
        }

        const aurl = 'https://github.com/' + adapterRepo + '/archive/refs/' + ref + '.zip';
        const ar = await fetchLoose(aurl, {
          headers: { 'user-agent': 'YF-Robot' },
          timeoutMs: 120000,
          log: (m) => log(m),
        });
        if (!ar.ok) throw new Error('HTTP ' + ar.status);
        const abuf = ar.buf;

        const aall = unzipAll(abuf);
        const { files: afiles } = stripRootDir(aall);

        // 这些不覆盖：你自己的配置、运行时数据、缓存
        const KEEP = /^(config\.json|data\/|__pycache__\/|\.git\/)|(\.pyc$)|(\.log$)/;

        let aw = 0;
        for (const f of afiles) {
          if (KEEP.test(f.name)) continue;
          if (writeInside(adapterDir, f.name, f.data)) aw++;
        }

        steps.push('适配器已更新到 ' + label + '（覆盖 ' + aw + ' 个文件，配置和数据保留）');
        log('[update] adapter -> ' + label);
      } catch (e) {
        steps.push('适配器更新失败（主程序已更新）：' + e.message);
      }
    }
  }

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
