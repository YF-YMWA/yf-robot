/**
 * git 副本的更新提示。
 *
 * 之前只回一句「请自己 git pull」，用户不知道在哪个目录、拉哪个分支、
 * 有未提交改动怎么办。现在给出能照抄的命令。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitUpdateHint } from '../core/git-hint.mjs';

const TMP = path.join(process.cwd(), '.tmp', 'githint-test');

function makeRepo(name) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

test('不是 git 副本：返回 isGit=false，不打扰', () => {
  const dir = makeRepo('plain');
  const h = gitUpdateHint(dir, '0.9.17');
  assert.equal(h.isGit, false);
  assert.deepEqual(h.commands, []);
});

test('git 副本：给出 stash / fetch / pull 的命令', (t) => {
  if (!hasGit()) {
    t.skip('机器上没有 git');
    return;
  }

  const dir = makeRepo('repo');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

  const h = gitUpdateHint(dir, '0.9.17');
  assert.equal(h.isGit, true);
  assert.equal(h.hasGit, true);
  assert.equal(h.branch, 'main');
  assert.equal(h.dirty, false, '干净的工作区应报 dirty=false');
  assert.ok(h.commands.some((c) => c.includes('git fetch')));
  assert.ok(h.commands.some((c) => c.includes('git pull --ff-only')));
  assert.ok(!h.commands.some((c) => c.includes('stash')), '干净时不该建议 stash');
});

test('有未提交改动：提示先 stash', (t) => {
  if (!hasGit()) {
    t.skip('机器上没有 git');
    return;
  }

  const dir = makeRepo('dirty');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v2'); // 未提交

  const h = gitUpdateHint(dir, '0.9.17');
  assert.equal(h.dirty, true);
  assert.ok(h.commands.some((c) => c.includes('git stash')), '脏工作区应先 stash');
  assert.match(h.text, /未提交/);
});
