/**
 * 残留进程：看清楚、清干净。
 *
 * 现象（用户截图）：任务管理器里「终端」有 162 个窗口。
 * 原因是反复启停服务/适配器，每次都会起一个控制台进程，
 * 旧的没人收 —— 越积越多，占内存也让人以为中了病毒。
 *
 * 这里按「命令行里含我们自己的目录」来认领进程：
 *   · 只认本程序目录下的（不误伤别的 node/python）
 *   · 永不杀自己和自己的父进程
 *   · 杀掉前先列出来，让人看清楚再动手
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 拿所有进程（含命令行）。Windows 用 CIM，其它平台返回空。 */
export function listAll() {
  if (process.platform !== 'win32') return [];
  try {
    const ps = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress -Depth 3",
    ];
    const out = execFileSync('powershell.exe', ps, {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    const j = JSON.parse(out || '[]');
    return Array.isArray(j) ? j : [j];
  } catch {
    return [];
  }
}

/** 命令行里有没有我们自己的目录 */
function belongsToUs(cmdline, roots) {
  const s = String(cmdline || '').toLowerCase();
  if (!s) return false;
  return roots.some((r) => r && s.includes(r.toLowerCase()));
}

/**
 * 列出属于本程序的进程。
 *
 * @param {string[]} roots 关心的目录（程序根、适配器目录…）
 */
export function scan(roots) {
  const all = listAll();
  const self = process.pid;
  const parent = process.ppid;

  return all
    .filter((p) => p && p.ProcessId && p.ProcessId !== self && p.ProcessId !== parent)
    .filter((p) => belongsToUs(p.CommandLine, roots))
    .map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      name: p.Name,
      // 不截断：判断「是不是我们的进程」要靠完整命令行，截断会把路径切掉
      cmd: String(p.CommandLine || '').replace(/\s+/g, ' '),
      startedAt: p.CreationDate || '',
    }));
}

/**
 * 结束指定进程（只允许结束 scan() 里认领过的）。
 *
 * @returns {{killed:number[], failed:{pid:number,why:string}[]}}
 */
export function killPids(pids, roots) {
  const ours = new Set(scan(roots).map((p) => p.pid));
  const killed = [];
  const failed = [];

  for (const raw of pids || []) {
    const pid = Number(raw);
    if (!pid || !ours.has(pid)) {
      failed.push({ pid, why: '不是本程序的进程（不杀）' });
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
      killed.push(pid);
    } catch (e) {
      // Windows 上 node 只能 SIGTERM==强制结束，失败就记下来
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          timeout: 8000,
          windowsHide: true,
        });
        killed.push(pid);
      } catch (e2) {
        failed.push({ pid, why: String(e2.message || e.message).slice(0, 80) });
      }
    }
  }
  return { killed, failed };
}

/** 本程序相关的目录（用于认领进程） */
export function ownRoots(root) {
  return [root, path.join(root, '..', 'yf-robot-wechat-adapter'), path.join(root, 'adapters')];
}
