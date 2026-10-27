"""素材库（media_store）的真实单元测试。

这些测试直接 import 桥接在跑的那份代码，不是复刻逻辑。

重点覆盖：
  · GIF 入库（这正是之前坏掉的地方）
  · 动图替换静态版本
  · 查重不会把不同内容误杀
"""
import os
import shutil
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))          # bridge_wg/tests
_BRIDGE = os.path.dirname(_HERE)                            # bridge_wg
_ROOT = os.path.dirname(_BRIDGE)                            # jingjing
sys.path.insert(0, _BRIDGE)                                 # 为了 import media_store
sys.path.insert(0, os.path.join(_ROOT, 'runtime', 'python', 'Lib', 'site-packages'))

from PIL import Image, ImageDraw, ImageSequence

from media_store import MediaStore, hamming, perceptual_hash


def make_png(color=(60, 120, 200), size=(120, 120)):
    """造一张静态 PNG。"""
    import io

    img = Image.new('RGB', size, (30, 30, 40))
    d = ImageDraw.Draw(img)
    d.ellipse([10, 10, size[0] - 10, size[1] - 10], fill=color)
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    return buf.getvalue()


def make_gif(n=6, size=(120, 120)):
    """造一个动图（同一画面，方块在移动 —— 第一帧和 make_png 尽量接近）。"""
    import io

    frames = []
    for i in range(n):
        img = Image.new('RGB', size, (30, 30, 40))
        d = ImageDraw.Draw(img)
        x = 10 + i * 4
        d.ellipse([x, 10, x + size[0] - 20, size[1] - 10], fill=(60, 120, 200))
        frames.append(img)

    buf = io.BytesIO()
    frames[0].save(buf, 'GIF', save_all=True, append_images=frames[1:],
                   duration=100, loop=0)
    return buf.getvalue()


