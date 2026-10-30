/**
 * 待审批的操作队列。
 *
 * 为什么需要：有了权限档位还不够 —— 档位是「事先定死」的，
 * 而真正危险的是「这一次」：她突然要写一个文件、跑一条命令。
 * 原则：危险操作当场问人，人点头才做 —— 档位是事先定死的，
 *
 * 微信场景下怎么问：她发一条「主人，要我写文件吗？回允许/拒绝」，
 * 主人回「允许」就执行，回「拒绝」就算了；5 分钟不回复自动作废。
 */
import fs from 'node:fs';
import path from 'node:path';

const TTL_MS = 5 * 60 * 1000;
const MAX_KEEP = 50;

export class ApprovalStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'data', 'approvals.json');
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
      // 只留未过期的，文件不会无限长
      this.items = this.items.filter((x) => x.status === 'pending' && Date.now() - x.at < TTL_MS);
      fs.writeFileSync(
        this.file,
        JSON.stringify({ seq: this.seq, items: this.items.slice(-MAX_KEEP) }, null, 2),
        'utf8',
      );
    } catch {
      /* 写不下去也不能影响主流程 */
    }
  }

  /**
   * 登记一个待审批操作。
   * @returns {{id:string, at:number}}
   */
  add({ chatId, tool, args, reason }) {
    this.seq += 1;
    const item = {
      id: 'ap' + this.seq,
      chatId: String(chatId || ''),
      tool,
      args: args && typeof args === 'object' ? args : {},
      reason: String(reason || ''),
      at: Date.now(),
      status: 'pending',
    };
    this.items.push(item);
    this.save();
    return { id: item.id, at: item.at, tool, args: item.args };
  }

  /** 取这个会话里最近一条待审批（过期的顺手清掉） */
  latest(chatId) {
    const now = Date.now();
    this.items = this.items.filter((x) => x.status === 'pending' && now - x.at < TTL_MS);
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].chatId === String(chatId || '')) return this.items[i];
    }
    return null;
  }

  /** 标记结果 */
  resolve(id, status) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return null;
    it.status = status;
    it.resolvedAt = Date.now();
    this.save();
    return it;
  }

  /** 当前挂着的（给面板看） */
  pending() {
    const now = Date.now();
    return this.items.filter((x) => x.status === 'pending' && now - x.at < TTL_MS);
  }
}

/** 主人回复是不是「同意」 */
export function isApproveText(text) {
  const t = String(text || '').trim();
  return /^(允许|同意|可以|好|行|准|批准|yes|y|ok|okay)$/i.test(t);
}

/** 主人回复是不是「拒绝」 */
export function isDenyText(text) {
  const t = String(text || '').trim();
  return /^(拒绝|不行|不许|不准|不要|别|no|n|stop)$/i.test(t);
}

export const APPROVAL_TTL_MS = TTL_MS;
