/** 测试看图能力：生成一张图，喂给视觉模型。 */
import fs from 'node:fs';
import path from 'node:path';
import { VisionClient } from '../core/vision.mjs';
import { loadConfig } from '../core/config.mjs';

const cfg = loadConfig();

console.log('=== 看图测试 ===');
console.log(`模型: ${cfg.vision.model}`);
console.log('');

// 用 Python 生成一张带文字的测试图
const tmpDir = path.join(process.cwd(), '.tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const { execFileSync } = await import('node:child_process');
const pyScript = `
import sys
sys.path.insert(0, r'${path.join(process.cwd(), 'runtime', 'python', 'Lib', 'site-packages')}')
from PIL import Image, ImageDraw
img = Image.new('RGB', (400, 200), (30, 60, 120))
d = ImageDraw.Draw(img)
d.rectangle([20, 20, 380, 180], outline=(255, 255, 255), width=3)
d.text((60, 80), 'HELLO 123', fill=(255, 255, 255))
d.ellipse([300, 100, 360, 160], fill=(255, 200, 0))
img.save(r'${path.join(tmpDir, 'test-vision.png')}')
print('ok')
`;

const pyPath = path.join(tmpDir, 'make-img.py');
fs.writeFileSync(pyPath, pyScript);

try {
  const out = execFileSync(path.join(process.cwd(), 'runtime', 'python', 'python.exe'), [pyPath], {
    encoding: 'utf8',
    timeout: 30000,
  });
  console.log('生成测试图:', out.trim());
} catch (e) {
  console.log('生成失败:', e.message);
  process.exit(1);
}

const imgPath = path.join(tmpDir, 'test-vision.png');
const size = fs.statSync(imgPath).size;
console.log(`图片: ${imgPath} (${size} 字节)`);
console.log('');

const vision = new VisionClient(cfg.vision, { logger: console });

const t0 = Date.now();
try {
  const desc = await vision.describe(imgPath);
  console.log(`耗时: ${Date.now() - t0}ms`);
  console.log('');
  console.log('识别结果:');
  console.log(desc || '（空）');
  console.log('');
  console.log(desc ? '✓ 看图正常' : '✗ 识别为空');
} catch (e) {
  console.log(`✗ 失败: ${e.message}`);
}
