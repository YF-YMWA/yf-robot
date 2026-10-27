/**
 * 首次运行引导：交互式填配置。
 *
 * 设计原则：只问必须问的，其余用默认值。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(ROOT, 'config.json');

/** 常见服务商的预设。 */
const PRESETS = [
  {
    key: '1',
    name: 'DeepSeek（推荐）',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    note: '国内直连，便宜，质量好',
  },
  {
    key: '2',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    note: '有免费模型',
  },
  {
    key: '3',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-flash',
    note: '阿里云百炼',
  },
  {
    key: '4',
    name: '本地 Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5',
    note: '完全离线，需要先装 Ollama',
    noKey: true,
  },
  {
    key: '5',
    name: '自定义',
    baseUrl: '',
    model: '',
    note: '任何 OpenAI 兼容接口',
  },
];

function ask(rl, question, defaultValue = '') {
  return new Promise((resolve) => {
    const hint = defaultValue ? ` [${defaultValue}]` : '';
    rl.question(`${question}${hint}: `, (answer) => {
      const v = answer.trim();
      resolve(v || defaultValue);
    });
  });
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('要连接哪个模型服务？\n');
  for (const p of PRESETS) {
    console.log(`  ${p.key}. ${p.name}  —  ${p.note}`);
  }
  console.log('');

  let preset = null;
  while (!preset) {
    const choice = await ask(rl, '选择（1-5）', '1');
    preset = PRESETS.find((p) => p.key === choice);
    if (!preset) console.log('  请输入 1-5 之间的数字');
  }

  let baseUrl = preset.baseUrl;
  let model = preset.model;

  if (preset.key === '5') {
    baseUrl = await ask(rl, '接口地址（如 https://api.example.com/v1）');
    model = await ask(rl, '模型名');
    while (!baseUrl || !model) {
      console.log('  地址和模型名都必须填写');
      if (!baseUrl) baseUrl = await ask(rl, '接口地址');
      if (!model) model = await ask(rl, '模型名');
    }
  }

  let apiKey = '';
  if (!preset.noKey) {
    console.log('');
    console.log(`请到 ${preset.name} 的后台创建一个 API Key，然后粘贴到这里。`);
    apiKey = await ask(rl, 'API Key');
    while (!apiKey) {
      console.log('  API Key 不能为空');
      apiKey = await ask(rl, 'API Key');
    }
  } else {
    apiKey = 'ollama';
  }

  rl.close();

  // 写配置
  const cfg = {
    _说明: '由引导生成。想改直接编辑本文件，或用 设置.bat',

    server: { host: '127.0.0.1', port: 8899, autoPort: true },

    llm: {
      baseUrl,
      apiKey,
      model,
      temperature: 1.0,
      maxTokens: 800,
      timeoutMs: 60000,
      fallbacks: [],
    },

    vision: {
      _说明: '看图。需要一个支持图像输入的模型，填了才启用',
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: '',
      timeoutMs: 45000,
      maxEdge: 1568,
      maxTokens: 1024,
      segments: 3,
      ffmpeg: '',
    },

    voice: {
      _说明: '语音转文字。填了才启用',
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: '',
      mode: 'chat',
      language: '',
      enableItn: true,
      timeoutMs: 60000,
      maxSeconds: 120,
      ffmpeg: '',
    },

    search: {
      _说明: '联网搜索。填了才启用',
      enabled: false,
      provider: 'bocha',
      baseUrl: '',
      apiKey: '',
      maxResults: 5,
      timeoutMs: 15000,
      autoDetect: true,
      fieldMap: null,
    },

    share: {
      _说明: '定时分享 B 站视频。只在微信通道启用时有效',
      enabled: false,
      intervalHours: 2,
      count: 20,
      keywords: ['鲸鱼', '海洋', 'AI'],
      recentIds: [],
    },

    session: {
      historyTurns: 20,
      idleMinutes: 120,
      compressAfter: 40,
      maxQueue: 5,
    },

    reply: {
      maxChars: 300,
      maxBubbles: 3,
      bubbleDelayMs: 400,
      stripMarkdown: true,
    },

    channels: {
      web: { enabled: true },
      // 不接任何平台也能用（网页聊天）。
      // 想接微信/QQ 等，按 docs/adapter-protocol.md 跑一个适配器。
      'wechat-group': {
        _说明: '群聊通道（由适配器把群消息转发进来）',
        enabled: false,
      },
    },

    group: {
      requireAt: true,
      freeChat: false,
      freeChatChance: 0.06,
      cooldownSec: 0,
      masterAlwaysReply: true,
      engagedMinutes: 6,
      maxRepliesPerHour: 1000,
      muteDefaultMinutes: 30,
      // 群里的称呼：留空 = 用角色卡里的名字（控制台可改）
      aliases: [],
      ownerIds: [],
      historyTurns: 10,
    },

    log: { level: 'info', file: 'data/app.log' },
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  console.log('');
  console.log('设置完成！');
  console.log(`模型：${model}`);
  console.log(`微信：${enableWechat ? '已启用' : '未启用'}`);
  console.log('');
}

main().catch((e) => {
  console.error('设置失败:', e.message);
  process.exit(1);
});
