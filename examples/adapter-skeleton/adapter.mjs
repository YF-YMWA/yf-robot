/**
 * 适配器骨架。
 *
 * 它不接任何真实平台 —— 就是个「模拟聊天源」，用来验证：
 *   1. 协议对不对
 *   2. 核心能不能正常收发
 *   3. 素材能不能入库
 *
 * 你写自己的适配器时，把 `pollMessages()` 换成真实的收消息逻辑，
 * 把 `sendMessage()` 换成真实的发消息逻辑，其余照抄即可。
 *
 * 跑：
 *   node examples/adapter-skeleton/adapter.mjs
 *   node examples/adapter-skeleton/adapter.mjs http://127.0.0.1:8899
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8899';

/** 核心要求的适配器令牌（config.json 里 gateway.wechat.inboundToken；没配就留空） */
const TOKEN = process.env.YF_ADAPTER_TOKEN || '';

const headers = {
  'content-type': 'application/json',
  ...(TOKEN ? { 'x-adapter-token': TOKEN } : {}),
};

const NAME = 'skeleton-adapter';

// ===== 你要替换的部分 =====

/**
 * 收消息。真实适配器这里是：监听平台事件 / 轮询接口 / 读本地数据库。
 *
 * @returns {Promise<Array>} 一批消息
 */
async function pollMessages() {
  // 骨架：每 15 秒伪造一条，方便你看到端到端是通的
  const now = Date.now();
  return [
    {
      chat_id: 'demo-chat',
      chat_type: 'private',
      senderId: 'demo-sender-id',
      senderName: '演示用户',
      text: `骨架测试消息（${new Date(now).toTimeString().slice(0, 8)}）`,
      msg_id: `demo-${now}`,
    },
  ];
}

/**
 * 发消息。真实适配器这里是：调平台 API / 操作窗口 / 推送 websocket。
 *
 * @param {string} chatId
 * @param {string} text 一条气泡
 */
async function sendMessage(chatId, text) {
  // 骨架：只打印
  console.log(`  → 发给 ${chatId}：${text}`);
}

// ===== 下面的逻辑照抄就行 =====

/** 把一条平台消息交给核心，拿回回复 */
async function askCore(msg) {
  const r = await fetch(`${BASE}/api/wechat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(msg),
  });
  if (!r.ok) throw new Error(`核心返回 ${r.status}`);
  return r.json();
}

/** 心跳：让控制台知道适配器活着 */
async function heartbeat(stats = {}) {
  try {
    await fetch(`${BASE}/api/bridge/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        platform: 'demo',
        name: NAME,
        account: '骨架账号',
        listener: true,
        uia: true,
        ffmpeg: false,
        recentMessages: stats.recentMessages || 0,
      }),
    });
  } catch {
    // 核心没起来，下一轮再报
  }
}

/** 上报联系人（可选，但上报了控制台选人方便） */
async function reportContacts(contacts) {
  try {
    await fetch(`${BASE}/api/adapter/contacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contacts }),
    });
    console.log(`  已上报 ${contacts.length} 个联系人`);
  } catch {}
}

/** 上传一张图进素材库（可选） */
export async function ingestMedia({ kind = 'sticker', buffer, senderId, chatId }) {
  const r = await fetch(`${BASE}/api/media/ingest`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind,
      data: buffer.toString('base64'),
      senderId,
      chatId,
    }),
  });
  return r.json();
}

/** 处理一条消息：交给核心 → 逐条发出去 */
async function handle(msg) {
  const res = await askCore(msg);

  if (res.action !== 'reply' || !(res.bubbles || []).length) {
    console.log(`  · 核心没回（${res.action}${res.reason ? '：' + res.reason : ''}）`);
    return;
  }

  for (const bubble of res.bubbles) {
    await sendMessage(msg.chat_id, bubble);
    // 气泡之间停一下，像真人打字
    await new Promise((r) => setTimeout(r, 600));
  }

  if ((res.images || []).length) {
    console.log(`  · 核心想让发图：${res.images.join(', ')}`);
    // 真实适配器这里去 GET /api/media/stickers/<name> 拿文件再发
  }
}

// ===== 主循环 =====

console.log('适配器骨架启动');
console.log(`  目标核心：${BASE}`);
console.log(`  令牌：${TOKEN ? '已配置' : '未配置（核心若要求令牌会失败）'}`);
console.log('');

let recent = 0;
let lastReport = 0;

setInterval(() => heartbeat({ recentMessages: recent }), 20000);
heartbeat();

reportContacts([
  { wxid: 'demo-sender-id', name: '演示用户', chatName: '演示用户', isGroup: false },
]);

// 每 15 秒收一次消息
setInterval(async () => {
  try {
    const batch = await pollMessages();
    for (const msg of batch) {
      console.log(`  ← ${msg.senderName}：${msg.text}`);
      await handle(msg);
      recent++;
    }
  } catch (e) {
    console.log(`  ! 处理失败：${e.message}`);
  }
}, 15000);

// 每分钟把 recent 归零（心跳里的「最近一分钟」）
setInterval(() => {
  recent = 0;
}, 60000);

void lastReport;
