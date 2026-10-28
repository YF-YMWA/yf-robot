# 多适配器：放哪、怎么选、要不要提权

框架可以同时装多个适配器（微信、QQ、Telegram、自定义协议），
面板里选一个启动。这份文档说明约定。

## 一、放哪里

按优先级找三个位置：

| 位置 | 什么时候用 |
|---|---|
| `<项目>/adapters/<名字>/` | **推荐**。一个适配器一个文件夹 |
| `<项目>/adapter/` | 打包形态（带适配器的包解压后就这一个） |
| 隔壁 `../yf-robot-wechat-adapter/` | 开发形态（两个仓库并排） |

目录里必须有**入口脚本**；最好再有一份 `adapter.json` 清单：

```json
{
  "name": "微信（UIA）",
  "entry": "wechatauto_bridge.py",
  "needsAdmin": true,
  "description": "操作微信窗口收发消息，需要管理员权限"
}
```

没有清单时会按这个顺序猜入口：

```
wechatauto_bridge.py → adapter.py → main.py → bridge.py
```

猜不到就不算适配器（面板里不会出现）。

## 二、要不要管理员（UAC）

| needsAdmin | 行为 |
|---|---|
| `true`（默认） | 服务不是管理员时，启动会弹一次 UAC |
| `false` | 永远不弹 UAC，直接起 |

**为什么微信需要提权**：它要操作微信的窗口（UIA），而微信进程权限更高，
Windows 不允许低权限程序去操作高权限程序的窗口（UIPI）。

**点「是」之后会发生什么**：

- 适配器以管理员身份运行，**仍然是你当前登录的那个微信账号**，
  不会切换账号、不会重新登录、不影响聊天记录
- 只是拿到了「操作窗口」的权限，能正常收发消息、发图片
- 关掉适配器窗口，权限随之结束

**不想每次都弹**：用管理员身份运行一次 `桌面控制台.bat`，
服务本身就是管理员了，之后启动适配器就不再弹 UAC。

## 三、面板怎么选

`运行 → 接入状态 → 适配器`：

```
┌───────────────────────────────────────────────┐
│ ○ 微信（UIA）  wechat-adapter · sibling        │
│   操作微信窗口收发消息            [运行中] [停止] │
│ ○ 示例：回声适配器  demo-echo · adapters        │
│   只为验证多适配器识别            [启动]        │
└───────────────────────────────────────────────┘
```

- 单选按钮 = 当前选中的适配器（日志、复制配置都以它为准）
- 每个适配器都能**单独**启动/停止，互不影响
- 状态是实时的：PID 活着、或者微信那个锁端口占着，就算运行中

## 四、接口

| 接口 | 说明 |
|---|---|
| `GET /api/admin/adapters` | 列出所有适配器 + 各自运行状态 + 服务是否管理员 |
| `POST /api/admin/adapters/start` | `{ id }` 启动指定适配器 |
| `POST /api/admin/adapters/stop` | `{ id }` 停止 |
| `GET /api/admin/adapters/log?id=xx` | 该适配器日志尾巴 |

旧的 `/api/admin/adapter/start|stop|status` 保留，不传 `id` 时用第一个。

## 五、自己写一个适配器

最小可用：

```
adapters/my-bot/
  adapter.json
  main.py
```

`adapter.json`：

```json
{ "name": "我的机器人", "entry": "main.py", "needsAdmin": false }
```

`main.py` 需要做的事：

1. 收消息 → `POST /api/inbound`（字段见 `docs/adapter-protocol.md`）
2. 拿到回复 → 发出去
3. 每 20 秒 `POST /api/bridge/heartbeat`，面板才能显示在线
4. 想拿配置（概率、节奏）→ `GET /api/adapter/config` 与 `/api/media/policy`

参考 `examples/adapter-skeleton/`。

## 六、已知限制

- **微信发图片必须走剪贴板粘贴**，需要真实窗口，无法纯后台
- 适配器崩溃不会影响核心（它们是独立进程），但会断这个平台的消息
- 同时跑两个操作微信的适配器会抢窗口，不要这么干
