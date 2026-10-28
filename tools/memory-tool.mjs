#!/usr/bin/env node
/**
 * 记忆备份 / 恢复的命令行工具（bat 会调它）。
 *
 * 用法：
 *   node tools/memory-tool.mjs export            备份一份
 *   node tools/memory-tool.mjs list              列出快照
 *   node tools/memory-tool.mjs restore --latest  恢复最新一份
 *   node tools/memory-tool.mjs restore <文件名>   恢复指定快照
 *
 * 为什么要有命令行版本：服务没在跑（或者打不开网页）的时候，
 * 也得能备份/恢复 —— 双击 bat 就行，不用先启动服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  exportBundle,
  listSnapshots,
  restoreBundle,
  pruneSnapshots,
} from '../core/memory-backup.mjs';

const ROOT = process.cwd();
const cmd = String(process.argv[2] || 'export').toLowerCase();

function human(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

if (cmd === 'export') {
  const r = exportBundle(ROOT);
  const pruned = pruneSnapshots(ROOT);
  console.log('  已备份：' + path.relative(ROOT, r.file));
  console.log('  大小  ：' + human(r.bytes));
  console.log('  卡片  ：' + (r.cards.join('、') || '（无）'));
  console.log(
    '  内容  ：记忆 ' +
      r.counts.memories +
      ' 条、会话 ' +
      r.counts.sessions +
      ' 个、逻辑库 ' +
      r.counts.logic +
      ' 份',
  );
  if (pruned) console.log('  顺手清掉 ' + pruned + ' 份旧快照（只留最近 20 份）');
  process.exit(0);
}

if (cmd === 'list') {
  const list = listSnapshots(ROOT);
  if (!list.length) {
    console.log('  （还没有备份，先双击「备份记忆.bat」）');
    process.exit(0);
  }
  console.log('  序号  时间                  大小      文件名');
  list.slice(0, 10).forEach((s, i) => {
    const t = new Date(s.at).toLocaleString('zh-CN');
    console.log('  ' + String(i + 1).padEnd(5) + t.padEnd(21) + human(s.bytes).padEnd(9) + s.name);
  });
  process.exit(0);
}

if (cmd === 'restore') {
  const arg = process.argv[3] || '--latest';
  const list = listSnapshots(ROOT);
  if (!list.length) {
    console.error('  [错误] 还没有任何备份，无法恢复。');
    process.exit(1);
  }

  let file = '';
  if (arg === '--latest') {
    file = list[0].name;
  } else if (/^\d+$/.test(arg)) {
    // 允许输入列表里的序号
    const idx = Number(arg) - 1;
    if (!list[idx]) {
      console.error('  [错误] 没有第 ' + arg + ' 份备份。');
      process.exit(1);
    }
    file = list[idx].name;
  } else {
    file = path.basename(arg);
  }

  const full = path.join(ROOT, 'data', 'backups', file);
  if (!fs.existsSync(full)) {
    console.error('  [错误] 找不到快照：' + file);
    process.exit(1);
  }

  const bundle = JSON.parse(fs.readFileSync(full, 'utf8'));
  const r = restoreBundle(ROOT, bundle);

  console.log('  已恢复：' + file);
  console.log('  卡片  ：' + r.plan.cards.join('、'));
  console.log(
    '  内容  ：记忆 ' + r.plan.memories + ' 条、会话 ' + r.plan.sessions + ' 个、逻辑库 ' + r.plan.logic + ' 份',
  );
  if (r.safety) console.log('  恢复前状态已存：' + path.relative(ROOT, r.safety));
  process.exit(0);
}

console.error('  用法：node tools/memory-tool.mjs export|list|restore [--latest|文件名|序号]');
process.exit(1);
