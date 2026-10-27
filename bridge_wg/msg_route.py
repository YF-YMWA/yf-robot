"""消息分发决策：这条微信消息该走哪条处理路径。

为什么要单独成模块：
    「直接发的 GIF 收不到」那个 bug 的本质就在这里 ——
    微信把 GIF 当成 appmsg(type=8) 发过来，类型落在「文件/链接/卡片」，
    而分发代码只认带 <url> 的链接卡片，其余一律 return。
    消息在进入识别流程之前就被丢掉了，所以日志里连「识别失败」都没有。

    这段判断以前嵌在 main() 的 on_message_inner 里，外面调不到，
    只能靠真发一条消息去试。抽成纯函数之后可以直接拿真实报文做用例。
"""

from wechat_xml import is_emoji_appmsg, is_link_card

# route 的返回值
IMAGE = "image"          # 普通图片：下载 → 识别 → 收藏
VOICE = "voice"          # 语音：转文字
STICKER = "sticker"      # 表情/动图：解缓存或截图 → 识别 → 收藏
LINK = "link"            # 链接卡片：抠 url + 标题
TEXT = "text"            # 普通文本
IGNORE = "ignore"        # 不处理（系统消息、转账、被移出群等）


def is_image_file_appmsg(content):
    """appmsg 里夹着一个图片文件（少见，但个别客户端会这么发）。"""
    s = str(content or "")
    if "<appmsg" not in s:
        return False
    # 有 emoticonmd5 的按表情走，别抢
    if is_emoji_appmsg(s):
        return False
    low = s.lower()
    for ext in (".gif", ".png", ".jpg", ".jpeg", ".webp", ".bmp"):
        if ext in low:
            return True
    return False


def route_message(mtype, content=""):
    """决定这条消息怎么处理。

    @param mtype 数据库里给出的类型（图片/语音/表情/动画表情/文本/文件/链接/卡片…）
    @param content 消息原文（XML 或纯文本）
    @returns IMAGE / VOICE / STICKER / LINK / TEXT / IGNORE
    """
    t = str(mtype or "")
    c = str(content or "")

    # 系统消息：移出群聊这类，交给上层处理（这里只归为 ignore）
    if "移出群聊" in c or "移出" in c:
        return IGNORE

    if t == "图片":
        return IMAGE
    if t == "语音":
        return VOICE
    if t in ("表情", "动画表情"):
        return STICKER

    # ===== 关键分支：被判成「文件/链接/卡片」的东西 =====
    # 微信会把 GIF / 大表情当成 appmsg(type=8) 发过来，
    # 以前这里只处理链接卡片，表情类整条被丢掉。
    if is_emoji_appmsg(c):
        return STICKER
    if is_image_file_appmsg(c):
        return IMAGE
    if is_link_card(c):
        return LINK

    if t == "文本":
        return TEXT

    # 其余（转账、红包、系统提示…）不接
    return IGNORE
