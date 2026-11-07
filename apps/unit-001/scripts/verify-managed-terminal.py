#!/usr/bin/env python3
"""#25: Exercise the installed root dispatcher and unprivileged rich client through a real PTY."""
import errno
import fcntl
import os
import platform
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time


def verify_case(monochrome):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    original = termios.tcgetattr(slave)
    environment = dict(os.environ, TERM="xterm-256color")
    environment.pop("NO_COLOR", None)
    if monochrome:
        environment["NO_COLOR"] = "1"

    def terminal_session():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    child = None
    output = bytearray()
    try:
        child = subprocess.Popen(
            ["/usr/local/bin/agent", "attach"],
            stdin=slave, stdout=slave, stderr=slave,
            env=environment, preexec_fn=terminal_session,
        )
        deadline = time.monotonic() + 15
        detached = False
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.1)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                output.extend(chunk)
                assert len(output) <= 1048576, "Terminal output exceeded its test bound"
            if not detached and b"READY" in output and b"Ctrl+D detach" in output:
                os.write(master, b"\x04")
                detached = True
            if child.poll() is not None:
                # Drain the final terminal restoration bytes after the dispatcher exits.
                while select.select([master], [], [], 0)[0]:
                    try:
                        remaining = os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        break
                    if not remaining:
                        break
                    output.extend(remaining)
                    assert len(output) <= 1048576, "Terminal output exceeded its test bound"
                break
        assert child.poll() is not None, "Managed terminal exceeded 15 seconds"
        assert detached, f"Rich terminal never became ready: {bytes(output)!r}"
        assert child.returncode == 0, f"Managed attach exited {child.returncode}: {bytes(output)!r}"
        assert b"\x1b[?1049h" in output, "Rich terminal did not enter the alternate screen"
        assert b"\x1b[?1049l" in output, "Detach did not restore the original screen"
        try:
            restored = termios.tcgetattr(slave)
        except termios.error as error:
            # Some kernels revoke the slave when its controlling session exits.
            if error.args[0] != errno.ENOTTY:
                raise
        else:
            assert restored[3] == original[3], "Detach left terminal input flags changed"
        colors = re.findall(rb"\x1b\[([0-9;]*)m", output)
        if monochrome:
            assert not any(
                int(code) in range(30, 50) or int(code) in range(90, 108)
                for parameters in colors for code in parameters.split(b";") if code
            ), "NO_COLOR was lost across the managed privilege boundary"
        else:
            assert b"\x1b[1;36m" in output, "Normal rich header has no cyan styling"
        print(f"Managed PTY passed: {'NO_COLOR' if monochrome else 'color'}; ready, detach, terminal restored.")
    finally:
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=2)
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    ci = (
        os.environ.get("GITHUB_ACTIONS") == "true"
        and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
        and os.environ.get("UNIT_001_DISPOSABLE_CI") == "1"
    )
    container = (
        os.environ.get("UNIT_001_DISPOSABLE_CONTAINER") == "1"
        and os.path.isfile("/.dockerenv")
        and platform.node() == "unit-001-vps-acceptance"
    )
    if os.geteuid() != 0 or platform.system() != "Linux" or not (ci or container):
        raise SystemExit("Requires the explicitly authorized disposable Linux root acceptance host.")
    verify_case(False)
    verify_case(True)
