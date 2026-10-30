/**
 * 定时任务。
 *
 * 场景：「每天 8 点发早安」「每两小时看看有没有人找我」「晚上 11 点提醒睡觉」。
 * 不做完整 cron（太复杂、也容易写错），只支持三种最常用的：
 *
 *   daily  每天 HH:MM
 *   every  每 N 分钟
 *   once   指定时刻（毫秒时间戳）发一次
 *
 * 到点做的事：交给 JobStore 起一个后台作业 ——
 * 和画图共用同一条待发队列，适配器那边的轮询自然就发出去了。
 */
import fs from 'node:fs';
import path from 'node:path';

const TICK_MS = 20 * 1000;

export class Scheduler {
  constructor(root, opts = {}) {
    this.root = root;
    this.file = path.join(root, 'data', 'schedules.json');
    this.log = opts.logger || console;
    this.jobs = opts.jobs || null;
    this.compose = opts.compose || null; // (item) => Promise<{text, images}>
    this.timer = null;
    this.items = [];
    this.seq = 0;
    this.load();
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = Array.isArray(j.items) ? j.items : [];
      this.seq = Number(j.seq) || 0;
    } catch {
      this.items = [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        this.file,
        JSON.stringify({ seq: this.seq, items: this.items }, null, 2),
        'utf8',
      );
    } catch {
      /* 落盘失败不影响运行 */
    }
  }

  /**
   * 加一条。
   * @param {{kind:string, at?:string, everyMinutes?:number, timestamp?:number, chatId:string, text?:string, prompt?:string}} p
   */
  add(p = {}) {
    const kind = ['daily', 'every', 'once'].includes(p.kind) ? p.kind : 'daily';
    if (kind === 'daily') {
      const m = String(p.at || '').match(/^(\d{1,2}):(\d{2})$/);
      const hh = m ? Number(m[1]) : -1;
      const mm = m ? Number(m[2]) : -1;
      // 光靠正则不够：25:99 也能匹配 \d{1,2}:\d{2}，得看真实范围
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
        return { ok: false, error: 'daily 的 at 要是 00:00 ~ 23:59，格式 HH:MM' };
      }
    }
    if (kind === 'every' && !(Number(p.everyMinutes) > 0)) {
      return { ok: false, error: 'every 需要 everyMinutes（大于 0）' };
    }
    if (kind === 'once' && !(Number(p.timestamp) > Date.now())) {
      return { ok: false, error: 'once 需要一个未来的 timestamp（毫秒）' };
    }
    if (!String(p.chatId || '').trim()) return { ok: false, error: '要指定发给谁（chatId）' };
    if (!String(p.text || p.prompt || '').trim()) return { ok: false, error: '要有内容（text 或 prompt）' };

    this.seq += 1;
    const item = {
      id: 'sch' + this.seq,
      kind,
      at: String(p.at || ''),
      everyMinutes: Math.max(1, Math.round(Number(p.everyMinutes) || 0)),
      timestamp: Number(p.timestamp) || 0,
      chatId: String(p.chatId).trim(),
      text: String(p.text || ''),
      prompt: String(p.prompt || ''),
      enabled: true,
      lastAt: 0,
      createdAt: Date.now(),
    };
    this.items.push(item);
    this.save();
    return { ok: true, item };
  }

  list() {
    return this.items.map((x) => ({ ...x }));
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    this.save();
    return { ok: this.items.length < before };
  }

  /**
   * 这一条现在该不该触发？
   *
   * @param {object} item
   * @param {Date} now
   * @param {number} lastAt 上次触发时间（毫秒）
   */
  static isDue(item, now, lastAt) {
    if (!item.enabled) return false;
    const nowMs = now.getTime();

    if (item.kind === 'once') {
      return item.timestamp > 0 && nowMs >= item.timestamp && !lastAt;
    }

    if (item.kind === 'every') {
      const gap = item.everyMinutes * 60 * 1000;
      return !lastAt || nowMs - lastAt >= gap;
    }

    if (item.kind === 'daily') {
      const [hh, mm] = String(item.at).split(':').map(Number);
      const today = new Date(now);
      today.setHours(hh, mm, 0, 0);
      const target = today.getTime();
      // 到了点，且今天还没发过（2 分钟内算「刚到点」）
      const withinWindow = nowMs >= target && nowMs - target < 2 * 60 * 1000;
      const sentToday =
        lastAt > 0 && new Date(lastAt).toDateString() === now.toDateString();
      return withinWindow && !sentToday;
    }

    return false;
  }

  /** 跑一次检查（测试里直接调它，不用等定时器） */
  async tick(now = new Date()) {
    const fired = [];
    for (const item of this.items) {
      if (!Scheduler.isDue(item, now, item.lastAt || 0)) continue;

      item.lastAt = now.getTime();
      if (item.kind === 'once') item.enabled = false;
      this.save();

      fired.push(item);

      const run = async () => {
        // 有 prompt 就让模型现写，没有就用固定文案
        if (this.compose) {
          const out = await this.compose(item);
          if (out && (out.text || out.images?.length)) return out;
        }
        return { text: item.text || '（到点了）', images: [] };
      };

      if (this.jobs) {
        this.jobs.start({ chatId: item.chatId, kind: '定时', run, logger: this.log });
      } else {
        // 没有作业队列时直接跑，至少不丢
        await run().catch(() => {});
      }
      this.log.info?.(`[schedule] ${item.id} 触发（${item.kind}）`);
    }
    return fired;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log.warn?.('[schedule] tick 失败：' + e.message));
    }, TICK_MS);
    this.timer.unref?.();
    this.log.info?.(`[schedule] 已启动，共 ${this.items.length} 条`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
