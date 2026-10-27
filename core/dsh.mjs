/**
 * DSH 调用工具：让微信里的助手能真正调用 DSH（也就是我）。
 *
 * 原理：通过 DSH 官方的 ACP 协议（stdio JSON-RPC）通信。
 * 不碰 web 鉴权、不改 DSH 内部。
 *
 * 每次调用起一个独立的 dsh acp 进程，用完即关，
 * 避免长期驻留占用资源。
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';

export class DshClient {
  /**
   * @param {object} opts
   * @param {string} opts.nodePath 内置 node 路径
   * @param {string} opts.dshBin    dsh 的 lib/bin.js
   * @param {string[]} [opts.extraArgs] 额外参数（如 --patch）
   * @param {string} opts.cwd       工作目录
   * @param {string} [opts.dshHome] DSH_HOME 路径（改到可写位置）
   * @param {string} [opts.tmpDir]  临时目录（改到可写位置）
   * @param {number} [opts.timeoutMs]
   * @param {object} [opts.logger]
   */
  constructor(opts) {
    this.nodePath = opts.nodePath;
    this.dshBin = opts.dshBin;
    this.extraArgs = opts.extraArgs || [];
    this.cwd = opts.cwd;
    this.dshHome = opts.dshHome || '';
    this.tmpDir = opts.tmpDir || '';
    this.timeoutMs = opts.timeoutMs || 180000;
    this.log = opts.logger || console;
  }

  /** 检查运行环境是否就绪。 */
  static detect(logger = console) {
    /** 可能的 DSH 运行时位置 */
    const candidates = [
      path.join(process.env.USERPROFILE || '', 'Documents', 'deepseek-harness', 'default-workspace', 'wx-agent'),
      path.join(process.cwd(), '..', 'wx-agent'),
      path.join(process.cwd(), 'wx-agent'),
    ];

    for (const base of candidates) {
      const bin = path.join(base, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (!fs.existsSync(bin)) continue;

      const patch = path.join(base, 'acp-account.patch.yml');
      const extraArgs = fs.existsSync(patch) ? ['--patch', patch] : [];

      return { nodePath: process.env.DSH_NODE || process.execPath, dshBin: bin, extraArgs, base };
    }

    return null;
  }

  /**
   * 准备可写的 DSH_HOME 和临时目录。
   *
   * 为什么需要：DSH 会在 ~/.dsh/profiles/ 下写配置，
   * 在受限环境里会 EPERM。把它重定向到项目内即可。
   *
   * @param {string} projectRoot
   * @returns {{dshHome: string, tmpDir: string}}
   */
  static prepareHome(projectRoot) {
    const dshHome = path.join(projectRoot, '.dsh-home');
    const tmpDir = path.join(projectRoot, '.tmp', 'dsh');

    fs.mkdirSync(path.join(dshHome, 'profiles'), { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    // 复制现有配置和凭据（只复制一次）
    const src = path.join(process.env.USERPROFILE || '', '.dsh');

    const copyIfMissing = (from, to) => {
      try {
        if (!fs.existsSync(from) || fs.existsSync(to)) return;
        fs.cpSync(from, to, { recursive: true });
      } catch {}
    };

    copyIfMissing(path.join(src, 'profiles', 'acp'), path.join(dshHome, 'profiles', 'acp'));
    copyIfMissing(path.join(src, '.credentials.yaml'), path.join(dshHome, '.credentials.yaml'));

    return { dshHome, tmpDir };
  }

  /**
   * 向 DSH 提问。
   *
   * @param {string} question
   * @param {object} [opts]
   * @param {string} [opts.cwd] 执行目录
   * @returns {Promise<string>}
   */
  async ask(question, opts = {}) {
    const env = { ...process.env, NO_COLOR: '1', CI: '1' };

    // 把 DSH_HOME 和临时目录指向可写位置，
    // 否则 DSH 会尝试写 ~/.dsh 和系统 Temp，在某些环境下会 EPERM
    if (this.dshHome) env.DSH_HOME = this.dshHome;
    if (this.tmpDir) {
      env.TEMP = this.tmpDir;
      env.TMP = this.tmpDir;
      env.TMPDIR = this.tmpDir;
    }

    const child = spawn(
      this.nodePath,
      [this.dshBin, 'acp', ...this.extraArgs],
      {
        cwd: opts.cwd || this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        windowsHide: true,
      },
    );

    const pending = new Map();
    let nextId = 1;
    let assistantText = '';
    let stderrBuf = '';

    child.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-2000);
      if (process.env.DSH_DEBUG) this.log.warn?.(`[dsh] stderr: ${d.toString().trim().slice(0, 200)}`);
    });

    // 子进程起不来（路径错、权限不足）时，必须拒绝在等的请求，
    // 否则调用方会一直卡在 await 上，表现为「DSH 没反应」
    child.on('error', (e) => {
      this.log.warn?.(`[dsh] 子进程错误: ${e.message}`);
      for (const [, p] of pending) {
        try {
          p.reject(new Error(`DSH 启动失败: ${e.message}`));
        } catch {}
      }
      pending.clear();
    });

    // 子进程提前退出时同样要拒绝，否则永远等不到回复
    child.on('exit', (code, signal) => {
      if (pending.size) {
        this.log.warn?.(`[dsh] 进程提前退出 code=${code} signal=${signal}`);
        for (const [, p] of pending) {
          try {
            p.reject(new Error(`DSH 进程退出（code=${code}）`));
          } catch {}
        }
        pending.clear();
      }
    });

    const rl = readline.createInterface({ input: child.stdout });

    const cleanup = () => {
      try {
        rl.close();
      } catch {}
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill('SIGKILL');
      } catch {}
    };

    const request = (method, params, timeout = this.timeoutMs) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

        pending.set(id, { resolve, reject });

        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`DSH 响应超时（${method}）`));
          }
        }, timeout);
        timer.unref?.();

        child.stdin.write(payload + '\n', (err) => {
          if (err) {
            pending.delete(id);
            clearTimeout(timer);
            reject(err);
          }
        });
      });

    rl.on('line', (line) => {
      if (!line.trim()) return;

      if (process.env.DSH_DEBUG) this.log.info?.(`[dsh] ← ${line.slice(0, 200)}`);

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      // 响应
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }

      // 流式更新
      if (msg.method === 'session/update') {
        const u = msg.params?.update;
        if (u?.sessionUpdate === 'agent_message_chunk') {
          const c = u.content;
          if (c?.type === 'text' && c.text) assistantText += c.text;
        }
        return;
      }

      // 服务端请求（权限等）——一律拒绝
      if (msg.id !== undefined && msg.method) {
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unsupported' } }) + '\n',
        );
      }
    });

    try {
      this.log.info?.('[dsh] 启动 ACP 会话…');

      const initRes = await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });

      let sessionId = '';

      /**
       * 优先复用已有会话，让 DSH 那边也记得之前聊过什么。
       *
       * 以前每次都 session/new + session/close，等于每次都失忆 ——
       * 这就是「别人家的机器人能靠 DSH 记住上下文，我们不行」的根因。
       */
      if (opts.sessionId) {
        /**
         * 能力字段的位置：DSH 报的是
         *   agentCapabilities.sessionCapabilities: { close, list, resume }
         * 不是平铺的 sessionResume / loadSession，
         * 所以三种都认一下，任一存在就尝试恢复。
         */
        const caps = initRes?.agentCapabilities || {};
        const sc = caps.sessionCapabilities || {};
        const canResume = Boolean(sc.resume || caps.sessionResume || caps.resumeSession || caps.loadSession);

        if (canResume) {
          try {
            // 先试 resume（不重放历史，更省 token）
            await request('session/resume', {
              sessionId: opts.sessionId,
              cwd: opts.cwd || this.cwd,
              mcpServers: [],
            });
            sessionId = opts.sessionId;
            this.log.info?.(`[dsh] 已恢复会话 ${sessionId.slice(0, 8)}…`);
          } catch (e) {
            this.log.warn?.(`[dsh] 恢复会话失败，改用新会话：${e.message}`);
          }
        }
      }

      if (!sessionId) {
        const session = await request('session/new', {
          cwd: opts.cwd || this.cwd,
          mcpServers: [],
        });
        sessionId = session.sessionId;
      }

      this.log.info?.('[dsh] 已连接，提交问题…');

      await request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: question }],
      });

      // 注意：这里不 close 会话，DSH 那边要留着上下文下次接着用。
      // session/new 出来的会话本来就存在 DSH 的会话库里，
      // 进程退出不影响，下次用 session/resume 接回来。

      const text = assistantText.trim();
      if (!text) {
        throw new Error('DSH 返回了空内容');
      }

      // sessionId 交回调用方，存起来下次 resume
      this.lastSessionId = sessionId;

      if (opts.wantSessionId) {
        return { text, sessionId };
      }

      return text;
    } catch (e) {
      // 附带 stderr 帮助排查
      const detail = stderrBuf.trim().split('\n').slice(-3).join(' | ');
      throw new Error(`${e.message}${detail ? `（${detail}）` : ''}`);
    } finally {
      cleanup();
    }
  }
}
