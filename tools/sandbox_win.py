"""ENbot 的 Windows AppContainer 执行器。

只做 run_code 需要的最小闭环：
  · 每个任务创建临时 AppContainer profile
  · 给工作区授予 AppContainer SID Modify
  · 给 runtime capability SID 只读/执行（初始化时授权）
  · 用 Job Object 限制进程数/内存/CPU，并 kill-on-close
  · 管道捕获 stdout/stderr，超时杀整棵进程树
"""
from __future__ import annotations

import ctypes
import hashlib
import msvcrt
import os
import subprocess
import sys
import threading
import uuid
from ctypes import wintypes as wt
from pathlib import Path

CREATE_NO_WINDOW = 0x08000000
CREATE_SUSPENDED = 0x00000004
CREATE_UNICODE_ENVIRONMENT = 0x00000400
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
STARTF_USESTDHANDLES = 0x00000100
HANDLE_FLAG_INHERIT = 0x00000001
PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002
PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009
JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008
JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000100
JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000200
JOB_OBJECT_LIMIT_JOB_TIME = 0x00000004
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
WAIT_OBJECT_0 = 0x00000000
WAIT_TIMEOUT = 0x00000102

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
userenv = ctypes.WinDLL("userenv", use_last_error=True)
advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Sid", wt.LPVOID), ("Attributes", wt.DWORD)]


class SECURITY_CAPABILITIES(ctypes.Structure):
    _fields_ = [
        ("AppContainerSid", wt.LPVOID),
        ("Capabilities", ctypes.POINTER(SID_AND_ATTRIBUTES)),
        ("CapabilityCount", wt.DWORD),
        ("Reserved", wt.DWORD),
    ]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", wt.DWORD),
        ("lpReserved", wt.LPWSTR),
        ("lpDesktop", wt.LPWSTR),
        ("lpTitle", wt.LPWSTR),
        ("dwX", wt.DWORD),
        ("dwY", wt.DWORD),
        ("dwXSize", wt.DWORD),
        ("dwYSize", wt.DWORD),
        ("dwXCountChars", wt.DWORD),
        ("dwYCountChars", wt.DWORD),
        ("dwFillAttribute", wt.DWORD),
        ("dwFlags", wt.DWORD),
        ("wShowWindow", wt.WORD),
        ("cbReserved2", wt.WORD),
        ("lpReserved2", ctypes.POINTER(wt.BYTE)),
        ("hStdInput", wt.HANDLE),
        ("hStdOutput", wt.HANDLE),
        ("hStdError", wt.HANDLE),
    ]


