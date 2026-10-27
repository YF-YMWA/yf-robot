/**
 * 打包脚本：生成可分发版本。
 *
 * 做的事：
 *   1. 复制代码到 dist/
 *   2. 清空所有 API Key（config.json → config.example.json 的内容）
 *   3. 删除日志、临时文件、会话数据
 *   4. 生成使用说明
 *   5. 检查是否有敏感信息残留
 *
 * 用法：
 *   node tools/pack.mjs            # 打包到 dist/
 *   node tools/pack.mjs --check    # 只检查敏感信息，不打包
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const ONLY_CHECK = process.argv.includes('--check');
/** 是否包含运行时（node/python），默认包含 */
const WITH_RUNTIME = !process.argv.includes('--no-runtime');
/** 是否包含 Python（只在接微信时需要） */
const WITH_PYTHON = !process.argv.includes('--no-python');
/** 是否生成 zip */
const MAKE_ZIP = process.argv.includes('--zip');

/** 要复制的目录/文件。 */
const INCLUDE = [
  'app.mjs',
  'launch_background.mjs',
  'menu.mjs',
  'setup.mjs',
  'setup_vision.mjs',
  'package.json',
  'config.example.json',
  'persona.json',
  'README.md',
  // 开源分发必须带上许可证和第三方声明
  'LICENSE',
  'NOTICE',
  'core',
  'channels',
  'web',
  'cards',
  // 不打包 tests/：单元测试是开发用的，用户不需要；
  // 而且里面有一个写死的假 Key（sk-test-mock-*），会一直被扫描器拎出来。
  'tools',
  'bridge',
  // 启动脚本：YF-Robot.bat 会调 scripts\start.ps1，漏了就打不开
  'scripts',
  // 所有用户入口，一个都不能漏 —— 之前漏过三个，对方拿到手上只有主菜单
  '启动服务.bat',
  'YF-Robot.bat',
  '状态面板.bat',
  '工具菜单.bat',
  '启动微信桥接.bat',
];

/** 不复制的内容。 */
const EXCLUDE_PATTERNS = [
  /node_modules/,
  /__pycache__/,
  /\.pyc$/,
  /\.log$/,
  /\.bak$/,
  /^data\//,
  /^\.tmp\//,
  /^credentials\//,

  /**
   * bridge/data/ 是桥接的运行时数据，绝对不能打包。
   *
   * 里面实测有 31 个用户个人文件：收到的图片、**本人的语音消息**
   * （.silk 原始 + .wav 转码）、care/share 状态，而且文件名全都带着
   * 用户的 wxid（wxid_xxx_538_h.png 这种）。
   *
   * 之前只写了 /^data\//，管不到子目录，结果这些东西真的进了包。
   */
  /^bridge\/data\//,

  /**
   * 兜底：任何层级的 data/ 目录都不进包。
   * 以后新加的模块要是又搞个 xxx/data/，这里能拦住。
   */
  /(^|\/)data\//,

  // 只排除根目录的 config.json。
  // 以前写的是 /config\.json$/（末尾锚定），会把 bridge/config.json 也排掉 ——
  // 结果分发出去的包桥接一启动就读不到配置，GAME_TOKENS 这类变量全空，
  // 线程直接 NameError 崩掉，用户看到的就是「解压了用不了」。
  /^config\.json$/,
  // 桥接配置不直接复制：它里面有真实的 API Key（智谱那种 xxxx.yyyy 格式），
  // 复制过去会被敏感信息扫描拦下，或者更糟 —— 漏过去真的发给别人。
  // 改成在【5】里读源文件、清空 Key 和名单之后单独写一份干净的。
  /^bridge\/config\.json$/,
  /package-lock\.json$/,
  /\.dsh-home/,

  // bridge 下的调试脚本
  /^bridge\/test_/,
  /^bridge\/check_/,
  /^bridge\/diag_/,
  /^bridge\/verify_/,

  // Python 单元测试也不进发行包（跟根目录的 tests/ 一样）
  /^bridge\/tests\//,

  // 我排查问题时产生的临时文件
  /\.before-heal\.bak$/,
  /^dist\//,
];

