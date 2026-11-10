#!/usr/bin/env python3
"""#33: Prove trusted operator access with real Linux identities in an explicitly disposable Linux environment."""
import errno
import fcntl
import json
import os
from pathlib import Path
import platform
import pty
import pwd
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def require_disposable():
    ci = (
        os.environ.get("GITHUB_ACTIONS") == "true"
        and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
        and os.environ.get("UNIT_001_DISPOSABLE_CI") == "1"
        and os.environ.get("RUNNER_OS") == "Linux"
        and os.environ.get("RUNNER_ARCH") == "X64"
    )
    container = (
        os.environ.get("UNIT_001_DISPOSABLE_CONTAINER") == "1"
        and Path("/.dockerenv").is_file()
        and platform.node() == "unit-001-vps-acceptance"
    )
    if os.geteuid() != 0 or platform.system() != "Linux" or platform.machine() != "x86_64" or not (ci or container):
        raise SystemExit("Requires the explicitly authorized disposable Linux x64 root host.")
    release_os = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    if release_os.get("ID", "").strip('"') != "ubuntu" or release_os.get("VERSION_ID", "").strip('"') != "24.04":
        raise SystemExit("Requires Ubuntu 24.04.")


def drop_identity(user, terminal=False):
    account = pwd.getpwnam(user)

    def enter():
        if terminal:
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        os.initgroups(user, account.pw_gid)
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)

    return enter


def environment(user):
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": pwd.getpwnam(user).pw_dir,
        "LANG": "C.UTF-8",
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
    }


def as_user(user, arguments, success=True):
    result = subprocess.run(
        arguments, cwd="/", env=environment(user), preexec_fn=drop_identity(user),
        capture_output=True, text=True, timeout=15,
    )
    assert len(result.stdout) + len(result.stderr) <= 1048576, "Unbounded operator output"
    assert (result.returncode == 0) == success, (
        f"Unexpected exit {result.returncode} for {user} {arguments[0:2]}: {result.stderr}"
    )
    return result.stdout


def wire(user, endpoint, request):
    code = (
        "import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(5); "
        "s.connect(sys.argv[1]); s.sendall(sys.argv[2].encode()+bytes([10])); "
        "data=s.makefile('rb').readline(65537); "
        "assert len(data)<=65536; sys.stdout.buffer.write(data); s.close()"
    )
    return json.loads(as_user(user, [sys.executable, "-c", code, str(endpoint), json.dumps(request)]))


def denied_connect(user, endpoint):
    code = (
        "import socket,sys,errno\n"
        "s=socket.socket(socket.AF_UNIX); s.settimeout(3)\n"
        "try: s.connect(sys.argv[1])\n"
        "except OSError as error: assert error.errno in (errno.EACCES,errno.EPERM), error\n"
        "else: raise AssertionError('Unauthorized connection succeeded')\n"
    )
    as_user(user, [sys.executable, "-c", code, str(endpoint)])


def denied_file(user, path, writing=False):
    code = (
        "import os,sys,errno\n"
        "flags=os.O_WRONLY if sys.argv[2]=='write' else os.O_RDONLY\n"
        "try: fd=os.open(sys.argv[1],flags|os.O_NOFOLLOW)\n"
        "except OSError as error: assert error.errno in (errno.EACCES,errno.EPERM), error\n"
        "else: os.close(fd); raise AssertionError('Unauthorized file access succeeded')\n"
    )
    as_user(user, [sys.executable, "-c", code, str(path), "write" if writing else "read"])