class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [("StartupInfo", STARTUPINFOW), ("lpAttributeList", wt.LPVOID)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", wt.HANDLE),
        ("hThread", wt.HANDLE),
        ("dwProcessId", wt.DWORD),
        ("dwThreadId", wt.DWORD),
    ]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wt.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wt.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wt.DWORD),
        ("SchedulingClass", wt.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        (n, ctypes.c_uint64)
        for n in (
            "ReadOperationCount",
            "WriteOperationCount",
            "OtherOperationCount",
            "ReadTransferCount",
            "WriteTransferCount",
            "OtherTransferCount",
        )
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


userenv.CreateAppContainerProfile.argtypes = [
    wt.LPCWSTR,
    wt.LPCWSTR,
    wt.LPCWSTR,
    wt.LPVOID,
    wt.DWORD,
    ctypes.POINTER(wt.LPVOID),
]
userenv.CreateAppContainerProfile.restype = ctypes.c_long
userenv.DeriveAppContainerSidFromAppContainerName.argtypes = [
    wt.LPCWSTR,
    ctypes.POINTER(wt.LPVOID),
]
userenv.DeriveAppContainerSidFromAppContainerName.restype = ctypes.c_long
userenv.DeleteAppContainerProfile.argtypes = [wt.LPCWSTR]
userenv.DeleteAppContainerProfile.restype = ctypes.c_long

advapi32.FreeSid.argtypes = [wt.LPVOID]
advapi32.ConvertSidToStringSidW.argtypes = [wt.LPVOID, ctypes.POINTER(wt.LPWSTR)]
advapi32.ConvertSidToStringSidW.restype = wt.BOOL
advapi32.ConvertStringSidToSidW.argtypes = [wt.LPCWSTR, ctypes.POINTER(wt.LPVOID)]
advapi32.ConvertStringSidToSidW.restype = wt.BOOL
kernel32.LocalFree.argtypes = [wt.HLOCAL]
kernel32.LocalFree.restype = wt.HLOCAL

kernel32.InitializeProcThreadAttributeList.argtypes = [
    wt.LPVOID,
    wt.DWORD,
    wt.DWORD,
    ctypes.POINTER(ctypes.c_size_t),
]
kernel32.InitializeProcThreadAttributeList.restype = wt.BOOL
kernel32.UpdateProcThreadAttribute.argtypes = [
    wt.LPVOID,
    wt.DWORD,
    ctypes.c_size_t,
    wt.LPVOID,
    ctypes.c_size_t,
    wt.LPVOID,
    wt.LPVOID,
]
kernel32.UpdateProcThreadAttribute.restype = wt.BOOL
kernel32.DeleteProcThreadAttributeList.argtypes = [wt.LPVOID]
kernel32.CreateProcessW.argtypes = [
    wt.LPCWSTR,
    wt.LPWSTR,
    wt.LPVOID,
    wt.LPVOID,
    wt.BOOL,
    wt.DWORD,
    wt.LPVOID,
    wt.LPCWSTR,
    ctypes.POINTER(STARTUPINFOEXW),
    ctypes.POINTER(PROCESS_INFORMATION),
]
kernel32.CreateProcessW.restype = wt.BOOL
kernel32.CreateJobObjectW.argtypes = [wt.LPVOID, wt.LPCWSTR]
kernel32.CreateJobObjectW.restype = wt.HANDLE
kernel32.SetInformationJobObject.argtypes = [
    wt.HANDLE,
    ctypes.c_int,
    wt.LPVOID,
    wt.DWORD,
]
kernel32.SetInformationJobObject.restype = wt.BOOL
kernel32.AssignProcessToJobObject.argtypes = [wt.HANDLE, wt.HANDLE]
kernel32.AssignProcessToJobObject.restype = wt.BOOL
kernel32.ResumeThread.argtypes = [wt.HANDLE]
kernel32.ResumeThread.restype = wt.DWORD
kernel32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
kernel32.WaitForSingleObject.restype = wt.DWORD
kernel32.GetExitCodeProcess.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]
kernel32.GetExitCodeProcess.restype = wt.BOOL
kernel32.TerminateProcess.argtypes = [wt.HANDLE, wt.UINT]
kernel32.TerminateProcess.restype = wt.BOOL
kernel32.TerminateJobObject.argtypes = [wt.HANDLE, wt.UINT]
kernel32.TerminateJobObject.restype = wt.BOOL
kernel32.SetHandleInformation.argtypes = [wt.HANDLE, wt.DWORD, wt.DWORD]
kernel32.SetHandleInformation.restype = wt.BOOL


def _err(prefix: str) -> OSError:
    return OSError(ctypes.get_last_error(), f"{prefix}: {ctypes.FormatError()}")


def _sid_text(sid_ptr) -> str:
    out = wt.LPWSTR()
    if not advapi32.ConvertSidToStringSidW(sid_ptr, ctypes.byref(out)):
        raise _err("ConvertSidToStringSidW")
    try:
        return out.value
    finally:
        kernel32.LocalFree(out)


def _sid_from_text(text: str):
    ptr = wt.LPVOID()
    if not advapi32.ConvertStringSidToSidW(text, ctypes.byref(ptr)):
        raise _err("ConvertStringSidToSidW")
    return ptr


def runtime_capability() -> str:
    """与 setup/daemon 共用的 runtime capability SID。"""
    name = "enbot.runtime." + hashlib.sha256(
        str(Path(sys.prefix).resolve()).encode()
    ).hexdigest()[:24]
    fn = ctypes.WinDLL("kernelbase", use_last_error=True).DeriveCapabilitySidsFromName
    fn.argtypes = [
        wt.LPCWSTR,
        ctypes.POINTER(wt.LPVOID),
        ctypes.POINTER(wt.DWORD),
        ctypes.POINTER(wt.LPVOID),
        ctypes.POINTER(wt.DWORD),
    ]
    fn.restype = wt.BOOL
    group = wt.LPVOID()
    group_count = wt.DWORD()
    caps = wt.LPVOID()
    cap_count = wt.DWORD()
    if not fn(
        name,
        ctypes.byref(group),
        ctypes.byref(group_count),
        ctypes.byref(caps),
        ctypes.byref(cap_count),
    ):
        raise _err("DeriveCapabilitySidsFromName")
    if cap_count.value < 1:
        raise OSError("DeriveCapabilitySidsFromName returned no SID")
    item = ctypes.cast(caps.value, ctypes.POINTER(SID_AND_ATTRIBUTES))[0]
    return _sid_text(item.Sid)


