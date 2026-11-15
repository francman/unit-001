#!/usr/bin/env python3
"""#14/#17: Check managed formation/lifecycle with distinct UIDs in a disposable Linux container."""
import hashlib
import errno
import json
import os
from pathlib import Path
import platform
import pwd
import signal
import socket
import subprocess
import sys
import time


def require_disposable():
    if not (
        os.geteuid() == 0 and platform.system() == "Linux" and platform.machine() == "x86_64"
        and os.environ.get("UNIT_001_DISPOSABLE_CONTAINER") == "1"
        and Path("/.dockerenv").is_file() and socket.gethostname() == "unit-001-mission-acceptance"
    ):
        raise SystemExit("Requires the explicitly authorized disposable Linux x64 container.")
    release_os = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    if release_os.get("ID", "").strip('"') != "ubuntu" or release_os.get("VERSION_ID", "").strip('"') != "24.04":
        raise SystemExit("Requires Ubuntu 24.04.")
    records = Path("/etc/unit-001/agents")
    if records.exists() and any(records.iterdir()):
        raise SystemExit("Refusing a host containing existing installations.")


def identity(user):
    account = pwd.getpwnam(user)

    def drop():
        os.initgroups(user, account.pw_gid)
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)
    return drop


def invoke(arguments, user=None, success=True, env=None):
    environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", **(env or {})}
    result = subprocess.run(arguments, cwd="/", env=environment, preexec_fn=identity(user) if user else None,
                            capture_output=True, text=True, timeout=20)
    assert (result.returncode == 0) == success, (arguments[:3], result.returncode, result.stdout, result.stderr)
    assert len(result.stdout) + len(result.stderr) <= 1048576
    return result.stdout


def save(path, value, mode=0o644):
    path.write_text(json.dumps(value))
    path.chmod(mode)


require_disposable()
release = Path(sys.argv[1]).resolve()
execution = len(sys.argv) > 2 and sys.argv[2] == "execution"
node = str(release / "runtime/bin/node")
named = str(release / "app/dist/named.js")
entry = str(release / "deploy/mission.mjs")
installation = "11111111-1111-4111-8111-111111111111"
account = "ua-111111111111411181111111"
state = Path(f"/var/lib/unit-001/agents/{installation}")
config = Path(f"/etc/unit-001/agents/{installation}")
runtime = Path(f"/run/unit-001-{installation}")
authority = config / "mission-authority.json"

invoke(["groupadd", "--gid", "1810", account])
invoke(["useradd", "--uid", "1810", "--gid", account, "--no-create-home", account])
users = [("um-human", 1811), ("um-elder", 1812), ("um-org", 1813)]
for name, uid in users:
    invoke(["useradd", "--uid", str(uid), "--no-create-home", "--groups", account, name])
config.mkdir(parents=True, mode=0o755)
save(config / "installation.json", {"schemaVersion": 1, "id": installation, "name": "bob", "account": account,
                                     "releaseVersion": "0.0.7", "desiredState": "running"})
(state / "workspace").mkdir(parents=True, mode=0o700)
state.chmod(0o700)
runtime.mkdir(mode=0o750)
invoke(["chown", "-R", f"{account}:{account}", str(state), str(runtime)])


def client(*arguments, user="um-human", success=True):
    output = invoke([node, named, installation, "bob", str(state), "--operator", "mission", *arguments], user, success)
    return json.loads(output) if success else output


def admin(*arguments, actor="um-human", success=True):
    uid = pwd.getpwnam(actor).pw_uid
    return invoke([node, entry, *arguments, "--id", installation], success=success,
                  env={"SUDO_UID": str(uid), "SUDO_USER": actor})


