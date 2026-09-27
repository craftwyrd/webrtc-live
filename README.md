# CraftWyrd Live

Vue 3 + Vite provides the WHEP watch and WHIP publish console. The Express
service owns NATMap endpoint state, serves the built application, and proxies
HTTP signaling to the local SRS instance. Aliyun only terminates public HTTPS
and forwards to the home server over Tailscale. WebRTC UDP media uses the
NATMap endpoint directly.

## Local development

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:5173/watch` locally. From another device on the same
LAN, use the development machine's address, for example
`http://192.168.100.100:5173/watch` or `http://192.168.100.100:5173/publish`.

## Home server deployment

The ready-to-copy Docker bundle is in `deploy/`. Copy it to the target server,
then follow [`deploy/README.md`](deploy/README.md). It contains the Compose
stack, `.env` template, SRS and LiveKit configuration templates, and both Nginx
templates.

The home Nginx template forwards `/rtc/v1/` to SRS and the remaining routes to
the application. Replace its router address and private proxy CIDR, then test
and reload Nginx. The public edge template needs the public domain, certificate
paths, and home-server private address.

The home Nginx forwards only `/rtc/v1/` to the local SRS HTTP API on port 1985.
The broader `/rtc/` prefix must continue to reach the application because it
also contains the NATMap endpoint and the WHIP/WHEP page routes. Port 1985 is
used for SDP signaling; WebRTC media still uses the public UDP endpoint reported
by NATMap.

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Copy `deploy/public-nginx.conf.example` to the public HTTPS edge, replace the
public domain, certificate paths, and home-server private address. The
WebSocket upgrade headers are required at both Nginx hops; after installing the
two files, test and reload Nginx on the home server and the public edge server.

## ImmortalWrt notification

Install curl and deploy the notification script:

```sh
opkg update
opkg install curl
mkdir -p /etc/webrtc-live
chmod 700 /etc/webrtc-live
```

Copy the two NATMap notification scripts to NATMap's local configuration
directory and make them executable:

```sh
mkdir -p /etc/natmap/scripts
chmod 755 /etc/natmap /etc/natmap/scripts
chmod 755 /etc/natmap/scripts/srs-natmap-notify.sh
chmod 755 /etc/natmap/scripts/livekit-natmap-notify.sh
grep -qxF '/etc/natmap/' /etc/sysupgrade.conf || echo '/etc/natmap/' >> /etc/sysupgrade.conf
```

Configure SRS's mapping to call
`/etc/natmap/scripts/srs-natmap-notify.sh`, and LiveKit's UDP 7882 mapping to
call `/etc/natmap/scripts/livekit-natmap-notify.sh`. Set
`SRS_NATMAP_SYNC_URL` and `LIVEKIT_NATMAP_SYNC_URL` in the NATMap script
environment to the home server's internal URLs before enabling the callbacks.
The LiveKit callback can be omitted when voice is disabled. Save and restart
NATMap, then verify the synchronized state:

```sh
/etc/init.d/natmap restart
curl https://your-domain.example/rtc/srs-natmap.json
curl https://your-domain.example/rtc/livekit-natmap.json
```

The watch and publish pages fetch the SRS JSON before signaling and
automatically add the current `eip` to their SRS WHEP or WHIP URL. LiveKit
uses its own ICE candidates; `livekit-natmap.json` records the current media
mapping for diagnostics and future route selection, but it is not a browser
connection URL.

## Optional LiveKit voice

LiveKit is optional. Leaving `LIVEKIT_PUBLIC_URL`, `LIVEKIT_API_URL`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `VOICE_MODERATOR_TOKEN` empty does
not prevent the Node service or the SRS watch/publish/chat features from
starting. Voice token requests return `503` until LiveKit is configured, and
the voice controls remain unavailable. Start the optional services with
`docker compose --profile voice up -d` after setting the LiveKit values.

Chat images are limited to 5 MB and stored under `UPLOAD_DIR/YYYY-MM-DD`.
The deployment bundle keeps this directory under its local `data/` directory.
