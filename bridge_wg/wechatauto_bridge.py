#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鲸鲸 · 微信 4.x 桥接（不注入、不修改微信）

原理：
  - 读消息：解密微信 4.x 本地 SQLite 数据库（只读，需要微信处于登录状态）
  - 发消息：驱动微信窗口（UI 自动化 + 剪贴板），相当于有人替你打字发送

前置：
  1. WeChat 4.x 已登录（建议用小号）
  2. 已装依赖：pip install wechatauto-replica requests
  3. 鲸鲸服务已启动（双击 启动鲸鱼娘.bat）
  4. config.json 里 gateway.wechat.enabled = true（脚本会读 token）

用法：
  python examples/wechatauto_bridge.py

注意：
  - 发送消息会抢微信窗口焦点，这是 4.x 自动化的正常表现。
  - 微信必须保持登录；退出登录后数据库密钥会失效。
  - 自动化不是微信官方接口，仍有账号风险，只用小号 + 测试群。
"""

import json
import random
import urllib.parse
import os
import sys

# 把自己所在的目录放进 sys.path —— 这样不管从哪个目录启动
# （双击 bat、被别的进程拉起、还是跑单元测试），都能 import media_store。
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# 关掉 wechatauto 的「拟人节流」（默认 natural：120 秒内 6 次写就冷却 30~75 秒）
os.environ.setdefault("WECHATAUTO_RHYTHM", "off")
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
import sys
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
import time

# 独立副本：ROOT 指向本脚本所在目录（bridge_wg/），
# 这样 config.json、data/ 都在自己目录下，不依赖 whale-girl。
ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(ROOT, "config.json")
LOG_FILE = os.path.join(ROOT, "data", "wechat-bridge-4x.log")

# 只回复这些会话（留空 = 全部会话都交给鲸鲸判断）
# 例如 ["文件传输助手", "深海鱼塘"]
ONLY_CHATS = []

# 距离启动多久之前的消息不处理（秒）
SKIP_OLDER_THAN = 10
DIGEST_MINUTES = 30
MASTER_WXID = ''
# 超过这么多秒的旧消息直接不回，避免“回上一条”
STALE_AFTER = float(os.environ.get("WHALE_STALE_AFTER", "4"))

# 每次回复后补一个表情包的概率（0 = 关闭，1 = 每次都发）
STICKER_CHANCE = float(os.environ.get("WHALE_STICKER_CHANCE", "0"))

# 是否收藏收到的图片（存到 data/images/，控制台可查看）
MEDIA_COLLECT = os.environ.get("WHALE_MEDIA_COLLECT", "1") not in ("0", "false", "no")

# 只收藏这些账号发的图片（空 = 全部收藏）
# 填 wxid 或昵称，配置里写 wechat.collectOnlyFrom
COLLECT_WHITELIST = set()

# ===== 配置项默认值 =====
# 必须先全部给个默认值，再进 try 去读 config.json。
#
# 为什么：这些变量原来只在 try 块里定义，一旦 config.json 读不到
# （比如打包时分发出去少了 bridge_wg/config.json），except 把异常吞掉，
# 变量就根本不存在。后面 game_running() 一引用就是
#   NameError: name 'GAME_TOKENS' is not defined
# 直接把这个线程打死 —— 表现就是「解压出来的版本用不了」。
GAME_TOKENS = []
AWAY_NOTICE = True
RETURN_NOTICE = True
QUEUED_MAX_AGE = 300.0
QUEUED_MAX_CHATS = 2
QUOTE_REPLY = True
KEYBOARD_FALLBACK = True
BACKGROUND_SEND = True
LOW_BATTERY_PCT = 5.0
GOODNIGHT_TEXT = "晚安，电量快没了，我先睡啦，明天见～"
SHARE_ENABLED = True
SHARE_EVERY = 120.0
CARE_ENABLED = True
CARE_QUIET_MIN = 20.0
DIGEST_MINUTES = 30.0
MASTER_WXID = ""

try:
    # 读本目录的 config.json（原版是 ../config.json，被复制成独立副本后
    # 上一级是鲸鲸的配置，里面没有 wechat 段，会导致所有参数取默认值）
    _here = os.path.dirname(os.path.abspath(__file__))
    _cfg_path = os.path.join(_here, "config.json")

    # 第一次运行（或 clone 下来还没建配置）时，从模板复制一份。
    # 模板里 Key 是空的、名录是空的，不会把别人的数据带过来。
    if not os.path.exists(_cfg_path):
        _example = os.path.join(_here, "config.example.json")
        if os.path.exists(_example):
            import shutil as _shutil
            _shutil.copyfile(_example, _cfg_path)
            print(
                "[config] 首次运行，已从 config.example.json 生成 bridge_wg/config.json",
                file=__import__("sys").stderr,
            )

    with open(_cfg_path, "r", encoding="utf-8-sig") as _f:
        _cfg = json.load(_f)
    _stale = (_cfg.get("wechat") or {}).get("staleAfterSec")
    if isinstance(_stale, (int, float)) and _stale > 0:
        STALE_AFTER = float(_stale)
    _wechat = _cfg.get("wechat") or {}
    GAME_TOKENS = [str(x).lower() for x in (_wechat.get("gameWhitelist") or []) if str(x).strip()]
    AWAY_NOTICE = bool(_wechat.get("awayNotice", True))
    RETURN_NOTICE = bool(_wechat.get("returnNotice", True))
    QUEUED_MAX_AGE = float(_wechat.get("queuedMaxAgeSec", 300))
    QUEUED_MAX_CHATS = int(_wechat.get("queuedMaxChats", 2))
    QUOTE_REPLY = bool(_wechat.get("quoteReply", True))
    # UIA 彻底发不出去时，退到「Ctrl+F 搜索会话 → 粘贴 → 回车」的键盘通道（会抢前台）
    KEYBOARD_FALLBACK = bool(_wechat.get("keyboardFallback", True))
    # 后台发送：不抢前台直接发（实测最小化/被遮挡也能发）。false = 每次先把微信拉到前台
    BACKGROUND_SEND = bool(_wechat.get("backgroundSend", True))
    LOW_BATTERY_PCT = float(_wechat.get("lowBatteryPercent", 5))
    GOODNIGHT_TEXT = str(_wechat.get("goodnightText", "晚安，电量快没了，我先睡啦，明天见～"))
    _share = _cfg.get("share") or {}
    SHARE_ENABLED = bool(_share.get("enabled", True))
    SHARE_EVERY = float(_share.get("everyMinutes", 120))
    # 主动搭话（问「在干啥 / 累不累」）。时间窗和频率由服务端 /api/care/due 算，这里只留一个开关和静默期
    _care = _cfg.get("care") or {}
    CARE_ENABLED = bool(_care.get("enabled", True))
    CARE_QUIET_MIN = float(_care.get("quietAfterMinutes", 20) or 0)
    _digest = _wechat.get("digestMinutes", 30)
    DIGEST_MINUTES = float(_digest) if isinstance(_digest, (int, float)) else 30.0
    MASTER_WXID = (((_cfg.get("persona") or {}).get("master") or {}).get("wxids") or [''])[0]
except Exception as _e:                      # noqa: BLE001
    # 不能静默：配置文件缺失/损坏时所有开关都会退回默认值，
    # 用户会觉得「怎么设置都不生效」。至少要在日志里说清楚。
    import sys as _sys
    print(
        "[config] ⚠ 读不到 %s（%r），全部设置改用默认值。\n"
        "         如果这是分发出去的包，说明少了 bridge_wg/config.json，"
        "重新解压或从 config.example.json 复制一份即可。"
        % (locals().get("_cfg_path", "bridge_wg/config.json"), _e),
        file=_sys.stderr,
    )

START_TS = time.time()


def reload_config(path=None):
    """把 config.json 重新读一遍，覆盖上面这些「启动时定型」的开关。

    为什么需要：调试台（/debug）改的是 config.json，但桥接以前只在启动时读一次，
    用户在页面上关掉「主动分享」、改「忽略名单」、调「游戏白名单」……全都没反应，
    只能手动重启「启动微信桥接.bat」，表现出来就是「调了没用，还是默认」。
    现在 config.json 一变，5 秒内自动生效。

    返回是否真的重新加载了。
    """
    global GAME_TOKENS, AWAY_NOTICE, RETURN_NOTICE, QUEUED_MAX_AGE, QUEUED_MAX_CHATS
    global QUOTE_REPLY, KEYBOARD_FALLBACK, BACKGROUND_SEND, LOW_BATTERY_PCT, GOODNIGHT_TEXT
    global SHARE_ENABLED, SHARE_EVERY, CARE_ENABLED, CARE_QUIET_MIN, DIGEST_MINUTES
    global STALE_AFTER, SYSTEM_SENDER_NAMES, BASE_SYSTEM_SENDERS, MASTER_WXID
    global VOICE_ENABLED, VOICE_BASE_URL, VOICE_MODEL, STICKER_CHANCE, MEDIA_COLLECT, COLLECT_WHITELIST
    target = path or CONFIG_PATH
    try:
        with open(target, "r", encoding="utf-8-sig") as f:
            cfg = json.load(f)
    except Exception as e:                      # noqa: BLE001
        log("重读配置失败（继续用旧值）：", repr(e))
        return False

    w = cfg.get("wechat") or {}
    try:
        STALE_AFTER = float(w.get("staleAfterSec") or STALE_AFTER or 4)
    except Exception:
        pass
    # 表情包发送概率（0~1），配置里改 stickerChance
    try:
        if w.get("stickerChance") is not None:
            STICKER_CHANCE = max(0.0, min(1.0, float(w.get("stickerChance"))))
    except Exception:
        pass
    # 是否收藏收到的图片
    try:
        if w.get("mediaCollect") is not None:
            MEDIA_COLLECT = bool(w.get("mediaCollect"))
    except Exception:
        pass
    # 只收藏白名单账号的图片（空 = 全收）
    try:
        global COLLECT_WHITELIST
        raw_list = w.get("collectOnlyFrom") or []
        COLLECT_WHITELIST = {str(x).strip() for x in raw_list if str(x).strip()}
    except Exception:
        pass
    GAME_TOKENS = [str(x).lower() for x in (w.get("gameWhitelist") or []) if str(x).strip()]
    AWAY_NOTICE = bool(w.get("awayNotice", True))
    RETURN_NOTICE = bool(w.get("returnNotice", True))
    try:
        QUEUED_MAX_AGE = float(w.get("queuedMaxAgeSec", 300))
        QUEUED_MAX_CHATS = int(w.get("queuedMaxChats", 2))
        LOW_BATTERY_PCT = float(w.get("lowBatteryPercent", 5))
    except Exception:
        pass
    QUOTE_REPLY = bool(w.get("quoteReply", True))
    KEYBOARD_FALLBACK = bool(w.get("keyboardFallback", True))
    BACKGROUND_SEND = bool(w.get("backgroundSend", True))
    GOODNIGHT_TEXT = str(w.get("goodnightText") or GOODNIGHT_TEXT)
    try:
        DIGEST_MINUTES = float(w.get("digestMinutes", 30))
    except Exception:
        DIGEST_MINUTES = 30.0
    # 忽略名单：系统会话是固定底表，配置里的只追加
    SYSTEM_SENDER_NAMES = set(BASE_SYSTEM_SENDERS)
    SYSTEM_SENDER_NAMES |= {str(x).strip() for x in (w.get("ignoreSenders") or []) if str(x).strip()}

    sh = cfg.get("share") or {}
    SHARE_ENABLED = bool(sh.get("enabled", True))
    try:
        SHARE_EVERY = float(sh.get("everyMinutes", 120))
    except Exception:
        SHARE_EVERY = 120.0

    ca = cfg.get("care") or {}
    CARE_ENABLED = bool(ca.get("enabled", True))
    try:
        CARE_QUIET_MIN = float(ca.get("quietAfterMinutes", 20) or 0)
    except Exception:
        CARE_QUIET_MIN = 20.0

    vo = cfg.get("voice") or {}
    if "enabled" in vo:
        VOICE_ENABLED = bool(vo.get("enabled"))
    if vo.get("baseUrl"):
        VOICE_BASE_URL = str(vo.get("baseUrl"))
    if vo.get("model"):
        VOICE_MODEL = str(vo.get("model"))

    wxids = (((cfg.get("persona") or {}).get("master") or {}).get("wxids") or [])
    if wxids:
        MASTER_WXID = wxids[0]
    return True


# 系统 / 公众号通知：只用来记录，不接话（否则会跟「微信团队」吵起来）
SYSTEM_SENDER_NAMES = {
    "微信团队", "微信支付", "服务通知", "订阅号消息", "文件传输助手",
    "微信运动", "微信公众平台", "腾讯客服", "微信安全中心", "微信广告",
}
try:
    SYSTEM_SENDER_NAMES |= {str(x).strip() for x in (_wechat.get("ignoreSenders") or []) if str(x).strip()}
except Exception:
    pass
# 系统会话名单的原始底表（热更新时以它为基准重新算，避免配置里的旧值越滚越多）
BASE_SYSTEM_SENDERS = set(SYSTEM_SENDER_NAMES)

# 微信 4.x 数据目录的常见名字（不同版本 / 不同安装方式会有差异）
DB_ROOT_NAMES = ("xwechat_files", "WeChat Files", "xwechat_files_data")


def looks_like_db_root(p):
    """这个目录像不像微信 4.x 的数据根（下面有 <账号>/db_storage）。

    兼容三种布局：
      E:\\xwechat_files\\<账号>\\db_storage
      E:\\xwechat_files\\db_storage            （账号目录层级被拍平）
      直接把 <账号> 目录填进来
    """
    if not p or not os.path.isdir(p):
        return False
    bases = [p]
    for name in DB_ROOT_NAMES:
        bases.append(os.path.join(p, name))
    for base in bases:
        try:
            entries = os.listdir(base)
        except OSError:
            continue
        for name in entries:
            if os.path.isdir(os.path.join(base, name, "db_storage")):
                return True
    return False


def resolve_db_dir(config_path=None, drives="CDEFGHIJK"):
    """找微信 4.x 的数据库目录，比 wechatauto 自带的 auto_detect 更狠。

    库自带的只查「文档 / 用户目录 / 注册表」，用户把微信文件存到别的盘
    （很常见：E:\\xwechat_files、D:\\xwechat_files）就永远找不到，启动直接
    RuntimeError 崩掉 —— 也就是用户截图里那一整段 Traceback。

    顺序：config.json 的 wechat.dbDir → 正在运行的微信进程打开的文件 → 各盘根目录。
    """
    # 1) 配置里手填的
    manual = ""
    try:
        with open(config_path or CONFIG_PATH, "r", encoding="utf-8-sig") as f:
            manual = str(((json.load(f).get("wechat") or {}).get("dbDir") or "")).strip()
    except Exception:
        manual = ""
    if manual and looks_like_db_root(manual):
        return manual

    # 2) 正在运行的微信进程打开着数据库文件 —— 直接反射出来，最准
    try:
        import psutil
        for proc in psutil.process_iter(["name"]):
            name = str(proc.info.get("name") or "").lower()
            if not any(k in name for k in ("weixin", "wechat")):
                continue
            try:
                open_files = proc.open_files()
            except Exception:
                continue
            for item in open_files:
                m = re.search(r"([\\/])(" + "|".join(DB_ROOT_NAMES) + r")([\\/]|$)",
                              item.path or "", re.I)
                if not m:
                    continue
                # 取「名字之前的那一段」作为盘符/目录，再拼回 xwechat_files
                root = (item.path or "")[: m.start() + 1] + m.group(2)
                if looks_like_db_root(root):
                    return root
    except Exception:
        pass

    # 3) 所有固定盘的根目录
    for letter in drives:
        for name in DB_ROOT_NAMES:
            cand = os.path.join(letter + ":\\", name)
            if looks_like_db_root(cand):
                return cand
    return ""

# 系统 / 公众号通知：只用来记录，不接话（否则会跟「微信团队」吵起来）
SYSTEM_SENDER_NAMES = {
    "微信团队", "微信支付", "服务通知", "订阅号消息", "文件传输助手",
    "微信运动", "微信公众平台", "腾讯客服", "微信安全中心", "微信广告",
}
try:
    SYSTEM_SENDER_NAMES |= {str(x).strip() for x in (_wechat.get("ignoreSenders") or []) if str(x).strip()}
except Exception:
    pass
_SYSTEM_TEXT_RE = __import__("re").compile(r"<a\s+href=|weixin://|&lt;a\s+href=", __import__("re").I)
# 同一会话同一句话的重复回复保护（秒）与每分钟回复上限
DUP_REPLY_WINDOW = 45
MAX_REPLIES_PER_MIN = 8
# 单实例锁端口：被占用就说明已经有桥接在跑，直接退出
BRIDGE_LOCK_PORT = 47821

# —— 语音识别（语音消息 → 文字）——
# 默认用阿里云百炼的 qwen3-asr-flash；Key 依次取 voice.apiKey → data/settings.json → deepseek.apiKey
VOICE_ENABLED = True
VOICE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
VOICE_MODEL = "qwen3-asr-flash"
VOICE_API_KEY = ""
VOICE_TIMEOUT = 90
VOICE_MAX_SECONDS = 120
VOICE_SAMPLE_RATE = 16000
try:
    _voice_cfg = (_cfg.get("voice") or {})
    VOICE_ENABLED = bool(_voice_cfg.get("enabled", True))
    VOICE_BASE_URL = str(_voice_cfg.get("baseUrl") or VOICE_BASE_URL)
    VOICE_MODEL = str(_voice_cfg.get("model") or VOICE_MODEL)
    VOICE_API_KEY = str(_voice_cfg.get("apiKey") or "")
    VOICE_TIMEOUT = float(_voice_cfg.get("timeoutMs", 90000)) / 1000.0
    VOICE_MAX_SECONDS = float(_voice_cfg.get("maxSeconds", 120))
    if not VOICE_API_KEY:
        try:
            _settings_path = os.path.join(ROOT, "data", "settings.json")
            with open(_settings_path, "r", encoding="utf-8-sig") as _sf:
                _st = json.load(_sf)
            VOICE_API_KEY = str(_st.get("apiKey") or "")
        except Exception:
            VOICE_API_KEY = ""
except Exception:
    pass


def asr_transcribe(wav_bytes, api_key, model, base_url, timeout=90):
    """把 wav 字节交给语音识别接口，返回文字；失败抛异常或返回空串。"""
    import base64
    import urllib.request

    if not api_key:
        raise RuntimeError("没有可用的语音识别 Key")
    payload = {
        "model": model,
        "input": {
            "messages": [{
                "role": "user",
                "content": [{"audio": "data:audio/wav;base64," + base64.b64encode(wav_bytes).decode()}],
            }]
        },
    }
    req = urllib.request.Request(
        base_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8", "replace"))
    try:
        text = data["output"]["choices"][0]["message"]["content"][0]["text"]
    except Exception:
        text = ""
    return str(text or "").strip()


def clean_transcript(text):
    """去掉只剩标点的转写结果。"""
    t = str(text or "").strip()
    t = t.strip("，,。.！!？?…~～、 ")
    return t if len(t) >= 1 else ""

_recent_dup = {}
_reply_stamps = {}
_guard_lock = threading.Lock()
# 「演示模式」提示只喊一次，别每条都刷
MOCK_NOTICED = {"done": False}


def is_system_notice(username, nickname, content):
    """系统号 / 通知类消息：带 weixin:// 链接、HTML 链接、或已知系统号名字。"""
    if _SYSTEM_TEXT_RE.search(str(content or "")):
        return True
    name = str(nickname or "").strip()
    if name in SYSTEM_SENDER_NAMES:
        return True
    uid = str(username or "")
    if uid.startswith("gh_"):
        return True
    return False


