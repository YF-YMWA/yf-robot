/**
 * 主动搭话：让核心用模型写一句，而不是从模板里抽。
 *
 * 模板的问题：
 *   「早，醒了没？」「在干啥呢」——翻来覆去就这几句，
 *   聊上三天你就能背下来，比不说话还假。
 *
 * 这里改成：给她一个处境（几点、上次聊了什么、多久没说话），
 * 让她自己组织一句话。生成失败再退回模板（core/care.mjs 里那套）。
 */
import { composeCare } from './care.mjs';

/**
 * 组织一句主动搭话。
 *
 * @param {object} opts
 * @param {object} opts.llm 模型客户端（需要 stream）
 * @param {object} opts.persona 人设
 * @param {string} [opts.memory] 记忆片段（render 出来的文本）
 * @param {Date} [opts.now]
 * @param {number} [opts.idleMinutes] 多久没说话了
 * @param {Function} [opts.log]
 * @returns {Promise<{text:string, source:'model'|'template'}>}
 */
export async function composeCareLine({
  llm,
  persona,
  memory = '',
  now = new Date(),
  idleMinutes = 60,
  log = () => {},
} = {}) {
  const hour = now.getHours();
  const name = persona?.name || '';

  const prompt =
    `你是${name || '她'}，现在主动给对方发一条消息。\n` +
    `当前时间：${hour} 点${hour < 6 ? '（深夜）' : hour < 9 ? '（早晨）' : hour < 12 ? '（上午）' : hour < 14 ? '（中午）' : hour < 18 ? '（下午）' : hour < 22 ? '（傍晚）' : '（夜里）'}\n` +
    `距离上次说话大约 ${idleMinutes} 分钟。\n` +
    (memory ? `\n你记得的事：\n${memory.slice(0, 500)}\n` : '') +
    `\n要求：\n` +
    `1. 就一句话，不超过 25 个字\n` +
    `2. 不要问「在吗」「在干什么」这种空话，说点具体的\n` +
    `3. 可以提一句时间（饿了/困了/该吃饭了），也可以接着上次的话题\n` +
    `4. 不要客套，不要自我介绍，不要解释你为什么发这条\n` +
    `5. 只输出这句话本身，不要加引号\n`;

  try {
    let out = '';
    for await (const chunk of llm.stream([{ role: 'user', content: prompt }], { maxTokens: 120 })) {
      out += chunk;
    }
    const text = String(out)
      .trim()
      .replace(/^["'“”「」]|["'“”「」]$/g, '')
      .replace(/\n[\s\S]*$/, '')
      .trim();

    if (text && text.length <= 60) {
      return { text, source: 'model' };
    }
    log(`[care] 模型给的话不合适（${text.length} 字），退回模板`);
  } catch (e) {
    log(`[care] 生成失败，退回模板：${e.message}`);
  }

  // 兜底：模板
  return { text: composeCare({ persona: name, now }), source: 'template' };
}
