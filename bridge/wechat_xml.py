"""微信消息 XML 的小工具。

单独成模块的原因：
    微信把 GIF/大表情发过来时，消息类型会落到「文件/链接/卡片」，
    以前代码只认带 <url> 的链接卡片，这类消息**整条被丢掉** ——
    用户看到的就是「直接发的动图她完全没反应，识别不了」。

    这种判断逻辑放在 main() 里就没法测，抽出来才能加单元测试。
"""

import re

_EMOTICON_MD5_ATTR = re.compile(r'md5="([0-9a-fA-F]{32})"')
_EMOTICON_MD5_TAG = re.compile(r"<emoticonmd5>\s*([0-9a-fA-F]{32})\s*</emoticonmd5>")
_APPMSG_TYPE8 = re.compile(r"<type>\s*8\s*</type>")


def is_emoji_appmsg(content):
    """这条 appmsg 是不是「表情/GIF」而不是链接卡片。

    微信在这些情况下会把 GIF 当成 appmsg(type=8) 发过来：
      · 拖一个 .gif 文件进聊天框
      · 转发收藏里的表情
      · 部分「大表情」

    特征：带 <emoticonmd5>，或者 type=8 且有 <appattach>。
    """
    s = str(content or "")
    if "<appmsg" not in s:
        return False
    if _EMOTICON_MD5_TAG.search(s):
        return True
    return bool(_APPMSG_TYPE8.search(s) and "<appattach>" in s)


def extract_emoticon_md5(content):
    """从消息 XML 里取出表情 md5。

    两种写法都要认：
        <emoji md5="xxxx" .../>            —— 普通表情 / 动画表情
        <emoticonmd5>xxxx</emoticonmd5>    —— GIF 被当 appmsg 发来时

    @returns 32 位十六进制串；没有返回空字符串
    """
    s = str(content or "")
    m = _EMOTICON_MD5_ATTR.search(s)
    if m:
        return m.group(1).lower()
    m = _EMOTICON_MD5_TAG.search(s)
    if m:
        return m.group(1).lower()
    return ""


def is_link_card(content):
    """是不是一条带 url 的链接/分享卡片。"""
    s = str(content or "")
    return "<url>" in s and bool(re.search(r"<url>(.*?)</url>", s, re.S))
