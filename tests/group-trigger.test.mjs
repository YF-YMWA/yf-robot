/**
 * 群聊触发：别打断别人的对话。
 *
 * 用户反馈「群聊没说概率，会有误触发」。查下来两个来源：
 *   1. 接话窗口（默认 8 分钟）一开就无条件接话 —— 别人聊别的她也插嘴
 *   2. 「被骂」判定里有裸的「你」——「你个傻逼」冲别人开火也把她叫出来
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { GroupTrigger } from '../core/group.mjs';

function trig(over = {}) {
  return new GroupTrigger({
    requireAt: true,
    aliases: ['大肥鱼'],
    engagedMinutes: 8,
    engagedReplyChance: 0,
    masterAlwaysReply: true,
    maxRepliesPerHour: 1000,
    cooldownSec: 0,
    ...over,
  });
}

const engage = () => ({ engagedUntil: Date.now() + 600000, engagedBy: 'u1' });

test('窗口内不点名：按概率决定，概率 0 就不回', () => {
  const d = trig().decide({ text: '今天吃啥', senderId: 'u2', state: engage() });
  assert.equal(d.wake, false);
  assert.equal(d.reason, 'engaged_skip');
});

test('窗口内点名（@）：一定回', () => {
  const d = trig().decide({ text: '在吗', senderId: 'u2', atMe: true, state: engage() });
  assert.equal(d.wake, true);
  assert.equal(d.reason, 'addressed');
});

test('窗口内概率 1：照常接', () => {
  const d = trig({ engagedReplyChance: 1 }).decide({
    text: '今天吃啥',
    senderId: 'u1',
    state: engage(),
  });
  assert.equal(d.wake, true);
});

test('别人骂别人：不该把她叫出来', () => {
  const d = trig().decide({ text: '你个傻逼', senderId: 'u3', state: {} });
  assert.equal(d.wake, false, '「你」不是她的名字，不能当成冲她开火');
});

test('骂她（带她的名字）：要接', () => {
  const d = trig().decide({ text: '大肥鱼真傻', senderId: 'u3', state: {} });
  assert.equal(d.wake, true);
});

test('requireAt + freeChat 关闭：随便聊天不插话', () => {
  const d = trig({ freeChat: false }).decide({ text: '明天去哪玩', senderId: 'u9', state: {} });
  assert.equal(d.wake, false);
});

test('主人说话：alwaysReply 时必回', () => {
  const d = trig().decide({ text: '帮我看下', senderId: 'owner', isOwner: true, state: {} });
  assert.equal(d.wake, true);
  assert.equal(d.reason, 'owner');
});
