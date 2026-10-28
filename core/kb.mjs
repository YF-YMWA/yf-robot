/**
 * 知识库（RAG）：把文档切块、向量化，聊天时自动检索相关片段。
 *
 * 设计取舍：
 *   · 只用 JS，不引入第三方依赖（本项目一直零依赖）
 *     - .txt / .md / .html 直接读
 *     - .docx 是 zip，用内置 zlib 解 word/document.xml
 *     - .pdf **不支持**（要专门的解析库），导入时明确提示用户转换
 *   · 向量存成普通 JSON（data/kb/<id>.json），启动时载入内存
 *     文档量在几百份以内足够；不做 ANN 索引，暴力算余弦就够快
 *   · 检索是「相关性够高才注入」——宁可不引用，也不要塞一堆无关内容
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { htmlToPlainText } from './safe-fetch.mjs';
import { kbDir } from './scoped-paths.mjs';

/** 支持的扩展名 */
export const SUPPORTED = ['.txt', '.md', '.markdown', '.docx', '.html', '.htm'];

/** 一块大约多少字 */
const CHUNK_SIZE = 500;
/** 相邻块重叠多少字（避免把一句话切两半） */
const CHUNK_OVERLAP = 80;
/** 单次检索返回几块 */
const TOP_K = 4;
/** 余弦相似度低于这个就不引用（宁缺毋滥） */
const MIN_SCORE = 0.30;

/* ============================ 文档解析 ============================ */

/**
 * 从 zip 里取出一个文件（只实现「读中央目录 + inflateRaw」）。
 *
 * docx 就是个 zip，正文在 word/document.xml。
 * 不引入 unzip 库：格式够简单，自己解免得加依赖。
 */
function readZipEntry(buf, wantName) {
  // 1. 找 End of Central Directory（签名 0x06054b50，从尾部往前找）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  // 2. 遍历中央目录
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');

    if (name === wantName) {
      // 3. 从本地头里算出数据起点
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return data;
      if (method === 8) {
        try {
          return zlib.inflateRawSync(data);
        } catch {
          return null;
        }
      }
      return null;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** docx → 纯文本 */
function docxToText(buf) {
  const xml = readZipEntry(buf, 'word/document.xml');
  if (!xml) return '';
  const s = xml.toString('utf8');
  return (
    s
      // 段落、换行
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:br\s*\/>/g, '\n')
      .replace(/<w:tab\s*\/>/g, '\t')
      // 去掉所有标签
      .replace(/<[^>]+>/g, '')
      // XML 实体
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * html → 纯文本。
 *
 * 实现统一放在 core/safe-fetch.mjs —— 以前这里一份、learning.mjs 一份、
 * safe-fetch 又一份，三份行为略有差别（多一个空格的差异），纯属历史遗留。
 */
function htmlToText(s) {
  return htmlToPlainText(s);
}

/**
 * 解析一个文件成纯文本。
 * @returns {{ok:boolean, text?:string, error?:string}}
 */
export function parseDocument(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    return {
      ok: false,
      error: 'PDF 暂时不支持（需要专门的解析库）。' +
        '可以先用 Word 转成 .docx，或者复制正文存成 .txt 再导入。',
    };
  }
  if (!SUPPORTED.includes(ext)) {
    return { ok: false, error: `不支持的格式 ${ext}，支持：${SUPPORTED.join(' / ')}` };
  }

  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    return { ok: false, error: `读文件失败：${e.message}` };
  }
  if (buf.length > 30 * 1024 * 1024) {
    return { ok: false, error: '文件太大（上限 30MB）' };
  }

  let text = '';
  if (ext === '.docx') {
    text = docxToText(buf);
  } else if (ext === '.html' || ext === '.htm') {
    text = htmlToText(buf.toString('utf8'));
  } else {
    text = buf.toString('utf8');
  }

  text = text.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').trim();
  if (!text) return { ok: false, error: '文件里没解析出文字（可能是扫描件或空文件）' };
  return { ok: true, text };
}

/* ============================ 切块 ============================ */

/**
 * 把长文本切成带重叠的小块。
 *
 * 尽量在句号/换行处断开，而不是硬切 —— 硬切会把一句话劈成两半，
 * 检索到时读起来莫名其妙。
 */
export function chunkText(text, { size = CHUNK_SIZE, overlap = CHUNK_OVERLAP } = {}) {
  const clean = String(text || '').replace(/\r\n/g, '\n');
  const chunks = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);

    // 还没到结尾就找个自然的断点
    if (end < clean.length) {
      const window = clean.slice(Math.max(start + size - 200, start), end);
      const cut = Math.max(
        window.lastIndexOf('。'),
        window.lastIndexOf('\n'),
        window.lastIndexOf('！'),
        window.lastIndexOf('？'),
        window.lastIndexOf('. '),
      );
      if (cut > 0) {
        end = Math.max(start + size - 200, start) + cut + 1;
      }
    }

    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

/* ============================ 向量与相似度 ============================ */

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 中文按「二字组」切分，用来算关键词重合度。
 *
 * 为什么不用分词：中文分词要词典，本项目零依赖；
 * 二字组对「下午两点到四点」这类查询足够准 —— 覆盖率高就说明话题对上了。
 */
export function bigrams(text) {
  const clean = String(text || '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')   // 去掉空白、标点、符号
    .toLowerCase();
  const out = new Set();
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2));
  return out;
}

