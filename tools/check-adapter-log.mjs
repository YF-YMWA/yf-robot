/**
 * 适配器日志体检。
 *
 * 用户说「看日志聊天记录」——这脚本把日志里真正的问题统计出来：
 *   · 发送成功率、耗时分布
 *   · 失败按原因归类
 *   · 窗口/焦点相关的问题（托盘、拒绝访问）
 *   · 图片发送的重试（GIF → 压缩 → 静帧）
 *   · 适配器 ↔ 核心 的 HTTP 异常
 *
 * 用法：node tools/check-adapter-log.mjs [行数，默认最近 3000 行]
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX = Number(process.argv[2]) || 3000;

/** 找适配器日志 */
function findLog() {
  const candidates = [
    path.join(process.cwd(), '..', 'yf-robot-wechat-adapter', 'data', 'wechat-bridge-4x.log'),
    path.join(process.cwd(), 'adapter', 'data', 'wechat-bridge-4x.log'),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) return f;
  }
  return '';
}

const file = findLog();
if (!file) {
  console.log('  没找到适配器日志（纯框架包？或者还没启动过适配器）');
  process.exit(0);
}

const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const lines = all.slice(-MAX);

console.log('  日志:', file.replace(process.cwd() + path.sep, ''));
console.log('  总行数:', all.length, '| 本次分析最近', lines.length, '行');
console.log('');

const pick = (re) => lines.filter((l) => re.test(l));

// ===== 发送 =====
const okSends = pick(/发送成功/);
const failSends = pick(/发送未成功|发送失败|发送结果：False|没发出去/);
const times = okSends
  .map((l) => Number((l.match(/（([\d.]+)s）/) || [])[1]))
  .filter((n) => Number.isFinite(n));

console.log('【发送】');
console.log('  成功:', okSends.length, '| 失败:', failSends.length);
if (times.length) {
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const max = Math.max(...times);
  const min = Math.min(...times);
  console.log(
    '  耗时: 平均 ' + avg.toFixed(2) + 's，最快 ' + min.toFixed(1) + 's，最慢 ' + max.toFixed(1) + 's',
  );
}

// ===== 失败归类 =====
if (failSends.length) {
  console.log('');
  console.log('【失败原因】');
  const buckets = {};
  for (const l of failSends) {
    const key = (l.match(/[（(](.{2,40}?)[）)]/) || [])[1] || l.replace(/^\[[^\]]*\]\s*/, '').slice(0, 40);
    buckets[key] = (buckets[key] || 0) + 1;
  }
  Object.entries(buckets)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .forEach(([k, n]) => console.log('   ' + n + '× ' + k));
}

// ===== 窗口 / 焦点 =====
const winIssues = pick(/托盘|SetForegroundWindow|拒绝访问|窗口自检|调出失败/);
console.log('');
console.log('【窗口】');
console.log('  相关日志:', winIssues.length, '条');
winIssues.slice(-4).forEach((l) => console.log('   ' + l.slice(0, 100)));

// ===== 图片 =====
const imgRetry = pick(/GIF|表情包|图片|静帧|压缩后重试/);
console.log('');
console.log('【图片】');
console.log('  相关日志:', imgRetry.length, '条');
imgRetry.slice(-4).forEach((l) => console.log('   ' + l.slice(0, 100)));

// ===== 与核心通信 =====
const httpIssues = pick(/请求 YF-Robot 失败|上传核心失败|ReadTimeout|ConnectionError|ConnectionReset/);
console.log('');
console.log('【适配器 ↔ 核心】');
console.log('  通信异常:', httpIssues.length, '条');
httpIssues.slice(-3).forEach((l) => console.log('   ' + l.slice(0, 110)));

// ===== 稳定性（本轮新加）=====
const stability = pick(/连续发送失败|重建 UIA 缓存|跳过发送/);
if (stability.length) {
  console.log('');
  console.log('【稳定性机制触发】');
  stability.slice(-5).forEach((l) => console.log('   ' + l.slice(0, 110)));
}

// ===== 结论 =====
console.log('');
console.log('【结论】');
const failRate = okSends.length + failSends.length
  ? failSends.length / (okSends.length + failSends.length)
  : 0;

if (!okSends.length && !failSends.length) {
  console.log('  最近没有发送记录');
} else if (failRate > 0.3) {
  console.log('  ✗ 失败率 ' + Math.round(failRate * 100) + '%，明显偏高 —— 先查窗口是否在托盘/是否掉登录');
} else if (failRate > 0.05) {
  console.log('  ! 失败率 ' + Math.round(failRate * 100) + '%，有偶发失败（GIF/大图常见）');
} else {
  console.log('  ✓ 失败率 ' + Math.round(failRate * 100) + '%，看起来很稳');
}

if (times.length && Math.max(...times) > 15) {
  console.log('  ! 有单条发送超过 15 秒 —— 那几次可能卡在窗口恢复或 OCR 兜底');
}
