# SMS via your MikroTik router (no monthly number fee)

Send critical alerts through the LTE modem in your own MikroTik instead of
renting a number from a cloud provider. You pay per message on a prepaid SIM and
nothing per month — and, crucially, the alert still arrives **from a real phone
number**, so each family member can save it as a contact and switch on iOS
**Emergency Bypass**. That is the only mechanism that makes a muted iPhone ring
at 3am; an alphanumeric sender or a WhatsApp/Signal message cannot do it.

## The shape of the problem

Your notification server runs on a public VPS. Your router sits at home behind
NAT. The naive fix — publishing the router's REST API on its dynamic DNS name —
would put **your entire router management API on the public internet**, guarded
by nothing but HTTP Basic Auth. Don't.

Instead the router **dials out** to the VPS over WireGuard and we talk to it on
the tunnel address. The router opens no inbound ports at all.

```
                       WireGuard (router dials out, UDP 51820)
  ┌────────────── VPS ──────────────┐            ┌────── home ──────┐
  │  podman bridge   wg0            │            │                  │
  │  10.89.0.0/24 → 10.10.10.1  ────┼──≡tunnel≡──┼→ 10.10.10.2      │
  │   └ notify server (container)   │            │   MikroTik + LTE │
  └─────────────────────────────────┘            └──────────────────┘
```

The server refuses to start if `MIKROTIK_URL` points at a public address. That
check exists precisely to stop the shortcut above.

---

## 1. Prerequisites

- **VPS running Fedora 44** (firewalld + SELinux enforcing + Podman). Commands
  below assume that. On a Debian/Ubuntu host the WireGuard config is identical;
  only the package manager and firewall commands differ.
- MikroTik with a cellular modem (built-in LTE, or a USB modem visible in
  `/port print`) and a SIM whose plan **permits SMS** — many data-only plans do
  not.
- **RouterOS v7** (the REST API needs 7.1 or newer).
- The LTE interface must be in **Running** state; SMS does not work while the
  modem is disconnected. If LTE is only your WAN failover, make sure the
  interface still comes up and stays connected.
- Confirm it works from the router's own terminal first:

  ```
  /tool sms send lte1 "+358401234567" message="test"
  ```

  If that fails, nothing below will help. Fix it there first.

## 2. WireGuard on the VPS (Fedora 44)

The WireGuard kernel module ships with the Fedora kernel; you only need the
userspace tools.

```bash
sudo dnf install -y wireguard-tools
```

Generate the key pair. `umask 077` matters — `wg-quick` refuses to use a config
that is world-readable, and the private key must not leak.

```bash
sudo mkdir -p /etc/wireguard && cd /etc/wireguard
umask 077
wg genkey | tee vps.key | wg pubkey > vps.pub
cat vps.key   # -> VPS_PRIVATE_KEY
cat vps.pub   # -> VPS_PUBLIC_KEY  (paste into the router config in step 3)
```

`/etc/wireguard/wg0.conf`:

```ini
[Interface]
Address = 10.10.10.1/24
ListenPort = 51820
PrivateKey = <VPS_PRIVATE_KEY>

[Peer]
# The router. It sits behind NAT with no fixed IP, so there is no Endpoint
# here — it dials us, and persistent-keepalive holds the mapping open.
PublicKey = <ROUTER_PUBLIC_KEY>
AllowedIPs = 10.10.10.2/32
```

```bash
sudo chmod 600 /etc/wireguard/wg0.conf
sudo systemctl enable --now wg-quick@wg0
sudo wg show
```

### firewalld

Fedora runs **firewalld**, so do not reach for `iptables` directly — rules added
that way will not survive a reload.