def duplicate_guard(chat_username, sender, content):
    """同一人 45 秒内重复同一句 → 不再回（微信重投/通知刷屏）。"""
    now = time.time()
    key = (str(chat_username or ""), str(sender or ""), str(content or "").strip())
    with _guard_lock:
        last = _recent_dup.get(key, 0)
        _recent_dup[key] = now
        if len(_recent_dup) > 500:
            for k, v in list(_recent_dup.items()):
                if now - v > 600:
                    _recent_dup.pop(k, None)
        return now - last < DUP_REPLY_WINDOW


def rate_guard(chat_username):
    """同一会话一分钟内已经回了 MAX_REPLIES_PER_MIN 条 → 先停下，避免越聊越乱。"""
    now = time.time()
    key = str(chat_username or "")
    with _guard_lock:
        stamps = [t for t in _reply_stamps.get(key, []) if now - t < 60]
        if len(stamps) >= MAX_REPLIES_PER_MIN:
            _reply_stamps[key] = stamps
            return False
        stamps.append(now)
        _reply_stamps[key] = stamps
    return True


BOOT_LOG = os.path.join(ROOT, "data", "bridge-boot.log")


def boot(msg):
    """启动诊断：只写文件，不依赖控制台（控制台被选中时 print 会卡住）"""
    try:
        os.makedirs(os.path.dirname(BOOT_LOG), exist_ok=True)
        with open(BOOT_LOG, "a", encoding="utf-8") as f:
            f.write("%s [pid %s] %s\n" % (time.strftime("%H:%M:%S"), os.getpid(), msg))
    except Exception:
        pass


boot("脚本开始执行")


def log(*args):
    line = time.strftime("[%H:%M:%S] ") + " ".join(str(a) for a in args)
    # 先写文件，再打印：这样即使控制台卡住，日志也不会丢
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    try:
        print(line, flush=True)
    except Exception:
        pass


_win_problem_ts = {}


def log_window_problem(where, err):
    """窗口操作失败两分钟内只报一次。

    挪不动/置顶不了窗口不该让整条发送失败（UIA 还能把字打进去），
    更不该让看门狗以为“发送卡住”把桥接反复重启——那会一直弹「拒绝访问」。
    """
    now = time.time()
    if now - _win_problem_ts.get(where, 0) < 120:
        return
    _win_problem_ts[where] = now
    log(where + "：", repr(err))


def read_config():
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
                cfg = json.load(f)
        except Exception as e:
            log("读取 config.json 失败：", e)
    return cfg


def build_bot_url(cfg):
    port = (cfg.get("server") or {}).get("port", 8787)
    return os.environ.get("WHALE_BOT_URL", "http://127.0.0.1:%s/webhook/wechat" % port)


# 当前使用的鲸鲸地址。main() 里会赋值；放在模块级是为了让 bot_base()
# 这类工具函数能读到（原版把 bot_url 定义在 main() 内部，导致闭包外的函数读不到）。
CURRENT_BOT_URL = build_bot_url({}) if os.environ.get("WHALE_BOT_URL") else ""


def bot_base():
    """从 bot_url 推出服务根地址。

    原版是 bot_url.rsplit("/webhook", 1)[0]。但鲸鲸的接口是 /api/wechat，
    里面没有 /webhook，rsplit 会原样返回整个 URL，导致后面拼出来的
    /api/vision、/api/care 变成 /api/wechat/api/vision 而 404。

    这里兼容两种形态：
      .../webhook/wechat → 去掉 /webhook/wechat
      .../api/wechat     → 去掉 /api/wechat
    """
    url = CURRENT_BOT_URL or ""
    if not url:
        return "http://127.0.0.1:8899"
    if "/webhook" in url:
        return url.rsplit("/webhook", 1)[0]
    if url.endswith("/api/wechat"):
        return url[: -len("/api/wechat")]
    if "/api/" in url:
        return url.rsplit("/api/", 1)[0]
    return url


def ensure_ffmpeg_env():
    """微信 4.x 的普通图片是 HEVC(wxgf) 容器，要 ffmpeg 才能转成 jpg。

    media 库用 shutil.which("ffmpeg") 找，很多机器装了 ffmpeg 但没加进 PATH，
    结果图片一直转不出来、看图全是「图片输入格式/解析错误」。
    这里先自己找一遍常见位置，找到就塞进 PATH。
    """
    import shutil
    if shutil.which("ffmpeg"):
        return True
    cands = [
        os.path.join(ROOT, "runtime", "ffmpeg", "bin"),
        os.path.join(ROOT, "tools", "ffmpeg", "bin"),
        r"C:\ffmpeg\bin", r"D:\ffmpeg\bin", r"E:\ffmpeg\bin", r"F:\ffmpeg\bin",
        os.path.expanduser(r"~\ffmpeg\bin"),
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\ffmpeg\bin"),
        r"C:\Program Files\ffmpeg\bin", r"D:\Program Files\ffmpeg\bin",
    ]
    for d in cands:
        exe = os.path.join(d, "ffmpeg.exe")
        if os.path.isfile(exe):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            log("找到 ffmpeg：", exe, "（微信图片是 wxgf/HEVC，靠它转 jpg）")
            return True
    log("[!] 没找到 ffmpeg：微信 4.x 的图片多是 wxgf/HEVC，没有它就看不了图。")
    log("    装一个（解压到 C:\\ffmpeg 即可）或把 ffmpeg.exe 放进 runtime\\ffmpeg\\bin")
    return False


