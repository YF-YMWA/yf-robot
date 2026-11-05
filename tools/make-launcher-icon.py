"""生成 ENbot 品牌图标（只依赖 Pillow，发行包自带）。

输出：
  desktop/ENbot.ico       多尺寸（16 → 256），给 exe 与快捷方式用
  desktop/ui/icon.png        256px，给启动器界面用

用法（仓库自带 Python，已包含 Pillow）：
  runtime\\python\\python.exe tools\\make-launcher-icon.py
"""
import io
import os
import struct

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024

C1 = (99, 102, 241)    # indigo
C2 = (59, 130, 246)    # blue
C3 = (6, 182, 212)     # cyan
DARK = (11, 14, 20)


def _lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size=S):
    """45° 三色渐变：indigo → blue → cyan（先在小图上算，再放大）。"""
    n = 256
    img = Image.new("RGB", (n, n))
    px = img.load()
    for y in range(n):
        for x in range(n):
            t = (x + y) / (2.0 * (n - 1))
            px[x, y] = _lerp(C1, C2, t / 0.55) if t < 0.55 else _lerp(C2, C3, (t - 0.55) / 0.45)
    return img.resize((size, size), Image.BICUBIC)


def rounded_mask(size=S, radius=232):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


def plate():
    """圆角渐变板 + 左上柔光 + 玻璃边。"""
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(gradient().convert("RGBA"), (0, 0), rounded_mask())

    # 中心偏上的柔光（radial_gradient 中心为 0，取反后压成柔光）
    rad = Image.radial_gradient("L").resize((S, S), Image.BICUBIC)
    rad = rad.point(lambda v: int(((255 - v) / 255.0) ** 2 * 36))
    glow = Image.new("RGBA", (S, S), (255, 255, 255, 0))
    glow.putalpha(rad)
    img.alpha_composite(Image.composite(glow, Image.new("RGBA", (S, S), (0, 0, 0, 0)), rounded_mask()))

    d = ImageDraw.Draw(img)
    d.rounded_rectangle((10, 10, S - 11, S - 11), radius=224, outline=(255, 255, 255, 46), width=5)
    d.rounded_rectangle((2, 2, S - 3, S - 3), radius=236, outline=(9, 12, 19, 255), width=5)
    return img


def with_shadow(layer):
    alpha = layer.getchannel("A").point(lambda v: int(v * 0.38))
    black = Image.new("RGBA", (S, S), (4, 6, 12, 255))
    sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sh.paste(black, (0, 0), alpha)
    sh = sh.filter(ImageFilter.GaussianBlur(18))
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.alpha_composite(sh)
    return out


def robot(img):
    """白色机器人头：天线 + 耳朵 + 双眼 + 嘴。"""
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle((492, 232, 532, 388), radius=20, fill=(255, 255, 255, 255))
    d.ellipse((458, 176, 566, 284), fill=(255, 255, 255, 255))
    d.rounded_rectangle((274, 470, 334, 638), radius=30, fill=(255, 255, 255, 255))
    d.rounded_rectangle((690, 470, 750, 638), radius=30, fill=(255, 255, 255, 255))
    d.rounded_rectangle((330, 350, 694, 742), radius=126, fill=(248, 251, 255, 255))

    d.ellipse((406, 486, 494, 574), fill=DARK + (255,))
    d.ellipse((530, 486, 618, 574), fill=DARK + (255,))
    d.ellipse((426, 504, 452, 530), fill=(255, 255, 255, 235))
    d.ellipse((550, 504, 576, 530), fill=(255, 255, 255, 235))
    d.rounded_rectangle((458, 646, 566, 678), radius=16, fill=(13, 17, 26, 255))

    img.alpha_composite(with_shadow(layer))
    img.alpha_composite(layer)


def small_face(sz):
    """16 / 20 / 24 的小尺寸专用画法：放大脸、加粗眼睛、去掉嘴和耳朵。

    直接把 1024 的设计缩到 16px 会糊成一团，小图标必须单独画。
    """
    k = 8
    n = sz * k
    img = plate().resize((n, n), Image.LANCZOS)
    d = ImageDraw.Draw(img)

    # 头
    d.rounded_rectangle((n * 0.20, n * 0.27, n * 0.80, n * 0.79), radius=n * 0.17,
                        fill=(248, 251, 255, 255))
    # 天线
    d.rounded_rectangle((n * 0.475, n * 0.15, n * 0.525, n * 0.30), radius=n * 0.02,
                        fill=(255, 255, 255, 255))
    d.ellipse((n * 0.43, n * 0.09, n * 0.57, n * 0.23), fill=(255, 255, 255, 255))
    # 眼睛（比大图更粗）
    r = n * 0.095
    cy = n * 0.51
    for cx in (n * 0.385, n * 0.615):
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=DARK + (255,))
    return img.resize((sz, sz), Image.LANCZOS)


def save_ico(img, path, sizes):
    """手写 ICO：≤128 用 32bpp BMP 帧，256 用 PNG 帧。

    Pillow 自带的 ICO 保存会让 GDI+（WinForms 的 Icon 类）读出花屏/白纸，
    所以这里直接按 ICO 结构写标准 BMP 帧，任务栏/托盘/快捷方式都能正确解码。
    """
    frames = []
    for sz in sizes:
        if sz <= 128:
            rgba = (small_face(sz) if sz <= 24 else img.resize((sz, sz), Image.LANCZOS)).convert("RGBA")
            px = rgba.load()
            xor = bytearray()
            for y in range(sz - 1, -1, -1):
                for x in range(sz):
                    r, g, b, a = px[x, y]
                    xor += bytes((b, g, r, a))
            mask_stride = ((sz + 31) // 32) * 4
            mask = bytes(mask_stride * sz)
            header = struct.pack(
                "<IiiHHIIiiII", 40, sz, sz * 2, 1, 32, 0, len(xor) + len(mask), 0, 0, 0, 0
            )
            frames.append((sz, header + bytes(xor) + mask))
        else:
            buf = io.BytesIO()
            img.resize((sz, sz), Image.LANCZOS).save(buf, format="PNG")
            frames.append((sz, buf.getvalue()))

    offset = 6 + 16 * len(frames)
    out = bytearray(struct.pack("<HHH", 0, 1, len(frames)))
    for sz, data in frames:
        w = 0 if sz >= 256 else sz
        out += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in frames:
        out += data

    with open(path, "wb") as f:
        f.write(out)


def main():
    img = plate()
    robot(img)

    ui_dir = os.path.join(ROOT, "desktop", "ui")
    os.makedirs(ui_dir, exist_ok=True)
    img.resize((256, 256), Image.LANCZOS).save(os.path.join(ui_dir, "icon.png"))

    sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    ico = os.path.join(ROOT, "desktop", "ENbot.ico")
    save_ico(img, ico, sizes)

    print("已生成：")
    print("  desktop/ENbot.ico   ", os.path.getsize(ico), "bytes")
    print("  desktop/ui/icon.png")


if __name__ == "__main__":
    main()
