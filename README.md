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

Install Node.js 18 or newer, deploy the repository to `/opt/webrtc-live`, then:

```sh
cd /opt/webrtc-live
npm ci
npm run build
npm prune --omit=dev
sudo install -d -m 750 /etc/webrtc-live
sudo tee /etc/webrtc-live/webrtc-live.env >/dev/null <<EOF
HOST=127.0.0.1
PORT=21080
SRS_NATMAP_STATE_FILE=/var/lib/webrtc-live/srs-natmap.json
LIVEKIT_NATMAP_STATE_FILE=/var/lib/webrtc-live/livekit-natmap.json
ROOMS_STATE_FILE=/var/lib/webrtc-live/rooms.json
UPLOAD_DIR=/var/lib/webrtc-live/uploads
SRS_API_ORIGIN=http://127.0.0.1:1985
SRS_HTTP_ORIGIN=http://127.0.0.1:8080
EOF
sudo chmod 600 /etc/webrtc-live/webrtc-live.env
sudo install -m 644 deploy/webrtc-live.service /etc/systemd/system/webrtc-live.service
sudo systemctl daemon-reload
sudo systemctl enable --now webrtc-live
curl http://127.0.0.1:21080/healthz
```

Copy `deploy/home-nginx-20080.conf.example` to your home Nginx configuration,
replace the router address and private proxy CIDR, then test and reload Nginx.
The file is a template because Nginx is deployed outside the application
container and cannot read Docker Compose variables directly.

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

## Container image

Copy `.env.example` to `.env`, set the deployment values, and deploy
`compose.yaml`. Update the image tag in `compose.yaml` when needed. Compose
loads `.env` directly; it is the single application configuration file. The
bridge network lets the application reach SRS at
`srs:1985` and `srs:8080`. Copy the SRS `https.docker.conf`, `edge.conf`, and
`rtc.conf` files into the directory configured by `SRS_CONF_DIR` before
starting the stack:

```sh
cd /opt/webrtc-live
docker compose up -d --pull always
docker compose ps
curl http://127.0.0.1:21080/healthz
```

The included GitHub Actions workflow is an example and should be adapted to the
registry used by your fork.

## Optional LiveKit voice

LiveKit is optional. Leaving `LIVEKIT_PUBLIC_URL`, `LIVEKIT_API_URL`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `VOICE_MODERATOR_TOKEN` empty does
not prevent the Node service or the SRS watch/publish/chat features from
starting. Voice token requests return `503` until LiveKit is configured, and
the voice controls remain unavailable. The separate
`deploy/livekit.compose.yaml` and `deploy/livekit.yaml.example` files can be
enabled later when voice chat is needed.

Chat images are limited to 5 MB and stored under `UPLOAD_DIR/YYYY-MM-DD`.
The provided Compose configuration keeps this directory in the
`webrtc-live-data` volume.
