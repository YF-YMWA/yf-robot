/**
 * 后台启动器：启动服务并记录 PID。
 *
 * 为什么不用 bat 里的 PowerShell Start-Process：
 *   在某些环境下重定向和 PID 写入不可靠，
 *   改用 node 自己 spawn，控制更精确。
 *
 * 用法: node launch_background.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const PID_FILE = path.join(DATA, 'app.pid');
const OUT_LOG = path.join(DATA, 'app.out.log');
const ERR_LOG = path.join(DATA, 'app.err.log');

fs.mkdirSync(DATA, { recursive: true });

// 检查是否已在运行
if (fs.existsSync(PID_FILE)) {
  const oldPid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  if (oldPid > 0) {
    try {
      process.kill(oldPid, 0); // 只检测存在性
      console.log(`已在运行（PID ${oldPid}）`);
      console.log('如需重启，先运行 stop.bat');
      process.exit(0);
    } catch {
      // 进程不存在，清理旧文件
      fs.unlinkSync(PID_FILE);
    }
  }
}

// 启动子进程，完全脱离父进程
const out = fs.openSync(OUT_LOG, 'a');
const err = fs.openSync(ERR_LOG, 'a');

const child = spawn(process.execPath, [path.join(ROOT, 'app.mjs'), '--no-open'], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', out, err],
  windowsHide: true,
});

child.unref();

fs.writeFileSync(PID_FILE, String(child.pid));
console.log(`已启动，PID ${child.pid}`);
console.log(`日志: ${OUT_LOG}`);