/**
 * 关键词覆盖率：查询里的二字组有多少出现在资料里。
 * 0 = 完全不沾边，1 = 全中。
 */
export function lexicalScore(queryGrams, docGrams) {
  if (!queryGrams || !docGrams || !queryGrams.size) return 0;
  let hit = 0;
  for (const g of queryGrams) if (docGrams.has(g)) hit++;
  return hit / queryGrams.size;
}

/* ============================ 知识库 ============================ */

export class KnowledgeBase {
  /**
   * @param {object} opts
   * @param {string} opts.root 项目根目录
   * @param {object} opts.config 核心配置（读 kb.* 和 vision.apiKey）
   * @param {Function} [opts.log]
   */
  constructor({ root, config, log = () => {}, card = '' }) {
    this.root = root;
    this.config = config;
    this.log = log;
    // 按角色卡隔离：换卡就换一整套文档
    this.dir = kbDir(root, card);
    this.docs = new Map(); // id → { id, name, chunks: [{text, vec}], addedAt }
    this.loaded = false;
  }

  /** 嵌入模型配置（复用看图那把智谱 Key） */
  #embedConfig() {
    const kb = this.config.kb || {};
    return {
      baseUrl: kb.embedBaseUrl || this.config.vision?.baseUrl || 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: kb.embedApiKey || this.config.vision?.apiKey || '',
      model: kb.embedModel || 'embedding-3',
    };
  }

  /** 算一批文本的向量 */
  async embed(texts) {
    const { baseUrl, apiKey, model } = this.#embedConfig();
    if (!apiKey) throw new Error('没配嵌入 Key（默认用看图那把智谱 Key）');

    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json();
    if (!r.ok || !j.data) {
      throw new Error(j?.error?.message || j?.message || `HTTP ${r.status}`);
    }
    // 接口按输入顺序返回；保险起见按 index 排序
    const arr = [...j.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return arr.map((d) => d.embedding);
  }

  /** 从磁盘载入（第一次用到时调） */
  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const n of fs.readdirSync(this.dir)) {
        if (!n.endsWith('.json')) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'));
          if (d?.id && Array.isArray(d.chunks)) this.docs.set(d.id, d);
        } catch {}
      }
      this.log(`[kb] 载入 ${this.docs.size} 份文档`);
    } catch (e) {
      this.log(`[kb] 载入失败：${e.message}`);
    }
  }

  #save(doc) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${doc.id}.json`);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
    fs.renameSync(tmp, file);
  }

  /** 文档清单（不含向量，给控制台用） */
  list() {
    this.load();
    return [...this.docs.values()].map((d) => ({
      id: d.id,
      name: d.name,
      chunks: d.chunks.length,
      chars: d.chunks.reduce((s, c) => s + c.text.length, 0),
      addedAt: d.addedAt,
    }));
  }

  /**
   * 导入一份文档。
   *
   * @param {string} filePath
   * @returns {Promise<{ok:boolean, id?:string, name?:string, chunks?:number, error?:string}>}
   */
  async addFile(filePath) {
    const parsed = parseDocument(filePath);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const name = path.basename(filePath);
    const id = 'kb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const pieces = chunkText(parsed.text);
    if (!pieces.length) return { ok: false, error: '切块后没有内容' };

    // 分批算向量（一次几十条，别把接口打爆）
    const chunks = [];
    const BATCH = 16;
    for (let i = 0; i < pieces.length; i += BATCH) {
      const batch = pieces.slice(i, i + BATCH);
      let vecs;
      try {
        vecs = await this.embed(batch);
      } catch (e) {
        return { ok: false, error: `算向量失败：${e.message}` };
      }
      for (let k = 0; k < batch.length; k++) {
        chunks.push({
          text: batch[k],
          vec: vecs[k],
          // 预先算好二字组，检索时不用每轮重算
          grams: [...bigrams(batch[k])],
        });
      }
    }

    const doc = { id, name, addedAt: Date.now(), chunks };
    this.#save(doc);
    this.docs.set(id, doc);
    this.log(`[kb] 导入「${name}」：${pieces.length} 块`);
    return { ok: true, id, name, chunks: pieces.length };
  }

  remove(id) {
    this.load();
    if (!this.docs.has(id)) return { ok: false, error: '没有这份文档' };
    this.docs.delete(id);
    try {
      fs.unlinkSync(path.join(this.dir, `${id}.json`));
    } catch {}
    return { ok: true };
  }

  /**
   * 检索：给一句话，找出最相关的几块。
   *
   * @param {string} query
   * @param {object} [opts]
   * @returns {Promise<Array<{text:string, score:number, doc:string}>>}
   */
  async search(query, { topK = TOP_K, minScore = MIN_SCORE } = {}) {
    this.load();
    if (!this.docs.size) return [];
    const q = String(query || '').trim();
    if (!q) return [];

    let qvec;
    try {
      [qvec] = await this.embed([q]);
    } catch (e) {
      this.log(`[kb] 检索失败（算查询向量）：${e.message}`);
      return [];
    }

    const qgrams = bigrams(q);

    /**
     * 混合打分：向量相似度 + 关键词覆盖率。
     *
     * 为什么不能只用向量：实测「下午两点到四点在干嘛」对
     * 「下午两点到四点必须午睡」的余弦只有 0.30 左右 —— 低于阈值就漏了。
     * 但关键词几乎是全覆盖的。两者加权后这类「原话换了说法」能捞回来，
     * 而完全不沾边的问题（关键词重合 0）分数仍然低。
     */
    const W_VEC = 0.65;
    const W_LEX = 0.35;

    const scored = [];
    for (const doc of this.docs.values()) {
      for (const c of doc.chunks) {
        const vec = cosine(qvec, c.vec);
        // 老数据没有 grams（混合打分是后加的），这里懒补一次，免得要重新导入
        if (!c.grams) c.grams = [...bigrams(c.text)];
        const lex = lexicalScore(qgrams, new Set(c.grams));
        const s = W_VEC * vec + W_LEX * lex;
        if (s >= minScore) {
          scored.push({ text: c.text, score: s, vecScore: vec, lexScore: lex, doc: doc.name });
        }
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** 把检索结果拼成提示词片段 */
  static render(hits) {
    if (!hits?.length) return '';
    const lines = hits.map((h, i) => `[资料${i + 1}｜${h.doc}]\n${h.text}`);
    return (
      '【参考资料】以下是从知识库里检索到的内容，和对方这次说的话可能相关：\n\n' +
      lines.join('\n\n') +
      '\n\n（用法：能回答就基于这些资料答，尽量贴合资料的意思；' +
      '资料里没有的不要编，也不要提「检索」「资料库」这些词，' +
      '就像你自己知道一样自然地说出来。）'
    );
  }
}

export { TOP_K, MIN_SCORE };
