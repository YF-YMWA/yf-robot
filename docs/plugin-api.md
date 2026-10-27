# 插件开发

给她加功能，不用改核心代码。

---

## 一分钟上手

```
plugins/
  my-plugin/
    plugin.json     ← 声明我叫什么、提供哪些工具
    index.mjs       ← 实现这些工具
```

重启服务，模型就能调用你的工具了。

**目录位置**：项目根目录的 `plugins/`（和 `core/`、`channels/` 平级）。

---

## plugin.json

```json
{
  "name": "我的插件",
  "version": "1.0.0",
  "description": "干什么用的，一句话",
  "author": "你的名字",
  "tools": [
    {
      "name": "get_weather",
      "description": "查某个城市的天气",
      "parameters": {
        "type": "object",
        "properties": {
          "city": { "type": "string", "description": "城市名" }
        },
        "required": ["city"]
      }
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | | 显示名（不填用目录名） |
| `version` | | 版本号 |
| `description` | | 一句话说明 |
| `author` | | 作者 |
| `tools[].name` | ✅ | 工具名（模型看到的函数名，用英文+下划线） |
| `tools[].description` | ✅ | **写清楚什么时候该用它**，模型靠这句话决定调不调 |
| `tools[].parameters` | | JSON Schema；不填表示无参数 |

> `description` 是效果的关键。写「查天气」不如写「查指定城市今天的天气，用户问天气/温度/下雨时用」。

---

## index.mjs

三种写法都行，挑顺手的：

### 写法一：tools 对象（推荐）

```js
export const tools = {
  get_weather(args, ctx) {
    return `${args.city} 今天晴，25 度`;
  },
};
```

### 写法二：`tools_` 前缀的函数

```js
export function tools_get_weather(args, ctx) {
  return `${args.city} 今天晴，25 度`;
}
```

### 写法三：和工具同名的函数

```js
export function get_weather(args, ctx) {
  return `${args.city} 今天晴，25 度`;
}
```

**返回值**会被当成工具结果喂回模型，所以用「人话」写，模型才回答得像样。

---

## ctx 上有什么

| 成员 | 作用 |
|---|---|
| `ctx.id` | 插件 id（目录名） |
| `ctx.log(...)` | 打日志，前缀自动带插件名 |
| `ctx.config` | 插件自己的配置（`config.json` 里 `plugins.items.<id>`） |
| `ctx.dataDir` | 自己的数据目录 `data/plugin-data/<id>/` |
| `ctx.loadData(name, fallback)` | 读自己的 JSON |
| `ctx.saveData(name, value)` | 写自己的 JSON（原子写） |
| `ctx.fetch` | 全局 fetch |
| `ctx.now()` | 当前时间 |

数据是**按插件隔离**的，各自一个目录，不会互相覆盖。

---

## 钩子

除了工具，还能插手消息流程。

### `onMessage` —— 消息进模型之前

```js
export function onMessage(payload, ctx) {
  // payload: { text, sessionId, speakerName, isOwner, images, audio }

  if (payload.text.includes('脏话')) {
    return { block: '命中屏蔽词' };   // 这条不回
  }
  if (payload.text === 'hi') {
    return '你好';                    // 改写消息
  }
  return undefined;                   // 不干预
}
```

| 返回 | 效果 |
|---|---|
| 字符串 | 替换消息内容 |
| `{ text }` | 同上 |
| `{ block: '原因' }` | 这条消息不回（`/api/wechat` 返回 `action: 'ignore'`） |
| 其他 / 不返回 | 不干预 |

多个插件时按加载顺序串联，后一个看到的是前一个改过的结果。

### `onLoad` / `onUnload`

```js
export function onLoad(ctx) { ctx.log('我起来了'); }
```

`onLoad` 在启动时调用（8 秒超时）。

---

## 超时与容错

| 项 | 限制 |
|---|---|
| 单个工具调用 | 20 秒 |
| 钩子 | 8 秒 |
| `onLoad` | 8 秒 |

超时或者抛异常都**不会**让核心崩溃：

- 工具出错 → 模型收到一句话「（工具 xxx 出错了：原因）」
- 钩子出错 → 记日志，跳过这个插件，其他插件照常

---

## 名字冲突

如果两个插件都提供 `get_weather`：

- 先加载的用原名
- 后加载的自动变成 `<插件目录名>_get_weather`

**不会覆盖内置工具**（`search_web`、`draw_image` 这些）。

---

## 启用 / 禁用

控制台「插件」页可以点禁用，状态存在 `data/plugins.json`，**重启后生效**。

也可以直接改那个文件：

```json
{ "my-plugin": { "enabled": false } }
```

---

## ⚠️ 安全

**插件和核心在同一个进程里跑，能拿到 Node 的一切**（读写文件、跑命令、发网络请求）。

这里**没有沙箱**——能做沙箱的只有独立进程 + 权限隔离，本项目不做，也不假装能做。

所以：

- **只装你自己写的、或者你看过源码的插件**
- 别人发你一个 `plugins/xxx/` 目录，等于给他一个在你电脑上执行任意代码的机会

---

## 完整例子

`plugins/demo-dice-notes/` 是一个能跑的示例：

- `roll_dice` —— 掷骰子（参数：面数、次数）
- `save_note` / `list_notes` —— 便签本（演示 `ctx.saveData` / `ctx.loadData`）
- `onMessage` —— 把英文 `hi` 改成「你好」（演示改写消息）

照着改就行。
