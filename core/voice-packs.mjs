/**
 * 语音包：把自定义音色导进来，不然只能用内置那 6 个。
 *
 * 阿里云百炼除了内置音色，还支持**声音复刻**（用一段录音克隆出专属音色）
 * 和自定义音色 ID。那些 ID 通常长这样：`cosyvoice-v2-xxxx` 之类，
 * 不可能写死在代码里，所以做成可导入的「语音包」。
 *
 * 语音包就是一个 JSON 文件：
 *
 *   {
 *     "name": "我的音色",
 *     "voices": [
 *       { "id": "cosyvoice-v2-abc123", "label": "我自己（复刻）", "note": "用 10 秒录音克隆的" }
 *     ]
 *   }
 *
 * 导入后存在 data/voice-packs.json，控制台的下拉框会合并 内置 + 语音包。
 * 也可以按角色卡指定：卡片里写 "voice": "<某个音色 id>"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { VOICES, DEFAULT_VOICE } from './tts.mjs';

/** 语音包文件 */
export function packsFile(root) {
  return path.join(root, 'data', 'voice-packs.json');
}

/** 音色 id 允许的字符（防止有人塞奇怪的东西进请求体） */
const ID_OK = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * 校验并规整一个语音包。
 * @returns {{ok:boolean, error?:string, pack?:object}}
 */
export function normalizePack(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: '不是合法的 JSON 对象' };

  const name = String(input.name || '').trim().slice(0, 30) || '未命名语音包';
  const raw = Array.isArray(input.voices) ? input.voices : [];
  if (!raw.length) return { ok: false, error: 'voices 是空的' };
  if (raw.length > 50) return { ok: false, error: '一个包最多 50 个音色' };

  const voices = [];
  for (const v of raw) {
    const id = String(v?.id || '').trim();
    if (!ID_OK.test(id)) {
      return { ok: false, error: `音色 id 不合法：${id.slice(0, 30)}（只允许字母数字和 ._: -）` };
    }
    voices.push({
      id,
      label: String(v?.label || id).trim().slice(0, 40),
      note: String(v?.note || '').trim().slice(0, 120),
      /** 标记来源，内置的不会重复出现在这里 */
      from: name,
    });
  }

  return { ok: true, pack: { name, voices, importedAt: new Date().toISOString() } };
}

/** 读所有语音包 */
export function readPacks(root) {
  try {
    const j = JSON.parse(fs.readFileSync(packsFile(root), 'utf8'));
    return Array.isArray(j?.packs) ? j.packs : [];
  } catch {
    return [];
  }
}

/** 写回 */
export function writePacks(root, packs) {
  const file = packsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, packs }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 导入一个语音包（同名会覆盖）。
 * @returns {{ok:boolean, error?:string, pack?:object, count?:number}}
 */
export function importPack(root, input) {
  const r = normalizePack(input);
  if (!r.ok) return r;

  const packs = readPacks(root);
  const i = packs.findIndex((p) => p.name === r.pack.name);
  if (i >= 0) packs[i] = r.pack;
  else packs.push(r.pack);

  writePacks(root, packs);
  return { ok: true, pack: r.pack, count: r.pack.voices.length };
}

/** 删掉一个语音包 */
export function removePack(root, name) {
  const packs = readPacks(root);
  const left = packs.filter((p) => p.name !== name);
  if (left.length === packs.length) return { ok: false, error: '没有这个语音包' };
  writePacks(root, left);
  return { ok: true, left: left.length };
}

/**
 * 可选音色全集：内置 + 所有语音包。
 * @returns {Array<{id:string,label:string,note?:string,from:string}>}
 */
export function allVoices(root) {
  const builtin = VOICES.map((v) => ({ ...v, from: '内置' }));
  const custom = [];
  for (const p of readPacks(root)) {
    for (const v of p.voices || []) {
      // 和内置重名的跳过，避免下拉框里出现两个同名项
      if (builtin.some((b) => b.id === v.id)) continue;
      if (custom.some((c) => c.id === v.id)) continue;
      custom.push({ ...v, from: p.name });
    }
  }
  return [...builtin, ...custom];
}

/**
 * 解析音色：给了就用，没给就用默认；给了但不存在也退回默认。
 * 这样导入的包被删掉之后，配置里残留的 id 不会让语音合成直接报错。
 */
export function resolveVoice(root, wanted) {
  const id = String(wanted || '').trim();
  if (!id) return { id: DEFAULT_VOICE, fallback: false };
  const hit = allVoices(root).find((v) => v.id === id);
  if (hit) return { id: hit.id, fallback: false };
  return { id: DEFAULT_VOICE, fallback: true, wanted: id };
}
