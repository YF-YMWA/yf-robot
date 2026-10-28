/**
 * 媒体入库：任何适配器上传的图片/表情/生成的图都由这里统一落盘。
 *
 * 为什么要在核心做这件事：
 *   以前这些文件是桥接进程自己写进 data/ 的。两个仓库分开之后，
 *   适配器不再和核心同目录，它那边算出来的 data/ 不是核心的 data/ ——
 *   于是「收藏了但控制台看不到」。所以把落盘收回到核心：
 *   适配器只负责把字节传过来，存哪、存不存、算不算重复，核心说了算。
 *
 * 顺带的好处：
 *   · 收藏白名单只在核心一处判断，不用两边各写一份
 *   · 去重（内容 md5 + 感知哈希）也只在核心一处
 *   · 描述索引和「动图替换静态图」这些规则跟着数据走，不会两边打架
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** 三类素材的目录和文件名前缀 */
export const KINDS = {
  image: { dir: 'images', prefix: 'img_', label: '图片' },
  sticker: { dir: 'stickers', prefix: 'stk_', label: '表情包' },
  generated: { dir: 'generated', prefix: 'gen_', label: '生成的图' },
};

/** 两份图差几位以内算「看着一样」 */
const SIMILAR_THRESHOLD = 6;

/** 只看文件头判断格式 */
export function sniffFormat(buf) {
  if (!buf || buf.length < 12) return 'unknown';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF') return 'webp';
  if (buf.subarray(0, 4).toString('latin1') === 'wxgf') return 'wxgf';
  return 'unknown';
}

const EXT_BY_FORMAT = { png: '.png', jpeg: '.jpg', gif: '.gif', webp: '.webp' };

/**
 * 算感知指纹（dHash，64 位）。
 *
 * 用 ffmpeg 把图缩成 9x8 灰度原始像素，再比较相邻像素明暗 ——
 * 这样不用在 Node 里塞一个图片解码库。
 * 没有 ffmpeg 时返回空串，调用方退回「只按内容 md5 去重」。
 *
 * @returns {Promise<string>} 16 位十六进制；算不出来返回 ''
 */
export function perceptualHash(buf, ffmpegPath) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve('');
    const args = [
      '-v', 'error',
      '-i', 'pipe:0',
      '-vf', 'scale=9:8,format=gray',
      '-frames:v', '1',
      '-f', 'rawvideo',
      'pipe:1',
    ];
    let done = false;
    try {
      const p = execFile(
        ffmpegPath,
        args,
        { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 15000 },
        (err, stdout) => {
          if (done) return;
          done = true;
          if (err || !stdout || stdout.length < 72) return resolve('');
          // 9x8 = 72 字节，逐行比较相邻像素
          let bits = '';
          for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
              const a = stdout[row * 9 + col];
              const b = stdout[row * 9 + col + 1];
              bits += a > b ? '1' : '0';
            }
          }
          let hex = '';
          for (let i = 0; i < 64; i += 4) {
            hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
          }
          resolve(hex);
        },
      );
      // 图从 stdin 喂进去，省一次临时文件
      p.stdin?.on('error', () => {});
      p.stdin?.end(buf);
    } catch {
      resolve('');
    }
  });
}

/** 两个指纹差几位 */
export function hamming(a, b) {
  try {
    const x = BigInt('0x' + a);
    const y = BigInt('0x' + b);
    let v = x ^ y;
    let n = 0;
    while (v) {
      n += Number(v & 1n);
      v >>= 1n;
    }
    return n;
  } catch {
    return 64;
  }
}

/**
 * 媒体库。
 *
 * @param {object} opts
 * @param {string} opts.root 项目根目录
 * @param {string} [opts.ffmpeg] ffmpeg 路径
 * @param {Function} [opts.log]
 */
export class MediaLibrary {
  constructor({ root, ffmpeg = null, log = () => {} }) {
    this.root = root;
    this.dataDir = path.join(root, 'data');
    this.ffmpeg = ffmpeg;
    this.log = log;
    this.phashFile = path.join(this.dataDir, 'media-phash.json');
  }

  dirOf(kind) {
    const info = KINDS[kind];
    if (!info) return '';
    return path.join(this.dataDir, info.dir);
  }

