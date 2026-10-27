/** 测试动图/表情包识别。 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { VisionClient } from '../core/vision.mjs';
import { loadConfig } from '../core/config.mjs';

const cfg = loadConfig();
const tmpDir = path.join(process.cwd(), '.tmp');
fs.mkdirSync(tmpDir, { recursive: true });

console.log('=== 动图 / 表情包测试 ===');
console.log('');

// 生成一张多帧 GIF（模拟表情包）
const pyScript = `
import sys
sys.path.insert(0, r'${path.join(process.cwd(), 'runtime', 'python', 'Lib', 'site-packages')}')
from PIL import Image, ImageDraw

frames = []
colors = [(255, 100, 100), (100, 255, 100), (100, 100, 255), (255, 255, 100)]
for i, bg in enumerate(colors):
    img = Image.new('RGB', (200, 200), bg)
    d = ImageDraw.Draw(img)
    # 画一个简单的表情
    d.ellipse([50, 50, 150, 150], fill=(255, 255, 255))
    d.ellipse([75, 80, 95, 100], fill=(0, 0, 0))
    d.ellipse([105, 80, 125, 100], fill=(0, 0, 0))
    if i % 2 == 0:
        d.arc([75, 105, 125, 140], 0, 180, fill=(0, 0, 0), width=4)
    else:
        d.line([75, 130, 125, 130], fill=(0, 0, 0), width=4)
    frames.append(img)

frames[0].save(r'${path.join(tmpDir, 'test-anim.gif')}',
               save_all=True, append_images=frames[1:],
               duration=200, loop=0)
print('ok')
`;

const pyPath = path.join(tmpDir, 'make-gif.py');
fs.writeFileSync(pyPath, pyScript);

try {
  execFileSync(path.join(process.cwd(), 'runtime', 'python', 'python.exe'), [pyPath], {
    encoding: 'utf8',
    timeout: 30000,
  });
  console.log('生成 GIF 表情包: ok');
} catch (e) {
  console.log('生成失败:', e.message);
  process.exit(1);
}

const gifPath = path.join(tmpDir, 'test-anim.gif');
console.log(`文件: ${gifPath} (${fs.statSync(gifPath).size} 字节)`);
console.log('');

const vision = new VisionClient(cfg.vision, { logger: console });

console.log('--- 识别 GIF 动图 ---');
const t0 = Date.now();
try {
  const desc = await vision.describe(gifPath);
  console.log(`耗时: ${Date.now() - t0}ms`);
  console.log('');
  console.log(desc || '（空）');
  console.log('');
  console.log(desc ? '✓ 动图识别正常' : '✗ 识别为空');
} catch (e) {
  console.log(`✗ 失败: ${e.message}`);
}
