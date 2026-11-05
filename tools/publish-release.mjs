/**
 * 把发行包传到 GitHub Release（只传纯框架包）。
 *
 * 为什么不传「带适配器」那个：
 *   主仓是公开的，那个包里含微信窗口自动化代码（wechatauto）。
 *   当初分成两个仓库，就是为了让主仓不含平台自动化代码 ——
 *   把合并包传上去等于把这个界限抹掉。
 */
import fs from 'node:fs';

const TOKEN = process.env.GH_TOKEN || '';
const REPO = 'YF-YMWA/e-night-companion';
const VERSION = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const TAG = 'v' + VERSION;
const FILE = 'ENbot-v' + VERSION + '.zip';

if (!TOKEN) {
  console.error('  缺少 GH_TOKEN');
  process.exit(1);
}

const H = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'ENbot',
  'content-type': 'application/json',
};

const notes = `## E Night Companion（ENC / ENbot）${TAG}

**E Night Companion**，简称 **ENC** 或 **ENbot**。名字不解释，留一点想象空间。

解压到纯英文路径（例如 \`D:\\ENbot\`），双击最外层的 **\`ENbot.exe\`** 启动
（不想用启动器就双击 \`ENbot.bat\`）。包内自带 Node 和 Python 运行时，不需要另装环境。

### 这个包包含什么

纯框架 + 启动器 + 控制台 + 插件。
**不含**任何平台的登录、协议逆向或窗口自动化代码。

要接微信，请把适配器放到 \`adapters/<名字>/\` 下（见 docs/multi-adapter.md）。

### 本次更新（0.9.30）

- **适配器兼容**
  - \`adapter.json\` 支持 \`runtime\` / \`command\` / \`health\` / \`log\` / \`features\` / \`platform\`
  - 启动器不再写死 Python：Python、Node、exe/bat、自定义命令都能启动
  - 非微信适配器不再被微信端口/PID 逻辑误判；\`needsAdmin:false\` 不弹 UAC
  - 适配器日志和面板日志分开，修复 EBUSY
- **Windows 沙箱**
  - \`run_code\` 切换到 AppContainer + Job Object
  - 工作区可写、runtime 只读、默认断网
  - 限制进程数/内存/CPU，超时杀整棵进程树
  - 初始化时申请一次管理员权限并启动常驻 daemon，之后不弹 UAC
  - 新增 \`初始化沙箱.bat\`；未初始化时直接报错，不降级裸跑
  - 工作区 ACL 自动清理，沙箱面板增加用量/回收站/审计/恢复

### 0.9.29 沙箱加固

- realpath 校验，拒绝 junction/symlink 走出工作目录
- 拒绝绝对路径、UNC、ADS、Windows 保留设备名和硬链接
- \`run_command\` 移除 Python/Node 直通；新增 \`run_code\`，仅完全权限 + 每次审批

### 0.9.28 动图上传

- **动图上传**
  - GIF / APNG / 动画 WebP 自动带「动图」标签
  - 视觉识别失败也保留动图标签，不再整张失败
  - 动图上限 32MB，静态图 16MB；控制台和 HTTP body 同步放宽
  - 视觉识别统一抽首帧；重建索引也会补动图标签

### 0.9.27 新图标

- **新品牌图标：月夜少女**
  - 深色星空 + 月牙 + 全身少女 + 朦胧月光
  - 1024 母版、多尺寸 ICO；16/20/24 头部特写，32 以上全身
  - 启动器、关于页、EXE、快捷方式、任务栏同步

### 0.9.26 仓库更名

- **两个 GitHub 仓库更名**
  - 主仓：\`YF-YMWA/yf-robot\` → \`YF-YMWA/e-night-companion\`
  - 适配器仓：\`YF-YMWA/yf-robot-wechat-adapter\` → \`YF-YMWA/e-night-companion-adapter\`
  - 更新检查、发布脚本、README、\`package.json\` 全部指向新地址；旧地址由 GitHub 自动重定向
  - 适配器发现支持新目录名，旧目录名继续兼容

#### 启动器与改名（0.9.25）

- **更名**：YF-Robot → **E Night Companion（ENbot）**
  - 启动器 exe 改为 \`ENbot.exe\`，快捷方式、托盘、安装器、控制台、文档统一换名
  - 旧品牌快捷方式 / 启动项 / 卸载项由安装器自动迁移
  - \`YF-Robot.bat\` 保留为兼容入口，实际调用 \`ENbot.bat\`
- **启动器界面**：WebView2 单页应用，无边框窗口 + 侧栏，
  概览 / 插件 / 市场 / 设置；服务状态、日志、备份恢复都在里面
- **控制台 / 聊天改成独立原生窗口**：仍用 WebView2 内嵌，不再拉起 Edge
- **高 DPI**：声明系统 DPI 感知，150% / 200% 缩放下不再被位图放大
- **exe 放到最外层**：根目录 \`ENbot.exe\`，自带多尺寸图标与版本信息
- **0.9.25 版图标**：机器人头像，16/20/24 单独优化；托盘图标带状态点（0.9.27 已换成月夜少女）
- **预览 / 截图模式**：\`--preview\`、\`--shot=路径\`、\`--page=plugins\`
- **打包**：\`pack.mjs --zip\` 直接产出发布包

### 修复

- 手动点「停止服务」后被守护逻辑立刻拉起
- 开机自启（\`--silent\`）时「打开启动器」没反应
- 重启服务的空档里可能重复拉起进程
- 启动时同时弹出 Edge 控制台和启动器窗口
- 无边框窗口在网页区域拖不到边

### 升级说明

- **0.9.24 及更早的「一键更新」只覆盖代码，不会替换新的启动器 exe 和桌面 UI。**
  升级到 0.9.30 请手动解压覆盖（\`config.json\`、\`data/\` 会保留）。
- 解压后跑一次 \`安装软件.bat\`：会建 \`ENbot\` 快捷方式，并清掉旧的 \`YF-Robot\` 快捷方式/启动项/卸载项。
- 「一键更新」默认勾选「连适配器一起更新」：
  只更新 \`adapter/\` 下的非 git 副本，保留 \`config.json\` 和 \`data/\`；
  \`adapter/\` 是 git 副本时会跳过。
- 带微信适配器的完整包（\`-with-adapter.zip\`）不放在这个 Release 里。
`;

