"""解压发行的 zip，在干净目录里跑全功能测试。

验证的是「别人拿到这个包会怎样」：
  解压 → 检查文件齐不齐 → 确认没带 Key → 临时填一份带 Key 的配置 →
  起服务 → 跑全套功能测试 → 收尾

全程在独立目录（default-workspace/pkg-e2e），不碰开发目录的 data/。

用法：
  python tools/test_package.py YF-Robot-v0.2.zip
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIP = os.path.join(BASE, sys.argv[1] if len(sys.argv) > 1 else 'YF-Robot-v0.2.zip')
WORK = os.path.join(os.path.dirname(BASE), 'pkg-e2e')
NODE = os.path.join(BASE, 'runtime', 'node.exe')
PORT = 19750

OUT = os.path.join(BASE, 'data', 'pkg-e2e-report.txt')
L = []


def log(m=''):
    L.append(str(m))
    print(m)


def http_ok(url, timeout=3, token=None):
    """访问一个地址，返回是否 200。带 token 时加管理令牌头。"""
    try:
        req = urllib.request.Request(url)
        if token:
            req.add_header('x-local-token', token)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    if not os.path.exists(ZIP):
        log('找不到 %s' % ZIP)
        return 1

    log('=== 1. 解压 ===')
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK, exist_ok=True)
    t0 = time.time()
    with zipfile.ZipFile(ZIP) as z:
        names = z.namelist()
        z.extractall(WORK)
    log('  包: %s（%.1f MB）' % (os.path.basename(ZIP), os.path.getsize(ZIP) / 1024 / 1024))
    log('  条目: %d 个，解压耗时 %.1fs' % (len(names), time.time() - t0))

    landed = 0
    for _dp, _dn, fns in os.walk(WORK):
        landed += len(fns)
    log('  落地文件: %d 个' % landed)

    log('')
    log('=== 2. 关键文件 ===')
    must = [
        'YF-Robot.bat', '启动服务.bat', '状态面板.bat', '工具菜单.bat',
        'app.mjs', 'config.json', 'config.example.json',
        'LICENSE', 'NOTICE', 'README.md', '使用说明.md',
        'docs/adapter-protocol.md', 'examples/adapter-skeleton/adapter.mjs',
        'core/media-ingest.mjs',
        'runtime/node.exe', 'runtime/python/python.exe',
    ]
    missing = []
    for m in must:
        ok = os.path.exists(os.path.join(WORK, m))
        if not ok:
            missing.append(m)
        log('  %-34s %s' % (m, '有' if ok else '缺 ✗'))
    log('  缺失 %d 个' % len(missing))

    log('')
    log('=== 3. 分发包配置检查 ===')
    cfg = json.loads(open(os.path.join(WORK, 'config.json'), encoding='utf-8').read())
    keyed = [k for k in ('llm', 'vision', 'voice', 'search', 'imagegen')
             if (cfg.get(k) or {}).get('apiKey')]
    log('  带 Key 的项: %s' % (keyed or '无（正确）'))
    log('  owner.wxids: %s' % ((cfg.get('owner') or {}).get('wxids') or '空（正确）'))

    bcfg_path = os.path.join(WORK, 'bridge', 'config.json')
    if os.path.exists(bcfg_path):
        b = json.loads(open(bcfg_path, encoding='utf-8').read())
        bk = [k for k in ('llm', 'vision', 'voice', 'search', 'imagegen')
              if (b.get(k) or {}).get('apiKey')]
        log('  桥接配置带 Key: %s' % (bk or '无（正确）'))

    log('')
    log('=== 4. 准备运行（临时填一份带 Key 的配置）===')
    src = json.loads(open(os.path.join(BASE, 'config.json'), encoding='utf-8').read())
    src.setdefault('server', {})['port'] = PORT
    src['server']['autoPort'] = False
    with open(os.path.join(WORK, 'config.json'), 'w', encoding='utf-8') as f:
        json.dump(src, f, ensure_ascii=False, indent=2)
    log('  端口 %d' % PORT)

    log('')
    log('=== 5. 启动 ===')
    out_p = os.path.join(BASE, 'data', 'pkg-e2e.out.log')
    err_p = os.path.join(BASE, 'data', 'pkg-e2e.err.log')
    out = open(out_p, 'w', encoding='utf-8')
    err = open(err_p, 'w', encoding='utf-8')

    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    proc = subprocess.Popen([NODE, 'app.mjs', '--no-open'], cwd=WORK,
                            stdout=out, stderr=err, creationflags=flags)

    up = False
    waited = 0
    for i in range(40):
        time.sleep(1)
        waited = i + 1
        if http_ok('http://127.0.0.1:%d/api/status' % PORT):
            up = True
            break

    log('  服务: %s（PID %d，等了 %ds）' % ('起来了' if up else '没起来 ✗', proc.pid, waited))
    if up:
        tok = open(os.path.join(WORK, 'data', 'token.txt'), encoding='utf-8').read().strip()
        log('  %-18s %s' % ('/console', '200' if http_ok('http://127.0.0.1:%d/console' % PORT) else '失败'))
        log('  %-18s %s' % ('/api/admin/config',
                            '200' if http_ok('http://127.0.0.1:%d/api/admin/config' % PORT, token=tok) else '失败'))

    if not up:
        out.close()
        err.close()
        log('')
        log('--- stderr 最后 20 行 ---')
        try:
            for l in open(err_p, encoding='utf-8').read().split('\n')[-20:]:
                if l.strip():
                    log('  ' + l)
        except Exception:
            pass
        try:
            proc.terminate()
        except Exception:
            pass
        open(OUT, 'w', encoding='utf-8').write('\n'.join(L))
        return 1

    log('')
    log('=== 6. 全功能测试（打这个解压实例）===')
    env = dict(os.environ)
    env['YF_BASE'] = 'http://127.0.0.1:%d' % PORT
    env['YF_GROUP'] = 'http://127.0.0.1:%d' % (PORT + 1)
    r = subprocess.run([NODE, os.path.join(BASE, 'tools', 'test-all-features.mjs')],
                       cwd=WORK, env=env, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=900)
    tail = (r.stdout or r.stderr or '').strip().split('\n')
    for line in tail:
        log('  ' + line) if line.strip() else log('')

    log('')
    log('=== 7. 收尾 ===')
    try:
        proc.terminate()
        proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    out.close()
    err.close()
    log('  服务已停')
    log('  解压目录保留在: %s' % WORK)
    log('  （想再手工验就进去双击 YF-Robot.bat）')

    open(OUT, 'w', encoding='utf-8').write('\n'.join(L))
    return 0


if __name__ == '__main__':
    sys.exit(main())
