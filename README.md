# 鲸鲸（Jingjing）

一个能陪聊、能干活、能进微信的人设化 AI 助手。

Node.js + Python，Windows 桌面双击即用。支持自定义角色卡、长期记忆、联网搜索、看图、画图、语音转写，以及通过 [DeepSeek Harness](https://github.com/deepseek-ai) 反向调用 agent 干活。

> **免责声明**：微信自动化违反《微信个人账号使用规范》，有被封号的风险。本项目仅用于个人学习研究，请自行承担后果。详见 [合规说明](#合规说明)。

---

## 它长什么样

```
┌─────────────────────────────────────┐
│  控制台  http://127.0.0.1:8899/console  │
├─────────────────────────────────────┤
│  总览     运行状态 / 一键测试          │
│  对话调试  直接和它聊                  │
│  模型功能  Key、开关、频率             │
│  角色卡    新建 / 编辑 / 切换（热生效） │
│  主人设置  谁能指挥它                  │
│  记忆      它记住了什么                │
│  词库      网络用语 / 回怼 / 缩写       │
│  素材库    图片、表情包、动图、查重      │
│  联网学习  自动学词、学图、热点摘要      │
│  微信桥接  连接状态、UIA 诊断           │
│  日志      实时尾巴                    │
└─────────────────────────────────────┘
```

---

## 快速开始

### 方式一：下载发行包（推荐给不写代码的人）

到 [Releases](../../releases) 下载最新 `鲸鲸.zip`，解压到**纯英文路径**（例如 `D:\jingjing`），双击 `鲸鲸.bat`。

包内自带 Node 和 Python 运行时，**不需要另外安装**。

> 不要解压到桌面或「文档」——Windows 的「受控文件夹访问」可能拦住写配置。

### 方式二：从源码运行

```bash
git clone https://github.com/<your-name>/jingjing.git
cd jingjing

# 1. Node 依赖（当前没有第三方依赖，只检查版本）
node --version   # >= 18

# 2. Python 依赖（接微信才需要）
python -m pip install -r requirements.txt

# 3. 首次配置：复制示例配置，填 Key
copy config.example.json config.json

# 4. 启动
node app.mjs
```

打开 http://127.0.0.1:8899/console ，在「模型与功能」里填 Key。

### 需要的 Key

| 用途 | 服务 | 是否必须 |
|---|---|---|
| 对话 | [DeepSeek](https://platform.deepseek.com/) | **必须** |
| 看图 | [智谱 GLM-4V](https://open.bigmodel.cn/) | 可选，有免费额度 |
| 画图 | [智谱 CogView](https://open.bigmodel.cn/) | 可选，有免费版 |
| 联网搜索 | [博查](https://open.bochaai.com/) | 可选 |
| 语音转写 | [阿里云百炼](https://bailian.console.aliyun.com/) | 可选 |

只填对话 Key 就能用，其他功能会自己降级。

---

## 接微信

需要 **Windows + 管理员权限**，因为要读微信进程和数据库。

1. 微信 PC 版登录，**保持窗口可见**（别最小化到托盘）
2. 双击 `启动微信桥接.bat`，UAC 弹窗点「是」
3. 控制台「微信桥接」页看到「在线」就好了

桥接基于 [wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)（Apache-2.0）。

---

## 核心功能

### 角色卡

标准 [Character Card V2](https://github.com/malfoyslastname/character-card-spec-v2) 格式，放在 `cards/*.json`。

控制台可以新建/编辑/删除，**切换立即生效**（不用重启）：

```json
{
  "spec": "chara_card_v2",
  "spec_version": "2.0",
  "data": {
    "name": "鲸鲸",
    "speaker": "主人",
    "description": "深蓝色长卷发，鲸尾发夹…",
    "personality": "懒、馋、嘴硬心软",
    "system_prompt": "说话简短，偶尔撒娇",
    "first_mes": "主人回来啦"
  }
}
```

### 长期记忆

- **会话落盘**：每轮对话写 `data/sessions/<id>.json`，重启、桥接断线重连都接着聊
- **事实提取**：自动从「我叫X」「我喜欢Y」里抽事实，问句不抽（避免把「我最喜欢的颜色是什么」记成「颜色=什么」）
- **摘要压缩**：历史过长时压成摘要，不丢上下文
- **跨会话**：不同人、不同群各自独立，互不串味

### 表情包 / 动图

- 收到图片、表情包自动收藏到素材库，用**感知哈希（dHash）**去重——同一张图被截两次、转两次也不会重复入库
- **动图**：微信 4.x 把 GIF 存在 `wxgf` 容器里（一段 HEVC 视频）。本项目用 ffmpeg 整段转成动画 GIF，所以素材库里能动、发出去也是动图
- **按语气挑图**：每张图有描述和情绪标签，回复后按当前语气挑贴合的，而不是随机甩

### 联网学习

- 自动从搜索 / 定向网站 / RSS 学网络用语，学完直接进词库
- 每日热点摘要：抓订阅源，总结成几条存进共享记忆
- 频率可控：每 N 轮 / 最小间隔 / 每日上限

### 反向调用 DSH

配置里开启后，遇到复杂任务它会调用 [DeepSeek Harness](https://github.com/deepseek-ai) 的 ACP 接口干活，并且**复用 DSH 会话号**——DSH 那边也记得之前聊过什么。

---

## 目录结构

```
app.mjs              服务入口
menu.mjs             主菜单（鲸鲸.bat 调它）
core/                引擎、会话、记忆、工具、学习
channels/            web / ilink / 微信群 / 微信 UIA
web/                 聊天页 + 控制台
cards/               角色卡
bridge_wg/           微信桥接（Python，独立进程）
scripts/             启动脚本
tools/               实用工具（自检、重建索引、打包）
tests/               单元测试（242 项）
config.example.json  配置模板
```

---

## 开发

```bash
# 单元测试
node --test tests/

# 功能自检（需要服务在跑）
node tools/check-all.mjs

# 控制台 JS 语法检查
node tools/check-console-js.mjs
node tools/check-console-fns.mjs

# 打包发行版
node tools/pack.mjs              # 含运行时，约 250MB
node tools/pack.mjs --no-runtime # 不含运行时，约 3MB
```

### 打包会自动做这些检查

- 敏感信息扫描（Key、wxid、本机路径、iLink token）
- **文件名**扫描（防止 `wxid_xxx_538_h.png` 这类泄露）
- 完整性检查（18 个关键文件缺一不可）
- 隐私目录排除（`data/`、`credentials/`、任何层级的 `data/`）

---

## 合规说明

**请务必读这一段再决定是否使用。**

1. **微信自动化违反用户协议**
   桥接通过 UI 自动化和读取本地数据库操作微信，这违反《微信个人账号使用规范》。**有封号风险**，尤其是高频大量发送时。请只在自己的号上低频使用。

2. **不要用于骚扰、营销、刷屏**
   项目里所有「主动搭话」「主动分享」默认关闭，就是为了避免这个。

3. **数据都在你本地**
   会话、图片、语音都存在 `data/`，不上传任何服务器。但 `config.json` 里有 API Key，**别把配置文件发给别人**。

4. **第三方组件**
   微信桥接依赖 [wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)（Apache-2.0）。本项目不包含它的源码，只通过 pip 安装使用其公开 API。

---

## 许可证

[MIT](LICENSE)

第三方组件许可见 [NOTICE](NOTICE)。

---

## 致谢

- [wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica) —— 微信 4.x 自动化库
- [DeepSeek Harness](https://github.com/deepseek-ai) —— ACP 接口与 agent 能力
- [character-card-spec-v2](https://github.com/malfoyslastname/character-card-spec-v2) —— 角色卡格式
