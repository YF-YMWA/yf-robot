"""系统诊断：一次性检查所有关键条件。

检查项：
  1. 微信进程是否运行
  2. 微信主窗口是否在屏幕内
  3. 控件树是否物化（mmui::MainWindow）
  4. 能否读取 Weixin.dll 模块（权限）
  5. 数据库能否打开
  6. 最近消息时间
"""
import os
import sys
import time
import ctypes

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'diagnosis.txt')
lines = []


def log(msg):
    lines.append(str(msg))
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))


open(OUT, 'w').close()
log('========================================')
log('  鲸鲸诊断报告')
log('  时间: ' + time.strftime('%Y-%m-%d %H:%M:%S'))
log('========================================')
log('')

# ===== 1. 微信进程 =====
log('【1】微信进程')
try:
    import psutil
    procs = []
    for p in psutil.process_iter(['pid', 'name', 'memory_info']):
        if p.info['name'] and 'weixin' in p.info['name'].lower():
            procs.append(p.info)

    if procs:
        procs.sort(key=lambda x: x['memory_info'].rss, reverse=True)
        main = procs[0]
        log(f'  主进程 PID: {main["pid"]}  内存: {main["memory_info"].rss // 1024 // 1024}MB')
        log(f'  进程总数: {len(procs)}')
    else:
        log('  [错误] 微信未运行')
except Exception as e:
    log(f'  [错误] {e}')

log('')

# ===== 2. 微信窗口 =====
log('【2】微信窗口')
try:
    import win32gui

    def find_wechat_windows():
        result = []

        def callback(hwnd, _):
            if not win32gui.IsWindowVisible(hwnd):
                return
            title = win32gui.GetWindowText(hwnd)
            cls = win32gui.GetClassName(hwnd)
            if 'Weixin' in cls or 'mmui' in cls or 'Qt5' in cls or title in ('微信', 'Weixin'):
                rect = win32gui.GetWindowRect(hwnd)
                w, h = rect[2] - rect[0], rect[3] - rect[1]
                if w > 300 and h > 250:
                    result.append((hwnd, title, cls, rect, w, h))
            return True

        win32gui.EnumWindows(callback, None)
        return result

    wins = find_wechat_windows()
    if wins:
        for hwnd, title, cls, rect, w, h in wins:
            x, y = rect[0], rect[1]
            in_screen = -10000 < x < 10000 and -10000 < y < 10000
            log(f'  窗口: "{title}"')
            log(f'    类名: {cls}')
            log(f'    位置: ({x},{y}) 尺寸: {w}x{h}')
            log(f'    在屏幕内: {"是" if in_screen else "否（有问题！）"}')
    else:
        log('  [错误] 找不到微信主窗口')
except Exception as e:
    log(f'  [错误] {e}')

log('')

# ===== 3. 控件树 =====
log('【3】控件树（mmui）')
try:
    import uiautomation as auto
    root = auto.GetRootControl()
    found_mmui = False
    for w in root.GetChildren():
        cls = w.ClassName or ''
        if 'mmui' in cls:
            found_mmui = True
            log(f'  [OK] 找到控件树: {w.Name} (cls={cls})')
            break
        if 'Qt5' in cls:
            log(f'  [部分] Qt 外壳: {w.Name} (cls={cls}) — 控件树未物化')

    if not found_mmui:
        log('  [警告] 没有 mmui 控件树')
except Exception as e:
    log(f'  [错误] {e}')

log('')

# ===== 4. 权限（读微信模块） =====
log('【4】权限检查')
try:
    import psutil
    wx = None
    for p in psutil.process_iter(['pid', 'name']):
        if p.info['name'] and 'weixin' in p.info['name'].lower():
            if wx is None:
                wx = p.info['pid']

    if wx:
        # 尝试读了望模块
        PROCESS_QUERY_INFORMATION = 0x0400
        PROCESS_VM_READ = 0x0010
        k = ctypes.windll.kernel32
        h = k.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, wx)
        if h:
            log(f'  [OK] 能打开微信进程 PID {wx}')
            k.CloseHandle(h)
        else:
            err = ctypes.get_last_error()
            log(f'  [失败] 无法打开微信进程 PID {wx}（错误 {err}）')
            log('         → 需要管理员权限')
    else:
        log('  [错误] 找不到微信进程')
except Exception as e:
    log(f'  [错误] {e}')

log('')

# ===== 5. 是否为管理员 =====
log('【5】当前权限')
try:
    is_admin = ctypes.windll.shell32.IsUserAnAdmin() != 0
    log(f'  管理员: {"是" if is_admin else "否"}')
except Exception as e:
    log(f'  [错误] {e}')

log('')

# ===== 6. 数据库 =====
log('【6】数据库')
try:
    _BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _RT = os.path.join(_BASE, 'runtime', 'python', 'Lib', 'site-packages')
    if _RT not in sys.path:
        sys.path.insert(0, _RT)

    from wechatauto import WeChatDB, auto_detect_db_dir
    db_dir = auto_detect_db_dir()
    log(f'  目录: {db_dir}')

    db = WeChatDB(db_dir=db_dir)
    sessions = db.get_sessions(limit=5)
    log(f'  会话数: {len(sessions)}')

    if sessions:
        u = sessions[0]['username']
        msgs = db.get_messages(u, limit=1)
        if msgs:
            ts = float(msgs[0].get('create_time') or 0)
            ago = time.time() - ts
            log(f'  最新消息: {time.strftime("%m-%d %H:%M:%S", time.localtime(ts))}')
            log(f'  距今: {ago:.0f} 秒')
except Exception as e:
    log(f'  [错误] {e}')
    import traceback
    log(traceback.format_exc()[:400])

log('')
log('========================================')
