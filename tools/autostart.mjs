/**
 * 安装开机自启 —— 用启动文件夹方案，不需要管理员权限。
 *
 * 原理：在 shell:startup 目录放一个快捷方式，
 * Windows 登录后会执行它。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));

const action = process.argv[2] || 'install';

/** 启动文件夹路径。 */
function startupDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

const START_BAT = path.join(ROOT, '启动服务.bat');
const LINK_NAME = 'yf-robot-autostart.vbs';
const VBS = path.join(startupDir(), LINK_NAME);

/** 生成一个 VBS 脚本来无窗口启动。 */
function vbsContent() {
  // VBS 用 0 表示隐藏窗口
  return `Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "${ROOT.replace(/"/g, '""')}"
WshShell.Run """${START_BAT.replace(/"/g, '""')}"" /background", 0, False
`;
}

async function install() {
  const dir = startupDir();
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(START_BAT)) {
    throw new Error(`找不到 ${START_BAT}`);
  }

  fs.writeFileSync(VBS, vbsContent(), 'utf8');
  console.log('已安装开机自启');
  console.log(`  位置: ${VBS}`);
  console.log('');
  console.log('下次登录 Windows 会自动启动（无窗口）。');
}

async function uninstall() {
  if (fs.existsSync(VBS)) {
    fs.unlinkSync(VBS);
    console.log('已取消开机自启');
  } else {
    console.log('没有找到自启项，可能从未安装');
  }
}

async function status() {
  const exists = fs.existsSync(VBS);
  console.log(exists ? '✓ 开机自启已启用' : '✗ 开机自启未启用');
  if (exists) console.log(`  位置: ${VBS}`);
}

try {
  if (action === 'install') await install();
  else if (action === 'uninstall') await uninstall();
  else if (action === 'status') await status();
  else {
    console.log('用法: node tools/autostart.mjs [install|uninstall|status]');
    process.exit(1);
  }
} catch (e) {
  console.error('失败:', e.message);
  process.exit(1);
}
