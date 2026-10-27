"""msg_route 的单元测试。

核心用例来自本机真实抓到的那条「直接发的 GIF」——
它在微信里 type 是「文件/链接/卡片」，以前会被当成「不是链接卡片」直接丢掉。
"""
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))

from msg_route import IGNORE, IMAGE, LINK, STICKER, TEXT, VOICE, route_message

# 本机真实那条 GIF（2026-10-27 17:15:28，type=文件/链接/卡片）
REAL_GIF_APPMSG = """<?xml version="1.0"?>
<msg>
\t<appmsg appid="" sdkver="0">
\t\t<title />
\t\t<des />
\t\t<action>view</action>
\t\t<type>8</type>
\t\t<showtype>0</showtype>
\t\t<url />
\t\t<appattach>
\t\t\t<totallen>3435252</totallen>
\t\t\t<attachid>0:0:6e4bc1c86ad64caca302d45a628b1f26</attachid>
\t\t\t<emoticonmd5>6e4bc1c86ad64caca302d45a628b1f26</emoticonmd5>
\t\t\t<cdnthumbwidth>292</cdnthumbwidth>
\t\t\t<cdnthumbheight>293</cdnthumbheight>
\t\t</appattach>
\t</appmsg>
</msg>"""

LINK_CARD = '<msg><appmsg><title>文章</title><url>https://example.com/a</url></appmsg></msg>'

IMAGE_XML = '<msg><img md5="0123456789abcdef0123456789abcdef" length="1234"/></msg>'

ANIMOJI_XML = '<msg><emoji md5="fedcba9876543210fedcba9876543210" type="2"/></msg>'

FILE_WITH_GIF_NAME = (
    '<msg><appmsg><type>6</type><title>搞笑.gif</title>'
    '<appmsg>/some/path/搞笑.gif</appmsg></appmsg></msg>'
)


class RouteMessageTest(unittest.TestCase):
    def test_real_gif_appmsg_routes_to_sticker(self):
        """本机真实那条 GIF：必须走表情路径（这是整个 bug 的核心）"""
        self.assertEqual(route_message('文件/链接/卡片', REAL_GIF_APPMSG), STICKER)

    def test_plain_image(self):
        self.assertEqual(route_message('图片', IMAGE_XML), IMAGE)

    def test_animoji(self):
        self.assertEqual(route_message('动画表情', ANIMOJI_XML), STICKER)
        self.assertEqual(route_message('表情', ''), STICKER)

    def test_voice(self):
        self.assertEqual(route_message('语音', ''), VOICE)

    def test_text(self):
        self.assertEqual(route_message('文本', '你好'), TEXT)

    def test_link_card(self):
        self.assertEqual(route_message('文件/链接/卡片', LINK_CARD), LINK)

    def test_link_card_with_empty_url_is_ignored(self):
        """url 空着的卡片以前会被 return，现在也还是 ignore（不是表情）"""
        s = '<msg><appmsg><type>5</type><url /></appmsg></msg>'
        self.assertEqual(route_message('文件/链接/卡片', s), IGNORE)

    def test_gif_file_appmsg_routes_to_image(self):
        """有些客户端把 .gif 当文件发，文件名带扩展名 → 按图片处理"""
        self.assertEqual(route_message('文件/链接/卡片', FILE_WITH_GIF_NAME), IMAGE)

    def test_transfer_is_ignored(self):
        self.assertEqual(route_message('转账', '<msg><wcpayinfo/></msg>'), IGNORE)

    def test_removed_from_group_is_ignored(self):
        self.assertEqual(route_message('系统消息', '你被"某某"移出群聊'), IGNORE)

    def test_empty_message_is_ignored(self):
        self.assertEqual(route_message('', ''), IGNORE)
        self.assertEqual(route_message(None, None), IGNORE)

    def test_emoji_appmsg_without_type8(self):
        """只有 emoticonmd5、没有 type=8 的版本也要认"""
        s = '<msg><appmsg><emoticonmd5>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</emoticonmd5></appmsg></msg>'
        self.assertEqual(route_message('文件/链接/卡片', s), STICKER)


if __name__ == '__main__':
    unittest.main(verbosity=2)
