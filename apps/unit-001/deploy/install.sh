#!/usr/bin/env bash
# Verifies and installs one complete Linux release; staging never changes host users or services.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./install.sh [--name NAME] [--dry-run | --root DIRECTORY]

Install this extracted unit-001 release on Ubuntu 24.04 LTS, Linux x64.
Verify the archive's published SHA-256 before extracting and running this installer.

  --dry-run         Verify release contents and print the plan without installing.
  --root DIRECTORY  Stage a filesystem image below DIRECTORY; do not manage host users/services.
  --name NAME       Installed command name (default: agent).
  --help            Show this help.

A live install needs root. First install leaves the named service stopped;
configure it with sudo NAME login, then sudo NAME start. No u1 alias is installed.
Upgrades preserve each installation's UUID, state, credentials, and stopped intent.
EOF
}

fail() { printf 'unit-001 install: %s\n' "$*" >&2; exit 1; }

root=""
dry_run=false
name=agent
name_seen=false
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --dry-run) [[ -z "$root" && "$dry_run" == false ]] || fail 'Choose --dry-run or --root once.'; dry_run=true; shift ;;
    --root) [[ $# -ge 2 && -n "$2" && -z "$root" && "$dry_run" == false ]] || fail '--root needs one directory and cannot be combined with --dry-run.'; root="$2"; shift 2 ;;
    --name) [[ $# -ge 2 && -n "$2" && "$name_seen" == false ]] || fail '--name needs one value and may be specified once.'; name="$2"; name_seen=true; shift 2 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH
[[ "$name" =~ ^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$ ]] || fail 'Agent name must be 1–32 lowercase letters, digits, or internal hyphens, starting with a letter.'
if [[ -z "$root" && "$dry_run" == false ]]; then
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
fi

release=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
[[ -f "$release/SHA256SUMS" && ! -L "$release/SHA256SUMS" ]] || fail 'Missing SHA256SUMS; run the installer from a complete release.'
verification=$(mktemp -d)
stage=""
lock=""
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  rm -rf -- "$verification"
  [[ -z "$stage" ]] || rm -rf -- "$stage"
  [[ -z "$lock" ]] || rmdir -- "$lock"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

verify_tree() {
  local directory="$1" line path
  [[ -z "$(find "$directory" -mindepth 1 ! -type d ! -type f -print -quit)" ]] || fail 'Release must contain only regular files and directories.'
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:xdigit:]]{64}\ \ (\./.+)$ ]] || fail 'Malformed checksum manifest.'
    path="${BASH_REMATCH[1]}"
    [[ "$path" != *'/../'* && "$path" != */.. && "$path" != *'/./'* && "$path" != './SHA256SUMS' ]] || fail 'Unsafe checksum path.'
    printf '%s\n' "$path"
  done < "$directory/SHA256SUMS" | LC_ALL=C sort > "$verification/expected"
  (cd -- "$directory" && find . -type f ! -path './SHA256SUMS' -print | LC_ALL=C sort) > "$verification/actual"
  cmp -s "$verification/expected" "$verification/actual" || fail 'Release file inventory differs from SHA256SUMS.'
  (cd -- "$directory" && sha256sum --check --strict --quiet SHA256SUMS) || fail 'Release checksum verification failed.'
}
verify_tree "$release"
for required in VERSION runtime/bin/node app/dist/bin.js app/dist/named.js app/package.json bin/agent deploy/unit-001.service deploy/activate.sh deploy/check-ready.mjs deploy/installation.mjs deploy/agent-command.mjs deploy/lifecycle.mjs; do
  [[ -f "$release/$required" ]] || fail "Missing release file: $required"
done
version=$(cat -- "$release/VERSION")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$ ]] || fail 'VERSION must be a safe semantic version.'
printf 'Verified unit-001 %s.\n' "$version"
if [[ -f "$release/deploy/update-root.json" || -f "$release/deploy/update-feed.json" ]]; then
  preflight_node="$release/runtime/bin/node"
  if [[ -n "$root" || $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
    preflight_node=$(command -v node) || fail 'Public update trust verification on another OS requires a host Node.js runtime.'
  fi
  "$preflight_node" "$release/deploy/installation.mjs" preflight "$release"
fi
if [[ "$dry_run" == true ]]; then
  printf 'Plan: install command %s with isolated identity and state; no host changes.\n' "$name"
  exit 0
fi
if [[ -n "$root" ]]; then
  [[ ! -L "$root" ]] || fail '--root must not be a symbolic link.'
  mkdir -p -- "$root"
  root=$(cd -- "$root" && pwd -P)
  [[ "$root" != / ]] || fail '--root must be a staging directory, not /.'
  [[ "$root" != "$release" && "$root" != "$release/"* ]] || fail 'The staging root must be outside the release directory.'
elif [[ "$dry_run" == false ]]; then
  [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'Live installation requires Linux x64.'
  [[ $EUID -eq 0 ]] || fail 'Run the live installer as root, or use --dry-run/--root.'
  [[ -f /etc/os-release ]] || fail 'Cannot identify the operating system.'
  # The OS metadata belongs to the host, outside the release trust boundary.
  # shellcheck source=/dev/null
  . /etc/os-release
  [[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || fail 'The initial supported live target is Ubuntu 24.04 LTS.'
  command -v systemctl >/dev/null || fail 'systemctl is required.'
fi
node="$release/runtime/bin/node"
if [[ -n "$root" || ( "$dry_run" == true && $(uname -s) != Linux ) ]]; then
  node=$(command -v node) || fail 'Filesystem staging on another OS requires a host Node.js runtime.'
fi
"$node" "$release/deploy/installation.mjs" install "$release" "$root" "$name" "$dry_run"