def _icacls(path: Path, *args: str) -> int:
    p = subprocess.run(
        ["icacls", str(path), *args, "/Q", "/C"],
        capture_output=True,
        timeout=90,
        creationflags=CREATE_NO_WINDOW,
    )
    return p.returncode


def grant_path(path: Path, sid_text: str, rights: str, recursive: bool = False) -> None:
    args = ["/grant", f"*{sid_text}:" + ("(OI)(CI)" if path.is_dir() else "") + rights]
    if recursive and path.is_dir():
        args.append("/T")
    if _icacls(path, *args) != 0:
        raise OSError(f"icacls grant failed: {path} {rights}")


def revoke_path(path: Path, sid_text: str, recursive: bool = False) -> None:
    args = ["/remove:g", f"*{sid_text}"]
    if recursive and path.is_dir():
        args.append("/T")
    _icacls(path, *args)


def _create_profile():
    name = "ENbot.Run." + uuid.uuid4().hex
    sid = wt.LPVOID()
    hr = userenv.CreateAppContainerProfile(
        name, "ENbot sandbox", "Restricted tool process", None, 0, ctypes.byref(sid)
    )
    if hr < 0:
        raise OSError(f"CreateAppContainerProfile failed: 0x{hr & 0xFFFFFFFF:08x}")
    return name, sid


def _read_pipe(fd: int, sink: list[bytes], limit: int, lock: threading.Lock) -> None:
    try:
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            with lock:
                total = sum(len(x) for x in sink)
                if total < limit:
                    sink.append(chunk[: limit - total])
    except OSError:
        pass
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def _make_env(workspace: Path) -> ctypes.Array:
    local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    root = Path(sys.executable).resolve().parent
    system = os.environ.get("SystemRoot", r"C:\Windows")
    env = {
        "SystemRoot": system,
        "WINDIR": system,
        "LOCALAPPDATA": local,
        "APPDATA": str(workspace),
        "TEMP": str(workspace),
        "TMP": str(workspace),
        "USERPROFILE": str(workspace),
        "HOME": str(workspace),
        "PATH": os.pathsep.join([str(root), str(Path(system) / "System32")]),
        "PYTHONIOENCODING": "utf-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PATHEXT": ".COM;.EXE;.BAT;.CMD",
    }
    return ctypes.create_unicode_buffer(
        "\0".join(f"{k}={v}" for k, v in sorted(env.items())) + "\0\0"
    )


