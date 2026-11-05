"""一次性初始化 Windows AppContainer 沙箱（需要管理员权限）。

给 runtime capability SID 授予 runtime 只读/执行权限，启动常驻提权 daemon。
AppContainer profile 由 daemon 为每个任务临时创建，不依赖固定 profile。
"""
from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from sandbox_win import grant_path, run as sandbox_run, runtime_capability

MARKER = ROOT / "data" / "sandbox-setup.json"
LOG = ROOT / "data" / "sandbox-setup.log"


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {msg}"
    print(line, flush=True)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def runtime_paths() -> tuple[Path, ...]:
    windows = Path(os.environ.get("SystemRoot", r"C:\Windows")).resolve()
    paths = {
        (ROOT / "runtime").resolve(),
        (ROOT / "runtime" / "python").resolve(),
        Path(sys.prefix).resolve(),
        Path(sys.executable).resolve().parent,
    }
    return tuple(
        sorted(
            p
            for p in paths
            if p.is_dir() and not str(p).lower().startswith(str(windows).lower())
        )
    )


def start_daemon() -> dict:
    """启动常驻提权 daemon；它继承了 setup 的交互式管理员令牌。"""
    state = ROOT / "data" / "sandbox-daemon.json"
    try:
        old = json.loads(state.read_text(encoding="utf-8"))
        if old.get("pid"):
            subprocess.run(
                ["taskkill", "/PID", str(old["pid"]), "/F"],
                capture_output=True,
                timeout=10,
            )
    except Exception:
        pass
    try:
        state.unlink()
    except Exception:
        pass

    flags = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED | NEW_GROUP | NO_WINDOW
    p = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "sandbox_daemon.py")],
        cwd=str(ROOT),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=flags,
    )
    deadline = time.time() + 15
    last = None
    while time.time() < deadline:
        time.sleep(0.3)
        try:
            st = json.loads(state.read_text(encoding="utf-8"))
            if st.get("pid") != p.pid:
                continue
            with urllib.request.urlopen(
                f"http://127.0.0.1:{st['port']}/health", timeout=2
            ) as r:
                if r.status == 200:
                    log(f"daemon 就绪 pid={p.pid} port={st['port']}")
                    return st
        except Exception as e:
            last = e
    raise RuntimeError(f"daemon 启动失败: {last}（看 data/sandbox-daemon.log）")


def main() -> int:
    if not is_admin():
        log("需要管理员：请双击 初始化沙箱.bat，或在右键菜单里选「以管理员身份运行」")
        return 5
    try:
        cap_sid = runtime_capability()
        granted = []
        for p in runtime_paths():
            grant_path(p, cap_sid, "RX", recursive=True)
            granted.append(str(p))
            log(f"runtime ACL ok: {p}")

        probe = ROOT / ".tmp" / "sandbox-probe"
        probe.mkdir(parents=True, exist_ok=True)
        code, out, err = sandbox_run(
            [sys.executable, "-I", "-c", "pass"],
            probe,
            allow_network=False,
            timeout=20,
        )
        if code != 0:
            raise RuntimeError(
                "AppContainer 探针失败：" + (err or out).decode("utf-8", "replace")[:400]
            )

        # 清理 A2 早期方案留下的计划任务
        try:
            subprocess.run(
                ["schtasks", "/Delete", "/TN", "ENbotSandbox", "/F"],
                capture_output=True,
                timeout=15,
            )
        except Exception:
            pass

        daemon = start_daemon()
        marker = {
            "ok": True,
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "engine": "sandbox_win",
            "runtimeCapabilitySid": str(cap_sid),
            "runtimePaths": granted,
            "probe": "ok",
            "daemon": daemon,
        }
        MARKER.parent.mkdir(parents=True, exist_ok=True)
        MARKER.write_text(json.dumps(marker, ensure_ascii=False, indent=2), encoding="utf-8")
        log("初始化完成：AppContainer 探针通过")
        return 0
    except Exception as e:
        log(f"初始化失败：{e}")
        try:
            MARKER.unlink()
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