```bash
# The only port the tunnel needs. Nothing else is exposed.
sudo firewall-cmd --permanent --add-port=51820/udp

# Put the tunnel interface in a zone that permits forwarding and masquerading,
# so the container's traffic can leave via wg0 with the source address rewritten
# to 10.10.10.1 (which is what the router is configured to trust).
sudo firewall-cmd --permanent --zone=internal --add-interface=wg0
sudo firewall-cmd --permanent --zone=internal --add-masquerade
sudo firewall-cmd --permanent --zone=internal --add-forward

sudo firewall-cmd --reload
sudo firewall-cmd --list-all --zone=internal
```

We use the `internal` zone rather than `trusted` deliberately. `trusted` accepts
*everything* arriving on the interface; the router never needs to initiate
anything towards the VPS, so there is no reason to grant it that.

### IP forwarding

Podman normally enables this, but make it explicit and persistent:

```bash
echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/99-notify-forward.conf
sudo sysctl --system
sysctl net.ipv4.ip_forward     # must report 1
```

### SELinux

Fedora runs SELinux in **enforcing** mode. WireGuard and `wg-quick` work under
the default policy with no changes. SELinux only bites if you mount extra files
into the container later — for instance the router's CA certificate when using
HTTPS. In that case the volume needs a `:Z` relabel, exactly like the volumes
already in `compose.yaml`:

```yaml
    volumes:
      - ./router-ca.crt:/certs/router-ca.crt:ro,Z
```

Without `:Z` the container gets a permission-denied that looks nothing like an
SELinux problem. If something is mysteriously unreadable inside the container,
check `sudo ausearch -m AVC -ts recent`.

## 3. WireGuard on the MikroTik

```
/interface wireguard
add name=wg-notify listen-port=13231

/ip address
add address=10.10.10.2/24 interface=wg-notify

/interface wireguard peers
add interface=wg-notify \
    public-key="<VPS_PUBLIC_KEY>" \
    endpoint-address=<VPS_PUBLIC_IP> \
    endpoint-port=51820 \
    allowed-address=10.10.10.1/32 \
    persistent-keepalive=25s
```

Print the router's own public key to paste into the VPS config:

```
/interface wireguard print detail
```

`persistent-keepalive` is what holds the NAT mapping open so the VPS can reach
back through it. Without it the tunnel goes quiet and the first alert of the day
fails.

Verify from the VPS:

```bash
ping -c3 10.10.10.2
```

## 4. A dedicated RouterOS user

Never use `admin` for this. Create a user restricted to the tunnel address, with
the minimum policies RouterOS requires to send an SMS over REST:

```
/user group
add name=sms-only policy=local,read,write,test,api,rest-api

/user
add name=notify-sms group=sms-only password="<STRONG_PASSWORD>" \
    address=10.10.10.1/32
```

`address=10.10.10.1/32` means these credentials are useless from anywhere except
the far end of the tunnel.

## 5. Bind the REST API to the tunnel only

```
/ip service
set www address=10.10.10.1/32 disabled=no
```

Plain HTTP is deliberate and safe **here**: the traffic never leaves the
WireGuard tunnel, which already encrypts and authenticates it. Exposing `www` on
any other interface would not be safe — hence the `address=` restriction.

Belt and braces, in the firewall:

```
/ip firewall filter
add chain=input in-interface=wg-notify src-address=10.10.10.1 \
    protocol=tcp dst-port=80 action=accept comment="notify server -> REST"
add chain=input in-interface=wg-notify action=drop comment="nothing else"
```

<details>
<summary>If you want HTTPS anyway (defence in depth)</summary>

```
/certificate
add name=ca-template common-name=notify-ca key-usage=key-cert-sign,crl-sign
add name=server-template common-name=10.10.10.2
sign ca-template name=root-ca
sign ca=root-ca server-template name=server
set root-ca trusted=yes
export-certificate root-ca

/ip service
set www-ssl certificate=server address=10.10.10.1/32 disabled=no
set www disabled=yes
```

Copy the exported CA to the VPS and mount it into the server container. On
Fedora the `:Z` relabel is **required** — SELinux is enforcing, and without it
the container gets a permission error that looks nothing like an SELinux problem:

