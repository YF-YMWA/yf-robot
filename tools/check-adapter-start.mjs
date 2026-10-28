/**
 * 验证适配器的启动命令拼装（不弹 UAC，只检查字符串）。
 */
import path from 'node:path';
import { buildStartCommand, findAdapter, status, stop, tailLog } from '../core/adapter-runner.mjs';

const root = process.cwd();
const c = buildStartCommand(root);

if (!c) {
  console.log('  没有适配器目录（这是纯框架包）—— 跳过');
  process.exit(0);
}

console.log('  python   :', path.basename(path.dirname(c.python)) + '/' + path.basename(c.python));
console.log('  工作目录 :', path.basename(c.adapterDir));
console.log('  cmdLine  :', c.cmdLine);
console.log('  PS 参数  :', c.psArgs[2]);
console.log('');

const checks = [
  ['带 -Verb RunAs（会提权）', c.psArgs[2].includes('-Verb RunAs')],
  ['带 -PassThru（拿 PID）', c.psArgs[2].includes('-PassThru')],
  // 转义坏掉时会变成 "\ = Start-Process"、"\)"、"\.Id" 这种
  [
    'PowerShell 变量完好',
    /\$p\s*=\s*Start-Process/.test(c.psArgs[2]) &&
      c.psArgs[2].includes('{ $p.Id }') &&
      !/\\\s*=|\\\)|\\\.Id/.test(c.psArgs[2]),
  ],
  ['工作目录指向适配器', c.psArgs[2].includes(path.basename(c.adapterDir))],
  ['命令里是固定入口', c.cmdLine.includes('wechatauto_bridge.py')],
  ['输出重定向到日志', c.cmdLine.includes('>') && c.cmdLine.includes('panel-run.log')],
  ['不包含用户可控命令', !c.cmdLine.includes('\n')],
];

let bad = 0;
for (const [name, ok] of checks) {
  console.log('  ' + (ok ? 'OK ' : 'XX ') + name);
  if (!ok) bad++;
}

console.log('');
const st = status(root);
console.log('  状态:', st.running ? '运行中' : '未运行', '| 模式:', st.mode);
console.log('  停止（没在跑时应返回 ok）:', JSON.stringify(stop(root)));

console.log('');
console.log(bad ? '  ✗ ' + bad + ' 项不合格' : '  ✓ 全部合格');
process.exit(bad ? 1 : 0);
