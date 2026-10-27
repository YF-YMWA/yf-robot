#!/usr/bin/env node
/**
 * YF-Robot 内核入口。
 *
 *   node app.mjs            启动所有已启用通道
 *   node app.mjs --doctor   只做配置与连通性检查，不启动服务
 */
import { loadConfig, inspect, ROOT } from './core/config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { personaSummary } from './core/persona.mjs';
import { loadAnyPersona, listCards } from './core/card.mjs';
import { ChatEngine } from './core/engine.mjs';
import { AdminApi } from './core/admin.mjs';
import { WebChannel } from './channels/web.mjs';
import { WeChatGroupChannel } from './channels/wechat-group.mjs';

const CHANNEL_FACTORIES = {
  web: (opts) => new WebChannel(opts),
  'wechat-group': (opts) => new WeChatGroupChannel(opts),
};

/**
 * 内联配置向导：就地填 API Key，填完继续启动。
 * 只在缺少 Key 时触发，不打断正常流程。
 */
async function runInlineSetup() {
  const readline = await import('node:readline');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');

  const PRESETS = [
    { k: '1', name: 'DeepSeek', url: 'https://api.deepseek.com', model: 'deepseek-chat' },
    { k: '2', name: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { k: '3', name: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-flash' },
    { k: '4', name: '本地 Ollama', url: 'http://localhost:11434/v1', model: 'qwen2.5', noKey: true },
  ];

  console.log('选一个模型服务（直接回车用 DeepSeek）：');
  for (const p of PRESETS) console.log(`  ${p.k}. ${p.name}`);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def = '') =>
    new Promise((res) => rl.question(q + (def ? ` [${def}]` : '') + ': ', (a) => res(a.trim() || def)));

  const choice = await ask('选择', '1');
  const preset = PRESETS.find((p) => p.k === choice) || PRESETS[0];

  let key = '';
  if (!preset.noKey) {
    console.log('');
    console.log(`去 ${preset.name} 后台创建一个 API Key，粘贴到这里：`);
    key = await ask('API Key');
    if (!key) {
      rl.close();
      throw new Error('没有输入 Key');
    }
  } else {
    key = 'ollama';
  }
  rl.close();

  // 就地更新配置文件
  const cfgFile = pathMod.join(ROOT, 'config.json');
  const cfg = JSON.parse(fsMod.readFileSync(cfgFile, 'utf8'));
  cfg.llm.baseUrl = preset.url;
  cfg.llm.apiKey = key;
  cfg.llm.model = preset.model;
  fsMod.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8');

  console.log(`\n✓ 已保存：${preset.name} / ${preset.model}\n`);
}

/**
 * Key 归档：每次启动存一份只含 Key 的快照。
 *
 * 为什么单独做这个：
 *   config.json.bak 只有一两份，而且会被后续写入覆盖。
 *   Key 丢过一次就真找不回来（实测过）。所以单独留一个归档目录，
 *   只存 Key 和时间戳，文件很小，留 50 份也不占地方。
 *   万一哪天又丢了，去 data/key-archive/ 里翻最近的就有。
 *
 * @param {object} config
 */
function archiveKeys(config) {
  const dir = path.join(ROOT, 'data', 'key-archive');
  const SECTIONS = ['llm', 'vision', 'voice', 'search', 'imagegen'];

  const keys = {};
  let has = false;
  for (const k of SECTIONS) {
    const v = config[k]?.apiKey || '';
    keys[k] = v;
    if (v) has = true;
  }

  if (!has) return;

  try {
    fs.mkdirSync(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, stamp + '.json');

    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          keys,
          lengths: Object.fromEntries(SECTIONS.map((k) => [k, keys[k].length])),
        },
        null,
        2,
      ),
      'utf8',
    );

    // 只留最近 50 份
    const all = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .reverse();

    for (const old of all.slice(50)) {
      try {
        fs.unlinkSync(path.join(dir, old));
      } catch {}
    }
  } catch (e) {
    console.warn('[keys] 归档失败：' + e.message);
  }
}

