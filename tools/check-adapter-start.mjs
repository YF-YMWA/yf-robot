/**
 * 验证适配器的启动方式（不弹 UAC，只检查生成的脚本和参数）。
 *
 * 上一版这里只检查命令行字符串，结果引号被转义坏了也没发现 ——
 * 面板显示「已启动」，实际 cmd 秒退。所以现在连 bat 内容一起验。
 */
import path from 'node:path';
import { buildStartCommand, status, stop, findBridgePid } from '../core/adapter-runner.mjs';

const root = process.cwd();
const c = buildStartCommand(root);

if (!c) {
  console.log('  没有适配器目录（纯框架包）—— 跳过');
  process.exit(0);
}

console.log('  启动脚本 :', c.launcher);
console.log('  PS 命令  :', c.psArgs[2]);
console.log('');
console.log('  bat 内容：');
console.log(
  c.bat
    .split('\r\n')
    .map((l) => '    ' + l)
    .join('\n'),
);
console.log('');

const ps = c.psArgs[2];
const checks = [
  ['带 -Verb RunAs（会提权）', ps.includes('-Verb RunAs')],
  ['带 -PassThru（拿 PID）', ps.includes('-PassThru')],
  ['PowerShell 变量完好', /\$p\s*=\s*Start-Process/.test(ps) && ps.includes('{ $p.Id }')],
  // 关键：参数里不能再出现 \" 这种 cmd 不认的转义
  ['参数里没有坏转义', !ps.includes('\\"')],
  ['只传一个 bat 路径（不塞命令）', ps.includes('.bat') && !ps.includes('>')],
  ['工作目录指向适配器', ps.includes(path.basename(c.adapterDir))],
  ['bat 里有 cd /d', c.bat.includes('cd /d')],
  ['bat 里是固定入口', c.bat.includes('wechatauto_bridge.py')],
  // 输出必须留在窗口里：适配器自己写日志，重定向会让窗口变空白
  ['bat 不重定向输出（窗口能看到识别过程）', !c.bat.includes('> "') && !c.bat.includes('2>&1')],
  ['bat 设了窗口标题', c.bat.includes('title ')],
  ['bat 强制 UTF-8（防乱码）', c.bat.includes('PYTHONIOENCODING')],
  ['bat 不含用户可控内容', !c.bat.includes('${') && !c.bat.includes('%1')],
];

let bad = 0;
for (const [name, ok] of checks) {
  console.log('  ' + (ok ? 'OK ' : 'XX ') + name);
  if (!ok) bad++;
}

console.log('');
const st = await status(root);
console.log('  当前状态:', st.running ? '运行中 pid=' + st.pid : '未运行', '| 模式:', st.mode);
console.log('  系统里的桥接进程:', (await findBridgePid()) || '无');
console.log('  停止:', JSON.stringify(await stop(root)));

console.log('');
console.log(bad ? '  ✗ ' + bad + ' 项不合格' : '  ✓ 全部合格');
process.exit(bad ? 1 : 0);
