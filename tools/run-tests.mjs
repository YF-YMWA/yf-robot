/**
 * 跑单元测试（跨平台可靠）。
 *
 * 为什么不用 `node --test tests/` 或 `node --test "tests/*.test.mjs"`：
 *   · 前者在 Windows 上会被当成模块路径（Cannot find module）
 *   · 后者依赖 Node 自己展开 glob，Node 20 不支持，CI 上直接报
 *     Could not find 'tests/*.test.mjs'
 *
 * 这里自己列文件再交给 node --test，任何版本、任何 shell 都一样。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const dir = path.join(ROOT, 'tests');

if (!fs.existsSync(dir)) {
  console.error('找不到 tests/ 目录');
  process.exit(1);
}

const files = fs
  .readdirSync(dir)
  .filter((n) => n.endsWith('.test.mjs'))
  .sort()
  .map((n) => path.join('tests', n));

if (!files.length) {
  console.error('tests/ 里没有 *.test.mjs');
  process.exit(1);
}

console.log(`跑 ${files.length} 个测试文件…`);

const child = spawn(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: ROOT,
});

child.on('exit', (code) => process.exit(code ?? 1));
