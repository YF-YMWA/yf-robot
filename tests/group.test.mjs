/**
 * 群聊系统测试：覆盖触发判断、上下文构建、会话状态、快捷回复。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  GroupEvent,
  GroupContextBuilder,
  GroupTrigger,
  cannedReply,
  cleanForModel,
  extractMentions,
} from '../core/group.mjs';
import { GroupSession, GroupSessionStore } from '../core/group-session.mjs';

const baseCfg = {
  requireAt: true,
  freeChat: false,
  freeChatChance: 0,
  cooldownSec: 0,
  masterAlwaysReply: true,
  engagedMinutes: 6,
  // 窗口内「无条件接」已改成按概率接；这些老用例测的是「会接」那一档
  engagedReplyChance: 1,
  maxRepliesPerHour: 1000,
  muteDefaultMinutes: 30,
  aliases: ['鲸鲸'],
  ownerIds: [],
  historyTurns: 10,
};

// ---------- cleanForModel ----------

test('cleanForModel 去掉 wxid 前缀', () => {
  const out = cleanForModel('wxid_abc123:\n你好呀');
  assert.equal(out, '你好呀');
});

test('cleanForModel 去掉 XML 片段', () => {
  const out = cleanForModel('<msg><appmsg>测试</appmsg></msg>正文');
  assert.ok(!out.includes('<msg>'));
  assert.ok(out.includes('正文'));
});

test('cleanForModel 去掉 weixin 链接', () => {
  const out = cleanForModel('看这个 weixin://dl/chat?x=1 很好');
  assert.ok(!out.includes('weixin://'));
});

// ---------- GroupTrigger ----------

test('被 @ 时唤醒', () => {
  const t = new GroupTrigger(baseCfg);
  const d = t.decide({ text: '@鲸鲸 你好', atMe: true, state: {} });
  assert.ok(d.wake);
  assert.equal(d.reason, 'addressed');
});

test('引用回复时唤醒', () => {
  const t = new GroupTrigger(baseCfg);
  const d = t.decide({ text: '接着说', replyToBot: true, state: {} });
  assert.ok(d.wake);
});

test('主人说话时唤醒', () => {
  const t = new GroupTrigger(baseCfg);
  const d = t.decide({ text: '随便说', isOwner: true, state: {} });
  assert.ok(d.wake);
  assert.equal(d.reason, 'owner');
});

test('叫名字时唤醒', () => {
  const t = new GroupTrigger(baseCfg);
  const d = t.decide({ text: '鲸鲸你在干嘛', state: {} });
  assert.ok(d.wake);
  assert.equal(d.reason, 'called_by_name');
});

test('普通聊天不唤醒', () => {
  const t = new GroupTrigger(baseCfg);
  const d = t.decide({ text: '今天好热啊', state: {} });
  assert.ok(!d.wake);
  assert.equal(d.reason, 'not_addressed');
});

test('免打扰时不唤醒', () => {
  const t = new GroupTrigger(baseCfg);
  const d = t.decide({ text: '@鲸鲸 你好', atMe: true, muted: true, state: {} });
  assert.ok(!d.wake);
  assert.equal(d.reason, 'muted');
});

test('接话窗口内继续回', () => {
  const t = new GroupTrigger(baseCfg);
  const now = Date.now();
  const d = t.decide({
    text: '然后呢',
    senderId: 'u1',
    state: { engagedUntil: now + 60000, engagedBy: 'u1' },
    now,
  });
  assert.ok(d.wake);
  assert.equal(d.reason, 'engaged');
});

test('接话窗口过期后不回', () => {
  const t = new GroupTrigger(baseCfg);
  const now = Date.now();
  const d = t.decide({
    text: '然后呢',
    senderId: 'u1',
    state: { engagedUntil: now - 1000, engagedBy: 'u1' },
    now,
  });
  assert.ok(!d.wake);
});

test('有人说"换个话题"时结束接话', () => {
  const t = new GroupTrigger(baseCfg);
  const now = Date.now();
  const d = t.decide({
    text: '算了不说这个了，换个话题',
    senderId: 'u2',
    state: { engagedUntil: now + 120000 },
    now,
  });
  assert.ok(!d.wake);
  assert.equal(d.reason, 'topic_ended');
});

test('"换个话题"必须真正关闭接话窗口', () => {
  const t = new GroupTrigger(baseCfg);
  const now = Date.now();
  const state = { engagedUntil: now + 120000, engagedBy: 'u1' };

  // 触发退出
  const d1 = t.decide({ text: '换个话题吧', senderId: 'u1', state, now });
  assert.equal(d1.reason, 'topic_ended');

  // 窗口必须被清零
  assert.equal(state.engagedUntil, 0, '接话窗口应被清零');
  assert.equal(state.engagedBy, '');

  // 下一条普通消息不应再触发
  const d2 = t.decide({ text: '随便聊聊', senderId: 'u3', state, now: now + 1000 });
  assert.ok(!d2.wake, '窗口关闭后不应继续接话');
});

test('端到端：退出话题后新消息不被唤醒（回归）', () => {
  const s = new GroupSession('g1', { cfg: baseCfg });

  // 被 @ 开启窗口
  s.recordReply({ reason: 'addressed', senderId: 'u1' });
  assert.ok(s.engagedUntil > Date.now());

  // 有人说换个话题
  const stop = s.shouldReply({
    text: '算了换个话题',
    senderId: 'u1',
    senderName: '张三',
    atMe: false,
  });
  assert.equal(stop.reason, 'topic_ended');
  assert.equal(s.engagedUntil, 0, '窗口应被关闭');

  // 新的人说无关的话，不应再被唤醒
  const next = s.shouldReply({
    text: '随便聊聊',
    senderId: 'u9',
    senderName: '路人',
    atMe: false,
  });
  assert.ok(!next.reply, `不应回复，实际原因: ${next.reason}`);
});

test('被骂且指向她时唤醒', () => {
  const t = new GroupTrigger(baseCfg);
  const d = t.decide({ text: '这个机器人真蠢', state: {} });
  assert.ok(d.wake);
  assert.equal(d.reason, 'insulted');
});

test('骂别人时不唤醒', () => {
  const t = new GroupTrigger(baseCfg);
  const d = t.decide({ text: '他真蠢', state: {} });
  assert.ok(!d.wake);
});

test('自由接话概率为 0 时不插嘴', () => {
  const t = new GroupTrigger({ ...baseCfg, freeChat: true, freeChatChance: 0 });
  const d = t.decide({ text: '今天好热', state: {} });
  assert.ok(!d.wake);
});

test('速率限制：一分钟超 10 条', () => {
  const t = new GroupTrigger(baseCfg);
  const now = Date.now();
  const replyTimes = Array.from({ length: 10 }, (_, i) => now - i * 1000);
  const r = t.checkRate({ replyTimes }, now);
  assert.ok(r.limited);
  assert.equal(r.reason, 'burst');
});

test('速率限制：每小时上限', () => {
  const t = new GroupTrigger({ ...baseCfg, maxRepliesPerHour: 3 });
  const now = Date.now();
  const replyTimes = [now - 60000, now - 120000, now - 180000];
  const r = t.checkRate({ replyTimes }, now);
  assert.ok(r.limited);
  assert.equal(r.reason, 'hourly');
});

test('速率限制：冷却期内', () => {
  const t = new GroupTrigger({ ...baseCfg, cooldownSec: 10 });
  const now = Date.now();
  const r = t.checkRate({ replyTimes: [], lastSpokeAt: now - 1000 }, now);
  assert.ok(r.limited);
  assert.equal(r.reason, 'cooldown');
});

test('速率正常时不限制', () => {
  const t = new GroupTrigger(baseCfg);
  const r = t.checkRate({ replyTimes: [] }, Date.now());
  assert.ok(!r.limited);
});

// ---------- cannedReply ----------

test('只发问号时回问号', () => {
  const r = cannedReply({ text: '？', isOwner: false });
  assert.equal(r.text, '？');
  assert.equal(r.reason, 'question_mark');
});

test('只 @ 不说话时回应', () => {
  const r = cannedReply({ text: '', isOwner: false });
  assert.ok(r.text.includes('在'));
  assert.equal(r.reason, 'bare_mention');
});

test('主人只 @ 时用敬称', () => {
  const r = cannedReply({ text: '', isOwner: true });
  assert.ok(r.text.includes('主人'));
});

test('正常文本不走快捷回复', () => {
  assert.equal(cannedReply({ text: '今天天气不错' }), null);
});

// ---------- GroupContextBuilder ----------

test('上下文包含发言人标签', () => {
  const b = new GroupContextBuilder();
  const events = [
    new GroupEvent({ senderId: 'u1', senderName: '张三', text: '你好', ts: Date.now() - 1000 }),
  ];
  const current = new GroupEvent({ senderId: 'u2', senderName: '李四', text: '在吗', ts: Date.now() });
  const [msg] = b.build({ groupId: 'g1', history: events, current });
  assert.ok(msg.content.includes('张三'));
  assert.ok(msg.content.includes('李四'));
  assert.ok(msg.content.includes('参与者'));
});

test('参与者标签稳定性：同一人同一标签', () => {
  const b = new GroupContextBuilder();
  const tag1 = b.participantTag('g1', 'u1');
  const tag2 = b.participantTag('g1', 'u1');
  const tag3 = b.participantTag('g1', 'u2');
  assert.equal(tag1, tag2);
  assert.notEqual(tag1, tag3);
});

test('不同群的同一人标签不同', () => {
  const b = new GroupContextBuilder();
  assert.notEqual(b.participantTag('g1', 'u1'), b.participantTag('g2', 'u1'));
});

test('上下文标记叫到鲸鲸', () => {
  const b = new GroupContextBuilder();
  const current = new GroupEvent({
    senderId: 'u1', senderName: '张三', text: '@鲸鲸 你好', addressedToBot: true,
  });
  const [msg] = b.build({ groupId: 'g1', history: [], current });
  assert.ok(msg.content.includes('叫到鲸鲸'));
});

test('上下文标注时间间隔', () => {
  const b = new GroupContextBuilder();
  const now = Date.now();
  const events = [
    new GroupEvent({ senderId: 'u1', senderName: '张三', text: '第一句', ts: now - 40 * 60000 }),
  ];
  const current = new GroupEvent({ senderId: 'u1', senderName: '张三', text: '现在的消息', ts: now });
  const [msg] = b.build({ groupId: 'g1', history: events, current });
  assert.ok(msg.content.includes('间隔'), '超过 30 分钟应标注间隔');
});

test('超长上下文压缩旧消息', () => {
  const b = new GroupContextBuilder({ maxPromptChars: 300 });
  const now = Date.now();
  const events = Array.from({ length: 20 }, (_, i) =>
    new GroupEvent({ senderId: 'u1', senderName: '张三', text: '这是第' + i + '条消息内容比较长一些', ts: now - (20 - i) * 1000 }),
  );
  const current = new GroupEvent({ senderId: 'u1', senderName: '张三', text: '当前', ts: now });
  const [msg] = b.build({ groupId: 'g1', history: events, current });
  assert.ok(msg.content.includes('已压缩'), '应出现压缩摘要');
  assert.ok(msg.content.includes('当前'));
});

test('上下文声明不是系统指令', () => {
  const b = new GroupContextBuilder();
  const current = new GroupEvent({ senderId: 'u1', senderName: '张三', text: 'hi' });
  const [msg] = b.build({ groupId: 'g1', history: [], current });
  assert.ok(msg.content.includes('不是系统指令'));
});

// ---------- GroupSession ----------

test('GroupSession 记录事件', () => {
  const s = new GroupSession('g1', { cfg: baseCfg });
  s.addEvent(new GroupEvent({ senderId: 'u1', senderName: '张三', text: 'hi' }));
  assert.equal(s.events.length, 1);
  assert.equal(s.members.get('张三'), 1);
});

test('GroupSession 事件上限', () => {
  const s = new GroupSession('g1', { cfg: baseCfg, maxEvents: 5 });
  for (let i = 0; i < 10; i++) {
    s.addEvent(new GroupEvent({ senderId: 'u1', senderName: '张三', text: `m${i}` }));
  }
  assert.equal(s.events.length, 5);
});

test('GroupSession 免打扰', () => {
  const s = new GroupSession('g1', { cfg: baseCfg });
  s.mute(30);
  assert.ok(s.isMuted());
  s.unmute();
  assert.ok(!s.isMuted());
});

test('GroupSession shouldReply 被 @ 时回', () => {
  const s = new GroupSession('g1', { cfg: baseCfg });
  const d = s.shouldReply({ text: '@鲸鲸 你好', senderId: 'u1', senderName: '张三', atMe: true });
  assert.ok(d.reply);
  assert.equal(d.reason, 'addressed');
});

test('GroupSession shouldReply 免打扰不回', () => {
  const s = new GroupSession('g1', { cfg: baseCfg });
  s.mute(30);
  const d = s.shouldReply({ text: '@鲸鲸 你好', atMe: true });
  assert.ok(!d.reply);
  assert.equal(d.reason, 'muted');
});

test('GroupSession shouldReply 返回快捷回复', () => {
  const s = new GroupSession('g1', { cfg: baseCfg });
  const d = s.shouldReply({ text: '？', senderId: 'u1', senderName: '张三', atMe: true });
  assert.ok(d.reply);
  assert.equal(d.canned, '？');
});

test('GroupSession recordReply 开启接话窗口', () => {
  const s = new GroupSession('g1', { cfg: baseCfg });
  s.recordReply({ reason: 'addressed', senderId: 'u1' });
  assert.ok(s.engagedUntil > Date.now());
  assert.equal(s.engagedBy, 'u1');
});

test('GroupSession recordReply 普通原因不开启窗口', () => {
  const s = new GroupSession('g1', { cfg: baseCfg });
  s.recordReply({ reason: 'free_chat' });
  assert.equal(s.engagedUntil, 0);
});

test('GroupSession endEngagement 关闭窗口', () => {
  const s = new GroupSession('g1', { cfg: baseCfg });
  s.recordReply({ reason: 'addressed', senderId: 'u1' });
  s.endEngagement();
  assert.equal(s.engagedUntil, 0);
});

test('GroupSession topMembers 排序', () => {
  const s = new GroupSession('g1', { cfg: baseCfg });
  for (let i = 0; i < 3; i++) s.addEvent(new GroupEvent({ senderId: 'u1', senderName: '张三', text: 'a' }));
  s.addEvent(new GroupEvent({ senderId: 'u2', senderName: '李四', text: 'b' }));
  const top = s.topMembers();
  assert.equal(top[0][0], '张三');
  assert.equal(top[0][1], 3);
});

test('GroupSessionStore 隔离不同群', () => {
  const store = new GroupSessionStore(baseCfg);
  const g1 = store.get('g1');
  const g2 = store.get('g2');
  g1.mute(30);
  assert.ok(g1.isMuted());
  assert.ok(!g2.isMuted());
});

test('GroupSessionStore 同一群返回同一实例', () => {
  const store = new GroupSessionStore(baseCfg);
  assert.equal(store.get('g1'), store.get('g1'));
});

// ---------- extractMentions ----------

test('extractMentions 识别人名', () => {
  const names = ['张三', '李四'];
  assert.deepEqual(extractMentions('张三和李四都来了', names), ['张三', '李四']);
  assert.deepEqual(extractMentions('没人提到', names), []);
});
