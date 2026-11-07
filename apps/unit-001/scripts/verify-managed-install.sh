#!/usr/bin/env bash
# Exercises real named installations only on an explicitly disposable Ubuntu runner or test container.
set -euo pipefail

fail() { printf 'managed acceptance: %s\n' "$*" >&2; exit 1; }
[[ $# == 1 ]] || fail 'Usage: verify-managed-install.sh EXTRACTED_RELEASE_DIRECTORY'
if [[ ${UNIT_001_DISPOSABLE_CONTAINER:-} == 1 ]]; then
  [[ -f /.dockerenv && $(hostname) == unit-001-vps-acceptance ]] || fail 'Requires the explicitly named disposable Docker acceptance container.'
else
  [[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && ${UNIT_001_DISPOSABLE_CI:-} == 1 && ${RUNNER_OS:-} == Linux && ${RUNNER_ARCH:-} == X64 ]] || fail 'Requires explicit disposable GitHub-hosted CI authorization.'
fi
[[ $(uname -s) == Linux && $(uname -m) == x86_64 && $EUID == 0 ]] || fail 'Requires root on Linux x64.'
# shellcheck source=/dev/null
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || fail 'Requires Ubuntu 24.04.'
[[ $(ps -p 1 -o comm=) == systemd ]] || fail 'Requires a real systemd host.'
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH
release=$(cd -- "$1" && pwd -P)
node="$release/runtime/bin/node"
[[ -x $node && -f $release/install.sh ]] || fail 'Expected a complete extracted Linux release.'
version=$(cat "$release/VERSION")
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || fail 'Invalid release version.'
# Refuse to adopt or clean up an installation that existed before this test.
if [[ -e /etc/unit-001/agents ]]; then
  [[ -d /etc/unit-001/agents && ! -L /etc/unit-001/agents ]] || fail 'Unexpected existing installation registry.'
  [[ -z $(find /etc/unit-001/agents -mindepth 1 -maxdepth 1 -print -quit) ]] || fail 'Existing managed installations; refusing to test on this host.'
fi
[[ ! -e /opt/unit-001/releases/$version ]] || fail 'Release already installed; refusing to adopt it.'
for name in agent unit-ci-bob unit-ci-renamed; do
  ! command -v "$name" >/dev/null 2>&1 || fail "Existing command: $name"
done
work=$(mktemp -d /tmp/unit-001-managed-acceptance.XXXXXX)
cat > "$work/check.mjs" <<'JS'
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
const [action, ...args] = process.argv.slice(2);
const registry = "/etc/unit-001/agents";
const read = (id) => JSON.parse(readFileSync(`${registry}/${id}/installation.json`, "utf8"));
if (action === "find") {
 const records = existsSync(registry) ? readdirSync(registry).map(read) : [];
 const record = records.find(record => record.name === args[0]);
 if (!record) process.exitCode = 1;
 else console.log(record.id);
} else if(action === "field") console.log(read(args[0])[args[1]]);
else if(action === "intent") assert.equal(read(args[0]).desiredState,args[1]);
else if(action === "status") {
 const [file,id,name,version,pid] = args;
 const value = JSON.parse(readFileSync(file,"utf8"));
 assert.equal(value.type,"status"); assert.equal(value.installationId,id);
 assert.equal(value.name,name); assert.equal(value.version,version);
 assert.equal(value.pid,Number(pid)); assert.equal(value.busy,false);
} else throw new Error("Unknown assertion.");
JS
owned=()
cleanup() {
  local status=$? id name account home intent
  trap - EXIT
  set +e
  for id in "${owned[@]}"; do
    [[ $id =~ ^[0-9a-f-]{36}$ ]] || continue
    name=$("$node" "$work/check.mjs" field "$id" name) || continue
    account=$("$node" "$work/check.mjs" field "$id" account) || continue
    "$node" "$release/deploy/agent-command.mjs" "$id" "$name" uninstall --yes || true
    intent=$("$node" "$work/check.mjs" field "$id" desiredState) || continue
    if [[ $intent == uninstalled ]] && ! systemctl is-active --quiet "unit-001@$id.service"; then
      home=$(getent passwd "$account" | cut -d: -f6)
      if [[ $home == "/var/lib/unit-001/agents/$id" && $account == ua-* ]]; then
        userdel "$account" || true
        rm -rf -- "/var/lib/unit-001/agents/$id" "/etc/unit-001/agents/$id"
      fi
    fi
  done
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

status() {
  local name=$1 id=$2 pid account expected_uid actual_uid
  pid=$(systemctl show --property=MainPID --value "unit-001@$id.service")
  account=$("$node" "$work/check.mjs" field "$id" account)
  expected_uid=$(id -u "$account")
  actual_uid=$(ps -p "$pid" -o uid= | tr -d "[:space:]")
  [[ $expected_uid != 0 && $actual_uid == "$expected_uid" ]] || fail "Service $id is not running as its dedicated nonroot account."
  timeout 10 "/usr/local/bin/$name" service-status > "$work/status.json"
  "$node" "$work/check.mjs" status "$work/status.json" "$id" "$name" "$version" "$pid"
}
stopped() {
  local id=$1
  "$node" "$work/check.mjs" intent "$id" stopped
  ! systemctl is-active --quiet "unit-001@$id.service" || fail 'Stopped service is active.'
  ! systemctl is-enabled --quiet "unit-001@$id.service" || fail 'Stopped service is enabled.'
  [[ $(systemctl show --property=MainPID --value "unit-001@$id.service") == 0 ]] || fail 'Stopped service still owns a process.'
}

# #19: default/custom commands must own independent accounts, state and services.
bash "$release/install.sh"
first=$("$node" "$work/check.mjs" find agent)
owned+=("$first")
bash "$release/install.sh" --name unit-ci-bob
second=$("$node" "$work/check.mjs" find unit-ci-bob)
owned+=("$second")
[[ $first != "$second" ]] || fail 'Installations share an ID.'
first_account=$("$node" "$work/check.mjs" field "$first" account)
second_account=$("$node" "$work/check.mjs" field "$second" account)
[[ $first_account != "$second_account" ]] || fail 'Installations share an account.'
for id in "$first" "$second"; do
  stopped "$id"
  account=$("$node" "$work/check.mjs" field "$id" account)
  for directory in "/var/lib/unit-001/agents/$id" "/var/lib/unit-001/agents/$id/workspace"; do
    [[ $(stat -c %U "$directory") == "$account" && $(stat -c %a "$directory") == 700 ]] || fail 'Agent state ownership or private permissions are incorrect.'
  done
  printf 'OPENAI_API_KEY=unit-ci-not-a-real-key\nUNIT_001_MODEL=openai/gpt-5\n' > "/etc/unit-001/agents/$id/environment"
  chmod 600 "/etc/unit-001/agents/$id/environment"
done
# Startup and status never submit work or call a paid model.
/usr/local/bin/agent status > "$work/provider-status"
grep -q 'API key from OPENAI_API_KEY' "$work/provider-status"
if timeout 10 runuser -u nobody -- /usr/local/bin/agent status > "$work/wrong-account" 2>&1; then fail 'An unrelated account accessed the named agent.'; fi
grep -q 'installation account' "$work/wrong-account"
/usr/local/bin/agent start --yes
/usr/local/bin/unit-ci-bob start --yes
status agent "$first"
status unit-ci-bob "$second"

# #20: nonterminal input and a blank terminal answer must both default to No.
if timeout 10 /usr/local/bin/agent stop </dev/null > "$work/refusal" 2>&1; then fail 'Nonterminal stop succeeded without consent.'; fi
grep -q 'Action cancelled' "$work/refusal"
if printf '\n' | timeout 10 script --quiet --return --command '/usr/local/bin/agent stop' /dev/null > "$work/refusal" 2>&1; then fail 'Blank terminal answer consented to stop.'; fi
grep -q '\[y/N\]' "$work/refusal"
grep -q 'Action cancelled' "$work/refusal"
status agent "$first"
/usr/local/bin/agent stop --yes
stopped "$first"
status unit-ci-bob "$second"
# Reinstallation models reboot/update persistence without booting the runner itself.
bash "$release/install.sh"
stopped "$first"
/usr/local/bin/agent start --yes
status agent "$first"
/usr/local/bin/agent kill --yes
sleep 6
stopped "$first"
status unit-ci-bob "$second"
bash "$release/install.sh"
stopped "$first"
/usr/local/bin/agent start --yes
status agent "$first"

# Rename must refresh cached runtime identity while retaining UUID and account.
/usr/local/bin/agent rename unit-ci-renamed --yes
[[ ! -e /usr/local/bin/agent ]] || fail 'Rename left an old alias.'
[[ $("$node" "$work/check.mjs" find unit-ci-renamed) == "$first" ]] || fail 'Rename changed ID.'
[[ $("$node" "$work/check.mjs" field "$first" account) == "$first_account" ]] || fail 'Rename changed account.'
status unit-ci-renamed "$first"
status unit-ci-bob "$second"
# Write an inert credential for an unused provider; no authentication request is made.
printf '%s\n' '{"google":{"type":"api_key","key":"ci-preserve-only"}}' > "$work/auth.fixture"
install -o "$first_account" -g "$first_account" -m 600 "$work/auth.fixture" "/var/lib/unit-001/agents/$first/auth.json"
printf 'retained\n' > "$work/marker.fixture"
install -o "$first_account" -g "$first_account" -m 600 "$work/marker.fixture" "/var/lib/unit-001/agents/$first/workspace/ci-marker"
cp "/var/lib/unit-001/agents/$first/auth.json" "$work/auth.before"
cp "/etc/unit-001/agents/$first/environment" "$work/environment.before"
/usr/local/bin/unit-ci-renamed uninstall --yes
"$node" "$work/check.mjs" intent "$first" uninstalled
[[ ! -e /usr/local/bin/unit-ci-renamed && ! -e /opt/unit-001/agents/$first && ! -e /usr/lib/unit-001/agents/$first && ! -e /etc/systemd/system/unit-001@$first.service ]] || fail 'Uninstall left owned software.'
cmp "$work/auth.before" "/var/lib/unit-001/agents/$first/auth.json"
cmp "$work/environment.before" "/etc/unit-001/agents/$first/environment"
grep -qx retained "/var/lib/unit-001/agents/$first/workspace/ci-marker"
[[ $(stat -c %U "/var/lib/unit-001/agents/$first/auth.json") == "$first_account" ]] || fail 'Credential ownership changed.'
getent passwd "$first_account" >/dev/null
[[ -d /opt/unit-001/releases/$version ]] || fail "Uninstall removed another agent's shared release."
status unit-ci-bob "$second"
/usr/local/bin/unit-ci-bob uninstall --yes
"$node" "$work/check.mjs" intent "$second" uninstalled
getent passwd "$second_account" >/dev/null
[[ ! -e /opt/unit-001/releases/$version ]] || fail 'Unreferenced selected release survived uninstall.'
printf 'Managed installation acceptance passed (real Ubuntu/systemd; no model requests).\n'