  /** 读指纹缓存 */
  readPhash() {
    try {
      const j = JSON.parse(fs.readFileSync(this.phashFile, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }

  /** 写指纹缓存（原子替换，避免写到一半） */
  writePhash(cache) {
    try {
      fs.mkdirSync(path.dirname(this.phashFile), { recursive: true });
      const tmp = this.phashFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
      fs.renameSync(tmp, this.phashFile);
    } catch {}
  }

  /**
   * 素材库里有没有「看着一样」的图。
   *
   * 需要先算好指纹（ffmpeg 那条路是异步的），所以这里接 hash 参数。
   * @returns {Promise<string>} 已有文件名；没有返回 ''
   */
  async findSimilar(buf, kind, hash) {
    const info = KINDS[kind];
    if (!info || !hash) return '';
    const cache = this.readPhash();
    const dir = this.dirOf(kind);

    for (const [name, rec] of Object.entries(cache)) {
      if (!rec?.hash) continue;
      if (rec.kind && rec.kind !== kind) continue;
      if (!fs.existsSync(path.join(dir, name))) continue;
      if (hamming(hash, rec.hash) <= SIMILAR_THRESHOLD) return name;
    }
    return '';
  }

  /**
   * 把一份图片收进素材库。
   *
   * 去重两层：
   *   1. 内容 md5 完全相同 → 直接返回已有文件名
   *   2. 看着一样（dHash 相近）→ 跳过；但**新的是动图、旧的是静态**时用动图替换
   *
   * @param {object} opts
   * @param {string} opts.kind image | sticker | generated
   * @param {Buffer} opts.data 图片字节
   * @param {string} [opts.note] 日志备注
   * @returns {Promise<{ok:boolean, name?:string, dup?:boolean, replaced?:string, error?:string}>}
   */
  async save({ kind, data, note = '', name: wanted = '' }) {
    const info = KINDS[kind];
    if (!info) return { ok: false, error: '未知类别' };
    if (!data || !data.length) return { ok: false, error: '空数据' };

    const fmt = sniffFormat(data);
    const ext = EXT_BY_FORMAT[fmt] || '';
    if (!ext) return { ok: false, error: `不认识的图片格式（头 ${data.subarray(0, 4).toString('hex')}）` };

    const dir = this.dirOf(kind);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return { ok: false, error: `建目录失败：${e.message}` };
    }

    /**
     * 名字来源。
     *
     * 默认按内容 md5 命名（同样的字节就是同一张图）。
     * 但动图表情是「连拍合成」的，同一个表情每次截出来的帧都不一样，
     * 按内容算就永远认不出是同一张 —— 所以允许调用方指定名字（适配器用
     * 微信 XML 里的表情 md5 命名）。名字只接受安全字符，防路径穿越。
     */
    const md5 = crypto.createHash('md5').update(data).digest('hex').slice(0, 12);
    const useWanted = /^[\w.-]{1,80}$/.test(String(wanted || ''));
    const name = useWanted ? String(wanted) : `${info.prefix}${md5}${ext}`;
    const full = path.join(dir, name);

    // 第一层：内容完全一样
    if (fs.existsSync(full)) {
      return { ok: true, name, dup: true };
    }

    // 第二层：看着一样
    let hash = '';
    try {
      hash = await perceptualHash(data, this.ffmpeg);
    } catch {}

    let replaced = '';
    if (hash) {
      const similar = await this.findSimilar(data, kind, hash);
      if (similar) {
        const oldIsGif = similar.toLowerCase().endsWith('.gif');
        const newIsGif = ext === '.gif';

        if (newIsGif && !oldIsGif) {
          // 动图替换静态：同一张表情包只保留会动的那份
          try {
            fs.unlinkSync(path.join(dir, similar));
            replaced = similar;
            this.log(`动图替换静态版本：${similar} → ${name}`);
          } catch (e) {
            this.log(`旧静态图删不掉（继续存动图）：${e.message}`);
          }
          const cache = this.readPhash();
          delete cache[similar];
          this.writePhash(cache);
        } else {
          this.log(`${info.label}重复（看着和 ${similar} 一样），跳过`);
          return { ok: true, name: similar, dup: true };
        }
      }
    }

    try {
      fs.writeFileSync(full, data);
    } catch (e) {
      return { ok: false, error: `写文件失败：${e.message}` };
    }

    if (hash) {
      const cache = this.readPhash();
      cache[name] = { hash, kind, at: Math.floor(Date.now() / 1000) };
      this.writePhash(cache);
    }

    this.log(`${info.label}已收藏：${name}（${Math.round(data.length / 1024)} KB）${note}`);
    return { ok: true, name, dup: false, replaced };
  }
}
