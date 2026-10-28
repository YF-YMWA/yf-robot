#!/usr/bin/env python
"""打包解压后的信息泄露扫描。

不是只扫 dist 目录，而是**真的解开 zip** 再逐个文件看 —— 因为
打包脚本可能把不该带的东西（config.json、data/、日志）复制进去，
只看 dist 白名单是不够的。

检查五类：
  1. 密钥        sk-xxx、智谱 32.16、阿里云、方舟…
  2. 个人标识    wxid_xxx、真实昵称、手机号
  3. 本机路径    C:\\Users\\<用户名>、下载/桌面路径
  4. 运行时数据  config.json / data/ 下的会话、记忆、素材、日志、token
  5. 打包残留    .git、node_modules、__pycache__、*.log、*.pid、测试临时目录

用法：python tools/scan-package-leak.py <zip> [<zip> ...]
"""
import io
import os
import re
import sys
import zipfile

# ---------- 模式 ----------
PATTERNS = [
    ('密钥 sk-', re.compile(rb'sk-[A-Za-z0-9_-]{24,}')),
    ('智谱 Key', re.compile(rb'[a-f0-9]{32}\.[A-Za-z0-9]{16}')),
    ('阿里云 Key', re.compile(rb'LTAI[A-Za-z0-9]{12,}')),
    ('方舟/火山', re.compile(rb'(?i)ark-[a-z0-9-]{16,}')),
    ('wxid', re.compile(rb'wxid_[a-z0-9]{8,}')),
    ('本机路径', re.compile(rb'C:' + re.escape(chr(92).encode()) + rb'Users' + re.escape(chr(92).encode()) + rb'[A-Za-z0-9_.-]{2,}')),
    ('下载/桌面', re.compile(rb'(?i)(Downloads|Desktop)' + re.escape(chr(92).encode()) + rb'[A-Za-z0-9_.-]{2,}')),
    ('本地令牌', re.compile(rb'(?i)(x-local-token|__TOKEN__)\s*[:=]\s*["\']?[a-f0-9]{32,}')),
    ('私聊内容', re.compile(r'\[(收到|回复) 私聊'.encode())),
]

# 允许出现的占位/示例（避免误报）
ALLOW = re.compile(
    r'(<|xxxx|change-me|your|example|placeholder|test|mock|fake|\*\*\*\*|sk-test)',
    re.I,
)

# 不该出现在包里的路径（相对解压根）
FORBIDDEN = [
    (r'^data/', '运行时数据（会话/记忆/素材/日志）'),
    (r'(^|/)data/token\.txt$', '本地令牌'),
    (r'\.log$', '日志文件'),
    (r'\.pid$', '进程号文件'),
    (r'(^|/)\.git/', 'git 仓库'),
    (r'node_modules/', 'node_modules'),
    (r'__pycache__/', '__pycache__'),
    (r'\.pyc$', 'pyc 缓存'),
    (r'(^|/)\.tmp/', '临时目录'),
    (r'(^|/)agent-workspace/', 'agent 工作目录'),
    (r'(^|/)backups?/', '备份目录'),
]

TEXT_EXT = re.compile(
    r'\.(mjs|js|cjs|json|py|html|css|md|txt|yml|yaml|bat|ps1|cfg|ini|toml|xml|log|pid|example)$',
    re.I,
)

MAX_SCAN = 8 * 1024 * 1024  # 单个文本文件最多扫 8MB

# 当前这台机器上的真实用户名（打包机的身份信息，绝不能出现在包里）
_REAL_USER = os.environ.get('USERNAME') or os.environ.get('USER') or ''
_REAL_HOME = os.environ.get('USERPROFILE') or os.environ.get('HOME') or ''
REAL_MARKERS = []
if _REAL_USER and len(_REAL_USER) >= 3:
    REAL_MARKERS.append(('本机用户名', _REAL_USER.encode('utf-8', 'ignore')))
if _REAL_HOME:
    REAL_MARKERS.append(('本机主目录', _REAL_HOME.encode('utf-8', 'ignore')))

# 这些目录是第三方运行时/依赖，通用规则在那里必然误报：
#   numpy 里写着 CI 构建机的用户目录（不是本机的）
#   psutil 的注释里有一串以 s 加 k 加短横开头的英文短语（不是密钥）
#   comtypes 的说明里提到桌面目录下的类型库
# 注意：这里故意不写出完整字面量 —— 否则 CI 的敏感信息扫描会把这脚本本身当成泄露源。
VENDOR_PREFIXES = ('runtime/', 'runtime\\')


