#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

fail() { printf 'submeld-agent: %s\n' "$1" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: install.sh --server https://panel.example --token TOKEN [--machine-id UUID] [--allow-http] [--vpsctl /absolute/path]' \
    '       install.sh --uninstall' \
    'Uninstall removes only the Agent service and executable; vpsctl, proxy services and private Agent state remain.'
}

server= token= machine_id= vpsctl= allow_http=false uninstall=false
while (($#)); do
  case "$1" in
    --server|--token|--machine-id|--vpsctl)
      (($# >= 2)) || fail 'missing option value'
      case "$1" in
        --server) server=$2 ;; --token) token=$2 ;;
        --machine-id) machine_id=$2 ;; --vpsctl) vpsctl=$2 ;;
      esac
      shift 2 ;;
    --allow-http) allow_http=true; shift ;;
    --uninstall) uninstall=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail 'unknown option' ;;
  esac
done

[[ $(id -u) == 0 ]] || fail 'run this installer as root'
[[ $(uname -s) == Linux ]] || fail 'Linux is required'
for tool in install mktemp rm chmod mv rmdir; do command -v "$tool" >/dev/null || fail "required tool missing: $tool"; done

service_kind=
if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
  service_kind=systemd
elif command -v rc-service >/dev/null && command -v rc-update >/dev/null; then
  service_kind=openrc
else
  fail 'a running systemd or OpenRC installation is required'
fi

if $uninstall; then
  if [[ $service_kind == systemd ]]; then
    if [[ -f /etc/systemd/system/submeld-agent.service ]]; then
      systemctl disable --now submeld-agent.service
      rm -f -- /etc/systemd/system/submeld-agent.service
      systemctl daemon-reload
    fi
  elif [[ -f /etc/init.d/submeld-agent ]]; then
    if rc-service submeld-agent status >/dev/null 2>&1; then rc-service submeld-agent stop; fi
    rc-update del submeld-agent default
    rm -f -- /etc/init.d/submeld-agent
  fi
  rm -f -- /usr/local/bin/submeld-agent
  printf '%s\n' 'Agent removed. vpsctl, proxy services, /etc/submeld-agent and /var/lib/submeld-agent were preserved.'
  exit 0
fi

for tool in curl sha256sum cp cat jq timeout; do command -v "$tool" >/dev/null || fail "required tool missing: $tool"; done
if [[ $service_kind == openrc ]]; then command -v supervise-daemon >/dev/null || fail 'OpenRC supervise-daemon is required'; fi
[[ -n $server && -n $token ]] || fail '--server and --token are required'
server=${server%/}
protocols='=https'
case "$server" in
  https://*) authority=${server#https://} ;;
  http://*) $allow_http || fail 'HTTP requires --allow-http on a trusted network'; authority=${server#http://}; protocols='=https,http' ;;
  *) fail 'server must be an HTTPS origin' ;;
