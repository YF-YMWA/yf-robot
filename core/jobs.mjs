/**
 * 后台作业：长任务先回话，做完再补一条。
 *
 * 为什么要做：
 *   画一张图要 8~12 秒，搜网页要 3~5 秒。现在是同步等 ——
 *   用户发一句「画只猫」，界面上什么都不动十几秒，很像卡死。
 *   智能体框架的做法是「扔后台、先应答、完成再推一条」。
 *
 * 我们这边的"推"：适配器本来就定时轮询核心（拉主动搭话），
 * 这里再加一个待发队列，它顺手一起拉走。
 */
import fs from 'node:fs';
import path from 'node:path';

const KEEP_MS = 30 * 60 * 1000;

export class JobStore {
  constructor(root, opts = {}) {
    this.root = root;
    this.file = path.join(root, 'data', 'jobs.json');
    this.log = opts.logger || console;
    this.seq = 0;
    /** 成功完成的、还没被取走的消息 */
    this.outbox = [];
    this.jobs = [];
    this.load();
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.seq = Number(j.seq) || 0;
      this.jobs = Array.isArray(j.jobs) ? j.jobs : [];
      this.outbox = Array.isArray(j.outbox) ? j.outbox : [];
    } catch {
      this.jobs = [];
      this.outbox = [];
    }
  }

  save() {
    try {
      const now = Date.now();
      this.jobs = this.jobs.filter((x) => now - (x.at || 0) < KEEP_MS).slice(-100);
      this.outbox = this.outbox.filter((x) => now - (x.at || 0) < KEEP_MS).slice(-100);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        this.file,
        JSON.stringify({ seq: this.seq, jobs: this.jobs, outbox: this.outbox }, null, 2),
        'utf8',
      );
    } catch {
      /* 落盘失败不影响主流程 */
    }
  }

  /**
   * 起一个后台作业。
   *
   * @param {object} p
   * @param {string} p.chatId 完成后把结果推给谁
   * @param {string} p.kind 作业类型（画图/搜索…）
   * @param {Function} p.run 实际的异步工作，返回 {text?, images?}
   */
  start({ chatId, kind, run, logger }) {
    this.seq += 1;
    const id = 'job' + this.seq;
    const job = { id, chatId: String(chatId || ''), kind, at: Date.now(), status: 'running' };
    this.jobs.push(job);
    this.save();

    const log = logger || this.log;

    Promise.resolve()
      .then(run)
      .then((out) => {
        job.status = 'done';
        job.doneAt = Date.now();
        const text = String(out?.text || '').trim();
        const images = Array.isArray(out?.images) ? out.images : [];
        if (text || images.length) {
          this.outbox.push({
            id: 'out' + this.seq,
            chatId: job.chatId,
            kind,
            text,
            images,
            at: Date.now(),
          });
          log.info?.(`[job] ${id} 完成：${text.slice(0, 30)}${images.length ? ' +' + images.length + ' 图' : ''}`);
        }
        this.save();
      })
      .catch((e) => {
        job.status = 'failed';
        job.error = String(e?.message || e).slice(0, 200);
        job.doneAt = Date.now();
        this.outbox.push({
          id: 'out' + this.seq,
          chatId: job.chatId,
          kind,
          text: `（那个${kind}没成：${job.error.slice(0, 60)}）`,
          images: [],
          at: Date.now(),
        });
        log.warn?.(`[job] ${id} 失败：${job.error}`);
        this.save();
      });

    return { id, kind };
  }

  /** 取走某个会话的待发消息（取走即清） */
  takeOutbox(chatId) {
    const id = String(chatId || '');
    const mine = this.outbox.filter((x) => !id || x.chatId === id);
    if (!mine.length) return [];
    this.outbox = this.outbox.filter((x) => id && x.chatId !== id);
    this.save();
    return mine;
  }

  /** 有没有在跑的作业 */
  running(chatId) {
    const id = String(chatId || '');
    return this.jobs.filter((x) => x.status === 'running' && (!id || x.chatId === id));
  }
}
