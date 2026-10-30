/**
 * git 工作副本：别只拒绝，给出能照做的命令。
 *
 * 现在的问题：检测到 .git 就直接报「请自己 git pull」，
 * 用户不知道在哪个目录、拉哪个分支、要不要先 stash。
 *
 * 这里读一下真实状态（分支、有无未提交改动、落后几个提交），
 * 生成一段可以照抄的命令，并把命令单独返回给面板显示成代码块。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function git(root, args, timeout = 8000) {
  try {
    return String(
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        timeout,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).trim();
  } catch {
    return '';
  }
}

/**
 * 分析 git 副本状态，给出更新建议。
 *
 * @param {string} root
 * @param {string} latest 远端最新版本（如 0.9.17）
 * @returns {{isGit:boolean, branch:string, dirty:boolean, hasGit:boolean, behind:number, commands:string[], text:string}}
 */
export function gitUpdateHint(root, latest) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    return { isGit: false, hasGit: false, branch: '', dirty: false, behind: 0, commands: [], text: '' };
  }

  const hasGit = Boolean(git(root, ['--version']));
  if (!hasGit) {
    return {
      isGit: true,
      hasGit: false,
      branch: '',
      dirty: false,
      behind: 0,
      commands: [],
      text: '这是 git 副本，但机器上找不到 git 命令。请装 Git，或改用发行包覆盖（会保留 config.json 和 data/）。',
    };
  }

  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
  const dirty = Boolean(git(root, ['status', '--porcelain']));
  // 落后几个提交（本地可能还没 fetch，这里只做尽力而为的判断）
  const behindRaw = git(root, ['rev-list', '--count', `HEAD..origin/${branch}`]);
  const behind = Number(behindRaw) || 0;

  const commands = [];
  if (dirty) {
    commands.push('# 先把你本地的改动存起来（没有改动就跳过这步）');
    commands.push('git stash push -u -m "更新前暂存"');
  }
  commands.push('# 在程序目录里执行：');
  commands.push('git fetch origin');
  commands.push(`git checkout ${branch}`);
  commands.push('git pull --ff-only');
  if (dirty) {
    commands.push('# 更新完把刚才的改动放回来（有冲突再手动处理）');
    commands.push('git stash pop');
  }
  commands.push('# 然后重启服务（面板「运行」页有一键重启）');

  const parts = [];
  parts.push(`这是 git 副本（分支 ${branch}${dirty ? '，有未提交的改动' : '，工作区干净'}）。`);
  parts.push('面板不覆盖 git 副本 —— 那样会把你的提交冲掉。');
  parts.push(
    latest
      ? `远端最新是 v${latest}；` + (behind ? `你落后 ${behind} 个提交。` : '先 fetch 看看落后多少。')
      : '先 fetch 看看远端有什么。',
  );
  if (dirty) parts.push('⚠ 你有未提交的改动，先 stash，否则拉取可能被拒绝。');

  return { isGit: true, hasGit: true, branch, dirty, behind, commands, text: parts.join('\n') };
}
