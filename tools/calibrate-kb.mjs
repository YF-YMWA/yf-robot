/**
 * 阈值校准：用几条典型查询看真实分数，决定 MIN_SCORE 该设多少。
 *
 * 太严 → 该引用的没引用；太松 → 什么话题都塞一段资料，答非所问。
 */
import fs from 'node:fs';
import path from 'node:path';
import { KnowledgeBase } from '../core/kb.mjs';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', 'kb-cal');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

// 造两份内容不同的资料
const docA = path.join(TMP, '公司制度.md');
fs.writeFileSync(docA, `# 公司制度

## 上班时间
每天早上九点上班，下午六点下班，中午休息一小时。

## 请假流程
请假需要提前一天在系统里提交，主管批准后生效。病假需要提供医院证明。

## 报销
差旅报销每月五号统一处理，需要附上发票原件。
`, 'utf8');

const docB = path.join(TMP, '产品说明.md');
fs.writeFileSync(docB, `# 产品说明

## 简介
这是一款人设化 AI 助手，可以接入微信聊天。

## 功能
支持角色卡、长期记忆、看图、画图、语音转写、联网搜索。

## 价格
个人使用免费，商用需要联系作者授权。
`, 'utf8');

const kb = new KnowledgeBase({ root: TMP, config: cfg, log: () => {} });
for (const f of [docA, docB]) {
  const r = await kb.addFile(f);
  if (!r.ok) {
    console.log('导入失败:', r.error);
    process.exit(1);
  }
}

const CASES = [
  ['几点上班？', true],
  ['请假怎么弄', true],
  ['报销什么时候处理', true],
  ['这个产品支持什么功能', true],
  ['多少钱', true],
  ['今天天气怎么样', false],
  ['帮我写段 Python 代码', false],
  ['你叫什么名字', false],
  ['土星环有多厚', false],
  ['我想吃火锅', false],
];

console.log('查询'.padEnd(28), '最高分', ' 命中', ' 期望');
console.log('─'.repeat(60));
let wrong = 0;
for (const [q, shouldHit] of CASES) {
  const hits = await kb.search(q, { topK: 3, minScore: 0 }); // 阈值 0，拿真实分数
  const top = hits[0];
  const score = top ? top.score : 0;
  const hit = score >= 0.30;
  const ok = hit === shouldHit;
  if (!ok) wrong++;
  console.log(
    q.padEnd(26),
    score.toFixed(3),
    (hit ? ' 是 ' : ' 否 ').padEnd(4),
    shouldHit ? ' 应该' : ' 不应该',
    ok ? '' : '  ← 不符',
  );
}

console.log('');
console.log(`  按 0.30 阈值（混合打分）：${CASES.length - wrong} / ${CASES.length} 符合预期`);
fs.rmSync(TMP, { recursive: true, force: true });
