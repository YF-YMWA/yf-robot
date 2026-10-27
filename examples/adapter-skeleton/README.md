# 适配器骨架

一个不接任何平台的「模拟聊天源」，用来验证协议通了没有。

## 跑起来

先启动核心（双击 `YF-Robot.bat`，或 `node app.mjs`），然后：

```bash
node examples/adapter-skeleton/adapter.mjs
```

你会看到它每 15 秒伪造一条消息发给核心，核心回复后再打印出来：

```
适配器骨架启动
  目标核心：http://127.0.0.1:8899
  令牌：未配置

  ← 演示用户：骨架测试消息（21:30:15）
  → 发给 demo-chat：咕噜，
  → 发给 demo-chat：你好呀，找我干啥？
```

同时控制台的「接入状态」页会显示：

```
适配器      已接入
适配器名称   skeleton-adapter
登录账号     骨架账号
```

## 写自己的适配器

只改两个函数：

| 函数 | 换成什么 |
|---|---|
| `pollMessages()` | 你的平台怎么收消息（监听事件 / 轮询 / 读库） |
| `sendMessage()` | 你的平台怎么发消息 |

其余（`askCore` / `heartbeat` / `reportContacts` / `ingestMedia`）照抄。

## 必做的三件事

```
1. 收到消息 → POST /api/wechat → 拿 bubbles → 逐条发出去
2. 每 20 秒 POST /api/bridge/heartbeat
3. 想收藏图片 → POST /api/media/ingest（别自己写 data/）
```

## 带令牌

如果核心的 `config.json` 里配了 `gateway.wechat.inboundToken`：

```bash
# Windows PowerShell
$env:YF_ADAPTER_TOKEN="你的令牌"; node examples/adapter-skeleton/adapter.mjs
```

完整协议见 [docs/adapter-protocol.md](../../docs/adapter-protocol.md)。