/**
 * 启动自检 + 自动恢复：Key 空了但备份里有？
 *
 * Key 被莫名清空过好几次，日志追不到是谁干的。
 * 与其继续查，不如让它自己长回来 —— 反正备份是我们生成的。
 *
 * 只在「当前为空 且 备份里有」时才覆盖，不会误伤用户新填的 Key。
 *
 * @param {object} config 已加载的配置（会被就地修改并写回文件）
 */
function healKeysFromBackup(config) {
  const cfgFile = path.join(ROOT, 'config.json');
  if (!fs.existsSync(cfgFile)) return config;

  const SECTIONS = ['llm', 'vision', 'voice', 'search', 'imagegen'];

  // 最近的备份排前面
  const backups = fs
    .readdirSync(path.dirname(cfgFile))
    .filter((n) => n.startsWith('config.json.') && n.endsWith('.bak'))
    .sort()
    .reverse();

  if (!backups.length) return config;

  const healed = [];

  /**
   * 是不是「像真的」Key。
   *
   * 排除测试/占位用的假 Key —— 我自己的测试写过 TESTKEY-xxx 这种东西，
   * 要是不小心把它当成真 Key 恢复回去，比丢了还糟。
   */
  const looksReal = (k) => {
    const s = String(k || '');
    if (s.length < 20) return false;
    if (/test|fake|demo|dummy|example|placeholder/i.test(s)) return false;
    if (/x{6,}/i.test(s)) return false;
    return true;
  };

  for (const bakName of backups) {
    let bak;
    try {
      bak = JSON.parse(fs.readFileSync(path.join(path.dirname(cfgFile), bakName), 'utf8'));
    } catch {
      continue;
    }

    for (const k of SECTIONS) {
      const now = config[k]?.apiKey;
      const old = bak[k]?.apiKey;

      // 只在「当前空 + 备份有 + 看着像真的」时补
      if (!now && old && looksReal(old)) {
        config[k] = config[k] || {};
        config[k].apiKey = old;
        healed.push(`${k}（${old.length} 字符，来自 ${bakName}）`);
      }
    }

    if (healed.length) break;
  }

  // 备份里没有，就去 Key 归档里翻（归档只存 Key，保留 50 份，比 .bak 耐丢）
  if (!healed.length) {
    const archDir = path.join(ROOT, 'data', 'key-archive');
    let archives = [];
    try {
      archives = fs
        .readdirSync(archDir)
        .filter((n) => n.endsWith('.json'))
        .sort()
        .reverse();
    } catch {}

    for (const name of archives) {
      let arch;
      try {
        arch = JSON.parse(fs.readFileSync(path.join(archDir, name), 'utf8'));
      } catch {
        continue;
      }

      for (const k of SECTIONS) {
        const now = config[k]?.apiKey;
        const old = arch.keys?.[k];

        if (!now && old && looksReal(old)) {
          config[k] = config[k] || {};
          config[k].apiKey = old;
          healed.push(`${k}（${old.length} 字符，来自归档 ${name}）`);
        }
      }

      if (healed.length) break;
    }
  }

  if (!healed.length) return config;

  /**
   * 先把「磁盘上到底有没有」单独读一遍，再决定这条消息该说什么。
   *
   * 之前只有一句「检测到 Key 丢失」，很容易让人以为 Key 真没了 ——
   * 实际上控制台里一直好好显示着。区别很重要：
   *   · 磁盘上确实没有 → 真的丢了（只是被自动补回来）
   *   · 磁盘上有、内存里没有 → 加载阶段出的问题（并发写/解析），
   *     Key 其实一直在，功能也没受影响，只是这次启动读岔了
   */
  let diskView = null;
  let diskWhy = '';
  try {
    diskView = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  } catch (e) {
    diskWhy = e.message;
  }

  const rebuilt = [];
  const mismatched = [];
  for (const k of SECTIONS) {
    if (!healed.some((h) => h.startsWith(k))) continue;
    const onDisk = diskView?.[k]?.apiKey ? diskView[k].apiKey.length : 0;
    (onDisk ? mismatched : rebuilt).push(`${k}(磁盘${onDisk}字符)`);
  }

  console.warn('========================================');
  if (mismatched.length) {
    console.warn('[i] 启动自检：内存里读到的 Key 比磁盘上少，已按磁盘/归档补齐');
    console.warn('    ' + mismatched.join('；'));
    console.warn('    → Key 没有真丢，功能不受影响；只是这次启动读岔了。');
    if (diskWhy) console.warn('    （直接读磁盘失败：' + diskWhy + '）');
  } else {
    console.warn('[!] 检测到 Key 丢失，已从备份自动恢复：');
  }
  for (const h of healed) console.warn('    ' + h);
  console.warn('');

  // 记进审计文件，下次再出现能对着时间点查
  try {
    const auditDir = path.join(ROOT, 'data');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.appendFileSync(
      path.join(auditDir, 'key-audit.log'),
      `${new Date().toISOString()} by=startup-heal ` +
        `${healed.join('，')} ` +
        `disk=${mismatched.length ? 'has-key' : 'missing'}${diskWhy ? ` diskErr=${diskWhy}` : ''}\n`,
      'utf8',
    );
  } catch {}

  try {
    // 恢复前先存一份当前的，免得把什么改坏了回不去
    fs.copyFileSync(cfgFile, cfgFile + '.before-heal.bak');
    fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2), 'utf8');
    console.warn('    已写回 config.json');
  } catch (e) {
    console.warn('    写回失败：' + e.message);
  }
  console.warn('========================================');

  return config;
}