def start_owner(configured=None):
    if configured is None:
        configured = execution
    process = subprocess.Popen([node, str(release / ("app/test/fixtures/mission-execution-owner.mjs" if configured else "app/test/fixtures/mission-managed-owner.mjs"))],
                               cwd="/", env={"PATH": "/usr/bin:/bin"}, preexec_fn=identity(account),
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    for _ in range(150):
        if (state / "owner-ready").exists() and (state / "owner-ready").read_text() == str(process.pid):
            return process
        if process.poll() is not None:
            raise AssertionError(process.communicate())
        time.sleep(0.1)
    process.terminate()
    raise AssertionError("Managed owner did not become ready")


process = start_owner(False)
try:
    assert client("status", "--json")["authority"] == "unconfigured"
    creator_file = Path("/tmp/unit-mission-creator.json")
    terms_file = Path("/tmp/unit-mission-terms.json")
    revision = 0
    for kind, (user, uid) in zip(["human", "elder", "organization"], users):
        save(creator_file, {"creator": {"kind": kind, "id": f"fixture-{kind}", "uid": uid}, "ceiling": {
            "allowedTools": ["read"], "maxCycles": 3, "maxRequests": 4, "maxRetries": 1,
            "maxConsecutiveNoProgress": 2, "maxDurationMs": 600000}})
        invoke([node, entry, "creator", "--file", str(creator_file), "--id", installation], user, False)
        if kind == "human":
            # #14: a root invocation does not trust another user's file or follow a selected symlink.
            os.chown(creator_file, 1812, -1)
            admin("creator", "--file", str(creator_file), actor=user, success=False)
            assert not authority.exists()
            os.chown(creator_file, 0, -1)
            creator_link = Path("/tmp/unit-mission-creator-link.json")
            creator_link.symlink_to(creator_file)
            admin("creator", "--file", str(creator_link), actor=user, success=False)
            assert not authority.exists()
            creator_pipe = Path("/tmp/unit-mission-creator-pipe")
            os.mkfifo(creator_pipe)
            admin("creator", "--file", str(creator_pipe), actor=user, success=False)
            assert not authority.exists()
        admin("creator", "--file", str(creator_file), "--json", actor=user)
        save(terms_file, {"objective": f"Inspect fixture for {kind}", "scope": "Fixture only",
                          "successCriteria": ["Return evidence"], "approvalBoundary": [], "reviewEveryMs": 1000,
                          "policy": {"allowedTools": ["read"], "maxCycles": 2, "maxRequests": 3, "maxRetries": 0,
                                     "maxConsecutiveNoProgress": 1, "deadlineAt": int(time.time() * 1000) + 300000}})
        saved = client("draft", "--file", str(terms_file), "--revision", str(revision), "--request-id", f"draft-{kind}", "--json", user=user)
        revision = saved["formation"]["draft"]["revision"]
        proposed = client("propose", "--revision", str(revision), "--request-id", f"propose-{kind}", "--json", user=user)
        digest = proposed["formation"]["draft"]["digest"]
        client("approve", "--revision", str(revision), "--digest", digest, user=user, success=False)
        arguments = ["approve", "--revision", str(revision), "--digest", digest, "--request-id", f"approve-{kind}", "--json"]
        admin(*arguments, actor=user)
        admin(*arguments, actor=user)
        agreed = client("status", "--json", user=user)
        assert agreed["agreementValid"] is True and agreed["execution"] == "not-started"
        assert agreed["formation"]["agreement"]["approval"]["approvedBy"] == {"kind": "local-creator", "uid": uid}
        assert authority.stat().st_uid == 0 and authority.stat().st_mode & 0o022 == 0
        before = authority.read_bytes()
        admin("approve", "--revision", str(revision), "--digest", "0" * 64, "--request-id", f"approve-{kind}", actor=user, success=False)
        assert authority.read_bytes() == before

    # The same service UID used by coding tools cannot mint a managed root receipt.
    denied_script = Path("/tmp/unit-mission-denied.py")
    denied_script.write_text("import errno,sys\ntry: open(sys.argv[1], 'w')\nexcept OSError as e: assert e.errno in (errno.EACCES, errno.EPERM)\nelse: raise AssertionError('Root receipt was writable')\n")
    invoke(["python3", str(denied_script), str(authority)], account)
    wire_script = Path("/tmp/unit-mission-wire.py")
    wire_script.write_text("import socket,sys\ns=socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect(sys.argv[1]); s.sendall(sys.argv[2].encode()+bytes([10])); print(s.makefile('r').readline(65537)); s.close()\n")
    protected = authority.read_bytes()
    for request in [
        {"operation": "approve-local", "expectedRevision": revision, "digest": digest, "requestId": "forged"},
        {"operation": "reconcile", "receiptId": "model-claimed-approval"},
    ]:
        response = json.loads(invoke(["python3", str(wire_script), str(state / "control/default.sock"),
                                      json.dumps({"type": "mission", "request": request})], account))
        assert response["type"] == "error", response
        assert authority.read_bytes() == protected
    if execution:
        save(creator_file, {"creator": {"kind": "human", "id": "execution-creator", "uid": 1811}, "ceiling": {
            "allowedTools": ["write"], "maxCycles": 8, "maxRequests": 10, "maxRetries": 4,
            "maxConsecutiveNoProgress": 8, "maxDurationMs": 600000}})
        admin("creator", "--file", str(creator_file))
        save(terms_file, {"objective": "Write verified proof", "scope": "Disposable workspace", "successCriteria": [
            "sha256:" + hashlib.sha256(b"proof").hexdigest() + ":proof.txt"], "approvalBoundary": [], "reviewEveryMs": 30000,
            "policy": {"allowedTools": ["write"], "maxCycles": 8, "maxRequests": 10, "maxRetries": 4,
                       "maxConsecutiveNoProgress": 8, "deadlineAt": int(time.time() * 1000) + 300000}})
        saved = client("draft", "--file", str(terms_file), "--revision", str(revision), "--request-id", "execute-draft", "--json")
        revision = saved["formation"]["draft"]["revision"]
        proposed = client("propose", "--revision", str(revision), "--request-id", "execute-propose", "--json")
        digest = proposed["formation"]["draft"]["digest"]
        admin("approve", "--revision", str(revision), "--digest", digest)
        for action in ["start", "pause", "resume", "stop"]:
            client(action, user="um-human", success=False)
        admin("start", "--request-id", "pending-start", "--policy-revision", "0", success=False)
        cancelled = json.loads(admin("stop", "--request-id", "cancel", "--policy-revision", "0"))
        assert cancelled["status"] == "not-started"
        admin("stop", "--request-id", "cancel", "--policy-revision", "0")
        assert client("status", "--json")["policyRevision"] == 1
        process.send_signal(signal.SIGTERM)
        assert process.wait(timeout=20) == 0
        process = start_owner()
        protected = authority.read_bytes()
        admin("start", "--request-id", "pending-start", "--policy-revision", "0", success=False)
        assert authority.read_bytes() == protected
        assert not (state / "workspace/request-count").exists()
        (state / "workspace/retry-once").write_text("retry")
        admin("start", "--request-id", "S1", "--policy-revision", "1")

        def requested(count):
            for _ in range(2000):
                marker = state / "workspace/request-count"
                if marker.exists() and int(marker.read_text()) >= count:
                    return
                time.sleep(0.02)
            raise AssertionError("Mission provider fixture did not dispatch")

        requested(1)
        sleeping = client("status", "--json")
        assert sleeping["execution"] == "waiting", sleeping
        deadline = sleeping["runtime"]["nextWakeAt"]
        assert deadline > int(time.time() * 1000)
        # The actual session lock rejects a second process before any competing SQLite owner is opened.
        invoke([node, str(release / "app/test/fixtures/mission-execution-owner.mjs")], account, False)
        process.kill()
        assert process.wait(timeout=20) == -signal.SIGKILL
        process = start_owner()
        restored = client("status", "--json")
        assert restored["runtime"]["nextWakeAt"] == deadline
        assert restored["runtime"]["requests"] == 1
        time.sleep(0.2)
        assert int((state / "workspace/request-count").read_text()) == 1
        requested(2)
        paused = json.loads(admin("pause", "--request-id", "P1", "--policy-revision", "2"))
        assert paused["status"] == "paused" and paused["runtime"]["unknownRequests"] == 0
        admin("pause", "--request-id", "P1", "--policy-revision", "2")
        admin("resume", "--request-id", "R1", "--policy-revision", "3")
        requested(3)
        paused = json.loads(admin("pause", "--request-id", "P2", "--policy-revision", "4"))
        assert paused["runtime"]["requests"] == 3
        protected = authority.read_bytes()
        admin("resume", "--request-id", "R1", success=False)
        admin("resume", "--request-id", "R1", "--policy-revision", "3", success=False)
        assert authority.read_bytes() == protected
        for request in [{"operation": "control-local", "action": "resume", "expectedPolicyRevision": 4, "requestId": "forged"},
                        {"operation": "reconcile-execution", "requestId": "forged"}]:
            response = json.loads(invoke(["python3", str(wire_script), str(state / "control/default.sock"),
                                         json.dumps({"type": "mission", "request": request})], account))
            assert response["type"] == "error", response
            assert authority.read_bytes() == protected
        operator = runtime / "default.sock"
        response = json.loads(invoke(["python3", str(wire_script), str(operator), json.dumps({"type": "mission", "request": {
            "operation": "reconcile-execution", "requestId": "P2"}})], "um-human"))
        assert response["type"] == "error", response
        creator = json.loads(creator_file.read_text())
        creator["creator"]["id"] = "replacement-creator"
        save(creator_file, creator)
        admin("creator", "--file", str(creator_file))
        stopped = json.loads(admin("stop", "--request-id", "revoked-stop", "--policy-revision", "5"))
        assert stopped["status"] == "stopped" and stopped["runtime"]["intentSequence"] == 7
        assert client("status", "--json")["agreementValid"] is False
        admin("resume", "--request-id", "revive", "--policy-revision", "6", success=False)
        assert not (state / "workspace/proof.txt").exists()
    before = client("status", "--json")
    process.send_signal(signal.SIGTERM)
    assert process.wait(timeout=20) == 0
    process = start_owner()
    after = client("status", "--json")
    assert after["formation"] == before["formation"] and after["agreementValid"] is (not execution)
    if execution:
        assert after["execution"] == "stopped" and after["runtime"] == {**before["runtime"], "observedAt": after["runtime"]["observedAt"]}
        assert int((state / "workspace/request-count").read_text()) == 3
        print("managed lifecycle, SIGKILL/persisted-wake/no-polling, sole owner, replay/revocation/stop/reopen and distinct UID denial passed")
    else:
        print("managed human/elder/organization creator approval, replay, UID denial and owner restart passed")
finally:
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