def terminal(user, command, prompt=None):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    original = termios.tcgetattr(slave)
    child = None
    output = bytearray()
    detached = False
    submitted = False
    try:
        child = subprocess.Popen(
            command, cwd="/", env=environment(user), preexec_fn=drop_identity(user, terminal=True),
            stdin=slave, stdout=slave, stderr=slave,
        )
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                output.extend(chunk)
                assert len(output) <= 1048576, "Unbounded terminal output"
            if b"READY" in output and b"Ctrl+D detach" in output:
                if prompt is not None and not submitted:
                    os.write(master, prompt.encode() + bytes([13]))
                    submitted = True
                elif not detached and (prompt is None or b"operator faux terminal reply" in output):
                    os.write(master, b"\x04")
                    detached = True
            if child.poll() is not None:
                break
        while select.select([master], [], [], 0)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not chunk:
                break
            output.extend(chunk)
            assert len(output) <= 1048576, "Unbounded terminal output"
        assert child.poll() is not None, "Operator PTY exceeded 15 seconds"
        assert child.returncode == 0 and detached, f"Operator PTY failed: {bytes(output)!r}"
        assert b"\x1b[?1049h" in output and b"\x1b[?1049l" in output, "Operator detach did not restore screen"
        try:
            restored = termios.tcgetattr(slave)
        except termios.error as error:
            if error.args[0] != errno.ENOTTY:
                raise
        else:
            assert restored[3] == original[3], "Operator detach left input flags changed"
    finally:
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=2)
        os.close(master)
        os.close(slave)


