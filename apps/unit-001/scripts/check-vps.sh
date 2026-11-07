#!/usr/bin/env bash
# Reports managed-install prerequisites without changing host configuration, packages, users, or services.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  printf 'Usage: bash check-vps.sh\nRead-only Ubuntu 24.04 x86-64 managed-install preflight.\n' >&2
  exit 2
fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  printf 'FAIL: managed installation requires Linux x86-64.\n' >&2
  exit 1
fi
if [[ ! -r /etc/os-release ]]; then
  printf 'FAIL: cannot read /etc/os-release.\n' >&2
  exit 1
fi
# OS metadata is supplied by the host administrator, outside the application trust boundary.
# shellcheck source=/dev/null
. /etc/os-release
if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 24.04 ]]; then
  printf 'FAIL: managed installation requires Ubuntu 24.04 LTS.\n' >&2
  exit 1
fi
IFS= read -r init < /proc/1/comm
if [[ "$init" != systemd || ! -d /run/systemd/system ]]; then
  printf 'FAIL: systemd must be running as PID 1; filesystem staging is not live validation.\n' >&2
  exit 1
fi
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
missing=false
for command in bash sha256sum find sort cmp mktemp cp chmod mv ln readlink dirname mkdir rm rmdir cat uname id getent useradd chown flock systemctl runuser timeout tar df awk; do
  if ! command -v "$command" >/dev/null; then
    printf 'FAIL: missing prerequisite: %s\n' "$command" >&2
    missing=true
  fi
done
if [[ "$missing" == true ]]; then exit 1; fi
printf 'PASS: Ubuntu 24.04 x86-64, systemd PID 1, installer/runtime host tools present.\n'
awk '/MemTotal:/ {printf "RAM: %.0f MiB total\n", $2 / 1024} /MemAvailable:/ {printf "RAM: %.0f MiB available\n", $2 / 1024}' /proc/meminfo
df -h / /opt /var/lib
printf 'Sizing: 2 GiB is a provisional starting point, not a measured minimum; size for the agent and project tools.\n'
printf 'Install needs root. No Node/npm/compiler is required on this host.\n'
printf 'Not checked: cloud/host firewall rules, outbound provider access, credentials, or application acceptance.\n'
