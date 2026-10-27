"""wechat_xml 的单元测试。

这些用例来自真实踩过的坑：
  「直接发的 GIF」在微信里是 appmsg(type=8) + emoticonmd5，
  类型被归到「文件/链接/卡片」，旧代码只认 <url> 卡片 → 整条消息被丢掉，
  用户看到的就是「发了动图她完全没反应 / 识别不了」。
"""
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))

from wechat_xml import extract_emoticon_md5, is_emoji_appmsg, is_link_card

# 本机真实抓到的一条「直接发的 GIF」消息（截取关键片段）
REAL_GIF_APPMSG = """<?xml version="1.0"?>
<msg>
\t<appmsg appid="" sdkver="0">
\t\t<title />
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

LINK_CARD = """<msg><appmsg><title>某篇文章</title><url>https://example.com/a</url></appmsg></msg>"""

IMAGE_MSG = '<msg><img md5="0123456789abcdef0123456789abcdef" length="1234"/></msg>'

ANIMOJI = '<msg><emoji md5="fedcba9876543210fedcba9876543210" type="2" len="4321"/></msg>'


class WechatXmlTest(unittest.TestCase):
    def test_real_gif_is_emoji_appmsg(self):
        """本机真实那条 GIF 必须被认出来（这是整个 bug 的核心）"""
        self.assertTrue(is_emoji_appmsg(REAL_GIF_APPMSG))

    def test_link_card_is_not_emoji(self):
        """链接卡片不能误判成表情"""
        self.assertFalse(is_emoji_appmsg(LINK_CARD))
        self.assertTrue(is_link_card(LINK_CARD))

    def test_plain_text_is_not_emoji(self):
        self.assertFalse(is_emoji_appmsg('你好'))
        self.assertFalse(is_emoji_appmsg(''))
        self.assertFalse(is_emoji_appmsg(None))

    def test_image_msg_is_not_emoji(self):
        """普通图片消息走另一条路，不该被当成 appmsg 表情"""
        self.assertFalse(is_emoji_appmsg(IMAGE_MSG))

    def test_extract_md5_from_emoticon_tag(self):
        self.assertEqual(
            extract_emoticon_md5(REAL_GIF_APPMSG),
            '6e4bc1c86ad64caca302d45a628b1f26',
        )

    def test_extract_md5_from_attr(self):
        """普通图片/表情是属性写法，也要能取"""
        self.assertEqual(
            extract_emoticon_md5(IMAGE_MSG),
            '0123456789abcdef0123456789abcdef',
        )
        self.assertEqual(
            extract_emoticon_md5(ANIMOJI),
            'fedcba9876543210fedcba9876543210',
        )

    def test_extract_md5_missing(self):
        self.assertEqual(extract_emoticon_md5('没有 md5 的文本'), '')
        self.assertEqual(extract_emoticon_md5(None), '')

    def test_type8_without_appattach_is_not_emoji(self):
        """只有 type=8 但没有 appattach，不能当成表情"""
        s = '<msg><appmsg><type>8</type></appmsg></msg>'
        self.assertFalse(is_emoji_appmsg(s))

    def test_appmsg_without_type8_but_has_emoticonmd5(self):
        """有的版本不给 type，只给 emoticonmd5，也要认"""
        s = '<msg><appmsg><emoticonmd5>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</emoticonmd5></appmsg></msg>'
        self.assertTrue(is_emoji_appmsg(s))

    def test_is_link_card(self):
        self.assertTrue(is_link_card(LINK_CARD))
        self.assertFalse(is_link_card(IMAGE_MSG))
        self.assertFalse(is_link_card(''))


if __name__ == '__main__':
    unittest.main(verbosity=2)
