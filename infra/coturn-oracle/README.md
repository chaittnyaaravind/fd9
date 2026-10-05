# Self-hosted coturn on Oracle Cloud (Always Free)

Replaces the previous Fly.io-hosted relay (`fd9-turn-relay.fly.dev`), whose
UDP listener on 3478 went dark while its TCP listener stayed up — a classic
"looks up, isn't actually usable" failure that's exactly what this setup
and `apps/signaling`'s diagnostics (`turnTransports` in `rtc.ts`) are meant
to catch early next time, on either provider.

## Why Oracle Cloud

The "Always Free" tier includes a small VM (ARM `VM.Standard.A1.Flex`, up to
4 OCPU / 24 GB, or an AMD `VM.Standard.E2.1.Micro`) with a static public IP
at no cost, indefinitely — enough for a TURN relay, which is bandwidth-light
control-plane work plus whatever file-transfer bytes actually get relayed
(most sessions should end up direct/STUN; TURN is the fallback path, not
the common case).

## One thing that WILL silently break this if skipped

Oracle Cloud's **VCN Security List** is a network-level firewall that sits
in front of the VM, separate from the OS firewall (`ufw`/`iptables`) that
`setup.sh` configures. Traffic can be allowed by `ufw` and still never
reach the VM if the Security List doesn't also allow it — this is the
single most common way a coturn deployment ends up in exactly the state
the Fly.io relay was in: the TCP control port answers (because it's
commonly left open or tested first) while the actual UDP relay silently
fails, because nobody opened the UDP range at the VCN layer.

**In the Oracle Cloud console, before running `setup.sh`:**
Networking -> Virtual Cloud Networks -> (your VCN) -> Security Lists ->
(the list attached to this VM's subnet) -> Add Ingress Rules:

| Source CIDR | Protocol | Port range | Purpose |
|---|---|---|---|
| 0.0.0.0/0 | UDP | 3478 | TURN control, UDP |
| 0.0.0.0/0 | TCP | 3478 | TURN control, TCP fallback |
| 0.0.0.0/0 | UDP | 49152-49352 | Bounded relay port range (actual media/data) |
| 0.0.0.0/0 | TCP | 5349 | TURN control, TLS — only add once you have a domain+cert |
| 0.0.0.0/0 | TCP | 443 | TURN control, TLS-443 fallback — same, later |

Verify both UDP rows with a real test after setup -- a TCP-only check (`nc
-zv host port`) proves nothing about UDP, which is exactly the mistake
that let the Fly.io outage go unnoticed. From any machine:

```bash
python3 -c "
import socket, struct
msg = struct.pack('!HHI12s', 0x0001, 0, 0x2112A442, b'0123456789AB')
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(5)
s.sendto(msg, ('YOUR_RELAY_HOST', 3478))
print(s.recvfrom(1024))
"
```

A real STUN response (not a timeout) confirms UDP actually works end to
end -- VCN Security List, OS firewall, and coturn's own listener all
correctly open.

## Setup (phase 1 — no domain yet: UDP+TCP only, no TLS)

1. Provision the VM (Ubuntu 22.04+ recommended).
2. Open the VCN Security List rules above (just the 3478 UDP/TCP + relay
   range rows for now).
3. Run:
   ```bash
   sudo TURN_SECRET="$(openssl rand -hex 32)" TURN_REALM=fd9-turn ./setup.sh
   ```
   (`TURN_REALM` can be any label, or the VM's public IP, when there's no
   domain yet — it only needs to be a real resolvable hostname once TLS is
   added in phase 2.)
4. Verify with the raw UDP STUN test further up this README, substituting
   the VM's public IP.
5. Set the printed `TURN_URLS`/`TURN_SECRET` on `apps/signaling`'s env
   (`.env` locally, or wherever it's deployed) and restart/redeploy it.
6. Test independently with a real TURN client (not a browser — see the
   verification section below), then test the physical Mac<->iPhone
   pairing.
7. Once confirmed working, remove `FALLBACK_TURN_URLS`/
   `FALLBACK_TURN_STATIC_USERNAME`/`FALLBACK_TURN_STATIC_CREDENTIAL` (Open
   Relay) from `apps/signaling`'s env -- this relay is now the sole TURN
   provider.

## Setup (phase 2 — once you have a domain: add TLS)

1. Point a DNS A record at the VM's public IP (e.g. `turn.yourdomain.com`).
2. Get a cert: `certbot certonly --standalone -d turn.yourdomain.com`.
3. Add the 5349/443 VCN Security List rows above.
4. Re-run `setup.sh` with `TURN_REALM` set to the real domain and
   `CERT_PATH`/`PKEY_PATH` pointed at the cert:
   ```bash
   sudo TURN_SECRET=<same secret as phase 1> \
     TURN_REALM=turn.yourdomain.com \
     CERT_PATH=/etc/letsencrypt/live/turn.yourdomain.com/fullchain.pem \
     PKEY_PATH=/etc/letsencrypt/live/turn.yourdomain.com/privkey.pem \
     ./setup.sh
   ```
5. Update `TURN_URLS` on `apps/signaling` to the new value `setup.sh`
   prints (now including `turns:.../5349` and `turns:.../443`).
6. Run `apps/web/e2e/connection-smoke.spec.ts`'s Test A/B/C (see the repo
   root README's networking section) from a real, unrestricted network --
   not a sandboxed CI runner -- to confirm direct, TURN-UDP, and TURN-TCP/
   TLS all actually work end to end.

## Certificate renewal

`certbot renew` rotates the cert files in place at the same path; coturn
needs a restart to pick up new files (`systemctl restart fd9-turnserver`).
Add a renewal hook:

```bash
echo '#!/bin/sh
systemctl restart fd9-turnserver' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/restart-coturn.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/restart-coturn.sh
```
