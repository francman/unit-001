#!/usr/bin/env bash
# Renews the existing signed feed on a trusted standalone maintainer host; never builds or updates an agent.
set -euo pipefail
umask 077
[[ $# == 3 ]] || { printf 'Usage: renew-update-metadata.sh PUBLIC_ROOT ONLINE_KEYS PRIVATE_STATE\n' >&2; exit 2; }
[[ $(uname -s) == Linux && $EUID != 0 ]] || { printf 'Use a dedicated nonroot Linux publisher account.\n' >&2; exit 2; }
[[ ${GITHUB_ACTIONS:-} != true ]] || { printf 'GitHub Actions is prohibited.\n' >&2; exit 2; }
root=$1
keys=$2
state=$3
[[ $root == /* && $keys == /* && $state == /* ]] || { printf 'Publisher paths must be absolute.\n' >&2; exit 2; }
[[ -d $state && ! -L $state && $(stat -c %u "$state") == "$EUID" && $((8#$(stat -c %a "$state") & 0077)) == 0 ]] || { printf 'Publisher state must be a private directory owned by its account.\n' >&2; exit 2; }
[[ -f $root && ! -L $root && -d $keys && ! -L $keys ]] || { printf 'Expected public root and online signing directory.\n' >&2; exit 2; }
[[ -n ${GH_TOKEN:-} ]] || { printf 'A repository-scoped publishing GH_TOKEN is required.\n' >&2; exit 2; }
for command in node gh flock; do command -v "$command" >/dev/null || { printf 'Missing publisher command: %s\n' "$command" >&2; exit 2; }; done
# Manual publication must take this same lock; process death releases it without stale-lock cleanup.
exec 9> "$state/publication.lock"
if ! flock --nonblock 9; then printf 'Another publication is active; renewal deferred.\n'; exit 0; fi
# Only the locked publisher owns these scratch directories; a killed predecessor may have left one behind.
for previous in "$state"/renewal.*; do
  [[ -e $previous || -L $previous ]] || continue
  [[ ${previous##*/} =~ ^renewal\.[A-Za-z0-9]{6}$ && -d $previous && ! -L $previous && $(stat -c %u "$previous") == "$EUID" && $((8#$(stat -c %a "$previous") & 0077)) == 0 && -f $previous/.owned && ! -L $previous/.owned && $(cat "$previous/.owned") == unit-001-renewal-v1 ]] || { printf 'Unexpected publisher scratch path; refusing cleanup.\n' >&2; exit 2; }
  rm -rf -- "$previous"
done
work=$(mktemp -d "$state/renewal.XXXXXX")
printf 'unit-001-renewal-v1\n' > "$work/.owned"
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
node "$scripts/update-repository.mjs" renew --out "$work/staged" --root "$root" --keys "$keys"
node "$scripts/update-repository.mjs" publish --out "$work/staged/publication" --root "$root"
env -u GH_TOKEN node "$scripts/verify-public-metadata.mjs" --root "$root" --expected-timestamp "$work/staged/publication/timestamp.json" --out "$work/receipt.json"
mv -- "$work/receipt.json" "$state/last-success.json"
printf 'Renewal and anonymous metadata verification completed.\n'
