/**
 * 极简 zip 解压（不引第三方库）。
 *
 * 用途：一键更新时把 GitHub 的源码包（zip）解开。
 * 只支持 store（0）和 deflate（8）两种压缩方式 —— 这两种覆盖了
 * GitHub 打出来的包，也覆盖几乎所有常见 zip。
 *
 * 不做的事：加密、分卷、zip64。遇到就明确报错，别装成支持。
 */
import zlib from 'node:zlib';

/** 找中央目录的结束标记（EOCD），从尾部往前搜 */
function findEOCD(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * 解压整个 zip。
 *
 * @param {Buffer} buf
 * @param {object} [opts]
 * @param {(name:string)=>boolean} [opts.filter] 只解这些条目
 * @returns {Array<{name:string, data:Buffer}>}
 */
export function unzipAll(buf, opts = {}) {
  const filter = opts.filter || (() => true);
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0) return [];

  const files = [];
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏');

    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    p += 46 + nameLen + extraLen + commentLen;

    // 目录条目跳过
    if (name.endsWith('/')) continue;
    if (!filter(name)) continue;

    // 本地头：拿到真正的数据起点
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);

    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = zlib.inflateRawSync(raw);
    } else {
      throw new Error(`不支持的压缩方式 ${method}（${name}）`);
    }

    files.push({ name, data });
  }

  return files;
}

/**
 * GitHub 的源码包会在最外层套一个 `repo-tag/` 目录，
 * 这里统一去掉它，方便调用方按相对路径处理。
 *
 * @param {Array<{name:string,data:Buffer}>} files
 * @returns {{prefix:string, files:Array}}
 */
export function stripRootDir(files) {
  if (!files.length) return { prefix: '', files };

  const first = files[0].name;
  const slash = first.indexOf('/');
  if (slash < 0) return { prefix: '', files };

  const prefix = first.slice(0, slash + 1);
  if (!files.every((f) => f.name.startsWith(prefix))) return { prefix: '', files };

  return {
    prefix,
    files: files.map((f) => ({ name: f.name.slice(prefix.length), data: f.data })),
  };
}
