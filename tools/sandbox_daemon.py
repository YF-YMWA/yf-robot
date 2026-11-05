"""常驻提权沙箱 daemon。

由 初始化沙箱.bat 以管理员身份拉起，监听 127.0.0.1 随机端口；
普通权限的 ENbot 服务通过本地 HTTP 把 run_code 任务交给它。
AppContainer profile 在这个交互式提权进程里创建，能正常启动。
"""
from __future__ import annotations

import atexit
import base64
import hmac
import json
import os
import secrets
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

STATE = ROOT / "data" / "sandbox-daemon.json"
LOG = ROOT / "data" / "sandbox-daemon.log"
TOKEN = secrets.token_hex(24)
LOCK = threading.Lock()
ALLOWED = (ROOT / "agent-workspace").resolve()


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {msg}"
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def run_job(job: dict) -> dict:
    from sandbox_win import run as sandbox_run

    workspace = Path(str(job.get("workspace") or "")).resolve()
    if not workspace.is_relative_to(ALLOWED):
        return {"ok": False, "error": "workspace 不在允许目录内"}
    argv = [str(x) for x in (job.get("argv") or [])]
    if not argv:
        return {"ok": False, "error": "缺少命令"}
    timeout = min(300.0, max(1.0, float(job.get("timeout") or 30)))
    try:
        code, out, err = sandbox_run(
            argv,
            workspace,
            allow_network=bool(job.get("network")),
            timeout=timeout,
            output_limit=1024 * 1024,
        )
        if code == 124:
            return {"ok": False, "error": f"Sandbox command timed out after {timeout:g} seconds."}
        return {
            "ok": True,
            "code": int(code),
            "stdout": base64.b64encode(out or b"").decode("ascii"),
            "stderr": base64.b64encode(err or b"").decode("ascii"),
        }
    except Exception as e:
        log(f"job 失败: {e}\n{traceback.format_exc()}")
        return {"ok": False, "error": str(e)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, obj, code=200):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send({"ok": True, "pid": os.getpid()})
        else:
            self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        if self.path != "/run":
            return self._send({"ok": False, "error": "not found"}, 404)
        if not hmac.compare_digest(str(self.headers.get("x-sandbox-token") or ""), TOKEN):
            return self._send({"ok": False, "error": "unauthorized"}, 401)
        try:
            n = int(self.headers.get("content-length") or 0)
            if n <= 0 or n > 2 * 1024 * 1024:
                raise ValueError("bad length")
            job = json.loads(self.rfile.read(n).decode("utf-8"))
            with LOCK:
                self._send(run_job(job))
        except Exception as e:
            self._send({"ok": False, "error": str(e)}, 400)


def cleanup():
    try:
        if STATE.exists():
            st = json.loads(STATE.read_text(encoding="utf-8"))
            if st.get("pid") == os.getpid():
                STATE.unlink()
    except Exception:
        pass


def main() -> int:
    atexit.register(cleanup)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(
        json.dumps(
            {"pid": os.getpid(), "port": port, "token": TOKEN, "started": time.time()},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    log(f"daemon start pid={os.getpid()} port={port}")
    try:
        server.serve_forever()
    finally:
        server.server_close()
        cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
