"""生成测试用的图片和动图。"""
import os
import sys

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_RT = os.path.join(_BASE, 'runtime', 'python', 'Lib', 'site-packages')
if _RT not in sys.path:
    sys.path.insert(0, _RT)

OUT = os.path.join(_BASE, 'data', 'test-media')
os.makedirs(OUT, exist_ok=True)

from PIL import Image, ImageDraw

# 1. 静态 PNG
img = Image.new('RGB', (300, 200), (70, 130, 200))
d = ImageDraw.Draw(img)
d.ellipse([80, 50, 220, 150], fill=(255, 255, 255))
d.text((120, 90), 'PNG TEST', fill=(50, 50, 50))
png_path = os.path.join(OUT, 'test.png')
img.save(png_path)
print('PNG:', png_path, os.path.getsize(png_path), 'bytes')

# 2. 静态 JPEG
jpg_path = os.path.join(OUT, 'test.jpg')
img.save(jpg_path, quality=90)
print('JPG:', jpg_path, os.path.getsize(jpg_path), 'bytes')

# 3. 动图 GIF（会动的圆）
frames = []
for i in range(8):
    f = Image.new('RGB', (200, 200), (30, 30, 50))
    fd = ImageDraw.Draw(f)
    # 圆从左移到右
    x = 20 + i * 20
    fd.ellipse([x, 80, x + 50, 130], fill=(255, 200, 60))
    fd.text((60, 20), 'GIF', fill=(255, 255, 255))
    frames.append(f)

gif_path = os.path.join(OUT, 'test.gif')
frames[0].save(
    gif_path,
    save_all=True,
    append_images=frames[1:],
    duration=150,
    loop=0,
)
print('GIF:', gif_path, os.path.getsize(gif_path), 'bytes')
print('')
print('全部生成完成')