```yaml
# deploy/compose.yaml, under the `server` service
    volumes:
      - ./root-ca.crt:/certs/root-ca.crt:ro,Z
```

Then set `MIKROTIK_URL=https://10.10.10.2` and
`MIKROTIK_CA_CERT=/certs/root-ca.crt` in `.env`.
</details>

## 6. Test the API from the VPS host

```bash
curl -u notify-sms:'<STRONG_PASSWORD>' http://10.10.10.2/rest/tool/sms \
  -H 'Content-Type: application/json'
# -> {"port":"lte1","status":"running", ...}   <-- status MUST be "running"
```

Then a real send:

```bash
curl -u notify-sms:'<STRONG_PASSWORD>' http://10.10.10.2/rest/tool/sms/send \
  -H 'Content-Type: application/json' \
  --data '{"port":"lte1","phone-number":"+358401234567","message":"test"}'
```

## 7. Make sure the *container* can reach it

This is the step people skip and then debug for an hour.

The notify server runs inside Podman, not on the host. It has no idea WireGuard
exists — its default route points at the Podman bridge, i.e. the host, which then
routes `10.10.10.0/24` out via `wg0`. On the way out the host **masquerades** the
source address to `10.10.10.1`, so the router sees the request coming from the
tunnel address it already trusts.

Check it from inside the container. Node is present in the runtime image, so no
extra tooling is needed:

```bash
sudo podman-compose exec server node -e "
  const auth = 'Basic ' + Buffer.from('notify-sms:<PASSWORD>').toString('base64');
  fetch('http://10.10.10.2/rest/system/resource', { headers: { Authorization: auth } })
    .then(r => r.text())
    .then(t => console.log('OK', t.slice(0, 80)))
    .catch(e => console.error('FAILED', e.message));
"
```

Compare with the same call from the host. If the host succeeds and the container
fails, read on — that exact asymmetry is the symptom below.

**If the host can reach the router but the container cannot**, one of two things
is happening — and both fail *silently*, which is what makes this worth twenty
minutes of reading now instead of two hours of debugging later.

### Cause A: the packet never leaves the VPS (firewalld)

Fedora's firewalld filters forwarded traffic. If the Podman bridge and `wg0` are
in different zones and forwarding is not permitted, the packet is dropped on the
host.

```bash
# Which zone is each interface in?
sudo firewall-cmd --get-active-zones

# The route must exit via wg0 with the tunnel source address:
ip route get 10.10.10.2
#  -> 10.10.10.2 dev wg0 src 10.10.10.1 uid 0     <-- this is what you want

# Watch for drops while you retry the request from the container:
sudo journalctl -f -t kernel | grep -i 'REJECT\|DROP'
```

If forwarding is being blocked, the `--add-forward` and `--add-masquerade` from
step 2 are missing or were not reloaded. Re-apply and `firewall-cmd --reload`.

### Cause B: the packet reaches the router and WireGuard discards it

WireGuard enforces *cryptokey routing*: it accepts a packet from a peer only if
the packet's source address is in that peer's `allowed-address` list. If the host
did **not** masquerade, the router sees a source of `10.89.0.x` (the Podman
subnet), which is not in the list — so it drops the packet and logs nothing. No
error reaches you; the SMS simply never sends.

Confirm what the router actually receives:

```
/interface wireguard peers print detail
# rx / last-handshake should be advancing. If rx stays at 0 while you send
# requests, nothing is arriving at all -> Cause A.
```

Two fixes, either works:

```bash
# A. Rely on masquerading (the default, and what step 2 configures).
#    `ip route get 10.10.10.2` showing `src 10.10.10.1` means you are fine.
```

```
# B. Or explicitly let the router accept the Podman subnet as well.
/interface wireguard peers
set [find interface=wg-notify] allowed-address=10.10.10.1/32,10.89.0.0/24
```

