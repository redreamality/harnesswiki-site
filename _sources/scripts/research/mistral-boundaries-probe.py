"""Run pinned upstream modules against disposable files and real child processes."""

import asyncio
import ctypes
from ctypes import wintypes
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types


ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT / "upstreams/mistralai/mistral-vibe"
SHA = "63d0e8f17e2c1f0d9e1d6f4399ab2dc10fbdf477"
SOURCES = {}


def load(name, path):
    for length in range(1, len(name.split("."))):
        parent = ".".join(name.split(".")[:length])
        if parent not in sys.modules:
            package = types.ModuleType(parent)
            package.__path__ = []
            sys.modules[parent] = package
    source = subprocess.check_output(
        ["git", "-C", str(REPO), "show", f"{SHA}:{path}"], timeout=45
    )
    SOURCES[path] = hashlib.sha256(source).hexdigest()
    module = types.ModuleType(name)
    module.__file__ = f"{SHA}/{path}"
    sys.modules[name] = module
    exec(compile(source, module.__file__, "exec"), module.__dict__)
    return module


load("vibe.utils.platform", "vibe/utils/platform.py")
processes = load("vibe.core.utils.async_subprocess", "vibe/core/utils/async_subprocess.py")
execution = load("vibe.app_server._execution", "vibe/app_server/_execution.py")
models = load("vibe.core.checkpoints.models", "vibe/core/checkpoints/models.py")
fs = load("vibe.core.checkpoints.fs", "vibe/core/checkpoints/fs.py")
store = load("vibe.core.checkpoints.file_store", "vibe/core/checkpoints/file_store.py")


def checkpoint_probe(directory):
    first, third = directory / "first.txt", directory / "third.txt"
    blocker = directory / "regular-file"
    first.write_bytes(b"edited")
    third.write_bytes(b"edited")
    blocker.write_bytes(b"not a directory")
    failed = blocker / "nested.txt"
    errors, restored = store.FileStore().apply({
        str(first): models.FileState(b"original"),
        str(failed): models.FileState(b"original"),
        str(third): models.FileState(b"original"),
    })
    assert len(errors) == 1 and restored == [str(first), str(third)]
    assert first.read_bytes() == third.read_bytes() == b"original"
    print(json.dumps({"case": "partial_restore", "errors": len(errors),
                      "restored": [Path(p).name for p in restored],
                      "failed_exists": failed.exists()}))

    raced = directory / "race.txt"
    raced.write_bytes(b"before")
    writer_observations = []

    class GatedDisk(fs.DiskFilesystem):
        def read_bytes(self, path):
            before = super().read_bytes(path)
            # Instrument only the scheduling boundary; both actors use real disk.
            subprocess.run(
                [sys.executable, "-c",
                 "import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(b'concurrent')",
                 path], check=True, timeout=5
            )
            writer_observations.append(Path(path).read_bytes().decode())
            return before

    errors, restored = store.FileStore(GatedDisk()).apply({
        str(raced): models.FileState(b"checkpoint")
    })
    assert writer_observations == ["concurrent"]
    assert not errors and restored == [str(raced)]
    assert raced.read_bytes() == b"checkpoint"
    print(json.dumps({"case": "read_write_race", "external_writer": writer_observations,
                      "final": raced.read_text(), "errors": errors}))


async def process_probe(directory):
    if sys.platform != "win32":
        raise RuntimeError("This process-tree probe requires Windows")
    output = directory / "ticks.txt"
    leaf_code = (
        "import pathlib,sys,time\n"
        "p=pathlib.Path(sys.argv[1])\n"
        "while True:\n"
        " with p.open('ab', buffering=0) as f: f.write(b'x')\n"
        " time.sleep(0.01)\n"
    )
    parent_code = (
        "import subprocess,sys\n"
        "p=subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2]])\n"
        "print(p.pid,flush=True)\n"
        "p.wait()\n"
    )
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = None
    child_pid = None
    parent = await asyncio.create_subprocess_exec(
        sys.executable, "-c", parent_code, leaf_code, str(output),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        child_pid = int(await asyncio.wait_for(parent.stdout.readline(), 5))
        handle = kernel.OpenProcess(0x00100000, False, child_pid)
        assert handle, ctypes.get_last_error()
        async with asyncio.timeout(5):
            while not output.exists() or output.stat().st_size < 3:
                await asyncio.sleep(0.01)
        assert kernel.WaitForSingleObject(handle, 0) == 258
        await asyncio.wait_for(processes.kill_async_subprocess(parent), 5)
        child_exited = kernel.WaitForSingleObject(handle, 1000) == 0
        at_return = output.read_bytes()
        await asyncio.sleep(0.2)
        unchanged = at_return == output.read_bytes()
        assert parent.returncode is not None and child_exited and unchanged
        print(json.dumps({"case": "process_tree", "parent_pid": parent.pid,
                          "child_pid": child_pid, "parent_returncode": parent.returncode,
                          "child_exited": child_exited, "writes_stable_200ms": unchanged,
                          "bytes_at_return": len(at_return)}))
    finally:
        alive = []
        if parent.returncode is None:
            alive.append(parent.pid)
        if handle and kernel.WaitForSingleObject(handle, 0) == 258:
            alive.append(child_pid)
        for pid in alive:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        try:
            await asyncio.wait_for(parent.communicate(), 5)
        finally:
            if handle:
                kernel.CloseHandle(handle)


async def swallowed_cancel():
    entered, release = asyncio.Event(), asyncio.Event()
    effects = []

    async def worker():
        entered.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            await release.wait()
        effects.append("after-return")

    task = asyncio.create_task(worker())
    await entered.wait()
    try:
        errors = await execution.cancel_tasks([task], label="probe", timeout=0.01)
        assert len(errors) == 1 and isinstance(errors[0], TimeoutError)
        assert not task.done() and not effects
        release.set()
        await asyncio.wait_for(task, 1)
        assert effects == ["after-return"]
        print(json.dumps({"case": "swallowed_cancel", "timeout": str(errors[0]),
                          "effect_after_return": effects}))
    finally:
        release.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def main():
    print(json.dumps({"sha": SHA, "python": sys.version, "platform": sys.platform,
                      "source_sha256": SOURCES}))
    with tempfile.TemporaryDirectory(prefix="mistral-boundaries-") as temporary:
        directory = Path(temporary)
        checkpoint_probe(directory)
        await process_probe(directory)
        await swallowed_cancel()
    assert len(asyncio.all_tasks()) == 1
    print(json.dumps({"remaining_asyncio_tasks": 0}))


if __name__ == "__main__":
    asyncio.run(main())
