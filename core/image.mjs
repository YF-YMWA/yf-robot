/**
 * 图片处理：格式识别、转码、压缩、编码为模型可用的格式。
 *
 * 核心问题：微信 4.x 的图片多是 wxgf 容器（HEVC 编码），
 * 直接按扩展名当 JPEG 发给视觉模型会一直报「解析错误」。
 * 必须按**文件头**判断真实格式，wxgf 先用 ffmpeg 转 JPEG。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

/**
 * 可写的临时目录。
 *
 * 系统临时目录在受限环境（沙箱、只读用户目录）下可能禁止写入，
 * 所以优先用项目内的 .tmp，失败再退回系统临时目录。
 */
let cachedTmpRoot = null;
function tmpRoot() {
  if (cachedTmpRoot) return cachedTmpRoot;

  const candidates = [];
  // 项目内临时目录（最可靠）
  try {
    const here = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
    candidates.push(path.join(here, '.tmp'));
  } catch {}
  candidates.push(path.join(process.cwd(), '.tmp'));
  candidates.push(os.tmpdir());

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 实际写一个文件验证权限
      const probe = path.join(dir, `.wtest-${process.pid}`);
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
      cachedTmpRoot = dir;
      return dir;
    } catch {}
  }

  cachedTmpRoot = os.tmpdir();
  return cachedTmpRoot;
}

/** 在可写临时目录里创建唯一子目录。 */
export async function makeTmpDir(prefix) {
  const root = tmpRoot();
  return fs.promises.mkdtemp(path.join(root, prefix));
}

/** 支持的图片格式。 */
export const FORMATS = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/**
 * 按文件头识别格式，不信任扩展名。
 * @param {Buffer} buf
 * @returns {string} 格式名，无法识别返回 'unknown'
 */
export function sniffFormat(buf) {
  if (!buf || buf.length < 4) return 'unknown';

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  // GIF: ASCII "GIF8"
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  // BMP: "BM"
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  // WebP: "RIFF"...."WEBP"
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  // HEIF/HEIC/HEVC 系列：ftyp box 在偏移 4
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
      return 'heic';
    }
  }
  // wxgf：微信自有容器。没有正式公开的 magic，但常见特征是非标准头 + HEVC 码流
  if (isLikelyWxgf(buf)) return 'wxgf';

  return 'unknown';
}

/**
 * 判断是否可能是 wxgf 容器。
 *
 * wxgf 没有公开规范，实际特征是：
 *   - 不是任何已知图片格式
 *   - 文件头几个字节不是可打印 ASCII
 *   - 能从中找到 HEVC NAL 起始码（00 00 01 或 00 00 00 01）
 *
 * 这个判断是启发式的，只在其他格式都识别失败后使用。
 * @param {Buffer} buf
 */
export function isLikelyWxgf(buf) {
  if (!buf || buf.length < 32) return false;

  // 头部有可打印的图片特征则不是
  const head = buf.subarray(0, 16).toString('latin1');
  if (/^[\x20-\x7e]{8,}/.test(head)) {
    // 可打印 ASCII 开头，更像文本格式，不是 wxgf
    if (!head.startsWith('wxgf')) return false;
  }

  // 找 HEVC NAL 起始码
  const scan = buf.subarray(0, Math.min(buf.length, 4096));
  for (let i = 0; i < scan.length - 4; i++) {
    if (scan[i] === 0 && scan[i + 1] === 0 && (scan[i + 2] === 1 || (scan[i + 2] === 0 && scan[i + 3] === 1))) {
      // 找到起始码，再往后看 NAL 类型（HEVC 的 nal_unit_type 在第一个字节高 6 位）
      const nalIdx = scan[i + 2] === 1 ? i + 3 : i + 4;
      if (nalIdx < scan.length) {
        const nalType = (scan[nalIdx] >> 1) & 0x3f;
        // VPS(32) / SPS(33) / PPS(34) / 编码片(0-31)
        if (nalType <= 34) return true;
      }
    }
  }
  return false;
}

/**
 * 查找可用的 ffmpeg。
 * @param {string[]} [extraDirs] 额外搜索目录
 * @returns {string|null}
 */
export function findFfmpeg(extraDirs = []) {
  const candidates = [
    ...extraDirs,
    path.join(os.homedir(), 'ffmpeg', 'bin'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'ffmpeg', 'bin'),
    'C:\\ffmpeg\\bin',
    'D:\\ffmpeg\\bin',
    // WinGet 安装位置
    ...findWingetFfmpeg(),
    // PATH 交给 execFile 解析
  ].filter(Boolean);

  for (const dir of candidates) {
    const exe = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    try {
      if (fs.existsSync(exe)) return exe;
    } catch {}
  }

  // 依赖 PATH
  try {
    const { execFileSync } = require('node:child_process');
  } catch {}
  return 'ffmpeg'; // 交给系统解析，失败时上层捕获
}

/** 在 WinGet 包目录里找 ffmpeg。 */
function findWingetFfmpeg() {
  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
    : '';
  if (!base) return [];
  const out = [];
  try {
    for (const name of fs.readdirSync(base)) {
      if (!/ffmpeg/i.test(name)) continue;
      const dir = path.join(base, name);
      for (const sub of fs.readdirSync(dir)) {
        const bin = path.join(dir, sub, 'bin');
        if (fs.existsSync(path.join(bin, 'ffmpeg.exe'))) out.push(bin);
      }
    }
  } catch {}
  return out;
}