def run(argv, workspace, *, allow_network=False, timeout=30, output_limit=1024 * 1024):
    """在 AppContainer 中运行 argv，返回 (code, stdout, stderr)。"""
    workspace = Path(workspace).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    profile_name = None
    app_sid_ptr = None
    cap_ptrs = []
    job = process = thread = None
    try:
        profile_name, app_sid_ptr = _create_profile()
        app_sid = _sid_text(app_sid_ptr)
        grant_path(workspace, app_sid, "M", recursive=True)

        cap_sids = [runtime_capability()]
        if allow_network:
            cap_sids += ["S-1-15-3-1", "S-1-15-3-3"]
        for s in cap_sids:
            cap_ptrs.append(_sid_from_text(s))
        cap_array = (SID_AND_ATTRIBUTES * len(cap_ptrs))(
            *[SID_AND_ATTRIBUTES(p, 4) for p in cap_ptrs]
        )
        caps = SECURITY_CAPABILITIES(app_sid_ptr, cap_array, len(cap_ptrs), 0)

        r_out, w_out = os.pipe()
        r_err, w_err = os.pipe()
        r_in, w_in = os.pipe()
        os.close(w_in)
        for h in (w_out, w_err, r_in):
            kernel32.SetHandleInformation(
                msvcrt.get_osfhandle(h), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT
            )
        std_in = msvcrt.get_osfhandle(r_in)
        std_out = msvcrt.get_osfhandle(w_out)
        std_err = msvcrt.get_osfhandle(w_err)

        handles = (wt.HANDLE * 3)(std_in, std_out, std_err)
        size = ctypes.c_size_t()
        kernel32.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
        attr_buf = ctypes.create_string_buffer(size.value)
        if not kernel32.InitializeProcThreadAttributeList(
            attr_buf, 2, 0, ctypes.byref(size)
        ):
            raise _err("InitializeProcThreadAttributeList")
        for key, val, sz in (
            (
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                ctypes.byref(caps),
                ctypes.sizeof(caps),
            ),
            (PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, ctypes.sizeof(handles)),
        ):
            if not kernel32.UpdateProcThreadAttribute(
                attr_buf, 0, key, val, sz, None, None
            ):
                raise _err(f"UpdateProcThreadAttribute {key:#x}")

        si = STARTUPINFOEXW()
        si.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES
        si.StartupInfo.hStdInput = std_in
        si.StartupInfo.hStdOutput = std_out
        si.StartupInfo.hStdError = std_err
        si.lpAttributeList = ctypes.cast(attr_buf, wt.LPVOID)

        env = _make_env(workspace)
        cmdline = ctypes.create_unicode_buffer(
            subprocess.list2cmdline([str(x) for x in argv])
        )
        pi = PROCESS_INFORMATION()
        ok = kernel32.CreateProcessW(
            str(argv[0]),
            cmdline,
            None,
            None,
            True,
            EXTENDED_STARTUPINFO_PRESENT
            | CREATE_SUSPENDED
            | CREATE_UNICODE_ENVIRONMENT
            | CREATE_NO_WINDOW,
            env,
            str(workspace),
            ctypes.byref(si),
            ctypes.byref(pi),
        )
        if not ok:
            raise _err("CreateProcessW")
        process, thread = pi.hProcess, pi.hThread
        for fd in (w_out, w_err, r_in):
            try:
                os.close(fd)
            except OSError:
                pass

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            raise _err("CreateJobObjectW")
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = (
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_PROCESS_MEMORY
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_JOB_TIME
        )
        info.BasicLimitInformation.ActiveProcessLimit = 16
        info.BasicLimitInformation.PerJobUserTimeLimit = int(max(1, timeout) * 10_000_000)
        info.ProcessMemoryLimit = 512 * 1024 * 1024
        info.JobMemoryLimit = 512 * 1024 * 1024
        if not kernel32.SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            raise _err("SetInformationJobObject")
        if not kernel32.AssignProcessToJobObject(job, process):
            raise _err("AssignProcessToJobObject")
        kernel32.ResumeThread(thread)

        stdout, stderr = [], []
        lock = threading.Lock()
        threads = [
            threading.Thread(
                target=_read_pipe,
                args=(r_out, stdout, output_limit, lock),
                daemon=True,
            ),
            threading.Thread(
                target=_read_pipe,
                args=(r_err, stderr, output_limit, lock),
                daemon=True,
            ),
        ]
        for t in threads:
            t.start()

        wait = kernel32.WaitForSingleObject(process, int(max(1, timeout) * 1000))
        if wait == WAIT_TIMEOUT:
            kernel32.TerminateJobObject(job, 124)
            kernel32.WaitForSingleObject(process, 5000)
        ec = wt.DWORD()
        kernel32.GetExitCodeProcess(process, ctypes.byref(ec))
        code = int(ec.value)
        for t in threads:
            t.join(timeout=2)
        return code, b"".join(stdout), b"".join(stderr)
    finally:
        for p in cap_ptrs:
            try:
                kernel32.LocalFree(p)
            except Exception:
                pass
        if process:
            # 启动失败/超时时也确保不留下挂起的子进程
            try:
                kernel32.TerminateProcess(process, 1)
            except Exception:
                pass
        for h in (process, thread, job):
            if h:
                try:
                    kernel32.CloseHandle(h)
                except Exception:
                    pass
        if app_sid_ptr:
            try:
                revoke_path(workspace, _sid_text(app_sid_ptr), recursive=True)
            except Exception:
                pass
            try:
                advapi32.FreeSid(app_sid_ptr)
            except Exception:
                pass
        if profile_name:
            try:
                userenv.DeleteAppContainerProfile(profile_name)
            except Exception:
                pass
