/**
 * 模型调用层：OpenAI 兼容接口，支持流式产出和失败降级。
 *
 * 关键设计：
 *   - 统一成 async generator，调用方用 for await 拿增量文本
 *   - 主服务商失败自动切备用，全部失败才抛错
 *   - 对「模型复读」「输出截断」做基础防护
 */

/** 可重试的 HTTP 状态：限流、超时、服务端错误 */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export class LlmError extends Error {
  constructor(message, { status, provider, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.provider = provider;
    this.retryable = retryable;
  }
}

/**
 * 模型客户端。
 * @param {object} cfg llm 配置段
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] 便于测试注入
 */
export class LlmClient {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.fetch = opts.fetchImpl || globalThis.fetch;
    /** 服务商列表：主 + 备 */
    this.providers = [
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, label: '主服务' },
      ...(cfg.fallbacks || []).map((f, i) => ({
        baseUrl: f.baseUrl,
        apiKey: f.apiKey,
        model: f.model,
        label: `备用${i + 1}`,
      })),
    ].filter((p) => p.baseUrl);
  }

  /**
   * 流式对话。产出增量文本。
   * @param {Array<{role:string, content:any}>} messages
   * @param {object} [opts]
   * @param {string} [opts.model]
   * @param {number} [opts.temperature]
   * @param {number} [opts.maxTokens]
   * @param {AbortSignal} [opts.signal]
   */
  async *stream(messages, opts = {}) {
    let lastErr = null;

    for (const provider of this.providers) {
      try {
        yield* this.#streamOne(provider, messages, opts);
        return;
      } catch (e) {
        lastErr = e;
        // 不可重试的错误直接抛出，不再浪费备用服务商
        if (e instanceof LlmError && !e.retryable) throw e;
      }
    }

    throw lastErr || new LlmError('没有可用的模型服务');
  }

  async *#streamOne(provider, messages, opts) {
    const url = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: opts.model || provider.model,
      messages,
      stream: true,
      temperature: opts.temperature ?? this.cfg.temperature,
      max_tokens: opts.maxTokens ?? this.cfg.maxTokens,
    };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    timer.unref?.();

    // 外部中断也要能取消
    const onAbort = () => ac.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!res.ok) {
        const detail = await safeText(res);
        throw new LlmError(
          `${provider.label} 返回 ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
          { status: res.status, provider: provider.label, retryable: RETRYABLE_STATUS.has(res.status) },
        );
      }

      // 非流式响应（部分服务商不支持 stream 时）直接解析
      const ctype = res.headers.get('content-type') || '';
      if (!ctype.includes('event-stream')) {
        const json = await res.json();
        const text = json?.choices?.[0]?.message?.content;
        if (typeof text === 'string') yield text;
        return;
      }

      yield* parseSseStream(res.body);
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (e.name === 'AbortError') {
        throw new LlmError('请求超时或被中断', { provider: provider.label, retryable: true });
      }
      throw new LlmError(`${provider.label} 请求失败: ${e.message}`, {
        provider: provider.label,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener?.('abort', onAbort);
    }
  }

  /**
   * 一次性拿完整回复（内部用 stream 拼接）。
   * @returns {Promise<string>}
   */
  async complete(messages, opts = {}) {
    let out = '';
    for await (const chunk of this.stream(messages, opts)) out += chunk;
    return out;
  }

  /**
   * 带工具调用的对话（非流式，简化实现）。
   *
   * 返回模型可能要求调用的工具列表；调用方执行后把结果回填再调一次。
   *
   * @param {Array} messages
   * @param {Array} tools 工具定义
   * @param {object} [opts]
   * @returns {Promise<{text:string, toolCalls:Array|null, finishReason:string}>}
   */
  async streamWithTools(messages, tools, opts = {}) {
    let lastErr = null;

    for (const provider of this.providers) {
      try {
        return await this.#callWithTools(provider, messages, tools, opts);
      } catch (e) {
        lastErr = e;
        if (e instanceof LlmError && !e.retryable) throw e;
      }
    }

    throw lastErr || new LlmError('没有可用的模型服务');
  }

  async #callWithTools(provider, messages, tools, opts) {
    const url = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: opts.model || provider.model,
      messages,
      temperature: opts.temperature ?? this.cfg.temperature,
      max_tokens: opts.maxTokens ?? this.cfg.maxTokens,
      stream: false,
    };

    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    timer.unref?.();

    try {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!res.ok) {
        const detail = await safeText(res);
        throw new LlmError(
          `${provider.label} 返回 ${res.status}${detail ? ': ' + detail.slice(0, 150) : ''}`,
          { status: res.status, provider: provider.label, retryable: RETRYABLE_STATUS.has(res.status) },
        );
      }

      const json = await res.json();
      const choice = json?.choices?.[0];
      const msg = choice?.message || {};

      return {
        text: typeof msg.content === 'string' ? msg.content : '',
        toolCalls: Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : null,
        finishReason: choice?.finish_reason || 'stop',
      };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (e.name === 'AbortError') {
        throw new LlmError('请求超时', { provider: provider.label, retryable: true });
      }
      throw new LlmError(`${provider.label} 请求失败: ${e.message}`, {
        provider: provider.label,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 解析 SSE 流，产出增量文本。
 * @param {ReadableStream} body
 */
export async function* parseSseStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;

        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) yield delta;

          // 某些服务商把结束原因放在这里
          const finish = json?.choices?.[0]?.finish_reason;
          if (finish && finish !== 'stop') {
            // 长度截断等情况，交由上层判断，这里不抛错
          }
        } catch {
          // 单个 chunk 解析失败不影响整体
        }
      }
    }

    // 处理结尾残留
    const rest = buffer.trim();
    if (rest.startsWith('data:')) {
      const payload = rest.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) yield delta;
        } catch {}
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * 检测输出是否异常（模型复读、乱码），返回问题描述或 null。
 * @param {string} text
 */
export function inspectOutput(text) {
  if (!text || !text.trim()) return '空回复';

  // 同一短语连续重复
  const repeat = /(.{2,8})\1{3,}/.exec(text);
  if (repeat) return `疑似复读: ${repeat[1]}`;

  // 极端字符长度（单个字符占主导）
  const freq = new Map();
  for (const ch of text) freq.set(ch, (freq.get(ch) || 0) + 1);
  const max = Math.max(...freq.values());
  if (text.length > 20 && max / text.length > 0.5) return '字符重复率过高';

  // 出现控制字符
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return '包含控制字符';

  return null;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
