#!/usr/bin/env bash
# Bootstraps coturn on a fresh Oracle Cloud "Always Free" Ubuntu VM as fd9's
# self-hosted TURN relay. Idempotent — safe to re-run after changing env vars.
#
# Run as (no domain/TLS yet — UDP+TCP only):
#   sudo TURN_SECRET="$(openssl rand -hex 32)" TURN_REALM=fd9-turn ./setup.sh
#
# Once you have a domain pointed at this VM and a cert (e.g. certbot), re-run
# with TLS enabled:
#   sudo TURN_SECRET=... TURN_REALM=turn.example.com \
#     CERT_PATH=/etc/letsencrypt/live/turn.example.com/fullchain.pem \
#     PKEY_PATH=/etc/letsencrypt/live/turn.example.com/privkey.pem \
#     ./setup.sh
#
# BEFORE running this: in the Oracle Cloud console, add ingress rules to
# this VM's VCN Security List (NOT just the OS firewall below — Oracle's
# own network-level security list is a separate layer that silently drops
# traffic even when ufw/iptables allow it, a very common "coturn looks up
# but relay never works" trap):
#   UDP 3478           (TURN control, UDP)
#   TCP 3478           (TURN control, TCP fallback)
#   UDP 49152-49352    (the bounded relay port range in turnserver.conf.template)
#   TCP 5349           (TURN control, TLS — only once CERT_PATH/PKEY_PATH are set)
#   TCP 443            (TURN control, TLS-443 fallback — same, later)

set -euo pipefail

: "${TURN_SECRET:?Set TURN_SECRET -- must match the TURN_SECRET env var on apps/signaling exactly}"
: "${TURN_REALM:?Set TURN_REALM -- any label works without TLS (e.g. fd9-turn, or the VM public IP); needs to be a real resolvable domain only once CERT_PATH/PKEY_PATH are set}"
# CERT_PATH/PKEY_PATH are OPTIONAL: unset = UDP+TCP on 3478 only, no TLS.
# Set both once you have a domain pointed at this VM and a cert (e.g. via
# certbot) to additionally enable turns:/5349 and the 443 TLS fallback.
CERT_PATH="${CERT_PATH:-}"
PKEY_PATH="${PKEY_PATH:-}"
if [[ -n "$CERT_PATH" && -z "$PKEY_PATH" ]] || [[ -z "$CERT_PATH" && -n "$PKEY_PATH" ]]; then
  echo "ERROR: set both CERT_PATH and PKEY_PATH, or neither (not just one)." >&2
  exit 1
fi

echo "==> Installing coturn"
apt-get update -y
apt-get install -y coturn

echo "==> Disabling the distro's default coturn service (we run our own unit + config)"
systemctl disable --now coturn.service 2>/dev/null || true

echo "==> Creating unprivileged turnserver user"
id -u turnserver &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin turnserver

echo "==> Writing /etc/turnserver.conf from template"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sed \
  -e "s#__REALM__#${TURN_REALM}#g" \
  -e "s#__TURN_SECRET__#${TURN_SECRET}#g" \
  "${SCRIPT_DIR}/turnserver.conf.template" > /etc/turnserver.conf

sed -i "/# __TLS_BLOCK__/d" /etc/turnserver.conf

if [[ -n "$CERT_PATH" ]]; then
  echo "==> CERT_PATH/PKEY_PATH set — enabling TLS (turns:/5349 and 443 fallback)"
  cat >> /etc/turnserver.conf <<EOF

tls-listening-port=5349
# Second TLS listener on 443 — the restrictive-network fallback. Needs
# CAP_NET_BIND_SERVICE (granted below) since it's a privileged port and
# coturn does not run as root.
alt-tls-listening-port=443
cert=${CERT_PATH}
pkey=${PKEY_PATH}
EOF
else
  echo "==> No CERT_PATH/PKEY_PATH — TLS listeners disabled, plain turn: on UDP+TCP 3478 only"
fi

mkdir -p /var/log/turnserver
chown turnserver:turnserver /var/log/turnserver

echo "==> Installing systemd unit"
cp "${SCRIPT_DIR}/fd9-turnserver.service" /etc/systemd/system/fd9-turnserver.service
systemctl daemon-reload
systemctl enable --now fd9-turnserver.service

echo "==> Opening the OS firewall (ufw) — the VCN security list above is SEPARATE and must also be opened"
if command -v ufw &>/dev/null; then
  ufw allow 3478/udp
  ufw allow 3478/tcp
  ufw allow 49152:49352/udp
  if [[ -n "$CERT_PATH" ]]; then
    ufw allow 5349/tcp
    ufw allow 443/tcp
  fi
fi

echo "==> Done. Verify with:"
echo "    systemctl status fd9-turnserver"
echo "    journalctl -u fd9-turnserver -f"
echo ""
echo "Then point apps/signaling's env at this relay:"
if [[ -n "$CERT_PATH" ]]; then
  echo "    TURN_URLS=turn:${TURN_REALM}:3478,turn:${TURN_REALM}:3478?transport=tcp,turns:${TURN_REALM}:5349?transport=tcp,turns:${TURN_REALM}:443?transport=tcp"
else
  echo "    TURN_URLS=turn:${TURN_REALM}:3478,turn:${TURN_REALM}:3478?transport=tcp"
  echo "    (no TLS yet — re-run this script with CERT_PATH/PKEY_PATH once you have a domain+cert to add turns:/5349 and 443)"
fi
echo "    TURN_SECRET=${TURN_SECRET}"
