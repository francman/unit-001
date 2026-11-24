#!/usr/bin/env bash
# Activates one prepared named installation and restores only that installation on failure.
set -euo pipefail

root="$1"
id="$2"
version="$3"
name="$4"
desired_state="$5"
plan="$6"
readiness_timeout="$7"
service_action="$8"
[[ "$service_action" == manage || "$service_action" == stage ]] || { printf 'Invalid service action.\n' >&2; exit 2; }
prefix="$root/opt/unit-001/agents/$id"
management="$root/usr/lib/unit-001/agents/$id"
config="$root/etc/unit-001/agents/$id"
record="$config/installation.json"
unit_name="unit-001@$id.service"
unit="$root/etc/systemd/system/$unit_name"
command="$root/usr/local/bin/$name"
release="$root/opt/unit-001/releases/$version"
backup=$(mktemp -d "$config/.activation-backup.XXXXXX")
was_running=false
was_enabled=false
activation_started=false
activation_complete=false
candidate_started=false
previous=

atomic_link() {
  local target="$1" path="$2" next="${2}.next.$$"
  ln -s -- "$target" "$next" || return
  if [[ $(uname -s) == Darwin ]]; then mv -fh -- "$next" "$path"; else mv -Tf -- "$next" "$path"; fi
}

publish_file() {
  local source="$1" path="$2" mode="$3" temporary
  temporary=$(mktemp "$path.next.XXXXXX")
  cp -- "$source" "$temporary"
  chmod "$mode" "$temporary"
  mv -f -- "$temporary" "$path"
}

restore_activation() {
  local item path
  if [[ "$service_action" == manage ]]; then
    if [[ "$candidate_started" == true ]] && ! systemctl stop "$unit_name"; then
      printf 'unit-001 install: cannot stop candidate; leaving selected software unchanged.\n' >&2
      return 1
    fi
    if [[ -f "$unit" ]]; then systemctl disable "$unit_name" || return; fi
  fi
  rm -f -- "$prefix/current.next.$$" || return
  if [[ -n "$previous" ]]; then
    atomic_link "$previous" "$prefix/current" || return
  else
    rm -f -- "$prefix/current" || return
  fi
  for item in record command unit; do
    path="${!item}"
    if [[ -f "$backup/$item" ]]; then
      cp -p -- "$backup/$item" "$path" || return
    else
      rm -f -- "$path" || return
    fi
  done
  rm -rf -- "$management" || return
  if [[ -d "$backup/management" ]]; then cp -pR -- "$backup/management" "$management" || return; fi
  if [[ "$service_action" == manage ]]; then
    systemctl daemon-reload || return
    if [[ "$was_enabled" == true ]]; then systemctl enable "$unit_name" || return; fi
    if [[ "$was_running" == true ]]; then systemctl start "$unit_name" || return; fi
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$activation_started" == true && "$activation_complete" == false ]]; then
    if ! restore_activation; then
      printf 'unit-001 install: restoration failed for installation %s. Recovery backup: %s\n' "$id" "$backup" >&2
      rm -f -- "$prefix/current.next.$$" || true
      exit "$status"
    fi
    printf 'unit-001 install: activation failed; restored installation %s.\n' "$id" >&2
  fi
  rm -f -- "$prefix/current.next.$$"
  rm -rf -- "$backup"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -L "$prefix/current" ]]; then
  previous=$(readlink "$prefix/current")
  printf '%s\n' "$previous" > "$backup/current"
fi
for item in record command unit; do
  path="${!item}"
  if [[ -e "$path" ]]; then cp -p -- "$path" "$backup/$item"; fi
done
if [[ -d "$management" ]]; then cp -pR -- "$management" "$backup/management"; fi

if [[ "$service_action" == manage ]] && systemctl is-active --quiet "$unit_name"; then was_running=true; fi
if [[ "$service_action" == manage ]] && systemctl is-enabled --quiet "$unit_name"; then was_enabled=true; fi
web_configured=false
if [[ "$service_action" == manage && ( -e "$config/web-activation.json" || -L "$config/web-activation.json" ) ]]; then
  web_configured=true
fi
if [[ "$service_action" == manage && ( "$was_running" == true || "$web_configured" == true ) ]]; then
  systemctl stop "$unit_name"
fi
activation_started=true
if [[ "$web_configured" == true ]]; then
  "$release/runtime/bin/node" "$release/deploy/installation.mjs" web-quiesce "$id"
fi
mkdir -p -- "$management"
chmod 755 "$management"
for module in installation.mjs agent-command.mjs lifecycle.mjs update-activation.mjs; do
  publish_file "$release/deploy/$module" "$management/$module" 644
done
publish_file "$plan/record.json" "$record" 644
publish_file "$plan/command" "$command" 755
publish_file "$plan/unit" "$unit" 644
atomic_link "../../releases/$version" "$prefix/current"
if [[ "$service_action" == manage ]]; then
  systemctl daemon-reload
  if [[ "$desired_state" == running ]]; then
    # Failed units retain start limits; inactive units can disappear before reset-failed.
    active_state=$(systemctl show --property=ActiveState --value "$unit_name")
    if [[ "$active_state" == failed ]]; then systemctl reset-failed "$unit_name"; fi
    systemctl enable "$unit_name"
    candidate_started=true
    systemctl start "$unit_name"
    "$release/runtime/bin/node" "$release/deploy/check-ready.mjs" "$root" "$id" "$version" "$readiness_timeout"
  else
    systemctl disable "$unit_name"
  fi
fi
activation_complete=true
