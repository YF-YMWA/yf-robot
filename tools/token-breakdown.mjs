/**
 * 拆解一次对话的输入 token 花在哪。
 *
 * 直接调引擎内部拼提示词的函数，逐块量字符数，
 * 再按「中文约 0.6 token/字」粗算（DeepSeek 的实测比例）。
 *
 * 用法：node tools/token-breakdown.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// 粗估：中文 1 字 ≈ 0.6 token，英文/符号 4 字符 ≈ 1 token
function estimate(s) {
  const str = String(s || '');
  const cjk = (str.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = str.length - cjk;
  return { chars: str.length, tokens: Math.round(cjk * 0.6 + rest / 4) };
}

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  return cfg;
}

async function main() {
  const cfg = loadConfig();

  const { ToolKit } = await import('../core/tools.mjs');
  const { PluginHost } = await import('../core/plugins.mjs');

  // 工具定义（每次请求都会带上，是固定开销）
  const plugins = new PluginHost({ root: ROOT, config: cfg, log: () => {} });
  await plugins.load();
  const kit = new ToolKit({
    sandbox: path.join(ROOT, 'agent-workspace'),
    plugins,
    logger: { info() {}, warn() {}, error() {} },
  });
  const toolDefs = JSON.stringify(kit.definitions());

  // 人设文件
  const personaRaw = fs.existsSync(path.join(ROOT, 'persona.json'))
    ? fs.readFileSync(path.join(ROOT, 'persona.json'), 'utf8')
    : '';
  let persona = null;
  try {
    persona = JSON.parse(personaRaw);
  } catch {}

  const parts = [
    ['工具定义（每次必带）', toolDefs],
    ['人设 system_prompt', persona?.system_prompt || ''],
    ['人设其它字段', JSON.stringify({ ...persona, system_prompt: undefined })],
    ['词库/口癖（如果注入）', ''],
  ];

  console.log('═'.repeat(64));
  console.log('  一次请求的固定开销（不含对话内容）');
  console.log('═'.repeat(64));
  let fixed = 0;
  for (const [name, text] of parts) {
    const e = estimate(text);
    fixed += e.tokens;
    console.log(`  ${name.padEnd(24)} ${String(e.chars).padStart(6)} 字  ≈ ${String(e.tokens).padStart(5)} token`);
  }
  console.log('─'.repeat(64));
  console.log(`  ${'固定部分合计'.padEnd(24)} ${' '.repeat(6)}    ≈ ${String(fixed).padStart(5)} token`);
  console.log('');

  // 实测基线（来自 token-report）
  console.log('═'.repeat(64));
  console.log('  实测 vs 估算');
  console.log('═'.repeat(64));
  console.log(`  实测首条对话输入        4,239 token`);
  console.log(`  固定部分估算            ${fixed} token（占 ${Math.round((fixed / 4239) * 100)}%）`);
  console.log('');
  console.log('  说明：实测比估算多，差额来自');
  console.log('    · 时间注入、记忆检索、输出约束等模板文字');
  console.log('    · 分词的误差（估算系数是近似的）');
  console.log('');

  // 减少固定开销的办法
  console.log('═'.repeat(64));
  console.log('  想把固定开销压下来，可以：');
  console.log('═'.repeat(64));
  const toolCount = kit.definitions().length;
  console.log(`  · 关掉用不到的工具（现在 ${toolCount} 个，每个都占几百 token）`);
  console.log('  · 人设 system_prompt 精简（现在 ' + estimate(persona?.system_prompt || '').tokens + ' token）');
  console.log('  · 固定部分不变 → 命中服务商缓存，实际单价能低不少');
}

main().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