esac
[[ -n $authority && $authority != *[/@?#]* && ! $authority =~ [[:space:]] ]] || fail 'server must be an origin without path, credentials or query'
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail 'supported architectures: amd64 and arm64' ;;
esac
[[ -z $vpsctl || $vpsctl == /* ]] || fail 'vpsctl must be an absolute executable path'
helper=${vpsctl:-/usr/local/bin/vpsctl}
[[ -x $helper ]] || fail 'vpsctl is not installed; install the compatible vps-script-lite machine API first'

tmp=$(mktemp -d /tmp/submeld-agent-install.XXXXXXXX)
trap 'rm -f -- "$tmp/binary" "$tmp/checksum" "$tmp/config.json" "$tmp/service" "$tmp/snapshot.json"; rmdir -- "$tmp"' EXIT
if ! timeout 45 "$helper" --non-interactive service proxy machine snapshot > "$tmp/snapshot.json" 2>/dev/null; then
  fail 'vpsctl machine snapshot failed; update vps-script-lite to a version with the machine API before installing Agent'
fi
if ! jq -e 'type == "object" and .schemaVersion == 1 and (.revision | type == "string" and test("^[a-f0-9]{64}$")) and (.capabilities.actions | type == "array") and (.cores | type == "array") and (.nodes | type == "array") and (.relay.exits | type == "array") and (.relay.bindings | type == "array") and (.relay.forwards | type == "array") and (.exports | type == "array") and (.pendingCores | type == "array")' "$tmp/snapshot.json" >/dev/null 2>&1; then
  fail 'vpsctl does not provide the required machine snapshot schema; update the management script while preserving existing proxies'
fi
rm -f -- "$tmp/snapshot.json"
asset="submeld-agent-linux-$arch"
curl --fail --silent --show-error --proto "$protocols" --connect-timeout 10 --max-time 180 --max-filesize 134217728 \
  "$server/agent/$asset" -o "$tmp/binary"
curl --fail --silent --show-error --proto "$protocols" --connect-timeout 10 --max-time 30 --max-filesize 4096 \
  "$server/agent/$asset.sha256" -o "$tmp/checksum"
read -r expected _ < "$tmp/checksum" || [[ -n ${expected:-} ]]
[[ ${expected:-} =~ ^[a-fA-F0-9]{64}$ ]] || fail 'invalid SHA-256 checksum response'
actual=$(sha256sum "$tmp/binary")
[[ ${actual%% *} == "${expected,,}" ]] || fail 'Agent download checksum mismatch'
chmod 0700 "$tmp/binary"

if [[ -f /etc/submeld-agent/config.json ]]; then cp -- /etc/submeld-agent/config.json "$tmp/config.json"; fi
setup=(setup --config "$tmp/config.json" --server "$server" --token-stdin "--allow-http=$allow_http")
[[ -z $machine_id ]] || setup+=(--machine-id "$machine_id")
[[ -z $vpsctl ]] || setup+=(--vpsctl "$vpsctl")
printf '%s' "$token" | "$tmp/binary" "${setup[@]}" >/dev/null
unset token

install -d -m 0700 /etc/submeld-agent /var/lib/submeld-agent
install -m 0755 "$tmp/binary" /usr/local/bin/submeld-agent.new
install -m 0600 "$tmp/config.json" /etc/submeld-agent/config.json.new
if [[ $service_kind == systemd ]]; then
  if systemctl is-active --quiet submeld-agent.service; then systemctl stop submeld-agent.service; fi
elif [[ -f /etc/init.d/submeld-agent ]] && rc-service submeld-agent status >/dev/null 2>&1; then
  rc-service submeld-agent stop
fi
mv -f -- /usr/local/bin/submeld-agent.new /usr/local/bin/submeld-agent
mv -f -- /etc/submeld-agent/config.json.new /etc/submeld-agent/config.json

if [[ $service_kind == systemd ]]; then
  cat > "$tmp/service" <<'SERVICE'
[Unit]
Description=SubMeld outbound machine agent
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/submeld-agent run --config /etc/submeld-agent/config.json
Restart=on-failure
RestartSec=5s
TimeoutStopSec=20s
UMask=0077

[Install]
WantedBy=multi-user.target
SERVICE
  install -m 0644 "$tmp/service" /etc/systemd/system/submeld-agent.service
  systemctl daemon-reload
  systemctl enable --now submeld-agent.service
else
  cat > "$tmp/service" <<'SERVICE'
#!/sbin/openrc-run
name="SubMeld machine agent"
description="SubMeld outbound machine agent"
command="/usr/local/bin/submeld-agent"
command_args="run --config /etc/submeld-agent/config.json"
supervisor="supervise-daemon"
respawn_delay=5
respawn_max=0
respawn_period=0
pidfile="/run/submeld-agent.pid"
umask="0077"
depend() { need net; after firewall; }
SERVICE
  install -m 0755 "$tmp/service" /etc/init.d/submeld-agent
  rc-update add submeld-agent default
  rc-service submeld-agent start
fi
printf '%s\n' 'Agent installed and started. Existing vpsctl configuration and proxy service ownership are unchanged.'
