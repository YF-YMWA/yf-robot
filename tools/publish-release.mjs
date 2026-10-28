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
const REPO = 'YF-YMWA/yf-robot';
const VERSION = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const TAG = 'v' + VERSION;
const FILE = 'YF-Robot-v' + VERSION + '.zip';

if (!TOKEN) {
  console.error('  缺少 GH_TOKEN');
  process.exit(1);
}

const H = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'YF-Robot',
  'content-type': 'application/json',
};

const notes = `## YF-Robot ${TAG}

解压到纯英文路径（例如 \`D:\\YF-Robot\`），双击 \`YF-Robot.bat\` 启动。
包内自带 Node 和 Python 运行时，不需要另外安装。

### 这个包包含什么

纯框架 + 控制台 + 插件 + 示例适配器骨架。
**不含**任何平台的登录、协议逆向或窗口自动化代码。

要接微信，请把适配器放到 \`adapters/<名字>/\` 下（见 docs/multi-adapter.md）。

### 本次更新（0.9.15）

- **记忆备份 / 恢复**：\`备份记忆.bat\` 导出一份 json，\`恢复记忆.bat\` 放回去；
  启动时还会自动快照（保留最近 20 份），恢复前再存一份「before-restore」
- **接入状态页显示「发送 成功/失败」**：冷却中标注剩余秒数，
  一眼分清是没收到消息，还是收到了发不出去
- **BUGS.md**：12 条真实故障档案（现象 / 根因 / 修复 / 回归测试）

### 修复

- 打包带上 \`.pyc\`，里面嵌着打包机的用户名路径 —— 现在打包会跳过所有缓存
- 接入状态页的发送健康度一直空着（心跳聚合漏了 \`send\` 字段）
- 面板启动的适配器崩溃后不会被拉起（缺守护循环）
- 控制台会把本地令牌也发给局域网访问者（现在只给本机）
- 微信多开时可能把话发到另一个号（现在检测到 ≥2 个主窗就拒绝发送）

### 升级说明

直接把新包解压覆盖到旧目录即可：\`config.json\` 和 \`data/\` 不会被覆盖。
已经解压到新文件夹的，先跑一次 \`备份记忆.bat\`，再用新包覆盖，最后 \`恢复记忆.bat\`。
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
        name: `YF-Robot ${TAG}`,
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
      'user-agent': 'YF-Robot',
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