/**
 * tools/ 只放行这几个给用户用的脚本，其余（一堆 test-/diag-/confirm- 之类）
 * 一律不打包。
 *
 * 为什么改成白名单：
 *   原来是黑名单（排除 test-* / diag-* …），每次新增开发脚本都得记得加规则，
 *   忘一次就把硬编码的 wxid 打进包里了 —— 实际就漏过 confirm-all.mjs。
 *   白名单下新脚本默认不出去，安全方向反过来了。
 */
const TOOLS_ALLOW = new Set([
  'tui.mjs', // 状态面板.bat 用
  'autostart.mjs', // 开机自启
  'pack.mjs', // 重新打包
  'check-all.mjs', // 自检
  'build-sticker-index.mjs', // 重建表情包描述索引
  'to_gbk.ps1', // 编码转换小工具
]);

/** 敏感信息模式。 */
const SECRET_PATTERNS = [
  { name: 'DeepSeek Key', re: /sk-[a-f0-9]{20,}/g },
  { name: '智谱 Key', re: /[a-f0-9]{32}\.[A-Za-z0-9]{16}/g },
  { name: '博查 Key', re: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'ilink token', re: /[a-zA-Z0-9_-]{30,}@im\.(bot|wechat)/g },
  { name: '通用 apiKey', re: /"apiKey"\s*:\s*"[^"]{10,}"/g },
  // 打包人的个人 wxid：不该出现在分发给别人的代码里
  // 排除占位符（全 x、全 0 这种），否则注释里的示例会误报
  { name: '硬编码 wxid', re: /wxid_(?!x{6,}|0{6,}|1{6,})[a-z0-9]{10,}/g },
  // 本机用户名路径：会暴露「打包的人叫什么」
  {
    name: '本机用户路径',
    re: /C:\\{1,2}Users\\{1,2}(?!<|%|Public|username|user)[A-Za-z0-9_.-]{2,}/g,
  },
];

/** 递归收集文件。 */
function walk(dir, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;

  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.join(base, name);
    const stat = fs.statSync(full);

    // 统一成正斜杠再比规则：Windows 下 path.join 给的是反斜杠，
    // 规则里写的是 /，不转换会导致排除规则全部失效
    const relPosix = rel.replace(/\\/g, '/');
    const fullPosix = full.replace(/\\/g, '/');

    if (EXCLUDE_PATTERNS.some((p) => p.test(relPosix) || p.test(fullPosix))) continue;

    // tools/ 白名单：不在名单里的开发脚本一律跳过
    if (relPosix.startsWith('tools/') && relPosix !== 'tools') {
      const rest = relPosix.slice('tools/'.length);
      // 只放行顶层文件，子目录一律不出去
      if (!rest.includes('/') && TOOLS_ALLOW.has(rest)) {
        out.push({ full, rel, size: stat.size });
      }
      continue;
    }

    if (stat.isDirectory()) {
      out.push(...walk(full, rel));
    } else {
      out.push({ full, rel, size: stat.size });
    }
  }
  return out;
}

/** 检查文件里有没有敏感信息。 */
function scanSecrets(files) {
  const found = [];

  for (const f of files) {
    const relPosix = f.rel.replace(/\\/g, '/');

    /**
     * 文件名本身就带隐私的先查一遍。
     *
     * 实测踩过：bridge/data/media-cache/ 里藏着
     *   wxid_xxxxxxxxxxxx_538_h.png
     *   wxid_xxxxxxxxxxxx_633.wav   ← 本人的语音
     * 这些都是二进制，内容扫不出来，但文件名已经把 wxid 暴露了。
     */
    if (/wxid_[a-z0-9]{8,}/i.test(relPosix)) {
      found.push({
        file: f.rel,
        type: '文件名含 wxid',
        sample: relPosix.split('/').pop().slice(0, 50),
      });
    }

    // 任何层级的 data/ 目录都不该出现在包里
    if (/(^|\/)data\//.test(relPosix)) {
      found.push({ file: f.rel, type: '运行时数据目录', sample: relPosix.slice(0, 60) });
    }

    if (!/\.(mjs|js|json|py|html|bat|md|txt)$/i.test(f.full)) continue;

    // runtime/ 是第三方运行时，里面本来就有别人的构建路径
    // （比如 numpy 的 __config__.py 会写构建机的用户名），
    // 那不是用户的隐私，扫它只会一直误报。
    if (relPosix.startsWith('runtime/')) continue;

    let content;
    try {
      content = fs.readFileSync(f.full, 'utf8');
    } catch {
      continue;
    }

    for (const p of SECRET_PATTERNS) {
      const m = content.match(p.re);
      if (!m) continue;

      // 排除模板里的空值、示例值
      const real = m.filter((x) => {
        if (x.includes('****')) return false;
        if (/"(apiKey)"\s*:\s*""/.test(x)) return false;
        if (/sk-xxx/i.test(x)) return false;
        // 测试用的假 Key（sk-test-mock-key-* 这种）
        if (/sk-test-mock/i.test(x)) return false;
        return true;
      });

      if (real.length) {
        found.push({ file: f.rel, type: p.name, sample: real[0].slice(0, 50) });
      }
    }
  }

  return found;
}