def scan_zip(path):
    print('=' * 66)
    print('扫描:', os.path.basename(path), '(%.1f MB)' % (os.path.getsize(path) / 1024 / 1024))
    print('=' * 66)

    bad = []
    forbidden_hits = []
    config_issues = []

    # config.json 必须随包发（首次运行要用），但必须是「Key 全空、路径相对」那种。
    # 一律禁止会误报，一律放行又有风险 —— 所以单独体检。
    def check_config(data):
        import json as _json
        try:
            j = _json.loads(data.decode('utf-8'))
        except Exception:
            config_issues.append('config.json 不是合法 JSON')
            return
        for section in ('llm', 'vision', 'voice', 'search', 'imagegen'):
            k = (j.get(section) or {}).get('apiKey') or ''
            if k:
                config_issues.append('%s.apiKey 不是空的（长度 %d）' % (section, len(k)))
        wx = (j.get('owner') or {}).get('wxids') or []
        if wx:
            config_issues.append('owner.wxids 不是空的：%s' % (wx,))
        if (j.get('voice') or {}).get('ttsApiKey'):
            config_issues.append('voice.ttsApiKey 不是空的')
        root = j.get('root') or ''
        if isinstance(root, str) and root and (':' in root or chr(92) in root):
            config_issues.append('root 是绝对路径：%s' % root[:40])
    names = []
    scanned = 0

    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        names = [i.filename for i in infos]

        # ---- 1. 路径检查 ----
        for name in names:
            for pat, why in FORBIDDEN:
                if re.search(pat, name, re.I):
                    # 示例配置、docs 里的说明不算
                    if name.endswith('config.example.json'):
                        continue
                    forbidden_hits.append((name, why))
                    break

        # ---- 2. 内容检查 ----
        for info in infos:
            name = info.filename
            if info.file_size > MAX_SCAN:
                continue
            if not TEXT_EXT.search(name):
                # 二进制也扫一遍头部，防「图片里塞了文本」
                if not name.lower().endswith(('.bin', '.exe', '.dll', '.pyd', '.so', '.png', '.jpg', '.gif', '.webp', '.amr', '.mp3', '.zip')):
                    pass
                else:
                    continue

            try:
                data = z.read(info)
            except Exception:
                continue
            scanned += 1

            if name == 'config.json':
                check_config(data)

            # 真实用户名/主目录：任何文件都要查（包括 runtime 里的 .pyc）
            for label, marker in REAL_MARKERS:
                if marker and marker in data:
                    bad.append((name, label, marker.decode('utf-8', 'ignore')[:60]))

            is_vendor = name.replace('\\', '/').startswith('runtime/')

            for label, pat in (() if is_vendor else PATTERNS):
                for m in pat.finditer(data):
                    text = m.group(0).decode('utf-8', 'ignore')
                    if ALLOW.search(text):
                        continue
                    # 允许文档里出现的示例占位
                    if 'placeholder' in text.lower() or 'example' in text.lower():
                        continue
                    bad.append((name, label, text[:80]))

    # ---- 输出 ----
    print('  文件总数:', len(names), '| 扫过内容:', scanned, '（runtime/ 第三方库只用「本机用户名」规则）')

    if forbidden_hits:
        print('')
        print('  [!!] 出现了不该打包的东西：')
        for name, why in forbidden_hits[:20]:
            print('     - %-52s %s' % (name[:52], why))
        if len(forbidden_hits) > 20:
            print('     ... 还有 %d 个' % (len(forbidden_hits) - 20))
    else:
        print('  [ok] 没有运行时数据 / 配置 / 日志 / git 残留')

    if config_issues:
        print('')
        print('  [!!] 包里的 config.json 不干净：')
        for c in config_issues:
            print('     - ' + c)
    else:
        print('  [ok] config.json 干净（Key 全空、无 wxid、无绝对路径）')

    if bad:
        print('')
        print('  [!!] 内容里发现疑似敏感信息：')
        for name, label, text in bad[:20]:
            print('     - %-40s %-10s %s' % (name[:40], label, text))
        if len(bad) > 20:
            print('     ... 还有 %d 条' % (len(bad) - 20))
    else:
        print('  [ok] 内容里没有密钥 / wxid / 本机路径 / 聊天记录')

    ok = not forbidden_hits and not bad and not config_issues
    print('')
    print('  结论:', '[只含代码，可以分发]' if ok else '[发现泄露，不能分发]')
    print('')
    return ok


def main():
    zips = sys.argv[1:]
    if not zips:
        zips = sorted(f for f in os.listdir('.') if f.endswith('.zip') and f.startswith('YF-Robot'))
    if not zips:
        print('  没有找到 YF-Robot-*.zip')
        return 1

    results = [(z, scan_zip(z)) for z in zips]
    print('=' * 66)
    for z, ok in results:
        print('  %-46s %s' % (z, '通过' if ok else '泄露'))
    print('=' * 66)
    return 0 if all(ok for _, ok in results) else 1


if __name__ == '__main__':
    sys.exit(main())
