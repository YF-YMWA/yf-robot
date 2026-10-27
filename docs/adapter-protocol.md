# 适配器协议

核心不实现任何聊天平台的登录或协议。它只对外提供一套 HTTP 接口，
由**适配器**把消息送进来、把回复取出去。

```
┌──────────┐   收消息 POST /api/wechat      ┌──────────┐
│          │ ──────────────────────────────▶ │          │
│  平台     │                                 │  YF-Robot │
│  适配器   │ ◀────────────────────────────── │   核心    │
└──────────┘   回复在响应的 bubbles 里返回      └──────────┘
      │                                              │
      └──── 心跳 POST /api/bridge/heartbeat ──────────┘
      └──── 媒体 POST /api/media/ingest ──────────────┘
```

适配器可以是任何语言、跑在任何进程里。只要它能发 HTTP 请求就行。

---

## 1. 收消息：`POST /api/wechat`

这是唯一的必选接口。

**请求**

```json
{
  "chat_id": "<对方或群的 id>",
  "chat_type": "private",
  "senderId": "<发送者 id，主人识别靠它>",
  "senderName": "小明",
  "text": "你好呀",
  "msg_id": "本地消息 id，用于去重",
  "images": []
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `chat_id` | ✅ | 会话 id。私聊=对方 id，群聊=群 id |
| `chat_type` | ✅ | `private` 或 `group` |
| `senderId` | ✅ | 发送者 id。**主人识别靠这个，不是靠昵称** |
| `senderName` | | 昵称，只用于显示 |
| `text` | | 文本内容 |
| `msg_id` | | 消息 id，核心用它去重 |
| `images` | | 图片，base64 或 URL 数组 |

**响应**

```json
{
  "action": "reply",
  "bubbles": ["咕噜，", "你好呀。"],
  "images": [],
  "reason": ""
}
```

| 字段 | 说明 |
|---|---|
| `action` | `reply` / `ignore` / `queued` |
| `bubbles` | 要发出去的气泡，**按顺序逐条发**。空数组表示这次不回 |
| `images` | 要附带的图片文件名 |
| `reason` | `action` 不是 reply 时说明原因 |

**适配器该做什么**

1. 收到平台消息 → 组装成上面的请求体
2. POST 到 `http://127.0.0.1:8899/api/wechat`
3. 把 `bubbles` 逐条发回平台，条与条之间可以停 0.5~1 秒
4. `images` 里的图，从 `http://127.0.0.1:8899/api/media/stickers/<name>` 取

---

## 2. 心跳：`POST /api/bridge/heartbeat`

强烈建议实现。不实现的话控制台会一直显示「未接入」。

每 20 秒一次。

```json
{
  "platform": "wechat",
  "name": "wechat-adapter",
  "account": "我的微信昵称",
  "uia": true,
  "listener": true,
  "ffmpeg": true,
  "recentMessages": 5,
  "rest": false
}
```

| 字段 | 说明 |
|---|---|
| `name` | 适配器名字，显示在控制台 |
| `account` | 当前登录账号，显示在控制台 |
| `listener` | 收消息的线程还活着吗 |
| `uia` | 发送通道可用吗（没有这个概念就填 `listener` 的值） |
| `recentMessages` | 最近一分钟处理了多少条 |

> 核心看不到适配器的日志（它是另一个进程），
> 所以「账号」「最近消息数」这些信息只能靠心跳带上来。

---

## 3. 媒体入库：`POST /api/media/ingest`

收到的图片、表情包想进素材库，就传到这里。**别自己写 `data/`**。

```json
{
  "kind": "sticker",
  "data": "<base64>",
  "senderId": "<发送者 id>",
  "chatId": "<会话 id>"
}
```

| 字段 | 说明 |
|---|---|
| `kind` | `sticker` / `image` / `generated` |
| `data` | base64（上限 12MB） |
| `senderId` / `chatId` | 用于白名单判断 |

**响应**

```json
{ "ok": true, "name": "stk_49a9861a8173.jpg", "dup": false }
```

| 情况 | 响应 |
|---|---|
| 新存入 | `{ok:true, name, dup:false}` |
| 已存在（内容相同或看着一样） | `{ok:true, name, dup:true}` |
| 动图替换了旧静态图 | `{ok:true, name, replaced:"旧文件名"}` |
| 白名单不允许 | `{ok:true, skipped:"不在收藏白名单"}` |
| 关闭了收藏 | `{ok:true, skipped:"mediaCollect 关闭"}` |
| 格式不认识 | `{ok:false, error:"..."}` |

**为什么要交给核心存**

1. 素材库、描述索引、去重表都在核心的 `data/` 下。
   适配器自己写会写到自己的目录，结果是「收藏了但控制台看不到」。
2. 收藏白名单只在核心一处判断，不会两边不一致。
3. 去重（内容 md5 + 感知哈希）和打描述都在核心做，适配器只管传字节。

**鉴权**：如果核心的 `config.json` 里配了 `gateway.wechat.inboundToken`，
请求要带 `x-adapter-token: <那个令牌>`。没配就免鉴权（单机自用场景）。

---

## 4. 上报联系人：`POST /api/adapter/contacts`

可选。上报后，控制台的「搭话发给谁」「收藏白名单」可以直接选，不用手抄 id。

```json
{
  "contacts": [
    { "wxid": "<真实 id>", "name": "小明", "chatName": "小明", "isGroup": false },
    { "wxid": "<群 id>", "name": "家庭群", "chatName": "家庭群", "isGroup": true }
  ]
}
```

启动时报一次就行，之后有新联系人再补。

---

## 5. 收藏策略：`GET /api/media/policy`

可选。想知道白名单要不要放行，也可以先问一下（不过 `ingest` 内部已经判了）。

```json
{ "ok": true, "collect": true, "collectOnlyFrom": [], "stickerChance": 0.5 }
```

---

## 6. 取素材文件

```
GET /api/media/stickers/<name>     表情包
GET /api/media/images/<name>       收到的图
GET /api/media/generated/<name>    生成的图
```

控制台用本地令牌访问；适配器发图时如果拿不到，可以把文件读成 base64 自己发。

---

## 7. 最小实现清单

一个能用的适配器只需要做三件事：

```
1. 收到消息 → POST /api/wechat → 拿到 bubbles → 逐条发出去
2. 每 20 秒 POST /api/bridge/heartbeat
3. 想收藏图片 → POST /api/media/ingest
```

其余都是可选的。

参考实现见 `examples/adapter-skeleton/`。