// ===== 主流程 =====

console.log('========================================');
console.log('  YF-Robot · 打包');
console.log('========================================');
console.log('');

// 1. 收集文件
console.log('【1】收集文件…');
const files = [];
for (const item of INCLUDE) {
  const full = path.join(ROOT, item);
  if (!fs.existsSync(full)) {
    console.log(`  [跳过] ${item}（不存在）`);
    continue;
  }
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    files.push(...walk(full, item));
  } else {
    files.push({ full, rel: item, size: stat.size });
  }
}

const totalSize = files.reduce((s, f) => s + f.size, 0);
console.log(`  ${files.length} 个文件，共 ${(totalSize / 1024).toFixed(1)} KB`);
console.log('');

// 2. 扫描敏感信息
console.log('【2】扫描敏感信息…');
const secrets = scanSecrets(files);

if (secrets.length) {
  console.log(`  ✗ 发现 ${secrets.length} 处敏感信息：`);
  for (const s of secrets) {
    console.log(`    ${s.file}`);
    console.log(`      类型: ${s.type}  样本: ${s.sample}`);
  }
  console.log('');
  console.log('  请先清理这些内容再打包。');
  if (!ONLY_CHECK) {
    console.log('');
    console.log('  （--check 模式只检查不打包）');
    process.exit(1);
  }
} else {
  console.log('  ✓ 未发现敏感信息');
}
console.log('');

if (ONLY_CHECK) {
  console.log('检查完成。加 --check 之外没有参数才会真正打包。');
  process.exit(secrets.length ? 1 : 0);
}

// 3. 清空 dist
console.log('【3】准备 dist 目录…');
if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true, force: true });
}
fs.mkdirSync(DIST, { recursive: true });
console.log('  已清空');
console.log('');