/**
 * 用 ffmpeg 把任意格式转成 JPEG。
 * @param {Buffer} buf 原始图片
 * @param {object} [opts]
 * @param {string} [opts.ffmpeg] ffmpeg 路径
 * @param {number} [opts.quality] 1-31，越小越好
 * @param {number} [opts.maxEdge] 长边上限，超出则等比缩小
 * @returns {Promise<Buffer>} JPEG 数据
 */
export async function toJpeg(buf, opts = {}) {
  const ffmpeg = opts.ffmpeg || findFfmpeg();
  const quality = opts.quality ?? 3;
  const maxEdge = opts.maxEdge || 1568;

  const tmpDir = await makeTmpDir("jj-img-");
  const inFile = path.join(tmpDir, 'in.bin');
  const outFile = path.join(tmpDir, 'out.jpg');

  try {
    await fs.promises.writeFile(inFile, buf);

    const scale = `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`;
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inFile,
      '-frames:v', '1',
      '-vf', scale,
      '-q:v', String(quality),
      outFile,
    ];

    await execFileAsync(ffmpeg, args, { timeout: 30000 });
    return await fs.promises.readFile(outFile);
  } catch (e) {
    throw new Error(`图片转码失败: ${e.message}`);
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 长截图检测：高宽比过大时视觉模型容易漏读，需要切段。
 * @param {Buffer} buf JPEG/PNG 数据
 * @returns {Promise<{width:number,height:number,isTall:boolean}|null>}
 */
export async function probeSize(buf, opts = {}) {
  const ffmpeg = opts.ffmpeg || findFfmpeg();
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));

  const tmpDir = await makeTmpDir("jj-probe-");
  const file = path.join(tmpDir, 'img');
  try {
    await fs.promises.writeFile(file, buf);
    const { stdout } = await execFileAsync(
      ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
      { timeout: 15000 },
    );
    const [w, h] = stdout.trim().split(',').map(Number);
    if (!w || !h) return null;
    return { width: w, height: h, isTall: h / w > 2.2 };
  } catch {
    return null;
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 把图片处理成可以交给视觉模型的 data URL。
 *
 * @param {Buffer|string} input 图片数据或文件路径
 * @param {object} [opts]
 * @param {number} [opts.maxEdge]
 * @param {string} [opts.ffmpeg]
 * @returns {Promise<{dataUrl:string, format:string, converted:boolean, width?:number, height?:number}>}
 */
export async function prepareImage(input, opts = {}) {
  const buf = Buffer.isBuffer(input) ? input : await fs.promises.readFile(input);
  const format = sniffFormat(buf);

  if (format === 'unknown' && !isLikelyWxgf(buf)) {
    throw new Error('无法识别的图片格式');
  }

  // 已是标准格式且不太大，直接编码
  const originalMime = FORMATS[format];
  const maxEdge = opts.maxEdge || 1568;

  // GIF 可能带动画，视觉模型多数只取首帧或直接报错，统一转静态 JPEG
  const needsConvert = !originalMime || format === 'gif';

  if (!needsConvert && buf.length < 4 * 1024 * 1024) {
    const size = await probeSize(buf, opts).catch(() => null);
    // 尺寸合规，直接用
    if (!size || (size.width <= maxEdge && size.height <= maxEdge)) {
      return {
        dataUrl: `data:${originalMime};base64,${buf.toString('base64')}`,
        format,
        converted: false,
        width: size?.width,
        height: size?.height,
      };
    }
  }

  // 其余情况（wxgf、heic、过大、未知）统一转 JPEG
  const jpg = await toJpeg(buf, { ffmpeg: opts.ffmpeg, maxEdge });
  const size = await probeSize(jpg, opts).catch(() => null);

  return {
    dataUrl: `data:image/jpeg;base64,${jpg.toString('base64')}`,
    format: 'jpeg',
    converted: format !== 'jpeg',
    sourceFormat: format,
    width: size?.width,
    height: size?.height,
  };
}

/**
 * 把长截图切成多段，便于逐段识别后拼接。
 * @param {Buffer} buf
 * @param {object} [opts]
 * @returns {Promise<Array<{dataUrl:string, index:number}>>}
 */
export async function splitTallImage(buf, opts = {}) {
  const ffmpeg = opts.ffmpeg || findFfmpeg();
  const maxEdge = opts.maxEdge || 1568;
  const segMax = opts.segments || 3;

  const size = await probeSize(buf, { ffmpeg });
  if (!size || !size.isTall) return [];

  // 按高度切成 segMax 段，每段之间有重叠避免切断内容
  const segH = Math.ceil(size.height / segMax);
  const overlap = Math.floor(segH * 0.06);
  const out = [];

  const tmpDir = await makeTmpDir("jj-split-");
  const inFile = path.join(tmpDir, 'in.bin');

  try {
    await fs.promises.writeFile(inFile, buf);

    for (let i = 0; i < segMax; i++) {
      const y = Math.max(0, i * segH - (i > 0 ? overlap : 0));
      const h = Math.min(size.height - y, segH + overlap * 2);
      if (h <= 0) break;

      const outFile = path.join(tmpDir, `s${i}.jpg`);
      const vf = `crop=iw:${h}:0:${y},scale='min(${maxEdge},iw)':-1`;
      try {
        await execFileAsync(
          ffmpeg,
          ['-hide_banner', '-loglevel', 'error', '-y', '-i', inFile, '-frames:v', '1', '-vf', vf, '-q:v', '3', outFile],
          { timeout: 30000 },
        );
        const seg = await fs.promises.readFile(outFile);
        out.push({ dataUrl: `data:image/jpeg;base64,${seg.toString('base64')}`, index: i });
      } catch {
        break;
      }
    }
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return out;
}