Find your actual subnet — Podman does not always use `10.89.0.0/24`:

```bash
sudo podman network inspect deploy_default | grep -i subnet
```

Option B is the more forgiving of the two: it works whether or not masquerading
happens, so if you want this to just work and stop thinking about it, do both.

## 8. Point the service at it

In `deploy/.env`:

```
SMS_PROVIDER=mikrotik
MIKROTIK_URL=http://10.10.10.2
MIKROTIK_USER=notify-sms
MIKROTIK_PASSWORD=<STRONG_PASSWORD>
MIKROTIK_SMS_PORT=lte1
```

Recreate the server, then add SMS numbers (E.164, e.g. `+358401234567`) to your
users in Settings → Family members. Critical alerts now go out over web push
**and** SMS in parallel.

```bash
podman-compose up -d server
```

## 9. Set up Emergency Bypass — this is the whole point

On every family iPhone:

1. Save the router SIM's number as a **contact** (e.g. "Koti Hälytys").
2. Contacts → the contact → **Edit** → **Text Tone** → turn on **Emergency
   Bypass**. Do the same under **Ringtone** if you later add voice escalation.

Without this the SMS is just another silenced notification and you have gained
nothing over web push.

---

## Character handling (already handled, but worth knowing)

RouterOS only transmits the GSM-7 alphabet and **silently drops anything else** —
a message containing "keittiössä" would arrive mangled, with no error anywhere.
The service therefore transliterates before sending (`ä→a`, `ö→o`, `å→a`, curly
quotes → straight, `€ → EUR`) and replaces anything still unrepresentable with
`?`. Alerts read slightly plainer than the original, and arrive intact.

## Operational advice

- **Test monthly, automatically.** A dead alert channel is the worst possible
  failure, and a prepaid SIM can expire, run out of credit, or be deactivated for
  inactivity without telling you. Send yourself a low-priority SMS on a schedule
  and check it arrives.
- **Watch the tunnel.** If WireGuard drops, SMS stops. `/interface wireguard
  peers print` shows `last-handshake`; anything older than a couple of minutes
  means the tunnel is down.
- **One SMS at a time.** RouterOS acquires the modem port for the duration of the
  command and it cannot be used concurrently, so bursts serialise. Fine for home
  alerting.
- **If the power goes out**, the router and your alerts go with it. That is true
  of every self-hosted option, but it is the one thing a cloud SMS provider would
  survive — provided your server is not at home either. Yours is on a VPS, so a
  home power cut means the server lives but cannot send SMS. Consider keeping a
  cloud provider configured as a fallback if that scenario matters to you.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/tool sms print` shows `status: off` | Modem not ready or LTE interface not Running. Fix on the router before touching the API. |
| Container gets a timeout, host does not | firewalld is dropping the forward, or masquerading isn't happening — see step 7. This is the most common failure on Fedora. |
| Worked, then broke after a reboot or `firewall-cmd --reload` | A rule was added without `--permanent`. Re-apply step 2 with `--permanent` and reload. |
| Permission denied reading the CA cert inside the container | Missing `:Z` on the volume. SELinux is enforcing; check `sudo ausearch -m AVC -ts recent`. |
| `wg-quick` refuses to start | `/etc/wireguard/wg0.conf` is world-readable. `sudo chmod 600` it. |
| `wg show` lists the peer but `last-handshake` never updates | The router is not reaching UDP 51820. Check `firewall-cmd --list-ports` on the VPS and the router's `endpoint-address`. |
| HTTP 401 | Wrong password, or the user's `address=` does not match the source the router sees. |
| HTTP 403 / "no permission" | The user group is missing one of `local,read,write,test,api,rest-api`. |
| Message arrives with letters missing | Non-GSM-7 text reached the modem. The service sanitises, so this means something bypassed it. |
| Nothing arrives, no error | Check SIM credit, and that the plan allows SMS at all. |
