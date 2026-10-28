# 架构评审：向主流机器人框架学什么

写这份文档的原因：一天之内修了 4 个同类 bug（工具开关、情绪开关、语音概率、
气泡节奏），全是「同一个配置要在两处各写一遍，漏了一边就静默失效」。
这不是手滑，是结构问题。所以去看了几个成熟框架怎么组织，再决定我们改哪里。

参考的三个框架：

- **AstrBot** —— 事件总线 + 消息管道 + Provider 注册 + Star 插件（Python）
- **NoneBot2** —— matcher 分发 + 依赖注入（Python）
- **Koishi** —— 服务容器 + 中间件链 + **Schema 驱动配置**（TypeScript）

---

## 一、它们共同的三件事

### 1. 配置由 Schema 生成，不是手写读写

Koishi 的 `Schema`（schemastery）最典型：插件只声明字段和类型，
默认值、校验、界面表单项、持久化全部由框架推出来。
AstrBot 的 `astrbot/core/config` 也是同一思路。

**我们的问题**：`#publicConfig()` 手写一遍字段，`#saveConfig()` 手写一遍合并，
两边独立维护 → 加字段漏一边就静默失效。

**已改**：`core/config-schema.mjs` 成为唯一事实来源，声明 100 个字段，
四个行为从它推出来：

| 函数 | 用在哪 |
|---|---|
| `defaults()` | 首次生成配置 |
| `fillDefaults()` | 一键修复补缺 |
| `applyPatch()` | 保存配置（含类型校验、范围夹取、枚举白名单） |
| `toPublic()` | 读接口（自动脱敏 Key） |

以后加字段只改 schema 一处。`tests/config-schema.test.mjs` 用声明本身做断言
（每个字段都要有默认值、能写入、能读出、密钥必须脱敏），所以漏写会挂测试。

### 2. 消息处理是显式管道，不是一个大方法

AstrBot 的流程：事件入队 → 分发 → 管道各阶段（过滤/唤醒/会话/Provider/工具）
→ 出站。每段可单独测试、单独跳过。

**我们的问题**：`engine.mjs` 的 `#reply()` 一千多行，从上下文拼装到发语音都在里面。
出问题只能靠日志猜。

**现状与取舍**：这次没动主干（风险太大），但做了两件降低耦合的事：

- 工具层从「构造时判断一次」改成 `syncTools()` 每轮校正，可开关
- 上下文拼装、语音决策、拟人化后处理都拆成了独立模块（`context.mjs`、
  `voice-reply.mjs`、`humanize.mjs`），可以被单测直接调用

**下一步**（未做，列出来避免遗忘）：把 `#reply()` 按 AstrBot 的阶段切成
`#buildContext / #callModel / #runTools / #postProcess / #buildPayload`，
每个阶段输入输出都是明确的对象。

### 3. 插件/工具必须有超时和隔离

NoneBot 和 AstrBot 都给 handler 加了超时和异常隔离，一个插件卡住不拖垮整个机器人。

**我们的现状**：插件加载有 try/catch，工具调用有 `cmdTimeout`，
但 LLM 调用和工具整体没有统一超时。

**下一步**：给「一轮对话」加总超时（例如 120 秒），超了就回一句
「我这会儿有点慢，等我一下」而不是永远不回。

---

## 二、刻意不学的

| 框架做法 | 为什么不学 |
|---|---|
| 依赖注入容器（NoneBot2） | 我们只有十几个模块，手写传参更直观；引入 DI 框架会让调试栈变深 |
| 事件总线（AstrBot） | 单进程单用户场景，一个 HTTP 入口 + 直接调用足够；总线反而增加「消息去哪了」的排查成本 |
| matcher 正则分发（NoneBot2） | 我们不是指令型机器人，是对话型，意图交给模型判断 |
| 服务容器（Koishi） | 同上，规模不到 |

判断标准很简单：**能减少 bug 的模式就学，只是「看起来更架构」的不学。**

---

## 三、从这次 bug 反推的三条规矩

1. **配置只有一个来源**：加字段改 `config-schema.mjs`，别在 admin 里手写第二份
2. **"改了有没有生效"要能被自动发现**：`tools/check-config-save.mjs`（查落盘）
   + `tools/check-runtime-effects.mjs`（查行为）两个脚本
3. **接口字段要么有测试，要么有校验**：`check-adapter-e2e.mjs` 会断言
   `/api/adapter/config` 里 `voiceChance`、`stickerChance`、`pace` 都在

---

## 四、当前自检矩阵

| 脚本 | 查什么 | 项数 |
|---|---|---|
| `tools/run-tests.mjs` | 单元测试 | 476 |
| `tools/check-all.mjs` | 运行时自检 | 36 |
| `tools/test-all-features.mjs` | 功能实测 | 29 |
| `tools/check-config-save.mjs` | 配置落盘 | 14 |
| `tools/check-runtime-effects.mjs` | 改完是否立刻生效 | 6 |
| `tools/check-adapter-e2e.mjs` | 适配器全链路 | 18 |
| `tools/check-console-*.mjs` | 控制台语法/函数/页面 | 3 |

跑一遍：

```bash
node tools/run-tests.mjs
node tools/check-config-save.mjs
node tools/check-runtime-effects.mjs
node tools/check-adapter-e2e.mjs
```
