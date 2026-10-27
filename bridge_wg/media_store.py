"""素材库存储：命名、查重、落盘。

为什么单独成模块：
    这段逻辑原来嵌在 wechatauto_bridge.py 的 main() 里，外面**没法调用**，
    于是每次改完都只能「看日志猜有没有生效」——
    动图被查重误杀那个 bug 就是这么漏过去的：日志里 GIF 明明生成了，
    却没有「已收藏 .gif」，光看日志看不出是被谁拦下的。

    抽出来之后可以写真实单元测试（tests/test_media_store.py），
    跑的是桥接真正在跑的那份代码，不是复刻。

设计：
    MediaStore 只管「一份图片数据怎么进库」，不关心微信。
    权限（谁能发图才算数）通过 allow 回调注入，
    删除旧文件后的副作用（比如清描述索引）通过 on_forgotten 回调注入。
"""

import hashlib
import json
import os

# 三类素材的目录和文件名前缀
KINDS = {
    "image": {"dir": "images", "prefix": "img_"},
    "sticker": {"dir": "stickers", "prefix": "stk_"},
    "generated": {"dir": "generated", "prefix": "gen_"},
}

# 两份图差几位以内算「看着一样」（64 位里差 6 位 ≈ 肉眼看不出区别）
SIMILAR_THRESHOLD = 6


def perceptual_hash(data):
    """算一个「看着像不像」的指纹（dHash，64 位）。

    为什么不能只比内容 md5：
        同一张表情包截两次图，JPEG 头里会有几十个字节不一样，
        md5 完全不同，但人眼看是同一张 —— 结果就是素材库里越攒越多。
        dHash 只看图像内容，缩放+灰度后比较相邻像素明暗，
        肉眼相同就得到同一个指纹。

    @returns 16 位十六进制串；算不出来返回空字符串
    """
    try:
        import io

        from PIL import Image

        img = Image.open(io.BytesIO(data))
        img = img.convert("L").resize((9, 8), Image.LANCZOS)
        px = list(img.getdata())
        bits = 0
        for row in range(8):
            for col in range(8):
                left = px[row * 9 + col]
                right = px[row * 9 + col + 1]
                bits = (bits << 1) | (1 if left > right else 0)
        return "%016x" % bits
    except Exception:
        return ""


def hamming(a, b):
    """两个十六进制指纹差几位。"""
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except Exception:
        return 64


class MediaStore:
    """素材库。

    @param data_dir   data 目录（下面有 images/ stickers/ generated/）
    @param phash_path 指纹缓存文件路径
    @param log        日志函数
    """

    def __init__(self, data_dir, phash_path, log=None):
        self.data_dir = data_dir
        self.phash_path = phash_path
        self.log = log or (lambda *a: None)

        # 谁能发的图才算数（由桥接注入）。None = 全收
        self.allow = None

        # 旧文件被删掉时的回调（用来清描述索引里的孤儿条目）
        self.on_forgotten = None

    # ---------- 指纹缓存 ----------

    def load_phash(self):
        try:
            with open(self.phash_path, "r", encoding="utf-8") as f:
                j = json.load(f)
            return j if isinstance(j, dict) else {}
        except Exception:
            return {}

    def save_phash(self, cache):
        try:
            os.makedirs(os.path.dirname(self.phash_path) or ".", exist_ok=True)
            tmp = self.phash_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(cache, f, ensure_ascii=False)
            os.replace(tmp, self.phash_path)
        except Exception:
            pass

    def remember(self, name, data, kind):
        """把新文件的指纹记进缓存。"""
        ph = perceptual_hash(data)
        if not ph or not name:
            return
        cache = self.load_phash()
        cache[name] = {"hash": ph, "kind": kind, "at": int(__import__("time").time())}
        self.save_phash(cache)

    def forget(self, name):
        """删掉某个文件的指纹记录（文件被替换/删除时用）。

        不删的话，缓存里留着一条指向已不存在文件的记录，
        之后同样的图会一直「匹配」到这个空壳 —— 但空壳在磁盘上不存在，
        遍历时会跳过；问题是这条记录永远占着，判断逻辑也容易绕。
        """
        if not name:
            return
        cache = self.load_phash()
        if name in cache:
            cache.pop(name, None)
            self.save_phash(cache)

    # ---------- 查重 ----------

    def kind_dir(self, kind):
        info = KINDS.get(kind)
        if not info:
            return ""
        return os.path.join(self.data_dir, info["dir"])

    def find_similar(self, data, kind):
        """素材库里有没有「看着一样」的图。有就返回文件名。

        @returns 已有文件名；没有返回空字符串
        """
        ph = perceptual_hash(data)
        if not ph:
            return ""

        info = KINDS.get(kind)
        if not info:
            return ""

        cache = self.load_phash()
        target = os.path.join(self.data_dir, info["dir"])

        for name, rec in cache.items():
            if not rec.get("hash"):
                continue
            if rec.get("kind") and rec["kind"] != kind:
                continue
            if not os.path.isfile(os.path.join(target, name)):
                continue
            if hamming(ph, rec["hash"]) <= SIMILAR_THRESHOLD:
                return name

        return ""

    # ---------- 保存 ----------

    def save(self, raw, ext, kind, chat_username="", sender_id="", note=""):
        """把一份图片数据收进素材库。

        去重分两层：
            1. 内容 md5 完全相同 → 同一个文件名，直接跳过
            2. 看着一样（dHash 相近）→ 跳过，避免截图重复入库

        但**动图例外**：GIF 的第一帧和之前存过的静态 PNG 长得一样，
        dHash 判定为「重复」→ GIF 直接被丢掉，素材库里永远只有静态图。
        所以「新的是动图、旧的不是」时，用动图替换掉静态版本。

        @returns 保存的文件名（或已存在的同名文件）；没收藏返回空字符串
        """
        info = KINDS.get(kind)
        if not info or not raw:
            return ""

        if self.allow is not None:
            try:
                if not self.allow(kind, chat_username, sender_id):
                    return ""
            except Exception:
                return ""

        try:
            target = os.path.join(self.data_dir, info["dir"])
            os.makedirs(target, exist_ok=True)

            # 第一层：内容完全一样
            digest = hashlib.md5(raw).hexdigest()[:12]
            name = "%s%s%s" % (info["prefix"], digest, ext)
            path = os.path.join(target, name)

            if os.path.exists(path):
                return name

            # 第二层：看着一样
            similar = self.find_similar(raw, kind)
            if similar:
                new_is_gif = str(ext).lower() == ".gif"
                old_is_gif = str(similar).lower().endswith(".gif")

                if new_is_gif and not old_is_gif:
                    # 动图替换静态版本
                    old_path = os.path.join(target, similar)
                    try:
                        os.remove(old_path)
                        self.log("动图替换静态版本：%s → %s" % (similar, name))
                    except OSError as e:
                        self.log("旧静态图删不掉（继续存动图）：%r" % (e,))

                    self.forget(similar)

                    if self.on_forgotten:
                        try:
                            self.on_forgotten(similar)
                        except Exception:
                            pass
                    # 不 return，继续往下存 GIF
                else:
                    self.log("%s重复（看着和 %s 一样），跳过" % (
                        "表情包" if kind == "sticker" else "图片", similar))
                    return similar

            with open(path, "wb") as f:
                f.write(raw)

            self.remember(name, raw, kind)

            self.log("%s已收藏：%s（%d KB）%s" % (
                "表情包" if kind == "sticker" else "图片",
                name, len(raw) // 1024, note))
            return name
        except Exception as e:
            self.log("素材收藏失败（不影响识别）：%r" % (e,))
            return ""