async function main() {
  const size = fs.statSync(FILE).size;
  console.log('  文件:', FILE, (size / 1024 / 1024).toFixed(1), 'MB');

  // 1. 创建（或复用）release
  let rel = null;
  const existing = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, {
    headers: H,
  });
  if (existing.ok) {
    rel = await existing.json();
    console.log('  release 已存在:', rel.html_url);
  } else {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        tag_name: TAG,
        name: `E Night Companion（ENC / ENbot）${TAG}`,
        body: notes,
        draft: false,
        prerelease: false,
      }),
    });
    if (!r.ok) {
      console.error('  创建 release 失败:', r.status, (await r.text()).slice(0, 300));
      process.exit(1);
    }
    rel = await r.json();
    console.log('  已创建 release:', rel.html_url);
  }

  // 2. 已经传过就跳过
  const already = (rel.assets || []).find((a) => a.name === FILE);
  if (already) {
    console.log('  附件已存在:', already.browser_download_url);
    process.exit(0);
  }

  // 3. 上传
  console.log('  上传中…（' + (size / 1024 / 1024).toFixed(1) + ' MB）');
  const uploadUrl = String(rel.upload_url).replace('{?name,label}', `?name=${encodeURIComponent(FILE)}`);
  const buf = fs.readFileSync(FILE);

  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'ENbot',
      'content-type': 'application/zip',
      'content-length': String(buf.length),
    },
    body: buf,
  });

  if (!up.ok) {
    console.error('  上传失败:', up.status, (await up.text()).slice(0, 300));
    process.exit(1);
  }
  const asset = await up.json();
  console.log('  上传成功:', asset.browser_download_url);
  console.log('  release 页面:', rel.html_url);
}

main().catch((e) => {
  console.error('  出错:', e.message);
  process.exit(1);
});
