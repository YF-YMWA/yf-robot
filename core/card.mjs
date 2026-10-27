/**
 * 人物卡转换：把 SillyTavern / Character Card V2 格式转成内部人设。
 *
 * 这样 cards/ 目录里的卡片可以直接用，不需要手工改写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadPersona, PERSONA_DEFAULTS } from './persona.mjs';

/**
 * 从 Character Card V2 的 data 构建人设。
 * @param {object} data
 * @returns {object} 内部人设结构
 */
export function cardToPersona(data) {
  const rules = [];
  const forbidden = [];

  // 卡片里的 system_prompt 是完整的行为准则，**整段保留**
  // 不拆分、不归类——拆错会改变语义（比如「绝对不许说软话」被拆成「绝对说软话」）
  if (data.system_prompt) {
    const lines = String(data.system_prompt)
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const line of lines) {
      // 只有当整行就是以「禁止/不许」开头时才归到 forbidden；
      // 其余一律作为准则保留原文
      if (/^(禁止|不许|严禁)/.test(line)) {
        forbidden.push(line.replace(/^(禁止|不许|严禁)\s*/, '').trim());
      } else {
        rules.push(line);
      }
    }
  }

  // 人物卡的开场白作为 greeting
  const greeting = data.first_mes ? String(data.first_mes).replace(/\n+/g, '\n').trim() : '';

  return {
    ...PERSONA_DEFAULTS,
    name: data.name || '助手',
    ownerName: data.speaker || '你',
    identity: data.description || '',
    personality: data.personality || '',
    background: data.scenario || '',
    greeting,
    speech: {
      ...PERSONA_DEFAULTS.speech,
      // 从对话示例里估计说话长度
      length: estimateLength(data.mes_example),
      // 卡片没指定是否用 emoji，交给全局表情开关决定
      emoji: undefined,
    },
    rules,
    forbidden,
    examples: data.mes_example || '',
    /** 卡片作者备注，供排查 */
    notes: data.creator_notes || '',
  };
}

/** 从对话示例估计回复长度偏好。 */
function estimateLength(example) {
  if (!example) return 'short';
  const lines = String(example)
    .split(/\n+/)
    .filter((l) => l && !l.startsWith('<START>') && !/^(用户|user)[：:]/.test(l));
  if (lines.length === 0) return 'short';
  const avg = lines.reduce((n, l) => n + l.length, 0) / lines.length;
  if (avg < 40) return 'short';
  if (avg < 100) return 'medium';
  return 'long';
}

/**
 * 加载人物卡（自动识别格式）。
 * @param {string} file
 * @returns {object|null}
 */
export function loadCard(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  // JSON 卡片
  if (file.endsWith('.json') || raw.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      const data = j?.spec?.includes('chara_card') && j.data ? j.data : j;
      if (!data || (!data.name && !data.description)) return null;
      return cardToPersona(data);
    } catch {
      return null;
    }
  }

  // Markdown 卡片（front-matter + 正文）
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (m) {
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
    return {
      ...PERSONA_DEFAULTS,
      name: meta.name || path.basename(file, '.md'),
      ownerName: meta.speaker || '你',
      identity: m[2].trim(),
      personality: meta.personality || '',
      background: meta.scenario || '',
      greeting: meta.first_message || '',
      rules: [],
      forbidden: [],
    };
  }

  return null;
}

/**
 * 加载人设：优先指定卡片，其次 persona.json，最后默认值。
 *
 * @param {object} opts
 * @param {string} opts.root 项目根
 * @param {string} [opts.personaFile] persona.json 路径
 * @param {string} [opts.card] 卡片 id（cards/ 下的文件名，不含扩展名）
 * @returns {object}
 */
export function loadAnyPersona({ root, personaFile, card }) {
  // 指定了卡片就用卡片
  if (card) {
    const dir = path.join(root, 'cards');
    const candidates = [
      path.join(dir, `${card}.json`),
      path.join(dir, `${card}.md`),
      path.join(dir, card),
    ];
    for (const f of candidates) {
      if (fs.existsSync(f)) {
        const p = loadCard(f);
        if (p) return p;
      }
    }
    console.warn(`[persona] 找不到卡片「${card}」，退回默认人设`);
  }

  // persona.json
  if (personaFile && fs.existsSync(personaFile)) {
    return loadPersona(personaFile);
  }

  return { ...PERSONA_DEFAULTS };
}

/** 列出 cards/ 下所有可用卡片。 */
export function listCards(root) {
  const dir = path.join(root, 'cards');
  if (!fs.existsSync(dir)) return [];

  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const ext = path.extname(name).toLowerCase();
    if (!['.json', '.md', '.txt'].includes(ext)) continue;
    const id = path.basename(name, ext);
    const p = loadCard(path.join(dir, name));
    if (p) out.push({ id, name: p.name, identity: (p.identity || '').slice(0, 50) });
  }
  return out;
}