async function main() {
  const doctor = process.argv.includes('--doctor');

  // --card xxx 临时切换角色
  const cardIdx = process.argv.indexOf('--card');
  const cardArg = cardIdx >= 0 ? process.argv[cardIdx + 1] : null;

  // --list 列出所有卡片
  if (process.argv.includes('--list')) {
    const cards = listCards(ROOT);
    if (cards.length === 0) {
      console.log('cards/ 目录下没有可用卡片');
    } else {
      console.log('可用角色：\n');
      for (const c of cards) {
        console.log(`  ${c.id.padEnd(12)} ${c.name}  ${c.identity || ''}`);
      }
      console.log('\n用法：启动.bat 配合 --card <id>，或在 config.json 里设 "card": "<id>"');
    }
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error('配置错误：\n' + e.message);
    process.exit(1);
  }

  // 配置文件不存在 → 交给启动脚本引导
  if (config.__configMissing__ && !doctor) {
    console.error('\n还没有配置文件，需要先完成设置。');
    process.exit(2);
  }

  /**
   * 单实例检查。
   *
   * 为什么必须拦：多开两个实例时，它们会同时连同一个 iLink 机器人
   * （长轮询抢同一个 cursor）和同一个微信适配器锁，表现是
   * 「机器人一会儿回一会儿不回」「同一条消息被回两遍」，
   * 而且从界面上完全看不出是开了两份。
   *
   * 端口占用会自动 +1 避让，所以以前多开不会报错 —— 这里主动拦掉。
   */
  const lockFile = path.join(ROOT, 'data', 'app.lock');
  try {
    if (fs.existsSync(lockFile)) {
      const old = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
      if (Number.isFinite(old) && old !== process.pid) {
        let alive = false;
        try {
          // 信号 0 只探活，不发信号
          process.kill(old, 0);
          alive = true;
        } catch {
          alive = false;
        }

        if (alive) {
          console.error('');
          console.error('========================================');
          console.error('  已经有一个 YF-Robot 在运行了（PID ' + old + '）');
          console.error('');
          console.error('  同时开两个会互相抢微信机器人和适配器，');
          console.error('  表现是「消息一会儿回一会儿不回」。');
          console.error('');
          console.error('  想重开的话：先关掉那个，或执行');
          console.error('    taskkill /F /PID ' + old);
          console.error('========================================');
          console.error('');
          process.exit(3);
        }
      }
    }

    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, String(process.pid), 'utf8');

    const releaseLock = () => {
      try {
        const cur = fs.readFileSync(lockFile, 'utf8').trim();
        if (cur === String(process.pid)) fs.unlinkSync(lockFile);
      } catch {}
    };

    process.on('exit', releaseLock);
    process.on('SIGINT', () => {
      releaseLock();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      releaseLock();
      process.exit(0);
    });
  } catch (e) {
    console.warn('[lock] 单实例检查失败（继续启动）：' + e.message);
  }

  // 启动自检：Key 被清空了但备份/归档里有 → 自动补回来
  try {
    config = healKeysFromBackup(config);
  } catch (e) {
    console.warn('[config] Key 自愈失败：' + e.message);
  }

  // 每次启动归档一份 Key，以后丢了能翻回来
  try {
    archiveKeys(config);
  } catch (e) {
    console.warn('[config] Key 归档失败：' + e.message);
  }

  const persona = loadAnyPersona({
    root: ROOT,
    personaFile: config.personaFile,
    card: cardArg || config.card,
  });
  const p = personaSummary(persona);

  console.log('========================================');
  console.log(` ${persona.name} · 内核`);
  console.log('========================================');
  console.log(`人设     : ${p.name}${p.identity ? ' — ' + p.identity.slice(0, 40) : ''}`);
  console.log(`模型     : ${config.llm.model} @ ${config.llm.baseUrl}`);
  console.log(`服务地址 : ${config.server.host}:${config.server.port}`);  console.log(`启用通道 : ${inspect(config).channels.join(', ') || '无'}`);
  console.log(`看图     : ${config.vision.enabled ? '开' : '关'}`);
  console.log(`语音     : ${config.voice.enabled ? '开' : '关'}`);
  console.log(`联网     : ${config.search.enabled ? `开（${config.search.provider}）` : '关'}`);
  console.log(`B站分享  : ${config.share.enabled ? `开（每 ${config.share.intervalHours} 小时）` : '关'}`);
  console.log('----------------------------------------');

  if (!config.llm.apiKey) {
    console.warn('⚠ 还没有配置 API Key');
    if (doctor) {
      console.warn('  聊天会失败，但配置检查通过。');
    } else {
      console.warn('  正在启动配置向导…\n');
      await runInlineSetup();
      // 重新读配置
      config = loadConfig();
      if (!config.llm.apiKey) {
        console.error('仍未配置 Key，退出。');
        process.exit(1);
      }
    }
  }

  if (doctor) {
    console.log('\n[诊断] 配置检查通过。');
    console.log(JSON.stringify(inspect(config), null, 2));
    return;
  }

  const engine = new ChatEngine({ config, persona });
  config.__personaName = persona.name;

  // 管理接口（控制台用）
  const enabledChannelNames = Object.entries(config.channels)
    .filter(([, v]) => v?.enabled)
    .map(([k]) => k);
  const admin = new AdminApi({ engine, config, channels: enabledChannelNames });

  const channels = [];
  for (const [name, factory] of Object.entries(CHANNEL_FACTORIES)) {
    const chCfg = config.channels[name];
    if (!chCfg?.enabled) continue;
    channels.push(factory({ engine, config, admin }));
  }

  if (channels.length === 0) {
    console.error('没有启用任何通道，退出。');
    process.exit(1);
  }

  // 逐个启动，单个失败不影响其他
  // 加载插件（别人给她加的功能）。失败不影响主流程。
  try {
    await engine.plugins.load();
    const list = engine.plugins.list();
    const okCount = list.filter((x) => x.state === 'loaded').length;
    if (list.length) {
      console.log(`[plugin] ${okCount}/${list.length} 个插件已加载`);
      for (const x of list) {
        if (x.state === 'error') console.warn(`[plugin] ${x.id} 出错：${x.error}`);
      }
    }
  } catch (e) {
    console.warn(`[plugin] 加载失败（不影响运行）：${e.message}`);
  }

  let webUrl = null;
  for (const ch of channels) {
    try {
      const info = await ch.start();
      console.log(`[${ch.name}] 已启动 ${info || ''}`);
      if (ch.name === 'web') webUrl = info;
    } catch (e) {
      console.error(`[${ch.name}] 启动失败: ${e.message}`);
    }
  }

  console.log('========================================');
  if (webUrl) {
    console.log(`网页聊天：${webUrl}`);
  }
  console.log('就绪。Ctrl+C 退出。');

  // 浏览器由启动器（scripts/start.ps1）负责打开：
  // node 若是从受限会话启动，它拉起的 GUI 窗口可能显示不出来，
  // 所以把「开浏览器」这件事交给和用户同一个桌面会话的 PowerShell。
  const consoleUrl = webUrl ? webUrl.replace(/\/console$/, '') + '/console' : null;
  if (consoleUrl) {
    console.log('');
    console.log('  ┌─────────────────────────────────────────┐');
    console.log('  │  控制台                                 │');
    console.log('  └─────────────────────────────────────────┘');
    console.log(`  ${consoleUrl}`);
    console.log('');
  }

  // B站分享调度
  //
  // 以前靠 ilink 通道主动推送。现在核心不直接连任何平台 ——
  // 发送由适配器负责，适配器自己去问 /api/share/due。
  // 所以这里不再起调度器，只留一条说明，免得有人找不到分享功能。
  if (config.share.enabled) {
    console.log('[share] 已启用；由适配器轮询 /api/share/due 触发（核心不主动推送）');
  }

  // 定时回收闲置会话
  const sweeper = setInterval(() => {
    const n = engine.sweep();
    if (n > 0) console.log(`[会话] 回收 ${n} 个闲置会话`);
  }, 10 * 60 * 1000);
  sweeper.unref?.();

  // 每日热点摘要：每小时问一次「到点了没」，到点才真跑
  const digestTimer = setInterval(async () => {
    try {
      const r = await admin.handle('POST', '/api/admin/learning/digest/tick', {});
      const body = r?.body;
      if (!body?.skipped && body?.ok) {
        console.log(`[digest] 每日热点已更新：${(body.points || []).length} 条`);
      }
    } catch (e) {
      console.warn('[digest] 检查失败：' + e.message);
    }
  }, 60 * 60 * 1000);
  digestTimer.unref?.();

  // 启动 30 秒后先查一次（防止刚开机就等一小时）
  setTimeout(() => {
    admin
      .handle('POST', '/api/admin/learning/digest/tick', {})
      .then((r) => {
        if (!r?.body?.skipped && r?.body?.ok) {
          console.log(`[digest] 每日热点已更新：${(r.body.points || []).length} 条`);
        }
      })
      .catch(() => {});
  }, 30000).unref?.();

  /**
   * 后台给素材补描述。
   *
   * 这件事以前是适配器里的后台线程干的 —— 但适配器现在是独立仓库，
   * 它已经不在核心目录下，也管不到核心的素材库。
   * 描述和索引本来就属于核心能力（不接微信也能用），所以搬回核心。
   *
   * 节奏：启动 60 秒后跑第一轮（别和启动流程抢资源），之后每 10 分钟一批，
   * 每批最多 6 张 —— 不把视觉接口和额度打爆。
   */
  if (config.sticker?.autoIndex !== false) {
    const indexTick = async () => {
      try {
        const r = await admin.handle('POST', '/api/admin/sticker-index/rebuild', {
          limit: 6,
          mode: 'missing',
        });
        const b = r?.body;
        if (b?.ok && b.done > 0) {
          console.log(`[素材] 补了 ${b.done} 张图的描述${b.failed ? `，${b.failed} 张失败` : ''}`);
        }
      } catch (e) {
        console.warn('[素材] 补描述失败：' + e.message);
      }
    };

    setTimeout(indexTick, 60 * 1000).unref?.();
    const indexTimer = setInterval(indexTick, 10 * 60 * 1000);
    indexTimer.unref?.();
  }

  const shutdown = async (sig) => {
    console.log(`\n[${sig}] 正在停止…`);
    clearInterval(sweeper);
    clearInterval(digestTimer);
    shareScheduler?.stop();
    for (const ch of channels) {
      try {
        await ch.stop();
      } catch {}
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('启动失败:', e.message);
  process.exit(1);
});
