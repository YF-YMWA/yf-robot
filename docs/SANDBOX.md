# 沙箱与工具权限

## 它防什么

ENbot 是本地个人助手，沙箱的第一目标不是防“拿到同权限账户的黑客”，而是：

- 模型手滑改错/删错文件
- 网页、插件、聊天内容里的提示注入，诱导它执行危险操作
- 命令/脚本借工具层越界

## 文件边界

所有文件工具都走 `ToolKit.resolveSafe()`：

- 只接受工作目录内的相对路径
- 拒绝绝对路径、盘符、UNC、`..`
- 拒绝 NTFS 数据流（`file.txt:stream`）和 Windows 保留设备名（`CON`、`COM1` 等）
- 拒绝尾随点/空格
- 对目标或最近已存在父目录做 realpath 校验，防止 junction/symlink 指向外面
- 不跟随 symlink/junction，不操作硬链接文件

工作目录默认是 `agent-workspace/`，可以在设置里改。

## 命令与代码

`run_command` 白名单只保留：

```
ffmpeg ffprobe dir ls type cat
```

Python / Node 不再直通。需要执行代码时用单独的高危工具 `run_code`：

- 只在 `tools.permission = "full"` 时可用
- 每次都弹审批，展示代码预览和工作目录
- 没有审批通道的通道直接拒绝

### Windows AppContainer

首次使用前，右键 **以管理员身份运行** `初始化沙箱.bat`，只做一次：

- 创建 AppContainer profile
- 给 runtime 目录授予运行时 capability 的只读权限
- 启动常驻的提权沙箱 daemon（`data/sandbox-daemon.json`）
- 写 `data/sandbox-setup.json`

之后 `run_code` 通过本地 daemon 在 AppContainer 里执行：

- 工作区可读写；runtime 只读
- 默认断网
- 有超时、输出上限、进程树终止
- 没有初始化时直接报错，不会降级成裸跑

> 当前隔离针对 Windows；Linux/macOS 仍按普通进程执行，后续再接 bwrap/Seatbelt。

## 配额与回滚

- 工作区默认总上限 200MB（`tools.maxWorkspaceSize`），写文件前检查；超限拒绝
- 覆盖文件前自动把旧文件复制到 `data/sandbox-trash/<id>/`
- 新建文件也会记一条 `create` 记录，撤销时删除
- 控制台「工具 → 沙箱」可以看用量、最近操作、清理临时文件、恢复写入备份
- 只保留最近 50 份；7 天前的备份清理时删除

## 审计

写文件、执行命令、执行代码、权限拒绝都会追加到：

```
data/sandbox-audit.log
```

一行一个 JSON，不记录代码正文，只记录语言、长度、命令和参数摘要。

## 已知边界

- 插件是进程内代码，没有沙箱；只装可信插件
- DSH 仍是外部进程，`run_code`/DSH 都不等于容器
- 沙箱 daemon 需要初始化时的一次管理员授权；重启后要重新运行 `初始化沙箱.bat`
- 还没有按会话隔离目录；这些是后续 P1
