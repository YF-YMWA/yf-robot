/**
 * 自动清理残留进程（启动时跑一次）。
 *
 * 为什么需要：反复启停会留下后台进程，用户任务管理器里能看到上百个终端窗口。
 * 手动清理要记得点，自动清理才治本。
 *
 * 安全边界（宁可少清，不可错杀）：
 *   1. 只清「命令行里含本程序目录」的进程
 *   2. 永不碰：当前进程、父进程链、正在运行的适配器（读 data/adapter-*.pid）
 *   3. 只清「启动超过 N 分钟」的旧进程 —— 刚起来的可能是正在启动的服务/适配器
 *   4. 默认只清 node/cmd/powershell/python 这几类，别的名字不碰
 *   5. 每条都写日志，清了多少、跳过了谁、为什么
 */
import fs from 'node:fs';
import path from 'node:path';
import { scan, killPids, ownRoots } from './proc-clean.mjs';

/** 从 pid 文件里读出正在运行的适配器 pid */
function protectedAdapterPids(root) {
  const out = new Set();
  try {
    const dir = path.join(root, 'data');
    for (const f of fs.readdirSync(dir)) {
      if (!/^adapter-.*\.pid$/.test(f)) continue;
      const n = Number(fs.readFileSync(path.join(dir, f), 'utf8').trim());
      if (Number.isFinite(n) && n > 0) out.add(n);
    }
  } catch {}
  return out;
}

/** 父进程链（向上最多 4 层），这些不能动 */
function ancestorPids() {
  const out = new Set();
  let pid = process.pid;
  for (let i = 0; i < 4; i++) {
    try {
      const list = fs.existsSync('/proc') ? [] : null;
      // Windows 上没有 /proc；用 wmic 太慢，这里只保护直接父进程
      if (i === 0 && process.ppid) out.add(process.ppid);
      if (i > 0) break;
      pid = process.ppid;
    } catch {
      break;
    }
  }
  return out;
}

/**
 * 跑一次自动清理。
 *
 * @param {string} root
 * @param {object} [opts]
 * @param {number} [opts.minAgeMinutes=10] 只清启动超过这么多分钟的
 * @param {Function} [opts.log]
 * @returns {{scanned:number, killed:number[], skipped:{pid:number,why:string}[], protectedPids:number[]}}
 */
export function autoCleanOnStart(root, opts = {}) {
  const minAge = Number(opts.minAgeMinutes ?? 10);
  const log = opts.log || (() => {});

  const roots = ownRoots(root);
  const scanFn = opts.scanFn || scan;
  const killFn = opts.killFn || killPids;
  const ours = scanFn(roots);
  if (!ours.length) {
    // 没扫到也要说一声：否则用户不知道这个功能到底跑没跑
    log('[proc] 自动清理：没有发现本程序遗留的进程');
    return { scanned: 0, killed: [], skipped: [], protectedPids: [] };
  }

  const keep = new Set([process.pid, ...ancestorPids()]);
  const adapters = protectedAdapterPids(root);
  for (const p of adapters) keep.add(p);

  // 只处理常见的控制台类进程，别的名字不碰（防止误杀编辑器等）
  const ALLOW_NAMES = /^(node|python|cmd|powershell|pwsh|conhost)\.exe$/i;

  const now = Date.now();
  const candidates = [];
  const skipped = [];

  for (const p of ours) {
    if (keep.has(p.pid)) {
      skipped.push({ pid: p.pid, why: '正在使用（当前服务/父子进程/适配器）' });
      continue;
    }
    if (!ALLOW_NAMES.test(String(p.name || ''))) {
      skipped.push({ pid: p.pid, why: '不是控制台类进程：' + p.name });
      continue;
    }
    // 启动时间解析（CIM 给的是 /Date(…)/ 或 ISO）
    let started = 0;
    try {
      const m = String(p.startedAt || '').match(/\/Date\((\d+)\)\//);
      started = m ? Number(m[1]) : Date.parse(p.startedAt);
    } catch {}
    if (!started) {
      skipped.push({ pid: p.pid, why: '拿不到启动时间（不确定新旧，保守跳过）' });
      continue;
    }
    const ageMin = (now - started) / 60000;
    if (ageMin < minAge) {
      skipped.push({ pid: p.pid, why: `才启动 ${ageMin.toFixed(0)} 分钟，可能还在用` });
      continue;
    }
    candidates.push(p.pid);
  }

  if (!candidates.length) {
    // 一条日志都不打的话，用户没法确认「到底跑没跑」
    log(
      `[proc] 自动清理：扫到 ${ours.length} 个，没有可清的` +
        (skipped.length ? `（跳过 ${skipped.length} 个）` : ''),
    );
    return { scanned: ours.length, killed: [], skipped, protectedPids: [...adapters] };
  }

  const r = killFn(candidates, roots);
  log(
    `[proc] 自动清理：扫到 ${ours.length} 个，清掉 ${r.killed.length} 个` +
      (r.failed.length ? `，${r.failed.length} 个没成功` : '') +
      (skipped.length ? `，跳过 ${skipped.length} 个` : ''),
  );

  return { scanned: ours.length, killed: r.killed, skipped, protectedPids: [...adapters] };
}