class MediaStoreTest(unittest.TestCase):
    def setUp(self):
        # 明确用系统临时目录：不指定的话会落在 cwd（项目根），跑完留一堆垃圾
        self.tmp = tempfile.mkdtemp(prefix='media-store-test-', dir=tempfile.gettempdir())
        self.data_dir = os.path.join(self.tmp, 'data')
        os.makedirs(self.data_dir, exist_ok=True)
        self.logs = []
        self.store = MediaStore(
            data_dir=self.data_dir,
            phash_path=os.path.join(self.data_dir, 'media-phash.json'),
            log=lambda *a: self.logs.append(' '.join(str(x) for x in a)),
        )
        self.stickers = os.path.join(self.data_dir, 'stickers')
        os.makedirs(self.stickers, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---------- 基础 ----------

    def test_saves_png(self):
        name = self.store.save(make_png(), '.png', 'sticker')
        self.assertTrue(name.startswith('stk_'))
        self.assertTrue(name.endswith('.png'))
        self.assertTrue(os.path.isfile(os.path.join(self.stickers, name)))

    def test_saves_gif(self):
        """GIF 必须能存进去 —— 这是 bug 的本体。"""
        gif = make_gif()
        name = self.store.save(gif, '.gif', 'sticker')

        self.assertTrue(name.endswith('.gif'), '存出来的应该是 .gif，实际 %r' % name)
        path = os.path.join(self.stickers, name)
        self.assertTrue(os.path.isfile(path))

        with open(path, 'rb') as f:
            self.assertEqual(f.read(6)[:3], b'GIF')

        im = Image.open(path)
        frames = sum(1 for _ in ImageSequence.Iterator(im))
        self.assertGreater(frames, 1, '存进去的应该是动图，实际 %d 帧' % frames)

    def test_md5_same_returns_same_name(self):
        data = make_png()
        a = self.store.save(data, '.png', 'sticker')
        b = self.store.save(data, '.png', 'sticker')
        self.assertEqual(a, b)
        self.assertEqual(len(os.listdir(self.stickers)), 1)

    # ---------- 核心：动图替换静态 ----------

    def test_gif_replaces_static(self):
        """先存静态 PNG，再存同画面的 GIF → 应替换成 GIF。"""
        png = make_png()
        static_name = self.store.save(png, '.png', 'sticker')
        self.assertTrue(static_name.endswith('.png'))

        gif = make_gif()
        gif_name = self.store.save(gif, '.gif', 'sticker')

        files = os.listdir(self.stickers)
        self.assertTrue(gif_name.endswith('.gif'))
        self.assertIn(gif_name, files)
        self.assertNotIn(static_name, files, '旧静态图应该被删掉')

        self.assertTrue(
            any('动图替换静态版本' in line for line in self.logs),
            '应该打出替换日志，实际: %r' % self.logs,
        )

    def test_gif_kept_when_already_gif(self):
        """已经是 GIF，再存一张一样的 → 判重复，不会重复入库。"""
        gif = make_gif()
        a = self.store.save(gif, '.gif', 'sticker')
        b = self.store.save(gif, '.gif', 'sticker')
        self.assertEqual(a, b)
        self.assertEqual(len([f for f in os.listdir(self.stickers) if f.endswith('.gif')]), 1)

    def test_static_does_not_replace_gif(self):
        """已有 GIF，再来一张静态的 → 静态的应该被跳过，GIF 保留。"""
        gif_name = self.store.save(make_gif(), '.gif', 'sticker')
        self.store.save(make_png(), '.png', 'sticker')

        files = os.listdir(self.stickers)
        self.assertIn(gif_name, files)
        self.assertEqual(len([f for f in files if f.endswith('.gif')]), 1)

    def test_forget_removes_phash(self):
        name = self.store.save(make_png(), '.png', 'sticker')
        self.assertIn(name, self.store.load_phash())
        self.store.forget(name)
        self.assertNotIn(name, self.store.load_phash())

    def test_on_forgotten_callback(self):
        """替换旧文件时应通知外部（桥接用这个清描述索引）。"""
        seen = []
        self.store.on_forgotten = seen.append

        static_name = self.store.save(make_png(), '.png', 'sticker')
        self.store.save(make_gif(), '.gif', 'sticker')

        self.assertEqual(seen, [static_name])

    # ---------- 查重不该误杀 ----------

    def test_different_images_not_deduped(self):
        a = make_png(color=(200, 60, 60))
        b = make_png(color=(60, 200, 60), size=(120, 120))
        # 换个图案，确保指纹差得远
        import io

        img = Image.new('RGB', (120, 120), (10, 10, 10))
        d = ImageDraw.Draw(img)
        for y in range(0, 120, 10):
            d.rectangle([0, y, 120, y + 5], fill=(250, 250, 250))
        buf = io.BytesIO()
        img.save(buf, 'PNG')
        b = buf.getvalue()

        name_a = self.store.save(a, '.png', 'sticker')
        name_b = self.store.save(b, '.png', 'sticker')
        self.assertNotEqual(name_a, name_b, '内容差很多的图不该被判重复')

    def test_kind_isolation(self):
        """sticker 和 image 各自查重，互不影响。"""
        data = make_png()
        s = self.store.save(data, '.png', 'sticker')
        i = self.store.save(data, '.png', 'image')
        self.assertNotEqual(s, i)
        self.assertTrue(os.path.isfile(os.path.join(self.data_dir, 'images', i)))

    # ---------- 指纹函数 ----------

    def test_phash_stable(self):
        data = make_png()
        self.assertEqual(perceptual_hash(data), perceptual_hash(data))
        self.assertEqual(len(perceptual_hash(data)), 16)

    def test_phash_bad_data(self):
        self.assertEqual(perceptual_hash(b'not an image'), '')

    def test_hamming(self):
        self.assertEqual(hamming('0000000000000000', '0000000000000000'), 0)
        self.assertEqual(hamming('0000000000000000', '0000000000000001'), 1)
        self.assertEqual(hamming('ffffffffffffffff', '0000000000000000'), 64)

    # ---------- 权限 ----------

    def test_allow_callback_blocks(self):
        self.store.allow = lambda kind, chat, sender: False
        name = self.store.save(make_png(), '.png', 'sticker')
        self.assertEqual(name, '')
        self.assertEqual(os.listdir(self.stickers), [])

    def test_allow_callback_permits(self):
        self.store.allow = lambda kind, chat, sender: True
        name = self.store.save(make_png(), '.png', 'sticker')
        self.assertTrue(name)

    # ---------- 真实素材（可选） ----------

    def test_real_captured_gif(self):
        """用桥上真正抓到的那张 GIF 跑一遍（存在才测）。"""
        real = os.path.join(_ROOT, 'data', 'last-sticker-shot.gif')
        if not os.path.exists(real):
            self.skipTest('没有真实抓拍 GIF')

        with open(real, 'rb') as f:
            gif = f.read()

        name = self.store.save(gif, '.gif', 'sticker')
        self.assertTrue(name.endswith('.gif'))
        path = os.path.join(self.stickers, name)
        im = Image.open(path)
        frames = sum(1 for _ in ImageSequence.Iterator(im))
        self.assertGreater(frames, 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
