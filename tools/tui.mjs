/**
 * 终端版控制台。
 *
 * 浏览器打不开时的备选：直接在命令行里看状态、改配置、测试能力。
 * 不依赖任何图形界面。
 */
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };
const col = (c, s) => `${C[c]}${s}${C.reset}`;

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;

let rl = null;
function ask(q) {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, r));
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}/api/admin/${path}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

async function showStatus() {
  console.log(col('dim', '  ' + '─'.repeat(50)));
  console.log('');

  try {
    const s = await api('status');
    const c = await api('config');

    console.log('  ' + col('bold', '服务'));
    console.log(`    进程      ${col('green', '运行中')}`);
    console.log(`    地址      ${BASE}`);
    console.log('');
    console.log('  ' + col('bold', '模型'));
    console.log(`    对话      ${(c.llm.model || '-').padEnd(26)} ${c.llm.hasKey ? col('green', '✓ Key 已配置') : col('yellow', '! 未配置')}`);
    console.log(`    看图      ${(c.vision.model || '-').padEnd(26)} ${c.vision.hasKey ? col('green', '✓ Key 已配置') : col('yellow', '! 未配置')}`);
    console.log(`    联网      ${(c.search.provider || '-').padEnd(26)} ${c.search.hasKey ? col('green', '✓ Key 已配置') : col('yellow', '! 未配置')}`);
    console.log('');
    console.log('  ' + col('bold', '功能'));
    const on = (v) => (v ? col('green', '开') : col('dim', '关'));
    console.log(`    看图 ${on(c.vision.enabled)}   语音 ${on(c.voice.enabled)}   联网 ${on(c.search.enabled)}   工具 ${on(c.tools?.enabled)}`);
    console.log('');
  } catch (e) {
    console.log(col('red', `  ✗ 读取失败: ${e.message}`));
    console.log(col('dim', '    服务可能没启动'));
  }
}

async function testAll() {
  console.log(col('dim', '  测试中…'));
  console.log('');
  try {
    const j = await api('test/all', { method: 'POST', body: {} });
    const line = (name, r, fmt) => {
      if (r?.ok) console.log(`  ${col('green', '✓')} ${name.padEnd(4)} ${col('dim', fmt(r))}`);
      else console.log(`  ${col('red', '✗')} ${name.padEnd(4)} ${col('red', (r?.error || '').slice(0, 60))}`);
    };
    line('对话', j.llm, (r) => `${r.ms}ms`);
    line('看图', j.vision, (r) => `${r.ms}ms  ${r.answer || ''}`);
    line('联网', j.search, (r) => `${r.ms}ms  ${r.count || 0} 条`);
  } catch (e) {
    console.log(col('red', `  ✗ ${e.message}`));
  }
}

async function setKey() {
  const which = (await ask('  改哪个 Key？(1)对话 (2)看图 (3)联网 (4)语音: ')).trim();

  const map = { '1': 'llm', '2': 'vision', '3': 'search', '4': 'voice' };
  const name = map[which];

  if (!name) {
    console.log(col('dim', '  取消'));
    return;
  }

  const labels = { llm: '对话模型', vision: '看图', search: '联网搜索', voice: '语音' };

  console.log('');
  console.log(col('dim', `  当前 ${labels[name]} 的 Key：`));
  try {
    const c = await api('config');
    const cur = c[name];
    console.log(`    ${cur.hasKey ? col('green', cur.apiKeyMasked) : col('yellow', '未配置')}`);
  } catch {}

  console.log('');
  const key = (await ask('  粘贴新 Key（留空取消）: ')).trim();
  if (!key) {
    console.log(col('dim', '  取消'));
    return;
  }

  try {
    await api('config', { method: 'POST', body: { [name]: { apiKey: key } } });
    console.log(col('green', '  ✓ 已保存'));

    // 立即测试
    console.log('');
    const r = await api('test/' + name, { method: 'POST', body: {} });
    if (r.ok) {
      console.log(col('green', `  ✓ 测试通过（${r.ms}ms）`));
    } else {
      console.log(col('red', `  ✗ 测试失败: ${r.error}`));
    }
  } catch (e) {
    console.log(col('red', `  ✗ 保存失败: ${e.message}`));
  }
}

async function chat() {
  console.log(col('dim', '  输入消息对话，输入 /exit 返回菜单'));
  console.log('');

  const sid = 'terminal-' + Date.now();

  while (true) {
    const text = (await ask('  你: ')).trim();
    if (!text) continue;
    if (text === '/exit') break;

    try {
      const res = await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, text }),
      });

      const raw = await res.text();
      let reply = '';
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const o = JSON.parse(line.slice(5));
          if (o.bubbles) reply = o.bubbles.join(' ');
        } catch {}
      }

      console.log(col('cyan', `  鲸: ${reply || '（无回复）'}`));
      console.log('');
    } catch (e) {
      console.log(col('red', `  ✗ ${e.message}`));
    }
  }
}

async function main() {
  console.log('');
  console.log(col('cyan', '  ╔════════════════════════════════════════╗'));
  console.log(col('cyan', '  ║') + '     YF-Robot · 状态面板                 ' + col('cyan', '║'));
  console.log(col('cyan', '  ╚════════════════════════════════════════╝'));

  while (true) {
    console.log('');
    await showStatus();

    console.log(col('dim', '  ────────────────────────────────────────'));
    console.log('');
    console.log(`   ${col('cyan', '1')}  测试全部能力`);
    console.log(`   ${col('cyan', '2')}  修改 API Key`);
    console.log(`   ${col('cyan', '3')}  终端对话`);
    console.log(`   ${col('cyan', '4')}  刷新状态`);
    console.log(`   ${col('cyan', '0')}  退出`);
    console.log('');

    const choice = (await ask('  请选择: ')).trim();
    console.log('');

    switch (choice) {
      case '1':
        await testAll();
        break;
      case '2':
        await setKey();
        break;
      case '3':
        await chat();
        break;
      case '4':
        break;
      case '0':
        if (rl) rl.close();
        console.log(col('dim', '  再见'));
        return;
    }

    await ask(col('dim', '  按回车继续…'));
    console.log('\x1b[2J\x1b[H');
  }
}

main().catch((e) => {
  console.error(col('red', '\n出错: ' + e.message));
  process.exit(1);
});