def main():
    require_disposable()
    faux_chat = len(sys.argv) == 5 and sys.argv[4] == "--faux-chat"
    if len(sys.argv) != 4 and not faux_chat:
        raise SystemExit("Usage: verify-operator-access.py EXTRACTED_RELEASE FIRST_ID SECOND_ID [--faux-chat]")
    release = Path(sys.argv[1]).resolve()
    assert (release / "runtime/bin/node").is_file(), "Expected a complete release"
    identifiers = sys.argv[2:4]
    assert len(set(identifiers)) == 2
    records = []
    for identifier in identifiers:
        assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", identifier)
        record = json.loads(Path(f"/etc/unit-001/agents/{identifier}/installation.json").read_text())
        assert record["id"] == identifier and record["desiredState"] == "running"
        assert record["name"] in ("agent", "unit-ci-bob")
        records.append(record)
    assert {record["name"] for record in records} == {"agent", "unit-ci-bob"}
    users = []
    grants = []
    try:
        for suffix in ("a", "b", "outsider"):
            user = f"unit-op-{os.getpid()}-{suffix}"
            try:
                pwd.getpwnam(user)
            except KeyError:
                pass
            else:
                raise AssertionError("Refusing to reuse an existing operator")
            subprocess.run(["useradd", "--user-group", "--create-home", "--shell", "/bin/sh", user], check=True)
            users.append(user)
        for user, record in zip(users[:2], records):
            command = f"/usr/local/bin/{record['name']}"
            subprocess.run([command, "operator", "add", user], check=True)
            grants.append((command, user))
        if faux_chat:
            # This extra acceptance path must never submit to a paid or network provider.
            for user, record in zip(users[:2], records):
                status = json.loads(as_user(user, [f"/usr/local/bin/{record['name']}", "status"]))
                assert status["runtime"]["provider"] == "faux", "Faux-only chat guard refused provider"
        outsider = users[2]
        for index, (user, record) in enumerate(zip(users[:2], records)):
            command = f"/usr/local/bin/{record['name']}"
            identifier = record["id"]
            state = Path(f"/var/lib/unit-001/agents/{identifier}")
            endpoint = Path(f"/run/unit-001-{identifier}/default.sock")
            status = json.loads(as_user(user, [command, "status"]))
            assert status["type"] == "status" and status["installationId"] == identifier
            assert status["name"] == record["name"] and status["runtime"]["pid"] == status["pid"]
            assert "working" in as_user(user, [command, "memory", "stats"])
            assert "No matching" in as_user(user, [command, "memory", "recall", "operator-test-no-match"])
            assert "Usage:" in as_user(outsider, [command, "--help"])
            assert as_user(outsider, [command, "--version"]).strip()
            for other in (users[1 - index], outsider):
                denied_connect(other, endpoint)
                as_user(other, [command, "status"], success=False)
            denied_connect(user, state / "control/default.sock")
            for path in (state / "auth.json", state / "settings.json", state / "sessions/default.sqlite"):
                denied_file(user, path)
                denied_file(user, path, writing=True)
            for path in (Path(f"/etc/unit-001/agents/{identifier}/installation.json"), Path(command)):
                denied_file(user, path, writing=True)
            cannot_unlink = (
                "import os,sys,errno\n"
                "try: os.unlink(sys.argv[1])\n"
                "except OSError as error: assert error.errno in (errno.EACCES,errno.EPERM), error\n"
                "else: raise AssertionError('Operator removed protected path')\n"
            )
            for path in (endpoint, Path(command), Path(f"/etc/unit-001/agents/{identifier}/installation.json")):
                as_user(user, [sys.executable, "-c", cannot_unlink, str(path)])
            for request in (
                {"type": "maintenance-enter", "operationId": "operator-denied", "timeoutMs": 0},
                {"type": "maintenance-release", "operationId": "operator-denied"},
                {"type": "setup"}, {"type": "login"}, {"type": "serve"},
            ):
                response = wire(user, endpoint, request)
                assert response["type"] == "error" and "administrator" in response["message"], response
            for arguments in (["setup"], ["login", "openai"], ["--print", "must not run"], ["serve"], ["status", "--data-dir", "/tmp"]):
                as_user(user, [command, *arguments], success=False)
            assert wire(user, endpoint, {"type": "cancel"})["type"] == "cancelled"
            canary = f"operatorcanary{os.getpid()}case{index}"
            remember = [command, "memory", "remember", canary, "--request-id", canary]
            first = as_user(user, remember)
            assert first == as_user(user, remember), "Memory retry changed identity"
            recalled = wire(user, endpoint, {"type": "memory", "request": {"operation": "recall", "query": canary}})
            memories = recalled["result"]["records"]
            assert len(memories) == 1 and memories[0]["content"] == canary
            assert "scheduled as task" in as_user(user, [command, "memory", "sleep"])
            memory_id = memories[0]["id"]
            as_user(user, [command, "memory", "forget", memory_id], success=False)
            unconfirmed = wire(user, endpoint, {"type": "memory", "request": {
                "operation": "forget", "id": memory_id, "requestId": canary + "-forget",
            }})
            assert unconfirmed["type"] == "error" and "confirmation" in unconfirmed["message"]
            assert canary in as_user(user, [command, "memory", "recall", canary])
            assert "Forgotten;" in as_user(user, [command, "memory", "forget", memory_id, "--yes"])
            assert "No matching" in as_user(user, [command, "memory", "recall", canary])
            if faux_chat:
                assert "operator faux reply" in as_user(user, [command, "send", "operator-faux-send"])
                proof = state / "workspace/operator-proof.txt"
                assert proof.read_text() == "operator coding tools retained"
                denied_file(user, proof)
                terminal(user, [command], prompt="operator-faux-terminal")
                deadline = time.monotonic() + 10
                while json.loads(as_user(user, [command, "status"]))["busy"]:
                    assert time.monotonic() < deadline, "Previous terminal request did not finish"
                    time.sleep(0.05)
                pending = subprocess.Popen(
                    [command, "send", "operator-faux-cancel"], cwd="/", env=environment(user),
                    preexec_fn=drop_identity(user), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                try:
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        busy = json.loads(as_user(user, [command, "status"]))
                        if busy["busy"]:
                            break
                        assert pending.poll() is None, "Cancellable faux request finished prematurely"
                        time.sleep(0.05)
                    else:
                        raise AssertionError("Operator request never became busy")
                    assert "cancelled" in as_user(user, [command, "cancel"])
                    stdout, stderr = pending.communicate(timeout=10)
                    assert pending.returncode != 0 and "unanswered:" in stderr, (stdout, stderr)
                    alive = json.loads(as_user(user, [command, "status"]))
                    assert alive["pid"] == status["pid"] and not alive["busy"]
                finally:
                    if pending.poll() is None:
                        pending.kill()
                        pending.communicate(timeout=2)
            terminal(user, [command])
            terminal(user, [command, "attach"])
        print("Operator acceptance passed: real UID/group isolation, memory mutations, private state and PTY detach; no paid provider calls.")
    finally:
        for command, user in reversed(grants):
            subprocess.run([command, "operator", "remove", user], check=False)
        for user in reversed(users):
            if pwd.getpwnam(user).pw_uid != 0:
                subprocess.run(["userdel", "--remove", user], check=True)


if __name__ == "__main__":
    main()
