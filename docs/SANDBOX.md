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
- 代码在沙箱目录里跑，环境变量做了最小化，但**仍然拥有当前用户权限**

> 注意：`run_code` 不是 OS 级隔离，不能拿它跑不可信代码。真正的进程隔离（Job Object / AppContainer / 容器）是下一步。

## 审计

写文件、执行命令、执行代码、权限拒绝都会追加到：

```
data/sandbox-audit.log
```

一行一个 JSON，不记录代码正文，只记录语言、长度、命令和参数摘要。

## 已知边界

- 插件是进程内代码，没有沙箱；只装可信插件
- DSH 仍是外部进程，`run_code`/DSH 都不等于容器
- 还没有按会话隔离目录、快照回滚和总配额；这些是后续 P1