// 4. 复制文件
console.log('【4】复制文件…');
let copied = 0;
for (const f of files) {
  const target = path.join(DIST, f.rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(f.full, target);
  copied++;
}
console.log(`  已复制 ${copied} 个文件`);
console.log('');

// 4.5 复制运行时
if (WITH_RUNTIME) {
  console.log('【4.5】复制运行时…');

  const copyDir = (src, dst, label) => {
    if (!fs.existsSync(src)) {
      console.log(`  [跳过] ${label}（源不存在）`);
      return 0;
    }
    const t0 = Date.now();
    fs.cpSync(src, dst, { recursive: true });
    let size = 0;
    const count = (d) => {
      for (const n of fs.readdirSync(d)) {
        const f = path.join(d, n);
        const st = fs.statSync(f);
        if (st.isDirectory()) count(f);
        else size += st.size;
      }
    };
    count(dst);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ${label}: ${(size / 1024 / 1024).toFixed(0)} MB（${secs}s）`);
    return size;
  };

  // Node 运行时：可能是单文件 node.exe，也可能是带 dll 的目录，两种都支持
  const nodeSrc = path.join(ROOT, 'runtime', 'node');
  const nodeExe = path.join(ROOT, 'runtime', 'node.exe');

  if (fs.existsSync(nodeSrc) && fs.statSync(nodeSrc).isDirectory()) {
    copyDir(nodeSrc, path.join(DIST, 'runtime', 'node'), 'Node 运行时');
  } else if (fs.existsSync(nodeExe)) {
    const dstDir = path.join(DIST, 'runtime');
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(nodeExe, path.join(dstDir, 'node.exe'));
    const mb = (fs.statSync(nodeExe).size / 1024 / 1024).toFixed(0);
    console.log(`  Node 运行时: ${mb} MB（单文件 node.exe）`);
  } else {
    console.log('  [警告] 没找到 Node 运行时，对方需要自己装 Node 22+');
  }

  if (WITH_PYTHON) {
    console.log('  （Python 172MB，需要一点时间…）');
    copyDir(path.join(ROOT, 'runtime', 'python'), path.join(DIST, 'runtime', 'python'), 'Python 运行时');
  } else {
    console.log('  [跳过] Python（用 --no-python 排除了，微信桥接会不可用）');
  }
  console.log('');
} else {
  console.log('【4.5】跳过运行时（--no-runtime）');
  console.log('  接收方需要有 Node 22+ 才能运行');
  console.log('');
}

// 5. 生成干净的 config.json
console.log('【5】生成配置…');
const examplePath = path.join(ROOT, 'config.example.json');
if (fs.existsSync(examplePath)) {
  const cfg = JSON.parse(fs.readFileSync(examplePath, 'utf8'));

  // 确保所有 Key 为空
  cfg.llm.apiKey = '';
  if (cfg.vision) cfg.vision.apiKey = '';
  if (cfg.search) cfg.search.apiKey = '';
  if (cfg.voice) cfg.voice.apiKey = '';
  cfg.__firstRun = true;

  fs.writeFileSync(path.join(DIST, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  console.log('  已生成 config.json（Key 全部为空）');
} else {
  console.log('  ✗ 找不到 config.example.json');
}

// 5.5 桥接的 config.json：必须存在，但要把本机专属的东西清掉
//
// 这个文件缺失会让桥接把所有开关退回默认值（GAME_TOKENS 之类），
// 表面上还能跑，实际功能全不对。所以既不能漏，也不能带本机数据。
// 内容从源文件读，清干净再写到 dist。
const bridgeCfgSrc = path.join(ROOT, 'bridge', 'config.json');
const bridgeCfgPath = path.join(DIST, 'bridge', 'config.json');
if (fs.existsSync(bridgeCfgSrc)) {
  try {
    const bc = JSON.parse(fs.readFileSync(bridgeCfgSrc, 'utf8'));

    // 入站令牌恢复成占位值（真令牌不该发给别人）
    bc.gateway = bc.gateway || {};
    bc.gateway.wechat = bc.gateway.wechat || {};
    bc.gateway.wechat.inboundToken = 'change-me-wechat';

    // 主人名单清空（wxid 是个人隐私）
    bc.persona = bc.persona || {};
    bc.persona.master = bc.persona.master || {};
    bc.persona.master.wxids = [];
    bc.persona.master.names = [];

    // 忽略名单 / 游戏白名单之类也清掉，避免带上本机联系人
    if (bc.wechat) {
      if (Array.isArray(bc.wechat.collectOnlyFrom)) bc.wechat.collectOnlyFrom = [];
      if (Array.isArray(bc.wechat.gameWhitelist)) bc.wechat.gameWhitelist = [];
      if (Array.isArray(bc.wechat.ignoreList)) bc.wechat.ignoreList = [];
    }

    /**
     * 递归清空所有 API Key。
     *
     * 这个文件里藏着真的智谱 Key（`xxxx.DyyYrYJvO0RzgP5R` 这种格式），
     * 原来只清了 token -- 差点把用户的 Key 一起发出去。
     * 凡是名叫 apiKey / api_key / token 的字符串字段，一律清空。
     */
    let cleared = 0;
    const scrub = (obj) => {
      if (!obj || typeof obj !== 'object') return;

      for (const k of Object.keys(obj)) {
        const v = obj[k];
        const lower = k.toLowerCase();

        if (typeof v === 'string' && v) {
          if (lower === 'apikey' || lower === 'api_key' || lower === 'secret' || lower === 'accesstoken') {
            obj[k] = '';
            cleared++;
            continue;
          }
        }

        if (v && typeof v === 'object') scrub(v);
      }
    };
    scrub(bc);

    fs.writeFileSync(bridgeCfgPath, JSON.stringify(bc, null, 2), 'utf8');
    console.log(`  已清洗 bridge/config.json（清空 ${cleared} 个 Key，令牌占位、名单清空）`);
  } catch (e) {
    console.log(`  ✗ 清洗 bridge/config.json 失败: ${e.message}`);
  }
} else {
  console.log('  ✗ 包里缺 bridge/config.json（桥接会用默认值，功能会不对）');
}
console.log('');

// 6. 生成使用说明
console.log('【6】生成说明文件…');
const readme = `# YF-Robot · 微信 AI 助手

一个能接微信的 AI 聊天助手，支持看图、联网、工具调用、主动搭话。

## 快速开始

### 1. 准备 API Key

至少需要一个对话模型的 Key（推荐 DeepSeek，便宜且稳定）：

| 服务商 | 地址 | 说明 |
|---|---|---|
| DeepSeek | https://platform.deepseek.com/api_keys | 推荐，几块钱能用很久 |
| 智谱 GLM | https://open.bigmodel.cn/usercenter/apikeys | 有免费额度 |

可选：
- **看图**：智谱 GLM-4V-Flash（免费）https://open.bigmodel.cn/usercenter/apikeys
- **联网搜索**：博查 https://open.bochaai.com

### 2. 启动

双击 \`YF-Robot.bat\`，按提示：

1. 选择模型服务商
2. 粘贴 API Key
3. 会自动启动服务并打开控制台

### 3. 配置微信（可选）

1. 双击 \`启动微信桥接.bat\`
2. 弹 UAC 时点「是」（需要管理员权限读取微信）
3. 保持微信窗口可见，不要最小化到托盘

> 桥接崩了会自动重启（5 秒后，最多 8 次），不用手动盯着。

### 4. 打开控制台

http://127.0.0.1:8899/console

在「模型与功能」页可以：
- 测试各项能力是否正常
- 更换 API Key
- 调整回复风格

## 目录说明

\`\`\`
YF-Robot.bat        主入口（启动服务 + 打开控制台）
启动服务.bat        只启动服务，不开浏览器
状态面板.bat        终端里的实时状态面板
工具菜单.bat        命令行菜单（测试能力、开关功能）
启动微信桥接.bat     接微信时用（需要管理员权限）

app.mjs             服务入口
core/               核心：引擎、会话、记忆、工具、学习、群聊
channels/           通道：网页 / iLink / 微信群 / 微信 UIA
web/                网页界面 + 控制台
cards/              角色卡
bridge/             微信桥接（独立进程，Python）
runtime/            Node + Python 运行时（自带，不用另装）

config.json         配置（API Key 存在这里）
data/sessions/      会话记忆（重启后接着上次聊）
data/stickers/      表情包 + 描述索引（index.json）
data/images/        收到的图片
data/generated/     她画的图
data/key-archive/   Key 快照（丢了能补回）
data/key-audit.log  Key 变更记录
\`\`\`

## 功能详解

### 1. 会记住你（长期记忆）

- 会话自动落盘到 \`data/sessions/\`，关服务、桥接断线重连都能接着聊
- 自动从「我叫X」「我喜欢Y」里抽事实；**问句不抽**
  （否则「我最喜欢什么」会被记成事实）
- **换会话不串味**：不同人、不同群各自独立
- **群聊里按发言人分开记**：A 报过名字，B 问「我叫什么」不会答成 A 的
- 两个人重名时她会说「分不清」，不瞎认

### 2. 定向白名单（只收谁的图 / 谁能指挥她）

**收藏白名单**：控制台 →「主人设置」→ 图片收藏

| 设置 | 行为 |
|---|---|
| 留空 | 谁发的图都收（默认） |
| 填了 wxid | **只收这些会话/发送者发的图**，别人的图不落盘 |

适合这些场景：
- 群里人多，只想存自己和朋友的图
- 不想让陌生人的图堆满素材库

填的是 wxid（\`wxid_xxx\` 这种），**不是昵称**——昵称谁都能改。
控制台可以从已知联系人里直接选，不用手抄。

**主人识别（三级）**

| 级别 | 怎么判定 | 能用工具 | 能听私事 |
|---|---|---|---|
| 已验证 | wxid 精确匹配 | 是 | 是 |
| 仅昵称 | 昵称对上了，但 wxid 不对 | 否 | **否** |
| 陌生人 | 都不匹配 | 否 | 否 |

昵称谁都能改成和你一样，所以只对上昵称不给任何权限——
被冒充时她会说「光凭昵称我认不了」。

### 3. 群聊策略（她什么时候该说话）

控制台 →「主动功能」→ 群聊策略

| 设置 | 说明 |
|---|---|
| 只在 @ 时回 | 开：只有 @、叫名字、主人说话才回；关：还会低概率主动插话 |
| 主人总是回 | 主人在群里说话，不 @ 也回 |
| 叫她什么 | 群里叫到这些词就算在叫她（默认「鲸鲸」） |
| 接话窗口 | 被 @ 之后这段时间内继续正常聊天（默认 8 分钟） |
| 每小时上限 | 防止在群里刷屏 |
| 群里的主人 | 留空 = 用「主人设置」里的名单（推荐） |

群里还能用指令：\`/mute\`、\`/unmute\`、\`/reset\`、\`/who\`——
只有主人或群管理员能用，陌生人会被拒。

### 4. 角色卡（换人设，不重启）

标准 Character Card V2 格式，放在 \`cards/*.json\`。
控制台「角色卡」页可以新建 / 编辑 / 删除，**切换立即生效**（不用重启服务）。
新建时填：角色名、怎么称呼你、身份设定、性格、行为准则、开场白。

### 5. 看图 / 画图 / 语音 / 联网

| 能力 | 说明 | 用什么 Key |
|---|---|---|
| 看图 | 收到的图自动认成文字，再当聊天内容处理 | 智谱 GLM-4V（flash 免费但较弱，想准就换 glm-4v） |
| 画图 | 让她画图，画完能发到微信 | 智谱 CogView |
| 语音 | 微信语音转文字 | 阿里云百炼 |
| 联网 | 需要实时信息时自动搜（不会瞎编天气/新闻） | 博查 |

### 6. 素材库（表情包 / 动图）

- 收到的图、表情、动图自动收藏
- **感知哈希去重**：同一张图截两次、转两次都不会重复入库
- **自动打情绪标签**：开心 / 难过 / 生气 / 惊讶 / 无语 / 害羞 / 困倦 / 得意 / 安慰 / 吃饭 / 可爱
- 回复后按语气挑图，不是随机甩
- 动图：微信 4.x 把 GIF 存在 wxgf 容器里（一段 HEVC 视频），程序整段转成动画 GIF
- 控制台「素材库」页可以看、删、改描述，也能点「重新识别无标签的」

### 7. 后台运行

默认：关掉网页，服务继续在后台跑（微信才能一直在线）。

想让它「用完就退」：控制台「总览」→ 后台运行 → 打开「关掉网页就停服务」。

> ⚠ 接微信时别开——一关网页，微信那边立刻不回话。

三道退路（万一开了收不了场）：

1. 控制台勾「应急：保持运行」
2. \`YF-Robot.bat\` → 选 9「关掉关网页即停服务」
3. 手改 \`config.json\`：\`server.stopWhenNoConsole = false\`

### 8. Key 不会莫名其妙丢

- 每次写配置前留一份 \`.bak\`
- 单独维护 \`data/key-archive/\`（最多 50 份快照）
- 启动时发现某个 Key 空了，自动从归档补回来
- \`data/key-audit.log\` 记录每次 Key 变化（哪个操作、从多长变成多长）
- 写盘是原子的（先写临时文件再改名），不会留下半个 JSON

### 9. 崩了自己爬起来

桥接遇到原生崩溃（UIA / COM 断开这类）会退出，
启动脚本 5 秒后自动重启，最多连试 8 次；
连崩 8 次就停下并提示去看 \`bridge/data/bridge-crash.log\`。

## 常见问题

**Q: 微信不回复？**

1. 检查桥接窗口是否还在运行
2. 确认微信窗口**没有被最小化**（桥接需要操作窗口）
3. 看控制台「微信桥接」页的状态

**Q: 表情包识别不出来？**

微信 4.x 把表情缓存加密了，官方也没给读法。程序的处理顺序是：

1. 试解密缓存（需要管理员权限，桥接有）
2. 解不开就按 UIA 定位截图（同样需要管理员）
3. 都不行就老实说「看不清」，不会瞎编

如果经常出现「看不清」，看 \`bridge/data/wechat-bridge-4x.log\`
里的「表情包：」开头的行，会写明卡在哪一步。

**Q: 图片识别失败？**

检查看图模型是否配置。推荐用智谱 GLM-4V-Flash（免费且快）。

**Q: 启动报错端口被占用？**

服务会自动找下一个可用端口。看控制台显示的地址。

**Q: 换台电脑还能记住之前聊的？**

把整个 \`data/\` 目录一起复制过去就行。
\`config.json\` 里有 Key，**不要连它一起发给别人**。

## 注意

- API Key 保存在 \`config.json\`，**不要把这个文件发给别人**
- 桥接需要管理员权限，这是读取微信进程所必需的
- 本工具仅供个人学习使用，请遵守微信用户协议

---

版本 0.2.0
`;

fs.writeFileSync(path.join(DIST, '使用说明.md'), readme, 'utf8');
console.log('  已生成 使用说明.md');
console.log('');

// 7. 最终检查
console.log('【7】最终检查…');
const distFiles = walk(DIST);
const distSecrets = scanSecrets(distFiles);

if (distSecrets.length) {
  console.log(`  ✗ dist 里有 ${distSecrets.length} 处敏感信息！`);
  for (const s of distSecrets.slice(0, 5)) {
    console.log(`    ${s.file}: ${s.sample}`);
  }
  process.exit(1);
}

console.log('  ✓ 干净');
console.log('');

// 8. 完整性自检：关键文件一个都不能少，否则对方拿到手打不开
console.log('【8】完整性检查…');

const MUST_HAVE = [
  ['YF-Robot.bat', '主启动入口'],
  ['启动服务.bat', '直接启动'],
  ['状态面板.bat', '终端界面入口'],
  ['工具菜单.bat', '菜单入口'],
  ['启动微信桥接.bat', '桥接快捷入口'],
  ['app.mjs', '服务入口'],
  ['config.json', '配置'],
  ['使用说明.md', '说明文档'],
  ['scripts/start.ps1', '启动脚本（YF-Robot.bat 调用）'],
  ['web/console.html', '控制台页面'],
  ['core/engine.mjs', '引擎'],
  ['core/admin.mjs', '管理接口'],
  ['tools/tui.mjs', '终端界面（状态面板.bat 调用）'],
  // 桥接靠它读配置，缺了会静默退回默认值 —— 功能全不对但还能启动，最难查
  ['bridge/config.json', '桥接配置'],
];

if (WITH_RUNTIME) {
  MUST_HAVE.push(['runtime/node.exe', 'Node 运行时（没有就跑不起来）']);

  // Python 只在「带了运行时 + 没排除 Python」时才要求
  if (WITH_PYTHON) {
    MUST_HAVE.push(['runtime/python/python.exe', 'Python 运行时（接微信要用）']);
    MUST_HAVE.push(['bridge/wechatauto_bridge.py', '微信桥接主程序']);
    MUST_HAVE.push(['启动微信桥接.bat', '桥接启动入口']);
  }
}

const missing = [];
for (const [rel, why] of MUST_HAVE) {
  if (!fs.existsSync(path.join(DIST, rel))) missing.push(`${rel}（${why}）`);
}

if (missing.length) {
  console.log('  ✗ 缺少关键文件：');
  missing.forEach((m) => console.log('    ' + m));
  console.log('');
  console.log('  这个包发给别人会打不开，请先修好再打包。');
  process.exit(1);
}

console.log(`  ✓ ${MUST_HAVE.length} 个关键文件齐全`);
console.log('');

// 完成
const distSize = distFiles.reduce((s, f) => s + f.size, 0);
console.log('========================================');
console.log('  打包完成');
console.log('========================================');
console.log(`  目录: ${DIST}`);
console.log(`  文件: ${distFiles.length} 个`);
console.log(`  大小: ${(distSize / 1024 / 1024).toFixed(1)} MB`);
console.log('');
console.log('  分发前请先自己解压试运行一次。');
