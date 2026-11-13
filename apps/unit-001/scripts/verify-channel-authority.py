#!/usr/bin/env python3
"""#56: Exercise root channel issuance and private bootstrap only in a named disposable Linux container."""
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

if not (os.geteuid() == 0 and platform.system() == "Linux" and platform.machine() == "x86_64"
        and os.environ.get("UNIT_001_DISPOSABLE_CONTAINER") == "1" and Path("/.dockerenv").is_file()
        and socket.gethostname() == "unit-001-channel-acceptance"):
    raise SystemExit("Requires the explicitly authorized disposable Linux x64 channel container.")
records = Path("/etc/unit-001/agents")
if records.exists() and any(records.iterdir()):
    raise SystemExit("Refusing a host containing existing installations.")

release = Path(sys.argv[1]).resolve()
node = str(release / "runtime/bin/node")
issuer = str(release / "deploy/channels.mjs")
owner_entry = str(release / "app/test/fixtures/channel-issuer-owner.mjs")
installation = "11111111-1111-4111-8111-111111111111"
account = "ua-111111111111411181111111"
state = Path(f"/var/lib/unit-001/agents/{installation}")
config = records / installation
policy = config / "channel-authority.json"


def identity(user):
    entry = pwd.getpwnam(user)

    def drop():
        os.initgroups(user, entry.pw_gid)
        os.setgid(entry.pw_gid)
        os.setuid(entry.pw_uid)
    return drop


def invoke(arguments, user=None, success=True, env=None):
    result = subprocess.run(arguments, cwd="/", preexec_fn=identity(user) if user else None,
                            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", **(env or {})},
                            capture_output=True, text=True, timeout=15)
    assert (result.returncode == 0) == success, (arguments[:3], result.returncode, result.stdout, result.stderr)
    assert "1234:synthetic_token" not in result.stdout + result.stderr
    return result.stdout


def save(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o600)


def admin(*arguments, success=True):
    return invoke([node, issuer, *arguments, "--id", installation], success=success,
                  env={"SUDO_UID": "1811", "SUDO_USER": "uc-creator"})


invoke(["groupadd", "--gid", "1810", account])
invoke(["useradd", "--uid", "1810", "--gid", account, "--no-create-home", account])
invoke(["useradd", "--uid", "1811", "--no-create-home", "uc-creator"])
invoke(["useradd", "--uid", "1812", "--no-create-home", "uc-outsider"])
config.mkdir(parents=True)
(config / "installation.json").write_text(json.dumps({"schemaVersion": 1, "id": installation,
    "name": "agent", "account": account, "releaseVersion": "0.0.7", "desiredState": "running"}))
state.mkdir(parents=True, mode=0o700)
invoke(["chown", f"{account}:{account}", str(state)])
invoke([node, owner_entry, "prepare"])
owner = subprocess.Popen([node, owner_entry], cwd="/", preexec_fn=identity(account),
                         env={"PATH": "/usr/bin:/bin"}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
try:
    for _ in range(100):
        if (state / "control/default.sock").exists():
            break
        if owner.poll() is not None:
            raise AssertionError(owner.communicate())
        time.sleep(0.05)
    assert (state / "control/default.sock").exists()
    input_file = Path("/tmp/unit-channel-policy.json")
    save(input_file, {"ceiling": [{"adapter": "telegram", "destinations": ["creator-1811"], "capabilities": ["status"]}], "disabled": []})
    for user in [account, "uc-creator", "uc-outsider"]:
        invoke([node, issuer, "policy", "--file", str(input_file), "--id", installation], user, False)
    os.chown(input_file, 1812, -1)
    admin("policy", "--file", str(input_file), success=False)
    assert not policy.exists()
    os.chown(input_file, 0, -1)
    alias = Path("/tmp/unit-channel-policy-link")
    alias.symlink_to(input_file)
    admin("policy", "--file", str(alias), success=False)
    fifo = Path("/tmp/unit-channel-policy-fifo")
    os.mkfifo(fifo)
    admin("policy", "--file", str(fifo), success=False)
    admin("policy", "--file", str(input_file))
    proposal = json.loads(Path("/tmp/unit-channel-proposal.json").read_text())
    arguments = ["approve", "--channel", "creator", "--revision", "1", "--digest", proposal["digest"], "--expires-at", str(proposal["expiresAt"] - 1)]
    admin(*arguments)
    before = policy.read_bytes()
    admin(*arguments)
    assert policy.read_bytes() == before
    wrong = list(arguments)
    wrong[wrong.index("--digest") + 1] = "0" * 64
    admin(*wrong, success=False)
    assert policy.read_bytes() == before
    assert policy.stat().st_uid == 0 and policy.stat().st_mode & 0o022 == 0
    bootstrap = Path("/tmp/unit-channel-manager.json")
    save(bootstrap, {"token": "1234:synthetic_token", "creatorId": 22, "username": "manager_bot"})
    admin("telegram-bootstrap", "--file", str(bootstrap))
    credential = state / "channels/telegram-manager.json"
    assert credential.stat().st_uid == 1810 and credential.stat().st_mode & 0o077 == 0
    assert json.loads(credential.read_text())["token"] == "1234:synthetic_token"
    for user in ["uc-creator", "uc-outsider"]:
        invoke(["cat", str(credential)], user, False)
    admin("revoke", "--channel", "creator")
    assert json.loads(policy.read_text())["disabled"] == ["creator"]
    assert not (state / "session.sqlite").exists()
    print("Root issuance, exact replay, protected input, service-UID bootstrap and private credential checks passed.")
finally:
    owner.send_signal(signal.SIGTERM)
    try:
        owner.wait(timeout=10)
    except subprocess.TimeoutExpired:
        owner.kill()
        owner.wait(timeout=5)
