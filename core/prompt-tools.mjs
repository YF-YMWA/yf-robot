/**
 * 文字版工具调用（给不支持 function calling 的模型用）。
 *
 * 为什么需要：
 *   换一个非 DeepSeek 的 Key，如果那家的接口不支持 function calling，
 *   以前整轮对话就失败；上一版改成「降级成纯聊天」——
 *   能聊，但发图、收藏、搜索、改设置全没了。
 *
 * 另一种做法：干脆不依赖工具，所有能力都由代码规则决定。
 *   好处是任何模型都能用，坏处是模型没法自己判断「这里该搜一下」。
 *
 * 这里走第三条路：**把工具写成提示词协议**。
 *   模型需要的时候输出一行 `{{tool:名字 {"参数":...}}}`，
 *   我们解析出来真去执行，再把结果喂回去让它接着说。
 *   对不支持 tools 字段的服务商也有效，能力基本不丢。
 *
 * 协议刻意做得极简，模型不容易写错：
 *   {{tool:send_image {"name":"stk_abc.gif"}}}
 *   {{tool:search_web {"query":"今天天气"}}}
 */

/** 单个工具的说明（一行，省 token） */
function describeTool(def) {
  const fn = def?.function || def || {};
  const name = fn.name || '';
  if (!name) return '';
  const props = fn.parameters?.properties || {};
  const args = Object.keys(props)
    .map((k) => {
      const d = props[k] || {};
      const type = d.type || 'string';
      const enums = Array.isArray(d.enum) ? `:${d.enum.join('|')}` : '';
      const required = Array.isArray(fn.parameters?.required) && fn.parameters.required.includes(k);
      return (required ? '' : '?') + k + ':' + type + enums;
    })
    .join(', ');
  const desc = String(fn.description || '').replace(/\s+/g, ' ').slice(0, 60);
  return `- ${name}(${args}) — ${desc}`;
}

/**
 * 生成提示词里的工具段。
 *
 * @param {Array} defs tools.definitions() 的返回
 * @param {string} [hint] 额外提示（比如「这次对方明确要图」）
 */
export function renderToolSpec(defs, hint = '') {
  const list = (defs || []).map(describeTool).filter(Boolean);
  if (!list.length) return '';

  return [
    '',
    '【可以做的事】',
    '下面这些操作你本身做不了，需要我来执行。要执行时，在回复里单独写一行：',
    '{{tool:工具名 {"参数":"值"}}}',
    '我会执行它，把结果告诉你，你再接着说。一次只写一个，不要编造结果。',
    '',
    ...list,
    hint ? '\n' + hint : '',
  ].join('\n');
}

const CALL_RE = /\{\{\s*tool\s*:\s*([A-Za-z0-9_]+)\s*(\{[\s\S]*?\})?\s*\}\}/gi;
/** 兼容模型写错方括号的情况 */
const CALL_RE_ALT = /\[\[\s*tool\s*:\s*([A-Za-z0-9_]+)\s*(\{[\s\S]*?\})?\s*\]\]/gi;

/**
 * 从模型输出里解析出工具调用。
 *
 * 容错优先：参数不是合法 JSON 也返回（args 为空），让调用方报错给模型看，
 * 而不是整轮对话崩掉。
 *
 * @returns {Array<{name:string,args:object,raw:string,parseError?:string}>}
 */
export function parseToolCalls(text) {
  const out = [];
  const s = String(text || '');

  for (const re of [CALL_RE, CALL_RE_ALT]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      const name = m[1];
      const rawArgs = m[2] || '';
      let args = {};
      let parseError;
      if (rawArgs) {
        try {
          const parsed = JSON.parse(rawArgs);
          args = parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          parseError = '参数不是合法 JSON';
        }
      }
      out.push({ name, args, raw: m[0], ...(parseError ? { parseError } : {}) });
    }
  }

  return out;
}

/** 去掉工具标记，只留要发出去的话 */
export function stripToolCalls(text) {
  return String(text || '')
    .replace(CALL_RE, '')
    .replace(CALL_RE_ALT, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