def main():
    boot("进入 main()")
    # reload_config() 会写这几个全局变量，这里先声明清楚
    global STICKER_CHANCE, MEDIA_COLLECT, COLLECT_WHITELIST
    ensure_ffmpeg_env()
    # 微信的 Qt accessibility 只在「纯英文路径」下能热激活成功；路径里带中文时，
    # UIA 认不出主窗（ensure_window 超时 37s），之后每次发送都退到 OCR 并报
    # error(5, 'SetWindowPos', '拒绝访问')，日志刷屏、消息发不出去。
    if any(ord(ch) > 127 for ch in ROOT):
        log("[!] 路径里有中文/非英文字符：", ROOT)
        log("    微信 UI 自动化在这种路径下会失败（发送一直报「拒绝访问」）。")
        log("    请把整个文件夹移到纯英文路径再启动，例如 D:\\whale-girl-3.0")
    # 单实例锁：多个桥接连同一份微信数据库会导致同一条消息被回好几遍
    _lock_sock = None
    try:
        import socket as _socket
        _lock_sock = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        _lock_sock.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 0)
        _lock_sock.bind(("127.0.0.1", BRIDGE_LOCK_PORT))
        _lock_sock.listen(1)
        boot("单实例锁已获取（端口 %d）" % BRIDGE_LOCK_PORT)
    except OSError as e:
        log("已经有一个桥接在跑了（端口 %d 被占用），本进程退出：%r" % (BRIDGE_LOCK_PORT, e))
        try:
            if _lock_sock:
                _lock_sock.close()
        except Exception:
            pass
        return 0
    except Exception:
        _lock_sock = None
    try:
        import faulthandler

        try:
            _hang_file = open(os.path.join(ROOT, "data", "bridge-hang.log"), "a", encoding="utf-8")
            faulthandler.dump_traceback_later(40, repeat=True, file=_hang_file)
            boot("已开启卡死堆栈转储（40s）")
        except Exception:
            pass

        # 原生崩溃（0xC0000005）发生时，让 faulthandler 尽量在死前吐出当时正在跑哪句，
        # 写进 data/bridge-crash.log。能吐出来就省得猜是 UIA 还是别的什么崩的。
        try:
            _crash_file = open(os.path.join(ROOT, "data", "bridge-crash.log"), "a", encoding="utf-8")
            _crash_file.write("\n==== %s 进程启动（pid=%d）====\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), os.getpid()))
            _crash_file.flush()
            faulthandler.enable(file=_crash_file, all_threads=True)
            boot("已开启崩溃堆栈记录（data/bridge-crash.log）")
        except Exception:
            pass

        boot("开始 import requests")
        import requests

        boot("开始 import wechatauto（可能较慢，10~20 秒）")
        from wechatauto import MediaDownloader, WeChatDB, WeChatGUI
        from wechatauto.db import Listener

        # 小版本兼容补丁：本机微信上 UIA 控件树其实已经物化，但顶层窗口类名不是
        # mmui::MainWindow，wechatauto 自带的判断会把它当成「没物化」，于是每次
        # 发送都跳过 UIA、掉进会卡死在截屏里的 OCR 兜底。补丁见 uia_compat.py。
        # 包里自带的 Python 开了 safe_path（sys.flags.safe_path=True，sys.path[0]
        # 是 python312.zip 而不是脚本目录），所以同目录的 uia_compat 直接 import 会
        # ModuleNotFoundError。这里显式把 examples 目录塞进 sys.path；再不行就按
        # 文件路径加载（双保险）。
        _here = os.path.dirname(os.path.abspath(__file__))
        if _here not in sys.path:
            sys.path.insert(0, _here)
        # 打开每一步的耗时日志（uia step xxx -> X.XXs），下次卡住能直接看出停在哪步
        os.environ.setdefault("WHALE_STEPLOG", "1")
        boot("应用 uia_compat 补丁")
        try:
            import uia_compat
            boot("uia_compat.apply() = %r" % (uia_compat.apply(),))
        except Exception as _compat_err:
            try:
                import importlib.util as _ilu
                _spec = _ilu.spec_from_file_location(
                    "uia_compat", os.path.join(_here, "uia_compat.py"))
                _mod = _ilu.module_from_spec(_spec)
                sys.modules["uia_compat"] = _mod
                _spec.loader.exec_module(_mod)
                _mod.apply()
                boot("uia_compat 已按文件路径加载并生效")
            except Exception:                # noqa: BLE001
                boot("uia_compat 未生效: %r" % (_compat_err,))

        boot("import 完成")
    except Exception as e:
        boot("导入失败: %r" % (e,))
        log("缺少依赖或导入失败：", e)
        log("请先运行：\"%LOCALAPPDATA%\\Programs\\Python\\Python312\\python.exe\" -m pip install wechatauto-replica requests")
        return 1

    cfg = read_config()
    gw = (cfg.get("gateway") or {}).get("wechat") or {}
    token = gw.get("inboundToken", "")
    bot_url = build_bot_url(cfg)
    # 启动时先把配置应用一遍：reload_config 负责把 wechat 段里的
    # stickerChance / staleAfterSec 等写进全局变量。
    # 原版只在 config_watch 线程里调用，导致「启动后第一次对话」用默认值
    # （STICKER_CHANCE 默认 0 → 永远不发表情包）。
    try:
        reload_config()
    except Exception as _rc_err:                # noqa: BLE001
        log("首次应用配置失败（用默认值继续）：", repr(_rc_err))
    # 同步到模块级，供 bot_base() 使用
    global CURRENT_BOT_URL
    CURRENT_BOT_URL = bot_url
    log("表情包概率：%.0f%%  图片收藏：%s" % (
        STICKER_CHANCE * 100, "开" if MEDIA_COLLECT else "关"))
    aliases = ((cfg.get("persona") or {}).get("aliases") or []) + [
        ((cfg.get("persona") or {}).get("name") or "鲸鲸")
    ]

    log("连接微信 4.x 数据库（只读）…")
    # token 一定要读到：读不到就是「她不理人」最隐蔽的原因（服务端会直接 401）
    if token:
        log("webhook token：已读取（%s…）" % token[:6])
    else:
        log("⚠️ webhook token 是空的！检查 config.json 的 gateway.wechat.inboundToken（文件要能正常解析）")
    db_dir = resolve_db_dir()
    if db_dir:
        log("数据库目录：", db_dir)
    try:
        db = WeChatDB(db_dir=db_dir) if db_dir else WeChatDB()
    except RuntimeError as e:
        # 不甩 traceback：告诉用户接下来该点哪里
        log("")
        log("✗ 找不到微信的数据库目录，读不到消息。按顺序检查：")
        log("  1) 微信 4.x 是不是已经登录了？（停在扫码/登录界面时还没有数据库）")
        log("  2) 微信 → 左下角三条杠 → 设置 → 文件管理 → 「微信文件默认保存位置」")
        log("     把那个路径填进 config.json：\"wechat\": { \"dbDir\": \"E:\\\\xwechat_files\" }")
        log("     （填到 xwechat_files 这一层，不是里面的 wxid_xxx 目录）")
        log("  3) 保存后重新运行「启动微信桥接.bat」")
        log("  原始错误：%s" % e)
        return 2
    _media_box = {"downloader": None}

    def _get_media():
        """按需创建媒体下载器；图片和表情识别共用一个实例。"""
        if _media_box["downloader"] is None:
            save_dir = os.path.join(ROOT, "data", "media-cache")
            os.makedirs(save_dir, exist_ok=True)
            _media_box["downloader"] = MediaDownloader(db, save_dir=save_dir)
        return _media_box["downloader"]

    def shrink_gif(path, max_bytes=1200 * 1024):
        """把 GIF 压到微信愿意当「图片」收的体积，压完还是动图。

        为什么需要：
           电脑微信有个隐形的体积线 —— GIF 太大时，剪贴板粘贴进去
           它不按图片处理，而是当成**文件**发出去（聊天里显示一个文件卡片，
           对方得点开才能看，动画也就没了）。
           所以发之前先把大 GIF 压一压：减色 + 缩尺寸 + 降帧。

        @returns 新文件路径；不需要压或压不动则返回原路径
        """
        try:
            if not path or not path.lower().endswith(".gif"):
                return path
            size = os.path.getsize(path)
            if size <= max_bytes:
                return path

            from PIL import Image, ImageSequence

            src = Image.open(path)
            frames = []
            durations = []

            for fr in ImageSequence.Iterator(src):
                frames.append(fr.convert("RGB"))
                durations.append(fr.info.get("duration", 100))

            if len(frames) < 2:
                return path

            # 抽帧（最多留 12 帧）+ 缩尺寸 + 减色
            step = max(1, len(frames) // 12)
            frames = frames[::step]
            durations = durations[::step]

            w, h = frames[0].size
            edge = 320
            if max(w, h) > edge:
                scale = edge / max(w, h)
                frames = [f.resize((max(1, int(w * scale)), max(1, int(h * scale))), 1) for f in frames]

            out = os.path.join(os.path.dirname(path), "_send_" + os.path.basename(path))
            for colors in (96, 64, 48, 32):
                pal = [f.quantize(colors=colors, method=Image.MEDIANCUT) for f in frames]
                pal[0].save(
                    out,
                    format="GIF",
                    save_all=True,
                    append_images=pal[1:],
                    duration=max(60, sum(durations) // max(1, len(durations))),
                    loop=0,
                    optimize=True,
                )
                if os.path.getsize(out) <= max_bytes:
                    log("GIF 压缩：%d KB → %d KB（%d 色，%d 帧）" % (
                        size // 1024, os.path.getsize(out) // 1024, colors, len(frames)))
                    return out

            # 压到最小还是太大 → 放弃，用原图（让对方点开看，总比不发强）
            try:
                os.remove(out)
            except OSError:
                pass
            log("GIF 压不到 %d KB 以内，按原图发" % (max_bytes // 1024))
            return path
        except Exception as e:                      # noqa: BLE001
            log("GIF 压缩失败（按原图发）：", repr(e))
            return path

    def wxgf_to_gif(data, max_edge=360, fps=10, max_seconds=6, max_bytes=3 * 1024 * 1024):
        """把 wxgf 容器里的 HEVC 流转成**动图 GIF**。

        为什么需要这个：
           微信 4.x 的动图（GIF/动图表情）不是 gif 文件，而是装在 wxgf
           容器里的一段 HEVC 视频。wechatauto 自带的 `_wxgf_to_jpg` 只取
           第一帧（ffmpeg `-frames:v 1`），转出来是**静态 JPEG** ——
           所以素材库里永远看不到动图，全变成一张不动的截图。

        这里改成整段转 GIF：素材库预览能动，发出去也是动图。

        参数取舍：
           360px / 10fps / 160 色 / 最多 6 秒。实测 240x180 两秒的素材
           按原始参数转出来 336KB，偏大；压到这个档位既看得清又不会太肥。
           超过 max_bytes 就当失败，让调用方退回静态图 —— 宁可不发，
           也不能让素材库被几 MB 的 GIF 撑爆。

        @returns GIF 字节；失败返回 None（调用方退回静态 JPEG）
        """
        try:
            md = _get_media()
            exe = md._ffmpeg_exe()
            if not exe:
                return None

            hevc = md._extract_hevc(data)
            if not hevc:
                return None

            import subprocess
            import tempfile

            with tempfile.TemporaryDirectory() as td:
                src = os.path.join(td, "in.hevc")
                dst = os.path.join(td, "out.gif")
                with open(src, "wb") as f:
                    f.write(hevc)

                # 两步法调色板：先 palettegen 再 paletteuse，
                # 直接转 GIF 会掉色掉得很难看（实测偏绿）。
                vf = (
                    "fps=%d,scale=%d:-1:flags=lanczos,split[s0][s1];"
                    "[s0]palettegen=max_colors=128[p];"
                    "[s1][p]paletteuse=dither=bayer:bayer_scale=3"
                ) % (fps, max_edge)

                try:
                    r = subprocess.run(
                        [
                            exe, "-y", "-v", "error",
                            "-t", str(max_seconds),
                            "-i", src,
                            "-vf", vf,
                            "-loop", "0",
                            dst,
                        ],
                        capture_output=True,
                        timeout=60,
                    )
                except Exception as e:          # noqa: BLE001
                    log("wxgf 转动图超时/异常：", repr(e))
                    return None

                if r.returncode != 0 or not os.path.exists(dst):
                    return None

                size = os.path.getsize(dst)
                if size < 1024 or size > max_bytes:
                    if size > max_bytes:
                        log("wxgf 动图太大（%d KB），改用静态图" % (size // 1024))
                    return None

                with open(dst, "rb") as f:
                    out = f.read()

                if out[:3] != b"GIF":
                    return None
                return out
        except Exception as e:                  # noqa: BLE001
            log("wxgf 转动图失败：", repr(e))
            return None

    me = db.wxid
    try:
        info = db.get_self_info() or {}
        log("当前登录账号：", info.get("nick_name") or info.get("remark") or me)
    except Exception:
        log("当前登录账号 wxid：", me)
    log("数据库目录：", db.db_dir)

    sessions = {}
    try:
        for s in db.get_sessions(limit=800):
            sessions[s["username"]] = s
    except Exception as e:
        log("读取会话列表失败：", e)

    name_cache = {}

    def display_name(username):
        if username in name_cache:
            return name_cache[username]
        name = ""
        try:
            if username.endswith("@chatroom"):
                name = db.group_id_to_name(username) or ""
                if not name:
                    s = sessions.get(username) or {}
                    name = s.get("last_sender") or ""
            else:
                name = db.get_nickname(username) or ""
        except Exception:
            name = ""
        name = name or username
        name_cache[username] = name
        return name

    alias_cache = {}
    # 上次把这个会话切到哪一行名字（微信里没命名的群，行名是成员名）
    open_cache = {}

    def aliases_for(username, shown=""):
        """会话列表里那一行可能叫什么（微信里没命名的群，显示的是成员名）。

        实测：群 45063658812@chatroom 在数据库里 nick_name 是空的，会话列表里显示
        「宇火之于、云白『世一区』」—— 按群名/open_chat 都匹配不上，所以这里把
        「成员名用、连起来」也当候选名。
        """
        key = (username or "", shown or "")
        if key in alias_cache:
            return alias_cache[key]
        out = []
        if shown and shown != username and not str(shown).endswith("@chatroom"):
            out.append(shown)
        if username and str(username).endswith("@chatroom"):
            try:
                nm = db.group_id_to_name(username) or ""
            except Exception:
                nm = ""
            if nm and nm != username:
                out.append(nm)
            try:
                nicks = []
                for m in (db.get_group_members(username) or []):
                    if m.get("username") == me:
                        continue
                    n = (m.get("remark") or "").strip() or (m.get("nick_name") or "").strip()
                    if n:
                        nicks.append(n)
                if nicks:
                    out.append("、".join(nicks))
            except Exception:
                pass
        if not out:
            out.append(shown or username)
        out = [x for x in dict.fromkeys(out) if x]
        alias_cache[key] = out
        return out

    def chat_latest_seq(username):
        try:
            rows = db.get_messages(username, limit=1)
            return rows[0].get("sort_seq") or 0 if rows else 0
        except Exception:
            return 0

    gui = None
    gui_lock = threading.Lock()
    send_lock = threading.Lock()
    dead_chats = set()
    fail_streak = {}
    self_wxid = db.wxid
    pending_replies = {}
    SEND_STATE = {"active": False, "start": 0.0}
    pending_lock = threading.Lock()
    AWAY = {"on": False}
    NOTIFIED = []

    def away_active():
        """主人在微信里发了「我去玩了」→ 写 data/away.json，这里据此静默排队。"""
        try:
            p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "away.json")
            with open(p, "r", encoding="utf-8") as f:
                d = json.load(f)
            return float(d.get("until") or 0) > time.time()
        except Exception:
            return False

    def game_running():
        if not GAME_TOKENS:
            return False
        try:
            import psutil
            for p in psutil.process_iter(["name"]):
                n = (p.info.get("name") or "").lower()
                if any(t in n for t in GAME_TOKENS):
                    return True
        except Exception:
            pass
        return False

    def foreground_is_fullscreen():
        """前台是不是「真全屏」程序（全屏游戏、全屏视频）——这时别抢焦点，先把回复排着。

        不能拿屏幕尺寸判断：Windows 上最大化窗口的 GetWindowRect 带 DWM 隐形边框，
        实测 2560x1440 的屏幕，最大化浏览器返回 rect=(-8,-8,2568,1448)，
        旧的 `r[2] >= sw-2 and r[3] >= sh-2` 会把它当全屏 ——
        表现就是「用户把窗口一最大化，她就不理人了」（3.3.1 实测复现）。

        改成两条一起判：
          ① 盖住整个显示器（MonitorFromWindow 取 rcMonitor，不是屏幕尺寸）；
          ② 没有标题栏和边框（真全屏游戏/无边框视频都是 WS_POPUP）。
        最大化窗口带 WS_CAPTION|WS_THICKFRAME，因此被正确排除。
        """
        try:
            import ctypes
            import ctypes.wintypes as wt
            import psutil
            import win32con
            import win32gui
            import win32process
            h = win32gui.GetForegroundWindow()
            if not h:
                return False
            _, pid = win32process.GetWindowThreadProcessId(h)
            name = psutil.Process(pid).name().lower()
            if name.startswith("weixin"):
                return False
            style = win32gui.GetWindowLong(h, win32con.GWL_STYLE)
            if (style & win32con.WS_CAPTION) and (style & win32con.WS_THICKFRAME):
                return False        # 普通窗口或最大化：有标题栏+可调边框，不是全屏

            class _MONITORINFO(ctypes.Structure):
                _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT),
                            ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]

            user32 = ctypes.windll.user32
            mi = _MONITORINFO()
            mi.cbSize = ctypes.sizeof(_MONITORINFO)
            hmon = user32.MonitorFromWindow(h, 2)  # MONITOR_DEFAULTTONEAREST
            if not user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
                return False
            mon = mi.rcMonitor
            r = win32gui.GetWindowRect(h)
            return (r[0] <= mon.left + 1 and r[1] <= mon.top + 1
                    and r[2] >= mon.right - 1 and r[3] >= mon.bottom - 1)
        except Exception:
            return False

    def group_is_alive(chat_username):
        """被踢出群后，群会话还在，但发不出去；先查成员列表。"""
        if not str(chat_username).endswith("@chatroom"):
            return True
        try:
            members = db.get_group_members(chat_username) or []
            ids = {str(m.get("wxid") or m.get("username")) for m in members}
            return self_wxid in ids
        except Exception:
            return True

    # ---------- 微信窗口置顶（关键：别的窗口挡在微信上面会导致打字落空） ----------
    def find_weixin_hwnd():
        try:
            import win32gui
            import win32con
            import win32process
            import psutil
        except Exception:
            return 0
        found = []
        # 微信（4.x / Qt）会额外建一个「托盘图标隐藏消息窗」：它算可见窗口，
        # 而且 GetWindowRect 出来的面积常常比主窗还大（实测 1320x900 > 主窗 896x776）。
        # 以前按「面积最大」挑，就会挑中它 —— 对它 SetWindowPos 直接 error(5) 拒绝访问，
        # 于是每次发送都失败、走 OCR 兜底、再被看门狗重启，一直循环报「拒绝访问」。
        BAD_CLASS = ("trayicon", "messagewindow", "msctf", "sopy", "sogou", "hintwnd", "default ime", "notifyicon")

        def cb(h, _):
            try:
                title = win32gui.GetWindowText(h) or ""
                _, pid = win32process.GetWindowThreadProcessId(h)
                if pid <= 0:
                    return
                cls = win32gui.GetClassName(h) or ""
                low = cls.lower()
                if any(bad in low for bad in BAD_CLASS):
                    return
                rect = win32gui.GetWindowRect(h)
                area = max(0, rect[2] - rect[0]) * max(0, rect[3] - rect[1])
                if win32gui.IsIconic(h):
                    # 最小化后 GetWindowRect 是 (-16000,-16000,…) 的退化矩形，
                    # 换算成「还原后」的尺寸再判大小
                    try:
                        rc = win32gui.GetWindowPlacement(h)[4]
                        area = max(0, rc[2] - rc[0]) * max(0, rc[3] - rc[1]) or area
                    except Exception:
                        pass
                # 不再要求 IsWindowVisible：微信缩在托盘里时主窗 visible=0，以前这里
                # 直接 return，于是整条「置顶 + 调窗口」都被跳过。主窗至少 300x250，
                # 托盘提示窗（260x85）和辅助窗（173x196）顺手被排除。
                if area < 300 * 250 and title.strip() != "微信":
                    return
                try:
                    name = psutil.Process(pid).name().lower()
                except Exception:
                    return
                if not name.startswith("weixin"):
                    return
                if "发送" in title or "助手" in title:
                    return
                try:
                    style = win32gui.GetWindowLong(h, win32con.GWL_STYLE)
                    has_min_box = bool(style & win32con.WS_MINIMIZEBOX)
                except Exception:
                    has_min_box = False
                is_main_title = title.strip() == "微信"
                looks_main_class = ("qwindowicon" in low) or ("mmui::mainwindow" in low)
                # 真主窗的三条特征都各加一个大权重，面积只在同类里起作用，
                # 这样托盘消息窗再“大”也排不到前面
                score = area
                if is_main_title:
                    score += 10 ** 9
                if looks_main_class:
                    score += 10 ** 8
                if has_min_box:
                    score += 10 ** 7
                found.append((score, 1 if is_main_title else 0, h))
            except Exception:
                pass

        try:
            win32gui.EnumWindows(cb, None)
        except Exception:
            return 0
        if not found:
            return 0
        found.sort(reverse=True)
        return found[0][2]

    def wechat_window_alive():
        """微信主窗现在是否还存在（每次现找，不缓存 —— 微信窗口回收/更新后，缓存句柄会失效）。

        长时间挂着不管时，微信可能半夜自更新、或把窗口拆了重开，此时 uiautomation
        手里还攥着旧窗口的 COM 指针 / 句柄，再碰一次就直接 0xC0000005（访问违规），
        Python 的 try/except 拦不住，进程当场死掉 —— 也就是「Bridge exited with code
        -1073741819」。这些 UIA 调用前先问一句窗口还在不在，就能把这种崩溃挡在外面。
        """
        try:
            import win32gui
            h = find_weixin_hwnd()
            return bool(h and win32gui.IsWindow(h))
        except Exception:
            return False

    def normalize_window(hwnd):
        """微信窗口太小 / 超出屏幕 / 被挪走都会让 UI 自动化点空，统一调成稳定尺寸。"""
        try:
            import win32gui
            import win32con
            import win32api
            sw, sh = win32api.GetSystemMetrics(0), win32api.GetSystemMetrics(1)
            rect = win32gui.GetWindowRect(hwnd)
            x, y, w, h = rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]
            tw, th = min(1320, sw - 160), min(900, sh - 160)
            need = w < 1080 or h < 760 or w > sw - 80 or h > sh - 80 or x < -20 or y < -20 or x + w > sw + 20 or y + h > sh + 20
            if need:
                win32gui.SetWindowPos(hwnd, win32con.HWND_TOP, 40, 20, tw, th, win32con.SWP_SHOWWINDOW)
                log("微信窗口调整：%dx%d @(%d,%d) → %dx%d（保证自动发送稳定）" % (w, h, x, y, tw, th))
                time.sleep(0.8)
        except Exception as e:
            log_window_problem("调整微信窗口失败（继续发送）", e)

    def force_send_foreground(fn):
        """把微信拉到前台再发送（真正的兜底路径）。

        注意：实测下来大多数时候**不需要**这条路 —— 微信最小化、被别的窗口挡住、
        甚至前台是全屏程序时，UIA 都能正常发送（见 docs/接入微信.md 的实测数据）。
        所以它只作为「后台发送失败后」的第二次尝试。
        """
        hwnd = find_weixin_hwnd()
        was_topmost = False
        touched = False
        try:
            import win32gui
            import win32con
            if hwnd:
                try:
                    if not win32gui.IsWindowVisible(hwnd):
                        # 微信在托盘里时主窗是隐藏的，先把窗口拉出来再打字
                        win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
                        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                        log("微信在托盘里，已把主窗口拉出来再发送")
                        time.sleep(0.4)
                except Exception as e:
                    log("拉出微信窗口失败：", repr(e))
                normalize_window(hwnd)
                try:
                    fg = win32gui.GetForegroundWindow()
                except Exception:
                    fg = 0
                if fg != hwnd:
                    touched = True
                    force_foreground(hwnd)
                    ex = win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE)
                    was_topmost = bool(ex & win32con.WS_EX_TOPMOST)
                    # 置顶失败不该让整条发送失败（比如挑到了不能定位的窗口），
                    # 顶多是“可能被别的窗口挡住”，打字还有 UIA 兜着
                    try:
                        win32gui.SetWindowPos(
                            hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                            win32con.SWP_NOMOVE | win32con.SWP_NOSIZE,
                        )
                    except Exception as e:
                        log_window_problem("窗口置顶失败（继续发送）", e)
                    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                    time.sleep(0.2)
            return fn()
        finally:
            try:
                if touched and hwnd and not was_topmost:
                    import win32gui
                    import win32con
                    win32gui.SetWindowPos(
                        hwnd, win32con.HWND_NOTOPMOST, 0, 0, 0, 0,
                        win32con.SWP_NOMOVE | win32con.SWP_NOSIZE,
                    )
            except Exception:
                pass

    def with_window_on_top(fn):
        """发送前确保能发出去。

        默认**不长期占用前台**（backgroundSend=true）：
          1. 先直接让 UIA 在后台发（微信最小化/被遮挡也能发，实测 18/18）；
          2. 万一失败，才把微信拉到前台重试一次；
          3. 不管成功失败，**发完都把窗口状态还原**（该最小化的重新最小化、前台还给原来的窗口），
             这样你在用电脑时最多看到它闪一下。
        把 wechat.backgroundSend 设成 false 就退回以前的「每次先抢前台、发完不管」。
        """
        if game_running():
            return False
        SEND_STATE["active"] = True
        SEND_STATE["start"] = time.time()
        snap = snapshot_win_state() if BACKGROUND_SEND else None
        try:
            if BACKGROUND_SEND:
                try:
                    if fn():
                        return True
                except Exception as e:                 # noqa: BLE001
                    log("后台发送异常，改走前台重试：", repr(e))
                log("后台发送没成功，把微信拉到前台再试一次")
                return force_send_foreground(fn)
            return force_send_foreground(fn)
        finally:
            if BACKGROUND_SEND:
                restore_win_state(snap)
            SEND_STATE["active"] = False

    def force_foreground(hwnd):
        """把微信强制拉到前台（SetForegroundWindow 单用会被系统拒绝）。"""
        try:
            import ctypes
            user32 = ctypes.windll.user32
            if user32.GetForegroundWindow() == hwnd:
                return True
            fg = user32.GetForegroundWindow()
            tid_fg = user32.GetWindowThreadProcessId(fg, None)
            tid = user32.GetWindowThreadProcessId(hwnd, None)
            try:
                user32.AttachThreadInput(tid_fg, tid, True)
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                user32.SetForegroundWindow(hwnd)
                user32.BringWindowToTop(hwnd)
            finally:
                try:
                    user32.AttachThreadInput(tid_fg, tid, False)
                except Exception:
                    pass
            time.sleep(0.15)
            return True
        except Exception:
            return False

    UIA_CACHE = {"u": None}

    def _input_value(u):
        """尽量读出输入框当前文字；读不到返回空串。"""
        try:
            e = u._chat_input()
            if e is None:
                return ''
            for name in ('get_value', 'value'):
                try:
                    v = getattr(e, name)
                    v = v() if callable(v) else v
                    if v is not None:
                        return str(v)
                except Exception:
                    pass
            try:
                return str(e.iface_value.Value)
            except Exception:
                pass
        except Exception:
            pass
        return ''

    def press_enter(with_ctrl=False):
        """用底层按键补发 Enter（UIA 的 SendKeys 有时不触发发送）。"""
        try:
            import win32api
            import win32con
            hwnd = find_weixin_hwnd()
            if hwnd:
                force_foreground(hwnd)
            time.sleep(0.10)
            if with_ctrl:
                win32api.keybd_event(0x11, 0, 0, 0)
            win32api.keybd_event(0x0D, 0, 0, 0)
            win32api.keybd_event(0x0D, 0, win32con.KEYEVENTF_KEYUP, 0)
            if with_ctrl:
                win32api.keybd_event(0x11, 0, win32con.KEYEVENTF_KEYUP, 0)
            time.sleep(0.25)
            return True
        except Exception as e:
            log("手动回车失败：", repr(e))
            return False

    def snapshot_win_state():
        """记下发送前的「窗口长什么样」，发完要还原。

        要还原的东西：微信是不是最小化、原来哪个窗口在前台。
        """
        snap = {"hwnd": 0, "iconic": False, "fg": 0}
        try:
            import win32gui
            snap["hwnd"] = find_weixin_hwnd() or 0
            if snap["hwnd"]:
                snap["iconic"] = bool(win32gui.IsIconic(snap["hwnd"]))
            snap["fg"] = win32gui.GetForegroundWindow() or 0
        except Exception:
            pass
        return snap

    def restore_win_state(snap):
        """把窗口状态还原：微信重新最小化，前台还给刚才那个窗口。

        实测（2026-10-25 02:5x）：微信最小化 + 前台是浏览器时发一条，窗口会被抬起约 5 秒；
        发完立刻最小化并把前台还回去，用户几乎无感。
        SetForegroundWindow 会被前台锁拒绝，所以带 ALT 解锁 + 重试 + SwitchToThisWindow 兜底。
        """
        if not snap:
            return
        try:
            import win32gui
            import win32con
            import ctypes          # 修复：下面用了 ctypes.windll，原来漏导入
            wx = snap.get("hwnd")
            if wx and snap.get("iconic"):
                try:
                    win32gui.ShowWindow(wx, win32con.SW_MINIMIZE)
                except Exception:
                    pass
                time.sleep(0.12)
            fg = snap.get("fg")
            if not fg or fg == wx or not win32gui.IsWindow(fg):
                return
            for attempt in range(3):
                try:
                    # 先按一下 ALT 解锁前台锁（单独 SetForegroundWindow 会被拒绝）
                    win32api.keybd_event(win32con.VK_MENU, 0, 0, 0)
                    win32api.keybd_event(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0)
                    time.sleep(0.04)
                    ctypes.windll.user32.SetForegroundWindow(fg)
                except Exception:
                    pass
                time.sleep(0.12)
                if ctypes.windll.user32.GetForegroundWindow() == fg:
                    return
                # 兜底：SwitchToThisWindow 不受前台锁限制（老 API，但有效）
                try:
                    ctypes.windll.user32.SwitchToThisWindow(fg, True)
                except Exception:
                    pass
                time.sleep(0.12)
                if ctypes.windll.user32.GetForegroundWindow() == fg:
                    return
            log_window_problem("还原前台失败（窗口已最小化，不影响使用）", None)
        except Exception as e:                      # noqa: BLE001
            log_window_problem("还原窗口状态失败", e)

    def install_quiet_uia(u):
        """让 UIA 引擎「别抢前台」。

        wechatauto 的 WeChatUIA.ensure_window() 每次都会调 _activate() →
        _force_foreground()/ShowWindow(9)，也就是把微信窗口恢复并抢到最前面。
        实测 18/18：微信最小化、被遮挡、前台全屏时其实都能发，所以这步纯属多余，
        代价是你正在用的电脑被反复打断。

        这里给引擎实例打个补丁：quiet_mode 打开时 _activate 直接返回。
        不改第三方库文件，随桥接一起走；万一后台发不出去，force_send_foreground()
        会显式把窗口拉出来，不依赖这个补丁。
        """
        try:
            import types
            if getattr(u, "_whale_quiet_patch", False):
                u.quiet_mode = True
                return
            orig = u._activate

            def patched(self, win, _orig=orig):
                if getattr(self, "quiet_mode", False):
                    return
                return _orig(win)

            u._activate = types.MethodType(patched, u)
            u._whale_quiet_patch = True
            u.quiet_mode = True
        except Exception as e:                      # noqa: BLE001
            log("后台模式补丁没打上（不影响发送）：", repr(e))

    def uia_send(text, who, username=""):
        """优先用 UIA 发送：不依赖 OCR 找发送按钮，成功后返回 True。"""
        if not wechat_window_alive():
            # 主窗没了，缓存引擎里的句柄已失效，碰了会 0xC0000005；直接走键盘/OCR 兜底
            with gui_lock:
                UIA_CACHE["u"] = None
            return False
        u = UIA_CACHE["u"]
        # 每次发送都问一次库里的引擎（它内部 30 秒节流、会自己检测「子控件不可见」并重新热激活）。
        # 以前只在缓存为空时才问，结果微信把 accessibility gate byte 归零后，缓存的引擎变成
        # 「假死」：能收消息、但一条也发不出去，挂着挂着就不理人了，只能重启桥接才好。
        try:
            with gui_lock:
                fresh = gui._get_uia() if gui is not None else None
            if fresh is not None:
                u = fresh
            UIA_CACHE["u"] = u
        except Exception:
            u = UIA_CACHE["u"]
        if u is None:
            return False
        if BACKGROUND_SEND:
            # 后台模式：禁止引擎自己恢复窗口/抢前台（真正的抢前台只在兜底那一步做）
            install_quiet_uia(u)
        keys = aliases_for(username, who) if username else [who]
        try:
            cur = None
            try:
                cur = u.current_chat()
            except Exception:
                pass
            hit_cur = (cur == who) or any(cur == k for k in keys if k)
            if not hit_cur and username:
                hit_cur = bool(cur) and open_cache.get(username) == cur
            if not hit_cur:
                if not u.open_chat(keys):
                    try:
                        u.back_to_chat_tab()
                    except Exception:
                        pass
                    if not u.open_chat(keys):
                        return False
                if username:
                    try:
                        open_cache[username] = u.current_chat() or ""
                        log("UIA 已切到会话：", open_cache[username])
                    except Exception:
                        pass
            t_open = time.time()
            sent_ok = False
            try:
                sent_ok = bool(u.send_text(text))
            except Exception:
                sent_ok = False
            if not sent_ok:
                try:
                    u.back_to_chat_tab()
                    sent_ok = bool(u.send_text(text))
                except Exception:
                    sent_ok = False
            log("UIA 发送耗时 %.1fs（打开会话+输入）" % (time.time() - t_open))
            if sent_ok:
                # 多按几次：Enter 两次 + Ctrl+Enter 两次（兼容“按 Ctrl+Enter 发送”的设置）
                press_enter(False)
                press_enter(False)
                press_enter(True)
                press_enter(True)
                return True
        except Exception as e:
            log("UIA 发送异常：", repr(e))
        return False

    def recover_uia(reason=""):
        """强制重新热激活 UIA（rewrite gate byte + 校验），成功返回 True。

        微信跑久了会把 accessibility gate byte 归零，UIA 引擎就变成「假死」：
        能读消息、发不出去。以前只能重启桥接；这里让它自己救回来。
        """
        try:
            if gui is None:
                return False
            if not wechat_window_alive():
                with gui_lock:
                    UIA_CACHE["u"] = None
                log("UIA 重新热激活跳过（微信主窗当前不存在）")
                return False
            with gui_lock:
                u = gui._get_uia(refresh=True)
            UIA_CACHE["u"] = u
            if u is not None:
                log("UIA 已重新热激活%s" % (("（" + reason + "）") if reason else ""))
                return True
            log("UIA 重新热激活失败%s" % (("（" + reason + "）") if reason else ""))
        except Exception as e:                     # noqa: BLE001
            log("UIA 重新热激活异常：", repr(e))
        return False

    def keyboard_send(text, chat_display_name, chat_username=""):
        """完全不依赖 UIA 的发送通道：Ctrl+F 搜索会话 → 粘贴 → 回车 → 回读数据库确认。

        为什么需要它：UIA 依赖微信的 accessibility gate，微信跑久了/窗口状态怪的时候
        整条路都会挂（见 recover_uia 的注释）。键盘通道只用 Win32 按键 + 剪贴板，
        走的是微信自己的搜索框，不碰 accessibility。
        代价：会抢前台、慢一些，所以只在 UIA 真的发不出去时用。
        """
        try:
            import ctypes
            import win32api          # noqa: F401
            import win32clipboard
            import win32con
            import win32gui
            user32 = ctypes.windll.user32
        except Exception as e:                     # noqa: BLE001
            log("键盘通道不可用（缺少 win32 模块）：", repr(e))
            return False

        hwnd = find_weixin_hwnd()
        if not hwnd:
            log("键盘通道：找不到微信主窗")
            return False

        def fg():
            return user32.GetForegroundWindow()

        # 抢前台：单独 SetForegroundWindow 会被前台锁拒绝，先按一下 ALT 解锁
        if fg() != hwnd:
            user32.keybd_event(win32con.VK_MENU, 0, 0, 0)
            time.sleep(0.05)
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.2)
            user32.keybd_event(win32con.VK_MENU, 0, 2, 0)
            time.sleep(0.2)
        if fg() != hwnd:
            try:
                user32.SwitchToThisWindow(hwnd, True)
                time.sleep(0.3)
            except Exception:
                pass
        if fg() != hwnd:
            log("键盘通道：抢不到前台，放弃这次（UIA 也不可用时这条就发不出去了）")
            return False

        def set_clip(t):
            for _ in range(5):
                try:
                    win32clipboard.OpenClipboard()
                    break
                except Exception:                  # noqa: BLE001
                    time.sleep(0.1)
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, t)
            finally:
                win32clipboard.CloseClipboard()

        def tap(vk, mods=()):
            for m in mods:
                user32.keybd_event(m, 0, 0, 0)
            user32.keybd_event(vk, 0, 0, 0)
            user32.keybd_event(vk, 0, 2, 0)
            for m in reversed(mods):
                user32.keybd_event(m, 0, 2, 0)
            time.sleep(0.12)

        def confirmed_target():
            """打开会话后确认「现在开着的到底是谁」。

            键盘通道是模拟按键，搜不到人时回车会落到「当前那个会话」上，
            正文就直接发给别人了 —— 2026-10-25 12:21 的日志里就出现过
            「键盘通道：按键发了，但数据库里没确认到（可能发到了别的会话）」。
            这里用 UIA 的只读能力核对（读会话名在「能读不能发」的假死状态下依然可用）；
            读不到就宁可这条失败，也不盲发 —— 私聊内容发错人比晚回一条严重得多。
            返回 (是否匹配, 当前会话名)。
            """
            try:
                u = gui._get_uia() if gui is not None else None
                cur = u.current_chat() if u is not None else None
            except Exception:
                cur = None
            if not cur:
                return None, None
            cands = {chat_display_name}
            try:
                if chat_username:
                    cands.update(aliases_for(chat_username, chat_display_name))
                    cached = open_cache.get(chat_username)
                    if cached:
                        cands.add(cached)
            except Exception:
                pass
            return (cur in cands), cur

        try:
            # ① 搜索会话（微信的 Ctrl+F）
            tap(ord("F"), (win32con.VK_CONTROL,))
            time.sleep(0.5)
            set_clip(chat_display_name)
            tap(ord("V"), (win32con.VK_CONTROL,))
            time.sleep(0.8)
            tap(win32con.VK_RETURN)          # ② 打开会话
            time.sleep(0.9)
            # ②.5 先核对打开的是不是目标会话，确认不了就不往输入框里打字
            matched, cur = confirmed_target()
            if matched is None:
                log("键盘通道：读不到当前会话名，为防发错人这次不发")
                return False
            if not matched:
                log("键盘通道：打开的是「%s」而不是「%s」，为防发错人这次不发"
                    % (cur or "", chat_display_name))
                return False
            set_clip(text)                    # ③ 粘贴正文
            tap(ord("V"), (win32con.VK_CONTROL,))
            time.sleep(0.4)
            tap(win32con.VK_RETURN)          # ④ 发送
        except Exception as e:                 # noqa: BLE001
            log("键盘通道按键失败：", repr(e))
            return False

        # ⑤ 回读数据库确认这条真的发出去了（搜错会话时能立刻发现）
        for _ in range(8):
            time.sleep(0.5)
            try:
                msgs = db.get_messages(chat_username or chat_display_name, limit=3) or []
            except Exception:
                msgs = []
            for m in msgs:
                if str(m.get("content") or "").strip()[:12] == str(text).strip()[:12]:
                    return True
        log("键盘通道：按键发了，但数据库里没确认到（可能发到了别的会话），这条按失败处理")
        return False

    def send_text(text, chat_display_name, chat_username="", force=False, quote_text=None):
        nonlocal gui
        if chat_username and chat_username in dead_chats:
            log("跳过已失效的会话：", chat_display_name)
            return False
        if chat_username and not group_is_alive(chat_username):
            dead_chats.add(chat_username)
            log("群里已经没有我了（被移出？），以后跳过：", chat_display_name)
            return False
        if not force and (AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen()):
            with pending_lock:
                pending_replies[chat_username or chat_display_name] = (text, chat_display_name, chat_username, time.time())
            log("你在游戏/全屏程序里，回复先排队，等你退出再发：", chat_display_name)
            return True
        with send_lock:
            if not force and (AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen()):
                with pending_lock:
                    pending_replies[chat_username or chat_display_name] = (text, chat_display_name, chat_username, time.time())
                log("游戏/全屏中，先排队：", chat_display_name)
                return True
            with gui_lock:
                if gui is None:
                    log("初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）")
                    gui = WeChatGUI()
            # ⓪ 引用回复（引用对方那条消息）——比普通发送慢，失败自动回退
            if quote_text and QUOTE_REPLY:
                try:
                    if with_window_on_top(lambda: gui.quote_msg(text, who=chat_display_name, target_text=quote_text, verify=False)):
                        log("引用回复成功 →", chat_display_name)
                        return True
                except Exception as e:
                    log("引用回复失败，回退普通发送：", repr(e))
            # ① 首选 UIA：稳定、快，不依赖 OCR 找发送按钮
            t_start = time.time()
            uia_available = False
            try:
                uia_available = gui._get_uia() is not None
            except Exception:
                uia_available = False
            for attempt in (1, 2):
                t_att = time.time()
                try:
                    if with_window_on_top(lambda: uia_send(text, chat_display_name, chat_username)):
                        fail_streak.pop(chat_username, None)
                        log("发送成功（%.1fs）→ %s" % (time.time() - t_start, chat_display_name))
                        return True
                    log("UIA 发送未成功（第 %d 次，%.1fs），准备重试" % (attempt, time.time() - t_att))
                except Exception as e:
                    log("UIA 发送异常（第 %d 次，%.1fs）：%r" % (attempt, time.time() - t_att, e))
                time.sleep(0.5)
            if uia_available:
                # UIA 报告可用却没发出去：多半是 gate byte 被归零（引擎假死）。
                # 强制重激活一次再试，别让用户只能重启桥接。
                if recover_uia("发送失败"):
                    try:
                        if with_window_on_top(lambda: uia_send(text, chat_display_name, chat_username)):
                            fail_streak.pop(chat_username, None)
                            log("重新激活 UIA 后发送成功（%.1fs）→ %s" % (time.time() - t_start, chat_display_name))
                            return True
                    except Exception as e:            # noqa: BLE001
                        log("重新激活后仍失败：", repr(e))
                log("UIA 发不出去，跳过 OCR 兜底：", chat_display_name)
            else:
                log("UIA 不可用，走 OCR 兜底")
            # ①.5 键盘兜底：完全不碰 accessibility（Ctrl+F 搜索会话 → 粘贴 → 回车），
            #      并用数据库回读确认。OCR 这条路会卡在截屏，所以先试它。
            if KEYBOARD_FALLBACK:
                if keyboard_send(text, chat_display_name, chat_username):
                    fail_streak.pop(chat_username, None)
                    log("发送成功（键盘通道，%.1fs）→ %s" % (time.time() - t_start, chat_display_name))
                    return True
            # ② 兜底：仅当 UIA 不可用时才走 OCR。
            #    注意：OCR 这条路在这台机器上会卡死在 PIL.ImageGrab.grab 截屏里
            #    （data/bridge-hang.log 有栈），以前直接拖到 40 秒看门狗把整个桥接
            #    os.exit 重启；这里给它 25 秒，超时就放弃这一条。
            if not uia_available:
                try:
                    with gui_lock:
                        try:
                            gui = WeChatGUI()
                        except Exception as e:
                            log("重建窗口驱动失败：", repr(e))
                    _box = {}

                    def _ocr_send():
                        try:
                            _box["r"] = with_window_on_top(
                                lambda: gui.send_msg(text, chat_display_name, True))
                        except Exception as _e:      # noqa: BLE001
                            _box["e"] = _e

                    _th = threading.Thread(target=_ocr_send, daemon=True)
                    _th.start()
                    _th.join(25)
                    if _th.is_alive():
                        log("OCR 兜底 25 秒没返回（卡在截屏），放弃这条，等下次消息")
                        resp = False
                    else:
                        if "e" in _box:
                            raise _box["e"]
                        resp = _box.get("r")
                    if bool(resp):
                        fail_streak.pop(chat_username, None)
                        return True
                    log("兜底发送失败：%s" % resp)
                except Exception as e:
                    log("兜底发送异常：%r" % e)
            if chat_username:
                fail_streak[chat_username] = fail_streak.get(chat_username, 0) + 1
                if fail_streak[chat_username] >= 2:
                    dead_chats.add(chat_username)
                    log("连续发送失败，先停掉这个会话：", chat_display_name)
            log("发送最终失败，请把微信窗口保持在桌面、别最小化；内容：", text[:30])
            return False

    def send_at(member, text, chat_display_name, chat_username=""):
        """在群里真 @ 某个成员（UI 选人），失败返回 False 让调用方退回普通发送。"""
        nonlocal gui
        if not member or not text:
            return False
        if chat_username and (chat_username in dead_chats or not group_is_alive(chat_username)):
            return False
        if AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen():
            with pending_lock:
                pending_replies[chat_username or chat_display_name] = (text, chat_display_name, chat_username, time.time())
            log("你在游戏/全屏程序里，@ 回复先排队：", chat_display_name)
            return True
        with send_lock:
            with gui_lock:
                if gui is None:
                    log("初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）")
                    gui = WeChatGUI()
            try:
                ok = bool(with_window_on_top(lambda: gui.at_member(member, text, who=chat_display_name, verify=False)))
                if ok:
                    log("已 @ %s → %s" % (member, chat_display_name))
                    return True
                log("@ 成员失败（%s），改用普通发送" % member)
            except Exception as e:
                log("@ 成员异常：", repr(e))
        return False

    def _is_collect_allowed(chat_username, sender_id):
        """判断这个会话/发送者发的图要不要收藏。

        规则（按顺序）：
          1. 配置里 collectOnlyFrom 为空 → 全收（旧行为）
          2. 会话 wxid 在白名单 → 收
          3. 发送者 wxid 在白名单 → 收
          4. 否则 → 不收
        """
        if not COLLECT_WHITELIST:
            return True

        candidates = {str(chat_username or ""), str(sender_id or "")}
        for c in candidates:
            if c and c in COLLECT_WHITELIST:
                return True

        return False

    # 收藏用的目录和文件名前缀，图片和表情包共用一套规则。
    # 唯一来源是 media_store.KINDS，下面拿到之后再赋给 COLLECT_KINDS。

    # 素材库存取逻辑已抽到 media_store.py —— 抽出去是为了**能被测试直接调用**。
    # 以前这段嵌在 main() 里，外面调不到，每次改完只能看日志猜，
    # 「动图被查重误杀」那个 bug 就是这么漏过去的。
    from media_store import (
        KINDS as _STORE_KINDS,
        MediaStore as _MediaStore,
        hamming as _hamming_fn,
        perceptual_hash as _perceptual_hash_fn,
    )

    # 目录/前缀的唯一来源是 media_store.KINDS，这里只做个别名
    COLLECT_KINDS = _STORE_KINDS

    _media_store = _MediaStore(
        data_dir=os.path.join(ROOT, "..", "data"),
        phash_path=os.path.join(ROOT, "..", "data", "media-phash.json"),
        log=log,
    )

    def _perceptual_hash(data):
        """dHash 指纹（实现见 media_store.py）。"""
        return _perceptual_hash_fn(data)

    def _hamming(a, b):
        """两个指纹差几位。"""
        return _hamming_fn(a, b)

    def _phash_cache_path():
        return _media_store.phash_path

    def _load_phash():
        return _media_store.load_phash()

    def _save_phash(cache):
        _media_store.save_phash(cache)

    def find_similar_media(data, kind):
        """素材库里有没有「看着一样」的图。有就返回文件名。"""
        return _media_store.find_similar(data, kind)

    def remember_phash(name, data, kind):
        """把新文件的指纹记进缓存。"""
        _media_store.remember(name, data, kind)

    def forget_phash(name):
        """删掉某个文件的指纹记录（文件被替换/删除时用）。"""
        _media_store.forget(name)

    def _drop_stale_index(name):
        """删除旧文件时顺手清掉描述索引里的孤儿条目。"""
        try:
            _idx = load_sticker_index()
            if name in _idx:
                _idx.pop(name, None)
                save_sticker_index(_idx)
        except Exception:                            # noqa: BLE001
            pass

    _media_store.on_forgotten = _drop_stale_index

    def save_media(raw, ext, kind, chat_username, sender_id, note=""):
        """把一份图片数据收进素材库。图片和表情包走同一个入口。

        权限判断留在桥接里（要读主人名单），存取逻辑在 MediaStore。

        @returns 保存的文件名（或已存在的同名文件）；没收藏返回空字符串
        """
        if not MEDIA_COLLECT:
            return ""

        if not _is_collect_allowed(chat_username, sender_id):
            log("%s不收藏（发送者未授权）：%s" % (
                "表情包" if kind == "sticker" else "图片",
                sender_id or "?"))
            return ""

        _media_store.allow = None            # 权限上面已经判过了
        return _media_store.save(raw, ext, kind, chat_username, sender_id, note)


    def describe_image(msg):
        try:
            import base64
            user = msg.get("username") or ""
            lid = msg.get("local_id")
            shard = msg.get("shard")
            if not user or lid is None:
                return ""
            # 先用完整图（原图 > 压缩版），别拿缩略图去识别；两档都没有才退回 best
            path = None
            for _tier in ("full", "best"):
                try:
                    path = _get_media().download_image(user, int(lid), tier=_tier, shard=shard)
                except Exception as _e:
                    log("图片下载失败（tier=%s）：%r" % (_tier, _e))
                    path = None
                if path:
                    log("图片档位：%s → %d KB" % (_tier, os.path.getsize(path) // 1024))
                    break
            if not path:
                log("图片取不到本地文件")
                return ""
            with open(path, "rb") as f:
                raw = f.read()
            if len(raw) > 8 * 1024 * 1024:
                log("图片太大，跳过")
                return ""
            # 关键：按文件头判断真实格式。微信 4.x 的普通图片是 wxgf(HEVC) 容器，
            # 老代码只看扩展名，于是把 wxgf 原样当 image/jpeg 发出去，
            # 视觉接口就回「图片输入格式/解析错误」——表现就是「有时能认、有时不能」。
            #
            # 动图也在这个容器里（一段 HEVC 视频）。所以这里要分成两份：
            #   raw_save  → 存进素材库（动图存 GIF，画面能动）
            #   raw       → 送去识别（用静态帧，又快又稳）
            raw_save = None
            if raw[:4] == b"wxgf":
                # 先试动图；成功就保存 GIF
                gif = wxgf_to_gif(raw)
                if gif:
                    raw_save = gif
                    ext = ".gif"
                    log("wxgf 动图 → GIF（%d KB）" % (len(gif) // 1024))
                else:
                    ext = ".jpg"

                try:
                    conv = _get_media()._wxgf_to_jpg(raw)
                except Exception as _e:
                    conv = None
                    log("wxgf 转码异常：", repr(_e))
                if not conv:
                    log("这张图是 wxgf/HEVC，本机 ffmpeg 没能转出来，跳过（装 ffmpeg 到 C:\\ffmpeg 即可）")
                    return ""
                raw = conv
            elif raw[:8] == b"\x89PNG\r\n\x1a\n":
                ext = ".png"
                raw_save = raw
            elif raw[:3] == b"\xff\xd8\xff":
                ext = ".jpg"
                raw_save = raw
            elif raw[:3] == b"GIF":
                ext = ".gif"
                raw_save = raw
            else:
                ext = os.path.splitext(path)[1].lower()
                if ext not in (".jpg", ".jpeg", ".png", ".gif"):
                    log("图片格式不认识（%s），跳过" % raw[:4])
                    return ""
                raw_save = raw

            if raw_save is None:
                raw_save = raw

            mime = "image/png" if ext == ".png" else ("image/gif" if ext == ".gif" else "image/jpeg")

            # 收藏收到的图片（与表情包共用 save_media，权限规则一致）
            _saved_name = ""
            try:
                _sender = str(msg.get("sender_username") or msg.get("sender_id") or "")
                _saved_name = save_media(raw_save, ext, "image", user, _sender)
            except Exception as _e:                  # noqa: BLE001
                log("图片收藏失败（不影响识别）：%r" % (_e,))

            base = bot_base()

            # 长截图（竖着很长）整张丢给模型，字会被缩糊；切成 2~3 段分别识别再拼起来
            parts = [raw]
            try:
                from PIL import Image
                import io as _io
                img = Image.open(_io.BytesIO(raw))
                img.load()
                w, h = img.size
                if w > 0 and h / float(w) > 2.2 and h > 1200:
                    n = 3 if h / float(w) > 4.0 else 2
                    overlap = int(h * 0.08)
                    parts = []
                    for i in range(n):
                        top = max(0, int(i * h / n) - (overlap if i else 0))
                        bottom = min(h, int((i + 1) * h / n) + overlap)
                        seg = img.crop((0, top, w, bottom)).convert("RGB")
                        buf = _io.BytesIO()
                        seg.save(buf, format="JPEG", quality=88)
                        parts.append(buf.getvalue())
                    log("长截图 %dx%d，切成 %d 段分别识别" % (w, h, len(parts)))
                else:
                    # 普通图：统一转 RGB JPEG 再发，规避 webp/heic 之类的格式坑
                    img2 = img.convert("RGB")
                    buf = _io.BytesIO()
                    img2.save(buf, format="JPEG", quality=88)
                    parts = [buf.getvalue()]
                    mime = "image/jpeg"
            except Exception as _e:
                log("图片预处理跳过（用原图）：", repr(_e))
                parts = [raw]

            texts = []
            for idx, part in enumerate(parts):
                prompt = ""
                if len(parts) > 1:
                    prompt = "这是一张长截图从上往下的第 %d/%d 段。逐条转写这一段里的文字（分清左边对方/右边本人），不要省略。" % (idx + 1, len(parts))
                r = requests.post(
                    base + "/api/vision",
                    json={"image": base64.b64encode(part).decode(), "mime": mime, "prompt": prompt},
                    timeout=120,
                )
                data = r.json()
                piece = str(data.get("text") or "").strip()
                if piece:
                    texts.append(piece)
                if not data.get("ok", True):
                    log("第 %d 段识别失败：%s" % (idx + 1, data.get("error")))
            text = "\n".join(texts).strip()
            if len(text) > 1200:
                text = text[:1200] + "…"
            log("图片识别：", text[:80])

            # 告诉她这张图存到哪了，这样对方说「收藏这张」「做成表情包」时她能照做
            if _saved_name:
                text += "\n[system] 这张图已自动存入素材库，文件名 %s（kind=images）" % _saved_name

            return text
        except Exception as e:
            log("图片识别失败：", repr(e))
            # 就算识别失败，如果图已收藏也要告诉她
            try:
                if _saved_name:
                    return "[system] 这张图看不清内容，但已存入素材库，文件名 %s（kind=images）" % _saved_name
            except Exception:
                pass
            return ""

    def _extract_voice_from_db(local_id):
        """兜底：直接从 media_*.db 的 VoiceInfo 表取 SILK 并解码成 WAV。

        download_voice 正常时用不上这条路径；但实测它偶尔返回 None，
        而表里其实有数据 —— 这时手工取一份，别让语音白白丢掉。
        """
        import io as _io
        import wave as _wave

        raw = None
        for rel, dbpath, _ in db._db_files:
            if not os.path.basename(dbpath).startswith("media_"):
                continue
            try:
                conn = db._open(rel)
                row = conn.execute(
                    "SELECT voice_data FROM VoiceInfo WHERE local_id=?", (local_id,)
                ).fetchone()
                if row and row[0]:
                    raw = row[0]
                    break
            except Exception:
                continue

        if not raw:
            return ""

        try:
            import pysilk
        except Exception:
            log("缺少 pysilk，装一下：pip install silk-python")
            return ""

        pcm = _io.BytesIO()
        pysilk.decode(_io.BytesIO(raw), pcm, VOICE_SAMPLE_RATE)
        data = pcm.getvalue()
        if not data:
            return ""

        out_dir = os.path.join(ROOT, "data", "media-cache")
        os.makedirs(out_dir, exist_ok=True)
        out = os.path.join(out_dir, "voice_%d.wav" % local_id)
        with _wave.open(out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(VOICE_SAMPLE_RATE)
            w.writeframes(data)

        return out

    def transcribe_voice(msg):
        """语音消息 → 文字；失败返回空串。"""
        if not VOICE_ENABLED:
            log("语音识别已关闭（voice.enabled=false）")
            return ""
        try:
            import base64
            import io
            import wave
            user = msg.get("username") or ""
            lid = msg.get("local_id")
            shard = msg.get("shard")
            if not user or lid is None:
                log("[语音] 缺字段：user=%r local_id=%r" % (user, lid))
                return ""

            _md = _get_media()
            log("[语音] 尝试下载：user=%r local_id=%r shard=%r" % (user, lid, shard))

            path = None
            try:
                path = _md.download_voice(user, int(lid), shard=shard)
            except Exception as _de:
                log("[语音] 带 shard 下载异常：%r，改不带 shard 重试" % (_de,))
                try:
                    path = _md.download_voice(user, int(lid))
                except Exception as _de2:
                    log("[语音] 不带 shard 也失败：%r" % (_de2,))

            if not path:
                # 用官方诊断接口问清楚原因
                try:
                    st = _md.voice_status(user, int(lid))
                    log("[语音] 状态：%r" % (st,))
                except Exception as _se:
                    log("[语音] voice_status 也失败：%r" % (_se,))

                # 兜底：直接从 media_*.db 的 VoiceInfo 表取 SILK 二进制。
                # 实测 download_voice 偶尔拿不到、但表里明明有数据。
                try:
                    path = _extract_voice_from_db(int(lid))
                    if path:
                        log("[语音] 兜底从 VoiceInfo 取到了：%s" % path)
                except Exception as _be:
                    log("[语音] 兜底提取失败：%r" % (_be,))

            if not path:
                log("语音没落盘（这条微信没缓存到本地），跳过")
                return ""

            # 兜底路径已经产出 WAV，不需要再解码
            if path.lower().endswith(".wav"):
                wav_path = path
                try:
                    with wave.open(wav_path, "rb") as _w:
                        frames = _w.getnframes()
                        rate = _w.getframerate()
                        seconds = frames / float(rate) if rate else 0
                except Exception:
                    seconds = 0
                log("[语音] 用兜底 WAV：%s（%.1fs）" % (wav_path, seconds))
                if seconds and seconds < 0.3:
                    log("语音太短（%.1fs），跳过" % seconds)
                    return ""
            else:
                try:
                    import pysilk
                except Exception:
                    log("缺少 pysilk，装一下：pip install silk-python")
                    return ""
                pcm = io.BytesIO()
                with open(path, "rb") as f:
                    pysilk.decode(f, pcm, VOICE_SAMPLE_RATE)
                raw = pcm.getvalue()
                seconds = len(raw) / float(VOICE_SAMPLE_RATE * 2)
                if seconds < 0.3:
                    log("语音太短（%.1fs），跳过" % seconds)
                    return ""
                if seconds > VOICE_MAX_SECONDS:
                    log("语音太长（%.0fs > %.0fs），跳过" % (seconds, VOICE_MAX_SECONDS))
                    return ""
                wav_path = os.path.splitext(path)[0] + ".wav"
                with wave.open(wav_path, "wb") as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(VOICE_SAMPLE_RATE)
                    w.writeframes(raw)

            # 统一走鲸鲸的 /api/voice：
            # 桥接不自己对接各家 ASR 接口，只需在控制台配一处 Key。
            with open(wav_path, "rb") as f:
                _audio_b64 = base64.b64encode(f.read()).decode()

            import requests as _rq
            _resp = _rq.post(
                bot_base() + "/api/voice",
                json={"audio": _audio_b64, "mime": "audio/wav"},
                timeout=VOICE_TIMEOUT,
            )
            _json = _resp.json() if _resp.ok else {}
            text = str(_json.get("text") or "")

            if not text and _json.get("error"):
                log("语音识别没结果：%s" % _json.get("error"))

            text = clean_transcript(text)
            log("语音识别（%.1fs）：%s" % (seconds, text[:60] or "（空）"))
            return text
        except Exception as e:
            log("语音识别失败：", repr(e))
            return ""

    def _account_root():
        try:
            for rel, path, _ in db._db_files:
                if os.path.basename(path).startswith("message_"):
                    p = os.path.dirname(path)
                    while p and not os.path.basename(p).startswith(("wxid", "all_users")):
                        parent = os.path.dirname(p)
                        if parent == p:
                            break
                        p = parent
                    return p
        except Exception:
            pass
        return ""

    def _find_sticker_file(md5):
        root = _account_root()
        if not root or not md5:
            return ""
        roots = [os.path.join(root, "cache"), os.path.join(root, "msg", "attach")]
        for base in roots:
            for dirpath, _dirs, files in os.walk(base):
                for name in files:
                    if md5 in name:
                        return os.path.join(dirpath, name)
        return ""

    def _sticker_label(content):
        """从表情 XML 的 desc（base64 protobuf）里提取表情名，比如「鲸鱼娘」"""
        try:
            import base64
            import re
            m = re.search(r'desc\s*=\s*"([^"]*)"', content or "")
            if not m:
                return ""
            raw = base64.b64decode(m.group(1))
            txt = raw.decode("utf-8", "ignore")
            parts = [x for x in re.findall(r"[\u4e00-\u9fa5A-Za-z0-9_]{2,}", txt) if x.lower() != "default"]
            return " ".join(parts[:3])
        except Exception:
            return ""

    def screen_scale():
        """算出「逻辑坐标 → 物理像素」的比例。

        为什么要这一步：
           本机 DPI 是 150%。没声明 DPI 感知的进程里，GetWindowRect 返回
           逻辑坐标（微信 880x600），但 ImageGrab 按物理像素截屏（2560x1600）。
           直接拿逻辑坐标去截，会截到偏左上角的一大块区域 ——
           实测截出来是「终端 + 会话列表」，表情包根本不在里面。
        """
        try:
            import ctypes

            user32 = ctypes.windll.user32
            logical_w = user32.GetSystemMetrics(0)

            # 全屏截一张，宽度就是物理分辨率
            from PIL import ImageGrab

            probe = ImageGrab.grab()
            phys_w = probe.width

            if logical_w > 0 and phys_w > 0:
                s = phys_w / float(logical_w)
                # 只接受常见的整数倍，避免读错时算出离谱的值
                if 0.9 < s < 4.0:
                    return s
        except Exception as e:
            log("取 DPI 比例失败：", repr(e))
        return 1.0

    def grab_weixin_window(hwnd):
        """把微信提到前台并截取它的窗口区域。

        为什么不用 PrintWindow：
           微信 4.x 是 Qt + GPU 渲染，PrintWindow 全部返回全黑
           （实测 flag=0/1/2 都是 0，亮度范围 (0,0)）。只能真正截屏。

        为什么要验证前台：
           原来直接 ImageGrab 屏幕坐标，微信没在最前面时截到的是别的应用
           （实测截到过日历、手机桌面），视觉模型自然认不出表情包。
           这里截之前确认「前台窗口就是微信」，不是就放弃，宁可不识别也不编。

        为什么全程持有 gui_lock：
           抢前台 = 把微信窗口的焦点抢过来。如果这时候正好有人在发图
           （发送走剪贴板粘贴，依赖微信窗口的输入焦点），图就发不出去 ——
           用户看到的现象是「收到表情包之后，她就不发图了」。
           发送那边全程持锁，这里也持同一把锁，两边就不会撞上。
        """
        import win32gui
        import win32con
        from PIL import ImageGrab

        with gui_lock:
            return _grab_weixin_window_locked(hwnd)

    def _grab_weixin_window_locked(hwnd):
        """grab_weixin_window 的实际实现（调用方必须已持有 gui_lock）。"""
        import win32gui
        import win32con
        from PIL import ImageGrab

        # 1. 最小化了就先还原
        try:
            if win32gui.IsIconic(hwnd):
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                time.sleep(0.5)
        except Exception:
            pass

        # 2. 想办法提到前台（单一手段在 Windows 上经常被拒，多试几种）
        try:
            win32gui.BringWindowToTop(hwnd)
        except Exception:
            pass
        try:
            force_foreground(hwnd)
        except Exception:
            pass
        try:
            # 模拟一次 Alt 键，绕开「非前台进程不能 SetForegroundWindow」的限制
            import ctypes
            ctypes.windll.user32.keybd_event(0x12, 0, 0, 0)
            ctypes.windll.user32.SetForegroundWindow(hwnd)
            ctypes.windll.user32.keybd_event(0x12, 0, 2, 0)
        except Exception:
            pass

        time.sleep(0.45)

        # 3. 验证：前台窗口得是微信本身或它的子窗口
        try:
            fg = win32gui.GetForegroundWindow()
            fg_root = fg
            for _ in range(4):
                parent = win32gui.GetParent(fg_root)
                if not parent:
                    break
                fg_root = parent
            if fg_root != hwnd and fg != hwnd:
                log("表情包截图跳过：微信不在前台（前台是 %r）" % win32gui.GetWindowText(fg)[:20])
                return None
        except Exception:
            pass

        # 4. 截窗口所在区域（逻辑坐标按 DPI 比例换算成物理像素）
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        if right - left <= 0 or bottom - top <= 0:
            return None

        scale = screen_scale()
        box = (
            int(round(left * scale)),
            int(round(top * scale)),
            int(round(right * scale)),
            int(round(bottom * scale)),
        )

        img = ImageGrab.grab(bbox=box)

        # 5. 全黑/全白说明没截到东西
        extrema = img.convert("L").getextrema()
        if extrema[1] - extrema[0] < 8:
            log("表情包截图跳过：截到的是纯色（窗口可能刚切过去还没画完）")
            return None

        return img

    def decrypt_emoticon(raw):
        """试着把微信 4.x 的表情缓存明文解出来。

        背景：cache/<日期>/Emoticon/<xx>/<md5> 存的是加密数据，没有 .dat 容器。
        文件长度通常是 16 的倍数，看起来像整块 AES-ECB。

        密钥复用图片那套（MediaDownloader 会从内存/cfgDword 里取）。
        拿不到密钥就返回 None，调用方走别的兜底 —— 不抛错、不编造。

        @returns 解密后的图片字节，或 None
        """
        if not raw or len(raw) < 32:
            return None

        # 已经是明文就不用解了
        if raw[:3] == b"\xff\xd8\xff" or raw[:8] == b"\x89PNG\r\n\x1a\n":
            return raw
        if raw[:3] == b"GIF" or raw[:4] == b"RIFF":
            return raw

        try:
            md = _get_media()
            key = md._resolve_aes_key()
        except Exception:
            key = None

        if not key:
            return None

        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        except Exception:
            return None

        def looks_like_image(b):
            if not b or len(b) < 16:
                return False
            return (
                b[:3] == b"\xff\xd8\xff"
                or b[:8] == b"\x89PNG\r\n\x1a\n"
                or b[:3] == b"GIF"
                or b[:4] == b"RIFF"
                or b[:4] == b"wxgf"
            )

        try:
            cipher_key = key.encode() if isinstance(key, str) else key
            if len(cipher_key) not in (16, 24, 32):
                return None

            # 试几个常见偏移：整块 / 跳过 13、15、16 字节
            for off in (0, 13, 15, 16):
                body = raw[off:]
                body = body[: len(body) // 16 * 16]
                if len(body) < 32:
                    continue
                try:
                    dec = Cipher(algorithms.AES(cipher_key), modes.ECB()).decryptor()
                    plain = dec.update(body) + dec.finalize()
                except Exception:
                    continue

                if not looks_like_image(plain):
                    continue

                # wxgf 还得再转一层
                if plain[:4] == b"wxgf":
                    try:
                        conv = md._wxgf_to_jpg(plain)
                        if conv:
                            return conv
                    except Exception:
                        pass
                    continue

                return plain
        except Exception as e:                    # noqa: BLE001
            log("表情包解密异常：", repr(e))

        return None

    def locate_sticker_rect(who):
        """用 UIA 找到「动画表情」消息的精确屏幕坐标。

        为什么用它而不是自己算百分比：
           微信界面布局随窗口大小、会话列表宽度、输入框高度变化，
           写死 28%/42% 这种比例必然截偏 —— 实测截到过侧边栏、日历、终端。
           wechatauto 的 UIA 驱动能拿到消息行的 BoundingRectangle，
           是真正的「直接定位」。

        @returns (rect, is_self) 或 None
        """
        try:
            from PIL import Image  # noqa: F401

            if gui is None:
                return None

            eng = None
            try:
                eng = UIA_CACHE.get("u") or gui._get_uia()
            except Exception as e:              # noqa: BLE001
                log("表情包定位：拿不到 UIA 引擎", repr(e))
                return None

            if eng is None or not eng.ensure_window():
                log("表情包定位：微信窗口没准备好")
                return None

            try:
                cur = eng.current_chat()
            except Exception:
                cur = None

            if who and cur != who:
                try:
                    eng.open_chat(who)
                    time.sleep(0.6)
                except Exception as e:          # noqa: BLE001
                    log("表情包定位：打开会话失败", repr(e))

            found = eng.find_in_message_list(
                lambda cn, nm: (
                    nm == "动画表情"
                    or (cn == "mmui::ChatBubbleItemView" and "[动画表情" in str(nm))
                ),
                match_last=True,
                max_scrolls=40,
            )

            if not found:
                log("表情包定位：消息列表里没找到「动画表情」控件")
                return None

            cn, nm, rect = found
            log("表情包定位：%s %r → (%d,%d)-(%d,%d)" % (
                cn, str(nm)[:20],
                rect.left, rect.top, rect.right, rect.bottom))

            return (rect.left, rect.top, rect.right, rect.bottom)
        except Exception as e:                  # noqa: BLE001
            log("表情包定位异常：", repr(e))
            return None

    def capture_sticker_frames(who, count=8, interval=0.12):
        """连续截同一块区域，用来还原动图表情。

        为什么需要这个：
           动图表情（动画表情）在微信本地是**加密缓存**，解不开；
           走截图兜底时只截一帧 —— 存进素材库就是一张不动的图，
           发出去也不动。用户看到的就是「动图收录不了」。

           微信在界面上是实时播放的，所以对着同一个矩形连续截几帧，
           用 PIL 合成 GIF 就能把动画「录」下来。帧率不高，但确实是动的。

        @returns (静帧PNG字节, 动图GIF字节) —— GIF 失败时第二项为空
        """
        rect = locate_sticker_rect(who)
        if not rect:
            return b"", b""

        left, top, right, bottom = rect
        if right - left < 20 or bottom - top < 20:
            log("表情包截图：定位到的区域太小 (%dx%d)" % (right - left, bottom - top))
            return b"", b""

        from PIL import Image

        frames = []

        for i in range(max(2, count)):
            try:
                with gui_lock:
                    shot = gui._grab_screen(rect)
                    # 截完立刻松手，别把锁占太久（发送那边要用）
            except Exception as e:              # noqa: BLE001
                log("表情包连拍失败：", repr(e))
                break

            if shot is None:
                break

            # 裁掉消息行两侧的头像和空白
            try:
                from wechatauto.msgs.mtype import EmojiMessage

                cropped = EmojiMessage._content_bbox_crop(shot)
                if cropped is not None and min(cropped.size) >= 50:
                    shot = cropped
            except Exception:
                pass

            frames.append(shot)
            if i < count - 1:
                time.sleep(interval)

        if not frames:
            return b"", b""

        # 第一帧当静帧（给视觉模型用）
        first = frames[0]
        if min(first.size) < 220:
            scale = min(4, max(2, int(220 / max(1, min(first.size)))))
            first = first.resize((first.width * scale, first.height * scale), 1)

        import io

        static_buf = io.BytesIO()
        first.save(static_buf, "PNG")
        static = static_buf.getvalue()

        # 只有一帧就没必要做 GIF
        if len(frames) < 3:
            return static, b""

        # 合成动图：统一尺寸 + 调色板量化
        try:
            w, h = frames[0].size
            norm = []
            for f in frames:
                if f.size != (w, h):
                    f = f.resize((w, h), 1)
                norm.append(f.convert("RGB"))

            # 小图放大一点，看起来别那么糊
            if min(w, h) < 160:
                s = min(3, max(2, int(160 / max(1, min(w, h)))))
                norm = [f.resize((w * s, h * s), 1) for f in norm]

            # 量化到 128 色，控制体积
            pal = [f.quantize(colors=128, method=Image.MEDIANCUT) for f in norm]

            gif_buf = io.BytesIO()
            pal[0].save(
                gif_buf,
                format="GIF",
                save_all=True,
                append_images=pal[1:],
                duration=int(interval * 1000),
                loop=0,
                optimize=True,
            )
            gif = gif_buf.getvalue()

            if len(gif) < 1024 or gif[:3] != b"GIF":
                return static, b""

            # 太大就放弃动图，退回静帧
            if len(gif) > 3 * 1024 * 1024:
                log("表情包动图太大（%d KB），只存静帧" % (len(gif) // 1024))
                return static, b""

            log("表情包连拍：%d 帧 → GIF %d KB" % (len(frames), len(gif) // 1024))

            try:
                dbg = os.path.join(ROOT, "..", "data", "last-sticker-shot.gif")
                with open(dbg, "wb") as f:
                    f.write(gif)
            except Exception:
                pass

            return static, gif
        except Exception as e:                  # noqa: BLE001
            log("表情包合成动图失败：", repr(e))
            return static, b""

    def capture_sticker(who):
        """按 UIA 定位到的坐标截取表情包本身，返回图片字节。

        比整块消息区截图强的地方：只截那一行，表情包占满画面，
        视觉模型看得清楚；也不会把上面的历史消息混进来。
        """
        static, _gif = capture_sticker_frames(who, count=1)
        return static

    def screenshot_sticker(who):
        """表情包兜底：优先 UIA 精确定位 + 连拍，失败才退回整块消息区截图。

        @returns (描述文字, 图片字节, 动图字节)
                 动图字节为空表示只有静帧
        """
        try:
            import io
            import base64

            # 1. 优先：UIA 精确定位，并且**连拍几帧**还原动画
            data, anim = capture_sticker_frames(who, count=8, interval=0.12)

            # 2. 退回：整块消息区截图（比例裁剪，精度差但聊胜于无）
            if not data:
                log("表情包：UIA 定位没成功，退回消息区截图")
                img = grab_weixin_window(find_weixin_hwnd())
                if img is None:
                    return "", b"", b""

                w, h = img.size
                img = img.crop(
                    (int(w * 0.35), int(h * 0.09), w, int(h * 0.44))
                )
                img = img.resize((int(img.width * 1.3), int(img.height * 1.3)), 1)

                buf = io.BytesIO()
                img.save(buf, "JPEG", quality=90)
                data = buf.getvalue()

                try:
                    dbg = os.path.join(ROOT, "..", "data", "last-sticker-shot.jpg")
                    with open(dbg, "wb") as f:
                        f.write(data)
                except Exception:
                    pass

            base = bot_base()
            resp = requests.post(
                base + "/api/vision",
                json={
                    "image": base64.b64encode(data).decode(),
                    "mime": "image/jpeg",
                    "prompt": (
                        "这是微信表情包/图片的消息区域截图，画面主体就是那个表情包。\n"
                        "描述画面内容：人物或动物是什么、什么表情、什么颜色、什么风格、"
                        "画面里有没有文字（有就照抄）。\n"
                        "如果确实看不清，只回答「看不清」。不要罗列历史消息。"
                    ),
                },
                timeout=60,
            )
            text = str(resp.json().get("text") or "").strip()
            log("表情包识别：", text[:50])
            if "看不清" in text or "模糊" in text:
                return "", data, anim
            return text, data, anim
        except Exception as e:
            log("表情包截图识别失败：", repr(e))
            return "", b"", b""

    def sticker_index_path():
        return os.path.join(ROOT, "..", "data", "stickers", "index.json")

    def load_sticker_index():
        """读表情包描述索引：{文件名: {desc, tags, addedAt}}"""
        try:
            with open(sticker_index_path(), "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def save_sticker_index(index):
        try:
            p = sticker_index_path()
            os.makedirs(os.path.dirname(p), exist_ok=True)
            tmp = p + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(index, f, ensure_ascii=False, indent=2)
            os.replace(tmp, p)
        except Exception as e:                       # noqa: BLE001
            log("表情包索引保存失败：", repr(e))

    # 情绪 → 用来匹配表情包描述的关键词
    EMOJI_TAGS = {
        "开心": ["开心", "高兴", "笑", "哈哈", "快乐", "兴奋", "棒", "好耶", "赞", "喜欢"],
        "难过": ["难过", "伤心", "哭", "委屈", "失落", "郁闷"],
        "生气": ["生气", "愤怒", "气", "怒", "火大", "不爽"],
        "惊讶": ["惊讶", "震惊", "吃惊", "哇", "竟然", "没想到"],
        "无语": ["无语", "无奈", "服了", "算了", "离谱", "沉默"],
        "害羞": ["害羞", "脸红", "不好意思", "羞", "撒娇"],
        "困倦": ["困", "累", "睡", "疲惫", "打哈欠", "晚安"],
        "得意": ["得意", "骄傲", "炫", "厉害", "牛", "哼"],
        "安慰": ["安慰", "抱抱", "摸头", "别难过", "没事"],
        "吃饭": ["吃", "饭", "饿", "美食", "馋"],
    }

    def index_sticker(filename, desc):
        """把一次识别结果记进索引，以后按语境挑图时用。"""
        if not filename or not desc:
            return
        try:
            index = load_sticker_index()
            tags = []
            for tag, words in EMOJI_TAGS.items():
                if any(w in desc for w in words):
                    tags.append(tag)
            index[filename] = {
                "desc": str(desc)[:200],
                "tags": tags,
                "addedAt": int(time.time()),
                "source": "auto",
            }
            save_sticker_index(index)
            log("表情包索引：%s → [%s] %s" % (
                filename, ",".join(tags) or "无标签", str(desc)[:30]))
        except Exception as e:                       # noqa: BLE001
            log("表情包索引写入失败：", repr(e))

    def index_missing_stickers(limit=20):
        """给还没描述的素材补生成描述 —— 她自己维护索引。

        触发时机：启动后一次、收到新图后顺带补几张。
        """
        try:
            base = os.path.join(ROOT, "..", "data")
            index = load_sticker_index()
            todo = []

            for sub in ("stickers", "images", "generated"):
                d = os.path.join(base, sub)
                if not os.path.isdir(d):
                    continue
                for n in os.listdir(d):
                    if not n.lower().endswith((".gif", ".png", ".jpg", ".jpeg", ".webp")):
                        continue
                    if n in index and index[n].get("desc"):
                        continue
                    p = os.path.join(d, n)
                    if os.path.isfile(p) and os.path.getsize(p) > 512:
                        todo.append((n, p))

            if not todo:
                log("表情包索引：所有素材都已有描述，跳过")
                return 0

            log("表情包索引：%d 张还没描述，开始补…" % len(todo))

            import base64

            done = 0
            for n, p in todo[:limit]:
                try:
                    with open(p, "rb") as f:
                        raw = f.read()

                    ext = os.path.splitext(n)[1].lower()
                    mime = ("image/png" if ext == ".png"
                            else "image/gif" if ext == ".gif" else "image/jpeg")

                    r = requests.post(
                        bot_base() + "/api/vision",
                        json={
                            "image": base64.b64encode(raw).decode(),
                            "mime": mime,
                            "prompt": (
                                "描述这张表情包：画面里是什么（人物/动物/物体）、"
                                "什么表情、什么颜色、有没有文字。"
                                "用一句话说清楚，不超过 30 字。"
                            ),
                        },
                        timeout=60,
                    )
                    desc = str(r.json().get("text") or "").strip()
                    if not desc or "看不清" in desc:
                        continue

                    index_sticker(n, desc)
                    done += 1
                    time.sleep(0.3)
                except Exception as e:       # noqa: BLE001
                    log("补描述失败 %s：%r" % (n, e))

            log("表情包索引：补完 %d 张" % done)
            return done
        except Exception as e:               # noqa: BLE001
            log("补描述任务异常：", repr(e))
            return 0

    def pick_sticker_by_text(text, pool):
        """按当前回复的语气挑一张最贴的表情包。

        以前是纯随机 —— 说到难过也可能甩一张大笑的图，这就是
        「以图代文」一直很弱的原因。现在先按情绪匹配，匹配不上才随机。

        @returns 文件路径，挑不到返回空字符串
        """
        if not pool:
            return ""

        import random as _rnd

        try:
            index = load_sticker_index()
            if not index:
                return _rnd.choice(pool)

            # 这段话里出现了哪些情绪
            wanted = set()
            for tag, words in EMOJI_TAGS.items():
                if any(w in text for w in words):
                    wanted.add(tag)

            if not wanted:
                return _rnd.choice(pool)

            # 找标签命中的，命中越多越优先
            scored = []
            for p in pool:
                meta = index.get(os.path.basename(p))
                if not meta:
                    continue
                hit = len(wanted & set(meta.get("tags") or []))
                if hit:
                    scored.append((hit, p))

            if scored:
                scored.sort(key=lambda x: -x[0])
                best = scored[0][0]
                top = [p for s, p in scored if s == best]
                picked = _rnd.choice(top)
                log("表情包按语境选中：%s（匹配 %d 个情绪）" % (
                    os.path.basename(picked), best))
                return picked

            return _rnd.choice(pool)
        except Exception as e:                       # noqa: BLE001
            log("表情包语境选择失败，退随机：", repr(e))
            return _rnd.choice(pool)

    def sticker_pool():
        """素材库里所有能当表情包发的图（不只是 stickers 目录）。

        为什么要合并三个目录：
          收到的图、她画的图，视觉效果和表情包没区别，
          只从 stickers 挑会让「素材库明明有图却发不出来」。
        """
        base = os.path.join(ROOT, "..", "data")
        pool = []
        # 顺序即优先级（stickers 是正牌表情包，排前面）
        for sub in ("stickers", "generated", "images"):
            d = os.path.join(base, sub)
            if not os.path.isdir(d):
                continue
            for n in os.listdir(d):
                if not n.lower().endswith((".gif", ".png", ".jpg", ".jpeg", ".webp")):
                    continue
                p = os.path.join(d, n)
                if os.path.isfile(p) and os.path.getsize(p) > 256:
                    pool.append(p)
        return pool

    def send_sticker(chat_display_name, chat_username="", specific_path=None, context=""):
        """发一个表情包（从素材库挑，或发指定的那张）。

        微信不能发「动作表情」（加密专有格式），但能发 GIF/图片 ——
        gui.send_image 走剪贴板粘贴，微信会当成图片消息插入，视觉效果一样。

        specific_path: 指定要发的文件路径**或文件名**（她画了图想发出去时用）
        context: 刚才的回复内容。有它就能按语气挑图，而不是纯随机。
        """
        nonlocal gui
        try:
            import random as _rnd

            if specific_path:
                path = specific_path

                # 传进来的是文件名而不是绝对路径 → 在素材库里找
                if not os.path.isfile(path):
                    path = resolve_media_path(path) or path

                if not os.path.isfile(path):
                    log("要发的图不存在：%s" % specific_path)
                    return False
            else:
                files = sticker_pool()
                if not files:
                    log("素材库里没有任何图可发")
                    return False

                # 按回复的语气挑，匹配不上才随机
                path = pick_sticker_by_text(context, files) or _rnd.choice(files)

            # 和 send_text 一样，用 gui 对象发送（统一走剪贴板粘贴路线）
            if gui is None:
                gui = WeChatGUI()

            is_gif = str(path).lower().endswith(".gif")

            def _do_send(p):
                # GIF 要校验：微信有可能不把它当图片，而是当**文件**发出去
                # （聊天里是个文件卡片，动画就没了）。verify=True 会查数据库，
                # 只有真出现了一条「图片」消息才算成功。
                try:
                    return gui.send_image(p, chat_display_name, verify=is_gif)
                except TypeError:
                    # 老版本没有 verify 参数
                    return gui.send_image(p, chat_display_name)
                except Exception as e:               # noqa: BLE001
                    log("send_image 异常，回退 send_file：", repr(e))
                    return gui.send_file(p, chat_display_name)

            r = _do_send(path)
            ok = bool(r and r.get("status") == "成功")

            # GIF 没被当成图片 → 压小再试一次
            if not ok and is_gif:
                log("GIF 没按图片发出（%s），压缩后重试" % (
                    (r or {}).get("message") or "无返回"))
                small = shrink_gif(path)
                if small and small != path:
                    try:
                        r = _do_send(small)
                        ok = bool(r and r.get("status") == "成功")
                    finally:
                        if small != path:
                            try:
                                os.remove(small)
                            except OSError:
                                pass

            # 还是不行 → 发静帧（至少是张图，不是乱飞的文件卡片）
            if not ok and is_gif:
                try:
                    from PIL import Image

                    still = os.path.join(os.path.dirname(path), "_still_" + os.path.splitext(os.path.basename(path))[0] + ".png")
                    Image.open(path).convert("RGB").save(still, "PNG")
                    log("动图发不出去，改发静帧")
                    r = _do_send(still)
                    ok = bool(r and r.get("status") == "成功")
                    try:
                        os.remove(still)
                    except OSError:
                        pass
                except Exception as e:               # noqa: BLE001
                    log("静帧兜底也失败：", repr(e))

            if ok:
                log("发送表情包 → %s：%s%s" % (
                    chat_display_name, os.path.basename(path), "（动图）" if is_gif else ""))
            else:
                log("表情包没发出去 → %s：%s" % (
                    chat_display_name, (r or {}).get("message") or "无返回"))
            return ok
        except Exception as e:                       # noqa: BLE001
            log("发表情包失败：", repr(e))
            return False

    def resolve_media_path(name):
        """把回复里给的文件名解析成绝对路径。

        依次在这些目录里找：generated（她画的）、stickers、images。
        """
        safe = os.path.basename(str(name or "").strip())
        if not safe:
            return ""

        base = os.path.join(ROOT, "..", "data")
        for sub in ("generated", "stickers", "images"):
            p = os.path.join(base, sub, safe)
            if os.path.isfile(p):
                return p
        return ""

    def describe_sticker(msg):
        """表情包：缓存能解就解，解不开就 UIA 定位截图，最后统一收藏。"""
        try:
            import base64
            import re
            import subprocess

            content = str(msg.get("content") or "")
            who = display_name(msg.get("username") or "")
            sender = str(msg.get("sender_username") or msg.get("sender_id") or "")
            chat_user = msg.get("username") or ""

            # 收藏：不管走哪条路拿到图，都进素材库。
            # 之前只有「缓存解密成功」才收藏，截图路线拿到的图白扔了。
            def collect(data, suffix=".jpg", desc=""):
                if not data:
                    return
                try:
                    name = save_media(data, suffix, "sticker", chat_user, sender)
                    # 把识别结果记进索引，以后能按语气挑图
                    if name and desc:
                        index_sticker(name, desc)
                except Exception as e:            # noqa: BLE001
                    log("表情包收藏失败（不影响识别）：%r" % (e,))

            m = re.search(r'md5="([0-9a-fA-F]{32})"', content)
            md5 = m.group(1).lower() if m else ""

            if not md5:
                log("表情包：XML 里没有 md5 → 只能截图")
                text, data, anim = screenshot_sticker(who)
                # 有动图就存 GIF（素材库和发出去都动）
                if anim:
                    collect(anim, ".gif", text)
                else:
                    collect(data, ".png" if data[:4] == b"\x89PNG" else ".jpg", text)
                return text or _sticker_label(content)

            path = _find_sticker_file(md5)
            if not path:
                log("表情包：本地缓存里找不到 md5=%s → 只能截图" % md5[:12])
                text, data, anim = screenshot_sticker(who)
                if anim:
                    collect(anim, ".gif", text)
                else:
                    collect(data, ".png" if data[:4] == b"\x89PNG" else ".jpg", text)
                if text:
                    return text
                return _sticker_label(content)

            log("表情包：找到缓存文件 %s（%d 字节）" % (
                os.path.basename(path), os.path.getsize(path)))

            with open(path, "rb") as f:
                raw = f.read()
            jpg = None
            # 动图原件（GIF 字节）。有它就优先按动图保存，别压成静态图
            anim = None

            if raw[:4] == b"wxgf":
                # 微信 4.x 的动图表情是 wxgf 里的 HEVC 视频。
                # 先试转成动画 GIF（素材库能动能发），失败再退回静态帧。
                anim = wxgf_to_gif(raw)
                if anim:
                    log("表情包 wxgf → 动图 GIF（%d KB）" % (len(anim) // 1024))
                jpg = _get_media()._wxgf_to_jpg(raw)
            elif raw[:3] == b"\xff\xd8\xff" or raw[:8] == b"\x89PNG\r\n\x1a\n":
                jpg = raw
            elif raw[:3] == b"GIF":
                anim = raw
                jpg = raw
            else:
                # 微信 4.x 的表情缓存是加密的（没有 .dat 容器，纯密文）。
                # 试着用图片的 AES 密钥解一份 —— 桥接以管理员跑，密钥可能拿得到。
                try:
                    jpg = decrypt_emoticon(raw)
                    if jpg:
                        log("表情包用 AES 解出来了（%d 字节）" % len(jpg))
                        if jpg[:3] == b"GIF":
                            anim = jpg
                    else:
                        log("表情包：缓存是加密的，拿不到密钥（%s…）" % raw[:4].hex())
                except Exception as e:                # noqa: BLE001
                    log("表情包 AES 解密不可用：", repr(e))

            if not jpg:
                try:
                    import shutil as _sh
                    exe = _sh.which("ffmpeg")
                    if not exe:
                        exe = _get_media()._ffmpeg_exe()
                    if exe:
                        # 先试着整段转动图；不行再取一帧
                        try:
                            with open(path, "rb") as _f:
                                _probe = _f.read(4)
                        except Exception:
                            _probe = b""

                        if _probe[:4] == b"wxgf":
                            anim = wxgf_to_gif(open(path, "rb").read())

                        out = path + ".jpg"
                        subprocess.run([exe, "-y", "-i", path, "-frames:v", "1", out],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
                        if os.path.exists(out):
                            with open(out, "rb") as f:
                                jpg = f.read()
                    else:
                        log("表情包转码跳过：没找到 ffmpeg（装到 C:\\ffmpeg 即可）")
                except Exception as e:                # noqa: BLE001
                    log("表情包转码失败：", repr(e))
            if not jpg:
                log("表情包：缓存解不开，改用截图兜底")
                text, data, anim = screenshot_sticker(who)
                if anim:
                    collect(anim, ".gif", text)
                else:
                    collect(data, ".png" if data[:4] == b"\x89PNG" else ".jpg", text)
                if text:
                    return text
                log("表情包：截图也没拿到内容，告诉她看不清")
                return _sticker_label(content)
            # 识别用静态帧（GIF 直接丢给视觉接口多数只取第一帧，还更慢）
            mime = "image/png" if jpg[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"

            base = bot_base()
            r = requests.post(base + "/api/vision",
                              json={"image": base64.b64encode(jpg).decode(), "mime": mime}, timeout=60)
            text = str(r.json().get("text") or "").strip()
            log("表情包识别：", text[:40])

            # 收藏到统一素材库：有动图就存 GIF（这样素材库预览和发出去都是动的），
            # 没有动图才存静态图。
            if anim:
                collect(anim, ".gif", text)
            else:
                collect(jpg, ".png" if "png" in mime else ".jpg", text)
            return text
        except Exception as e:
            log("表情包识别异常：", repr(e))
            return _sticker_label(str(msg.get("content") or ""))

    def on_message_inner(msg, listener):
        try:
            username = msg.get("username") or ""
            if not username:
                return
            mtype = msg.get("type") or ""
            content = (msg.get("content") or "").strip()
            if mtype == "图片":
                desc = describe_image(msg)
                if not desc:
                    # 识别失败（内容审查 / 格式不支持）也要回一句，
                    # 否则用户会以为她收到图装没看见。
                    content = "（对方发了一张图片，但你这会儿看不清图里是什么。诚实地告诉对方看不清，别编内容。）"
                else:
                    content = "（对方发了一张图片，图里是：%s）" % desc
            if mtype == "语音":
                said = transcribe_voice(msg)
                if not said:
                    log("语音没识别出内容，先不说话")
                    return
                content = "（对方发了一条语音，说的是：%s）" % said
            if mtype in ("表情", "动画表情"):
                desc = describe_sticker(msg)
                if not desc:
                    content = "（对方发了一个表情包，但你没看清是什么。随便应一声就行，别编具体内容。）"
                else:
                    content = "（对方刚刚新发了一个表情包，内容是：%s）" % desc
            if mtype not in ("文本", "语音", "图片", "表情", "动画表情"):
                if "移出群聊" in content or "移出" in content:
                    dead_chats.add(username)
                    log("被移出群聊，停掉这个会话：", display_name(username))
                    return
                # 链接卡片 / 分享卡片：从 XML 里把 url 和 title 抠出来，当成一句带链接的话
                import re as _re
                mu = _re.search(r"<url>(.*?)</url>", content, _re.S)
                mt = _re.search(r"<title>(.*?)</title>", content, _re.S)
                if mu:
                    title = (mt.group(1).strip() if mt else "")[:60]
                    content = "分享了一个链接：%s %s" % (title, mu.group(1).strip())
                else:
                    return
            if ONLY_CHATS:
                try:
                    if display_name(username) not in ONLY_CHATS:
                        return
                except Exception:
                    return
            # 图片/语音/表情的 content 已经被上面替换成描述，别再重置回原始 XML
            if mtype == "文本":
                content = (msg.get("content") or "").strip()
            if not content or content.startswith("<"):
                return
            sender = msg.get("sender_username") or ""
            if sender == me:
                return  # 自己发的
            create_time = float(msg.get("create_time") or 0)
            if create_time and create_time < START_TS - SKIP_OLDER_THAN:
                return
            # 已经放了太久的消息（比如前面堵着几条），不再回
            if create_time and (time.time() - create_time) > STALE_AFTER:
                log("跳过过期消息（%.0fs 前）：%s" % (time.time() - create_time, content[:20]))
                return

            is_group = username.endswith("@chatroom")
            nickname = ""
            try:
                nickname = db.get_nickname(sender) or ""
            except Exception:
                nickname = ""
            if not nickname:
                nickname = "群友" if is_group else "微信好友"

            # 系统号 / 通知不接话：之前会跟「微信团队」对骂，还把通知当成人来问
            if is_system_notice(username, nickname, content):
                if ONLY_CHATS:
                    return
                log("跳过系统通知：", nickname, "：", content[:24])
                return
            # 同一人短时间内重复同一句 → 不再回（防刷屏 / 防通知重投）
            if duplicate_guard(username, sender, content):
                log("跳过重复消息：", nickname, "：", content[:20])
                return


            # 「拍了拍」这类系统提示不是人在说话，别接
            if "拍了拍" in content and "<url>" not in content:
                log("跳过拍一拍提示：", content[:24])
                return
            # 只把真正的 @ 当作 at_me；普通句子里提到「鲸鲸」不能误触发。
            # WeChat 会在 @昵称 后插入 U+2005，先换成普通空格再判定。
            import re as _mention_re
            _at_text = content.replace("\u2005", " ")
            addressed = any(
                a and _mention_re.search(
                    r"@\s*" + _mention_re.escape(str(a)) + r"(?=$|[\s，,：:！!~～…?？。\-—])",
                    _at_text,
                )
                for a in aliases
            )
            _at_remainder = _mention_re.sub(r"^[A-Za-z0-9_\-]{4,}:\s*", "", _at_text).strip()
            for _alias in aliases:
                if _alias:
                    _at_remainder = _mention_re.sub(r"@\s*" + _mention_re.escape(str(_alias)), " ", _at_remainder)
            _bare_mention = not _at_remainder.strip(" \t\r\n，,。.!！?？…~～")
            # 群里先说话、再单独发一个 @ → 把上一条问题补回来
            if username.endswith("@chatroom") and addressed and _bare_mention:
                try:
                    # get_messages 按新到旧返回；直接遍历，拿离这个裸 @ 最近的上一条。
                    for m in db.get_messages(username, limit=12):
                        if m.get("type") != "文本":
                            continue
                        if (m.get("sender_username") or "") != sender:
                            continue
                        prev = (m.get("content") or "").strip()
                        prev = __import__("re").sub(r"^[A-Za-z0-9_\-]{4,}:\s*", "", prev).strip()
                        if prev and not any(a in prev for a in aliases):
                            content = prev
                            log("补上一条问题：", prev[:20])
                            break
                except Exception as e:
                    log("补问题失败：", repr(e))
            # 把群消息里的其他 @ 对象一并交给服务端，帮助模型分清“你”是在说谁。
            _mentioned_names = []
            if is_group:
                for _hit in _mention_re.findall(r"@\s*([^\s@，,：:！!~～…?？。—]+)", _at_text):
                    _name = str(_hit).strip()
                    if _name and _name not in aliases and _name not in _mentioned_names:
                        _mentioned_names.append(_name)
            # 记下发送者 wxid（控制台「主人设置」要靠它做安全识别）
            log("收到", ("群" if is_group else "私聊"), display_name(username), "←", nickname,
                "（%s）" % (sender or "unknown"), "：", content[:30])
            payload = {
                "chat_id": username,
                "chat_type": "group" if is_group else "private",
                "user_id": sender or "unknown",
                "senderId": sender or "unknown",
                "sender_id": sender or "unknown",
                "senderName": nickname,
                "nickname": nickname,
                "text": content,
                "msg_id": "%s:%s:%s" % (username, msg.get("shard") or "", msg.get("local_id")),
                "at_me": addressed,
                "mentioned_names": _mentioned_names,
                "chat_title": display_name(username) if is_group else "",
            }


            try:
                headers = {"x-whale-bridge": "1"}
                if token:
                    headers["x-bot-token"] = token
                r = requests.post(
                    bot_url,
                    json=payload,
                    headers=headers,
                    timeout=120,
                )
                data = r.json()
            except Exception as e:
                log("请求鲸鲸失败：", repr(e))
                return

            if data.get("action") != "reply" or not data.get("reply"):
                if is_group and addressed:
                    log("鲸鲸没接话：", nickname, "→", content[:20], "|", data.get("reason"))
                return

            # 演示模式（服务端没配 Key，说的是内置台词）：提醒一次，别让人以为「没 Key 也能真聊」
            if data.get("mock") and not MOCK_NOTICED["done"]:
                MOCK_NOTICED["done"] = True
                log("[!] 服务端现在是「演示模式」：没配置 API Key，她回的是内置台词，不是真模型。")
                log("    去网页右上角「设置」填一把 Key（DeepSeek / 智谱 都行）就会切成真模型。")

            target = display_name(username)
            bubbles = data.get("bubbles") or [data["reply"]]
            mention = str(data.get("mention") or "").strip()
            # 生成期间又来了新消息 → 这条旧回复就不发了（避免回上一句）
            # 不再因为“有新消息”丢掉旧回复：宁可晚一点，也要回
            if not rate_guard(username):
                log("这一分钟回太多了，先停一下：", target)
                return
            log("回复", ("群" if is_group else "私聊"), target, "→", nickname, "：", (bubbles[0] or "")[:40])

            first = True
            for line in bubbles:
                if not line:
                    continue
                # 第一条如果是骂人/点名，用真 @（UI 里选成员），而不是纯文本 @名字
                if first and mention and is_group:
                    body = line
                    for prefix in ("@%s" % mention, "@ %s" % mention):
                        if body.startswith(prefix):
                            body = body[len(prefix):].lstrip(" ，,：:")
                            break
                    if send_at(mention, body, target, username):
                        first = False
                        time.sleep(0.6)
                        continue
                    log("真 @ 失败，退回普通文本：", mention)
                    if not line.startswith("@"):
                        line = "@%s %s" % (mention, line)
                send_text(line, target, username, quote_text=(content if first and QUOTE_REPLY else None))
                first = False
                time.sleep(0.6)

            # 她要发的指定图（画完想发出去时，鲸鲸会在回复里带 images 字段）
            try:
                _imgs = data.get("images") or []
                if isinstance(_imgs, str):
                    _imgs = [_imgs]

                for _name in _imgs[:3]:              # 一次最多 3 张
                    _p = resolve_media_path(_name)
                    if not _p:
                        log("要发的图找不到：%s" % _name)
                        continue
                    time.sleep(0.8)
                    _ok = send_sticker(target, username, specific_path=_p)
                    log("[发图] %s → %s" % (_name, "成功" if _ok else "失败"))
            except Exception as _e:                  # noqa: BLE001
                log("发指定图失败（不影响文字回复）：", repr(_e))

            # 回复完后，有一定概率补一个表情包（微信发不了动作表情，用 GIF 代替）
            try:
                # 已经发过指定图就不再随机补，免得刷屏
                _already = bool(data.get("images"))
                _want_sticker = data.get("sticker") or (
                    not _already and STICKER_CHANCE > 0 and random.random() < STICKER_CHANCE
                )
                log("[表情包] 检查：chance=%.2f want=%s" % (STICKER_CHANCE, _want_sticker))
                if _want_sticker:
                    time.sleep(0.8)
                    # 把刚才的回复内容传进去，按语气挑图（而不是纯随机）
                    _ctx = " ".join(str(b) for b in (data.get("bubbles") or []))
                    _sent = send_sticker(target, username, context=_ctx)
                    log("[表情包] 发送结果：%s" % _sent)
            except Exception as _e:                  # noqa: BLE001
                log("发表情包失败（不影响文字回复）：", repr(_e))
        except Exception as e:
            log("处理消息异常：", repr(e))

    log("开始监听新消息…（Ctrl+C 退出）")
    executor = ThreadPoolExecutor(max_workers=1)

    def on_message(msg, listener):
        # 每条消息丢线程池：发送慢不再阻塞后面消息的接收
        try:
            executor.submit(on_message_inner, msg, listener)
        except Exception as e:
            log("提交消息处理失败：", repr(e))

    listener = Listener(db, interval=0.4)
    listener.add_all(on_message)
    listener.start()
    def recent_chats(limit=2, within=1800):
        out = []
        try:
            for s in db.get_sessions(limit=20):
                u = s.get("username") or ""
                if not u or u == "filehelper":
                    continue
                try:
                    ms = db.get_messages(u, limit=1)
                except Exception:
                    continue
                if not ms:
                    continue
                t = float(ms[0].get("create_time") or 0)
                if t and (time.time() - t) > within:
                    continue
                out.append((u, display_name(u)))
                if len(out) >= limit:
                    break
        except Exception:
            pass
        return out

    def notify_away():
        for u, name in recent_chats():
            send_text("我先去休息一下，晚点回你～", name, u, force=True)
            NOTIFIED.append((u, name))
            time.sleep(0.3)
        if NOTIFIED:
            log("已通知最近的聊天：", "、".join(n for _, n in NOTIFIED))

    def share_watch():
        """每隔一段时间自己刷 B 站热门，挑一个没分享过的发到最近活跃的群/私聊。"""
        state_file = os.path.join(ROOT, "data", "share-state.json")
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                last = float(json.load(f).get("lastTs") or 0)
        except Exception:
            last = 0.0
        if not last:
            # 首次启动：5 分钟后再发，别一开机就刷屏
            last = time.time() - SHARE_EVERY * 60 + 60
        while True:
            time.sleep(30)
            if not SHARE_ENABLED:
                continue
            if time.time() - last < SHARE_EVERY * 60:
                continue
            if game_running() or away_active() or foreground_is_fullscreen():
                continue
            target = recent_chats(limit=1, within=7200)
            if not target:
                log("没有最近活跃的会话，这次先不分享")
                last = time.time()
                continue
            u, name = target[0]
            try:
                base = bot_base()
                r = requests.get(base + "/api/share?chat=" + urllib.parse.quote(u), timeout=40)
                data = r.json()
            except Exception as e:
                log("拉取视频失败：", repr(e))
                last = time.time()
                continue
            video = data.get("video")
            last = time.time()
            try:
                with open(state_file, "w", encoding="utf-8") as f:
                    json.dump({"lastTs": last}, f)
            except Exception:
                pass
            if not video:
                log("这次没挑到合适的视频")
                continue
            title = str(video.get("title") or "")[:60]
            link = str(video.get("url") or "")
            topic = str(data.get("topic") or "").strip()
            comment = str(data.get("comment") or "").strip()
            if not comment:
                comment = random.choice([
                    "这个看着还行，评论区比视频有意思",
                    "刚刷到，你们看看",
                    "有点意思，我接着刷了",
                ])
            text = "%s\n%s" % (link, comment)
            log("主动分享视频 →", name, str(video.get("title"))[:30])
            send_text(text, name, u)

    def care_watch():
        """主动搭话：没事的时候她自己来问一句「在干啥 / 累不累」。

        和主动分享同一套节奏，但「该不该发」交给服务端判断（时间窗 / 频率 / 每日上限都在
        src/care.js 里，改配置不用改脚本）。这里只管三件事：到点问一次、挑一个不是正在聊的
        会话、把生成的话发出去。
        """
        state_file = os.path.join(ROOT, "data", "care-state.json")

        def load_state():
            try:
                with open(state_file, "r", encoding="utf-8") as f:
                    return json.load(f) or {}
            except Exception:
                return {}

        def save_state(st):
            try:
                os.makedirs(os.path.dirname(state_file), exist_ok=True)
                with open(state_file, "w", encoding="utf-8") as f:
                    json.dump(st, f, ensure_ascii=False)
            except Exception:
                pass

        while True:
            time.sleep(60)
            if not CARE_ENABLED:
                continue
            if game_running() or away_active() or foreground_is_fullscreen():
                continue
            st = load_state()
            last_ts = float(st.get("lastTs") or 0)
            today = time.strftime("%Y-%m-%d")
            sent = int(st.get("count") or 0) if st.get("day") == today else 0
            base = bot_base()
            try:
                r = requests.get(
                    base + "/api/care/due",
                    params={"last": int(last_ts * 1000), "sentToday": sent},
                    timeout=15,
                )
                due = r.json() or {}
            except Exception:
                continue
            if not due.get("due"):
                continue
            # 正在聊的会话先别打扰：连续 CARE_QUIET_MIN 分钟内有过消息就跳过
            active = set()
            if CARE_QUIET_MIN > 0:
                try:
                    active = set(u for u, _n in recent_chats(limit=50, within=int(CARE_QUIET_MIN * 60)))
                except Exception:
                    active = set()
            target = None
            try:
                for u, name in recent_chats(limit=8, within=7 * 86400):
                    if u not in active:
                        target = (u, name)
                        break
            except Exception:
                target = None
            if not target:
                log("主动搭话：最近都在聊，这次先不打扰")
                continue
            u, name = target
            try:
                r2 = requests.get(base + "/api/care", params={"chat": u}, timeout=40)
                text = str((r2.json() or {}).get("text") or "").strip()
            except Exception as e:
                log("生成搭话失败：", repr(e))
                continue
            if not text:
                continue
            log("主动搭话 →", name, text[:30])
            ok = send_text(text, name, u)
            if ok is not False:
                save_state({"lastTs": time.time(), "day": today, "count": sent + 1})


    BATTERY_SENT = {"done": False}

    def battery_watch():
        while True:
            time.sleep(30)
            try:
                import psutil
                b = psutil.sensors_battery()
            except Exception:
                continue
            if not b or b.percent is None:
                continue
            pct = float(b.percent)
            if pct > 10:
                BATTERY_SENT["done"] = False
                continue
            if pct <= LOW_BATTERY_PCT and not BATTERY_SENT["done"]:
                BATTERY_SENT["done"] = True
                log("电量低（%.0f%%），给最近 3 个会话发晚安" % pct)
                try:
                    for u, name in recent_chats(limit=3, within=86400):
                        send_text(GOODNIGHT_TEXT, name, u, force=True)
                        time.sleep(0.4)
                except Exception as e:
                    log("发晚安失败：", repr(e))

    def notify_back():
        for u, name in list(NOTIFIED):
            send_text("我回来啦，刚在打游戏", name, u, force=True)
            time.sleep(0.3)
        NOTIFIED.clear()

    def game_watch():
        while True:
            time.sleep(4)
            running = game_running()
            if running and not AWAY["on"]:
                AWAY["on"] = True
                log("检测到游戏运行，进入休息模式（回复先排队）")
                if AWAY_NOTICE and not game_running():
                    try:
                        notify_away()
                    except Exception as e:
                        log("休息通知失败：", repr(e))
            elif not running and AWAY["on"]:
                AWAY["on"] = False
                log("游戏已退出，补发排队消息")
                with pending_lock:
                    items = list(pending_replies.values())
                    pending_replies.clear()
                now = time.time()
                fresh = [x for x in items if now - x[3] <= QUEUED_MAX_AGE]
                dropped = len(items) - len(fresh)
                fresh = fresh[-QUEUED_MAX_CHATS:]
                if dropped:
                    log("排队里有 %d 条已经太旧（>%ds），不补发" % (dropped, int(QUEUED_MAX_AGE)))
                for text, target, uname, _ts in fresh:
                    send_text(text, target, uname, force=True)
                if RETURN_NOTICE:
                    try:
                        notify_back()
                    except Exception as e:
                        log("回来通知失败：", repr(e))

    def digest_watch():
        last = time.time()
        while True:
            time.sleep(30)
            if DIGEST_MINUTES <= 0 or not MASTER_WXID:
                continue
            if time.time() - last < DIGEST_MINUTES * 60:
                continue
            if AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen():
                continue
            try:
                base = bot_base()
                r = requests.get(base + "/api/digest", params={"since": int(last * 1000)}, timeout=30)
                data = r.json()
            except Exception as e:
                log("拉取消息汇总失败：", repr(e))
                continue
            if data.get("count") and data.get("text"):
                name = display_name(MASTER_WXID) or "主人"
                log("给主人发消息汇总：%d 条" % data["count"])
                if send_text(data["text"], name, MASTER_WXID, force=True):
                    last = time.time()
            else:
                last = time.time()

    def explain_uia_failure():
        """UIA 拿不到时把原因说清楚。

        「热激活 UIA 失败」有三种完全不同的原因，光看那一句没法修：
          A. 主窗所在进程里枚举不到 Weixin.dll（挑到子进程 / 权限 / 微信刚重启）
          B. 这个微信版本库还不支持（特征扫描没命中、版本表里也没有）
          C. 补丁写进去了但 mmui 控件没出现（校验失败，已回滚）
        """
        try:
            import win32process
            from wechatauto.accessibility import AccessibilityGate, QACCESSIBLE_ACTIVE_RVA_BY_VERSION
        except Exception as e:
            log("UIA 诊断不可用：", repr(e))
            return
        hwnd = find_weixin_hwnd()
        if not hwnd:
            log("UIA 诊断：找不到标题为「微信」的主窗（微信缩在托盘？先点开它）")
            return
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            mods = list(AccessibilityGate._process_modules(pid) or [])
        except Exception as e:
            log("UIA 诊断：枚举模块失败：", repr(e))
            return
        dll = None
        for _b, _s, name, path in mods:
            if (name or "").lower() == "weixin.dll":
                dll = path
                break
        if not dll:
            log("UIA 诊断（原因A）：主窗进程 pid=%s 里只有 %d 个模块，枚举不到 Weixin.dll" % (pid, len(mods)))
            log("    → 多见于：微信刚重启、主窗属于子进程、或与微信权限不一致")
            return
        ver = os.path.basename(os.path.dirname(dll))
        try:
            cands = AccessibilityGate._qaccessible_candidate_rvas(dll)
        except Exception as e:
            log("UIA 诊断：取候选 RVA 失败：", repr(e))
            return
        known = QACCESSIBLE_ACTIVE_RVA_BY_VERSION.get(ver)
        if not cands:
            log("UIA 诊断（原因B）：微信 %s 没有任何可用 gate RVA，这个版本库还不支持" % ver)
            log("    → 升级 wechatauto-replica，或换回 4.1.13.65 / 4.1.15.53")
        else:
            log("UIA 诊断（原因C）：微信 %s，候选 RVA %d 个（%s），补丁写了但 mmui 没出现" % (
                ver, len(cands),
                "版本表命中" if known is not None else "靠特征扫描",
            ))
            log("    → 重启微信后立刻重试；仍失败说明该版本的保护变了，等库更新")

    def warmup():
        """启动后预热发送通道，避免第一条回复慢 5~10 秒。"""
        time.sleep(3)
        if game_running():
            log("游戏在运行，跳过发送通道预热")
            return
        try:
            nonlocal gui
            with gui_lock:
                if gui is None:
                    gui = WeChatGUI()
            u = gui._get_uia()
            UIA_CACHE["u"] = u
            if u is None:
                log("发送通道预热：UIA 不可用（只剩 OCR 兜底，先跑「一键修复并自检.bat」）")
                explain_uia_failure()
            else:
                win = getattr(u, "_win", None)
                try:
                    wcls = win.ClassName if win is not None else None
                    wname = win.Name if win is not None else None
                except Exception:                # noqa: BLE001
                    wcls, wname = None, None
                log("发送通道预热完成（UIA 可用，主窗类名=%r 名称=%r）" % (wcls, wname))
        except Exception as e:
            log("发送通道预热失败：", repr(e))

    def sticker_index_worker():
        """后台补表情包描述索引：她自己把素材库读懂，不用用户手动点。

        启动后等 60 秒（别和启动流程抢资源），然后每 10 分钟补一批。
        有上限，补完就空转，不会一直烧视觉接口。
        """
        time.sleep(60)
        first = True
        while True:
            try:
                n = index_missing_stickers(limit=6)
                if first:
                    # 第一轮无论有没有活都报一声，方便确认线程活着
                    log("表情包索引线程运行中（本轮补了 %d 张）" % (n or 0))
                    first = False
            except Exception as e:               # noqa: BLE001
                log("索引补全循环异常：", repr(e))
            time.sleep(600)

    def send_watchdog():
        """发送卡住超过 40 秒就重启桥接，避免整个队列卡死。"""
        while True:
            time.sleep(5)
            if SEND_STATE["active"] and (time.time() - SEND_STATE["start"]) > 40:
                log("发送卡住超过 40 秒，强制重启桥接进程…")
                time.sleep(0.3)
                # 用 7 而不是 2：2 是「找不到数据库目录」这种优雅报错（不该被守护循环
                # 无限重启），7 才是「我自己要重启」—— 启动脚本看到 7 就连着重启。
                os._exit(7)

    def flush_pending():
        while True:
            time.sleep(2)
            if AWAY["on"] or away_active() or foreground_is_fullscreen():
                continue
            with pending_lock:
                if not pending_replies:
                    continue
                items = list(pending_replies.values())
                pending_replies.clear()
            now = time.time()
            fresh = [x for x in items if now - x[3] <= QUEUED_MAX_AGE][-QUEUED_MAX_CHATS:]
            for text, target, uname, _ts in fresh:
                log("补发排队消息 →", target)
                send_text(text, target, uname, force=True)

    def listener_alive():
        """收消息的轮询线程是否还活着。"""
        try:
            th = getattr(listener, "_thread", None)
            return bool(th is not None and th.is_alive())
        except Exception:
            return False

    def listener_watch():
        """轮询线程死了就把它拉起来。

        症状：桥接进程还在（心跳正常）、微信里发消息也进来了，但一条都不回复 ——
        因为读数据库的那个线程悄悄退出了。以前只能重启桥接。
        """
        misses = 0
        while True:
            time.sleep(15)
            if listener_alive():
                misses = 0
                continue
            misses += 1
            if misses < 2:
                continue
            log("[!] 收消息线程已经不在了，自动重启监听…")
            try:
                listener.start()
                if listener_alive():
                    log("监听已重启，继续收消息")
                else:
                    log("监听重启后仍未启动，建议重启桥接")
            except Exception as e:                 # noqa: BLE001
                log("监听重启失败：", repr(e))
            misses = 0

    def bridge_heartbeat():
        """每 20 秒告诉服务端「桥接还活着、UIA/ffmpeg 状态如何」。

        没有心跳时，服务端只知道「它收到了消息」，不知道回复到底有没有能力发出去；
        网页上也就没法提示「桥接离线」或「UIA 不可用」。
        """
        import shutil as _shutil

        nonlocal gui
        base = bot_base()
        misses = 0
        gate_logged = False
        while True:
            try:
                # 游戏在跑时桥接会跳过预热、进休息模式，这时 UIA 还没初始化，
                # 不能当成「UIA 坏了」上报 —— 不然网页会误报「消息发不出去」。
                resting = bool(game_running())
                # 不用等消息才去唤醒引擎：心跳每 20 秒问一次（库内部 30 秒节流、
                # 会自动重新热激活），这样状态是真实的，也能顺手把假死的引擎救回来。
                uia_now = None
                if not resting:
                    try:
                        if not wechat_window_alive():
                            # 微信主窗没了（进程更新/重启/被回收）。缓存引擎里那个窗口
                            # 句柄已失效，再调 UIA 可能直接 0xC0000005，Python 拦不住。
                            # 先把手里的引擎丢掉，等窗口回来再重建，别去碰它。
                            with gui_lock:
                                gui = None
                                UIA_CACHE["u"] = None
                            misses = 0
                            uia_now = False
                            if not gate_logged:
                                log("[!] 微信主窗当前不存在（可能缩进托盘/被回收/自更新），已收起 UIA 引擎，等窗口回来再预热")
                                gate_logged = True
                        else:
                            with gui_lock:
                                _u = gui._get_uia() if gui is not None else None
                            if _u is None:
                                # 连续拿不到就重建窗口驱动。
                                # 实测（3.3.2）：桥接启动那一刻微信正好在托盘里（主窗隐藏）时，
                                # gui 会一直定位不到主窗；之后即使把微信拉出来也不会自愈，
                                # 心跳永远报 uia:false。重建一次就好了。
                                misses += 1
                                if misses >= 3:
                                    log("[!] UIA 连续 %d 次拿不到，重建窗口驱动再试…" % misses)
                                    with gui_lock:
                                        gui = WeChatGUI()
                                        _u = gui._get_uia()
                                    if _u is not None:
                                        misses = 0
                            else:
                                misses = 0
                                gate_logged = False
                            UIA_CACHE["u"] = _u
                            uia_now = _u is not None
                    except Exception:
                        uia_now = UIA_CACHE.get("u") is not None
                payload = {
                    "platform": "wechat",
                    "uia": uia_now,
                    "rest": resting,
                    # 收消息线程还活着吗：死了就是「能心跳、但一条消息都不进来」
                    "listener": listener_alive(),
                    "ffmpeg": bool(_shutil.which("ffmpeg")),
                }
                headers = {"x-whale-bridge": "1"}
                if token:
                    headers["x-bot-token"] = token
                requests.post(base + "/api/bridge/heartbeat", json=payload, headers=headers, timeout=8)
            except Exception:
                pass  # 服务没起来/重启中，下一轮再报
            time.sleep(20)

    def config_watch():
        """盯 config.json 的修改时间：调试台一保存就热更新，不用重启桥接。

        以前这些开关只在启动时读一次，用户在 /debug 里关掉「主动分享」、
        改「忽略名单」、「游戏白名单」都没反应，只能重启桥接 —— 也就是
        「调了没用，还是默认」。
        """
        last = 0.0
        try:
            last = os.path.getmtime(CONFIG_PATH)
        except Exception:
            last = 0.0
        while True:
            time.sleep(5)
            try:
                mt = os.path.getmtime(CONFIG_PATH)
            except Exception:
                continue
            if mt <= last:
                continue
            last = mt
            if reload_config():
                log("配置已热更新（调试台改完即时生效，不用重启桥接）")

    threading.Thread(target=flush_pending, daemon=True).start()
    threading.Thread(target=config_watch, daemon=True).start()
    threading.Thread(target=game_watch, daemon=True).start()
    threading.Thread(target=digest_watch, daemon=True).start()
    threading.Thread(target=warmup, daemon=True).start()
    threading.Thread(target=send_watchdog, daemon=True).start()
    threading.Thread(target=battery_watch, daemon=True).start()
    threading.Thread(target=share_watch, daemon=True).start()
    threading.Thread(target=care_watch, daemon=True).start()
    threading.Thread(target=bridge_heartbeat, daemon=True).start()
    threading.Thread(target=listener_watch, daemon=True).start()
    # 她自己维护表情包描述索引（后台慢慢补，不阻塞消息）
    threading.Thread(target=sticker_index_worker, daemon=True).start()
    log("已启动。鲸鲸地址：", bot_url)

    def self_check():
        """启动自检：告诉服务「我从哪个目录启动的、是什么版本」。

        为什么需要：
            桥接把素材存到 **自己所在目录** 的 data/ 下，
            而控制台读的是 **服务所在目录** 的 data/。
            两边不是同一份安装时，会出现「明明收藏了，控制台里看不到」——
            而且完全没有报错，非常难查。

            实测踩过：服务跑在 A 目录，桥接在桌面另一个旧拷贝 B 目录，
            桥接是旧代码、素材库是空的，用户怎么测都不对。

        所以这里把目录和版本报给服务，服务对不上就在控制台报警。
        """
        try:
            import json as _json

            payload = {
                "root": os.path.dirname(ROOT),
                "dataDir": os.path.abspath(os.path.join(ROOT, "..", "data")),
                "bridgeFile": os.path.abspath(__file__),
                "hasGif": True,
                "pid": os.getpid(),
            }

            base = bot_base().rstrip("/")
            r = requests.post(base + "/api/bridge/hello", json=payload, timeout=8)
            j = r.json() if r.ok else {}

            if j.get("dataDirMismatch"):
                log("")
                log("=" * 56)
                log("⚠ 目录不一致！")
                log("  桥接数据目录： %s" % payload["dataDir"])
                log("  服务数据目录： %s" % j.get("serverDataDir"))
                log("  两边不是同一份安装 —— 素材会存到桥接那边，")
                log("  控制台却读服务那边，于是「收藏了却看不到」。")
                log("  解决：从服务所在目录启动桥接。")
                log("=" * 56)
                log("")
            else:
                log("启动自检：目录一致（%s）" % payload["dataDir"])
        except Exception as e:                      # noqa: BLE001
            log("启动自检跳过（服务未就绪）：%r" % (e,))

    threading.Thread(target=self_check, daemon=True).start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log("正在退出…")
        listener.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
