# YF-Robot

一个能陪聊、能干活、能进微信的人设化 AI 助手。

Node.js 写核心（零第三方依赖），Python 只给适配器用。Windows 下载解压双击即用。

> **免责声明**：微信自动化违反《微信个人账号使用规范》，有封号风险。
> 本项目仅用于个人学习研究，请自行承担后果。详见 [合规说明](#合规说明)。

---

## 快速开始

**方式一：下载发行包**（不想碰代码，推荐）

👉 **[下载最新版](../../releases/latest)** —— 约 52 MB，包内自带 Node 和 Python 运行时，
不用装任何环境。

解压到**纯英文路径**（例如 `D:\YF-Robot`），双击 `YF-Robot.bat`。
第一次启动会让你填模型 Key（DeepSeek / 智谱 / 通义 / Ollama 都行）。

> 别解压到桌面或「文档」—— Windows 的受控文件夹访问可能拦住写配置。
> 升级就解压覆盖到旧目录：`config.json` 和 `data/` 不会被覆盖，记忆还在。

**方式二：从源码跑**

```bash
git clone https://github.com/YF-YMWA/yf-robot.git
cd yf-robot
cp config.example.json config.json   # 然后填 Key
node app.mjs
```

三个入口，随便挑一个：

| 入口 | 用途 |
|---|---|
| 双击 `桌面控制台.bat` | 管理后台，独立窗口（无地址栏） |
| 双击 `桌面聊天.bat` | 聊天窗口，能传图、能看流式回复 |
| 浏览器开 `http://127.0.0.1:8899/console` | 从手机或另一台电脑管 |

---

## 需要的 Key

| 用途 | 服务 | 必须？ |
|---|---|---|
| 对话 | [DeepSeek](https://platform.deepseek.com/) | **必须** |
| 看图 / 知识库向量 | [智谱 GLM-4V](https://open.bigmodel.cn/) | 可选，有免费额度 |
| 画图 | [智谱 CogView](https://open.bigmodel.cn/) | 可选 |
| 联网搜索 | [博查](https://open.bochaai.com/) | 可选 |
| 语音转写 / 合成 | [阿里云百炼](https://bailian.console.aliyun.com/) | 可选 |

只填对话 Key 就能用，其它功能自己降级。

---

## 功能一览

| 能力 | 关键点 |
|---|---|
| **角色卡** | Character Card V2，控制台新建/编辑，**切换立即生效** |
| **数据按卡隔离** | 知识库 / 逻辑库 / 记忆 / 画作各自独立，换卡不串味 |
| **长期记忆** | 会话落盘、事实提取、跨会话隔离、群聊按发言人分开记 |
| **知识库** | 导入 .txt/.md/.docx/.html，聊天时自动检索参考 |
| **逻辑库** | 存「遇到情况怎么做」的经验，可手写、可从网页学（默认要审核） |
| **词库** | 网络用语 568 / 回怼 206 / 缩写 30，按语气只注入用得上的那类 |
| **看图** | 收到的图（含 GIF、wxgf）自动识别成文字再参与对话 |
| **画图** | 按描述生成并发出去 |
| **语音** | 转写 + 合成；合成前先清洗（去掉动作描写和 emoji 再念） |
| **情绪状态** | 被骂会烦、被夸会乐，影响回复长短和发不发语音 |
| **像真人** | 句尾不打句号、偶尔只回一句、偶尔打错字再改口、读消息才回 |
| **主动搭话** | 安静久了主动说一句，模型现写而不是套模板 |
| **素材库** | 感知哈希去重、自动情绪标签、按语气挑图、支持批量删除 |
| **插件** | `plugins/` 放个目录就能加工具和钩子，不用改核心 |
| **工具白名单** | 每个工具单独开关，插件工具一视同仁 |
| **可插拔接入** | 任何平台写成适配器即可接入，核心不含平台代码 |
| **Key 保护** | 原子写盘、守卫、50 份归档，一键修复能从备份恢复 |
| **维护** | 一键修复（查 Key / 目录 / 配置）+ 一键更新（只覆盖代码） |

---

## 更新日志

完整记录见 [CHANGELOG.md](CHANGELOG.md)。最近几版做了什么：

### v0.9.x —— 像真人 + 按卡隔离

- **按角色卡隔离数据**：知识库 / 逻辑库 / 记忆 / 她画的图各归各卡，
  换卡不再串味；老数据首次启动自动搬进当前卡
- **情绪状态**：骂人 −3、夸人 +2、敷衍 −0.6，随时间回归；
  影响语气和「要不要发语音」
- **句尾句号自然化**：实测她 77% 的气泡带句号，这是最像机器的地方 ——
  现在短句结尾的句号 75% 概率去掉（问号感叹号不动）
- **偶尔只回一句 + 读消息延迟**：不再每轮都发两三条，也不再秒回
- **主动搭话改成模型现写**：以前六套模板，聊三天就能背下来
- **语音联动重构**：念之前先清洗（去动作描写/emoji/代码），
  太短太长都不念；音色可按卡配置，支持导入语音包
- **一键修复 / 一键更新**：Key 丢了能从备份恢复；更新只覆盖代码，不动数据

### v0.8.x —— 三种库 + 插件

- **逻辑库**：和知识库分工（事实 vs 经验），可从网页学，默认先进待审
- **插件系统**：`plugins/` 放目录即可加工具和钩子，出错不影响核心
- **知识库 / 语音合成**：导入文档自动检索；文字转语音发出去
- **控制台合并**：15 页压到 11 页（资料 / 身份 / 运行 三组带标签栏）

---

## 接聊天平台

**这个仓库只包含框架，不含任何平台的登录、协议逆向或自动化代码。**

```
任何能收发消息的程序  ──HTTP──▶  YF-Robot 核心
（微信 / QQ / Telegram / 自己写的）
```

- 协议：[`docs/adapter-protocol.md`](docs/adapter-protocol.md)
- 骨架：[`examples/adapter-skeleton/`](examples/adapter-skeleton/) —— 跑起来就能看到端到端通了

微信适配器是**另一个项目**，单独发布、单独声明风险，与本仓库无关。

---

## 文档

| 文件 | 内容 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | 每个版本改了什么 |
| [docs/BUGS.md](docs/BUGS.md) | 修过的真实故障（现象/根因/修复/回归测试） |
| [docs/llm-inspired.md](docs/llm-inspired.md) | 借鉴大模型原理做的优化（上下文预算/前缀缓存/指令层级…） |
| [docs/adapter-protocol.md](docs/adapter-protocol.md) | 适配器 HTTP 协议 |
| [docs/plugin-api.md](docs/plugin-api.md) | 插件开发 |
| [docs/logic-library.md](docs/logic-library.md) | 逻辑库怎么用、安全边界 |
| [docs/content-model.md](docs/content-model.md) | 三种库各管什么、为什么不合并 |
| [docs/data-scoping.md](docs/data-scoping.md) | 按角色卡隔离的目录结构 |
| [docs/multi-adapter.md](docs/multi-adapter.md) | 多适配器：放哪、怎么选、要不要 UAC |
| [docs/architecture-review.md](docs/architecture-review.md) | 向 AstrBot / NoneBot / Koishi 学了什么、不学什么 |

---

## 目录结构

```
core/          引擎、模型客户端、记忆、三种库、工具
channels/      web（控制台/聊天页）、group（群聊接口）
web/           console.html 控制台、index.html 聊天页
plugins/       插件（示例：掷骰子 + 便签本）
cards/         角色卡
resources/     词库
tools/         测试与打包脚本
docs/          文档
tests/         单元测试
```

---

## 开发

```bash
node tools/run-tests.mjs           # 单元测试（450 项）
node tools/check-console-js.mjs    # 控制台语法
node tools/check-console-pages.mjs # 页面结构（孤儿页 / 死入口）
node tools/test-all-features.mjs   # 功能实测（要服务在跑）
node tools/pack.mjs                # 打包
```

---

## 合规说明

本项目**不含**以下任何内容：

- 微信客户端的协议逆向、内存注入、DLL 劫持
- 绕过微信安全机制的代码
- 任何平台的登录凭证或账号数据

适配器是独立项目，其风险与合规责任由使用者自行承担：

- 微信适配器：<https://github.com/YF-YMWA/yf-robot-wechat-adapter>
  （Windows UI 自动化方案，**违反微信个人账号使用规范，有封号风险**，仅供学习研究）
- 适配器协议文档：[docs/adapter-protocol.md](docs/adapter-protocol.md) —— 想接其他平台照着实现即可

---

## 许可

MIT，见 [LICENSE](LICENSE)。第三方组件见 [NOTICE](NOTICE)。
