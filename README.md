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
NATMAP_STATE_FILE=/var/lib/webrtc-live/natmap.json
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

Replace the home Nginx port-20080 server with `deploy/home-nginx-20080.conf`,
then test and reload Nginx. Keep the existing HTTPS server if direct IPv6 access
is still needed.

```sh
sudo nginx -t
sudo systemctl reload nginx
```

## ImmortalWrt notification

Install curl and deploy the notification script:

```sh
opkg update
opkg install curl
mkdir -p /etc/webrtc-live
chmod 700 /etc/webrtc-live
```

Copy `scripts/natmap-notify.sh` to NATMap's local configuration directory and
make it executable:

```sh
mkdir -p /etc/natmap/scripts
chmod 755 /etc/natmap /etc/natmap/scripts
chmod 755 /etc/natmap/scripts/natmap-notify.sh
grep -qxF '/etc/natmap/' /etc/sysupgrade.conf || echo '/etc/natmap/' >> /etc/sysupgrade.conf
```

Set the NATMap notification script to
`/etc/natmap/scripts/natmap-notify.sh`, save, and restart NATMap. Verify the
complete public route:

```sh
/etc/init.d/natmap restart
curl https://srs.drivod.top/rtc/natmap.json
```

The watch and publish pages fetch this JSON before signaling and automatically
add the current `eip` to their SRS WHEP or WHIP URL.

## Container image

GitHub Actions publishes the image to:

```text
registry.cn-chengdu.aliyuncs.com/craftwyrd/webrtc-live
```

Configure these repository secrets under GitHub Actions:

```text
ALIYUN_ACR_USERNAME=drivod
ALIYUN_ACR_PASSWORD=<ACR login password>
PIPELINE_WEBHOOK_URL=<deployment webhook URL>
PIPELINE_WEBHOOK_TOKEN=<optional webhook token>
```

Pushes to `main` publish `latest` and `sha-<commit>`. Tags such as `v1.0.0`
publish `v1.0.0`, `1.0.0`, and `sha-<commit>`.
After the publish job, the workflow sends the same `GENERAL_EVENT` payload used
by the naraka backend pipeline. Webhook delivery failure does not discard an
image that was already published.

On the home Linux server, host networking lets the container reach SRS on the
host loopback interface while keeping the Node listener on loopback. Deploy
`compose.yaml` to `/opt/webrtc-live/compose.yaml`, then run:

```sh
docker login --username=drivod registry.cn-chengdu.aliyuncs.com
cd /opt/webrtc-live
docker compose up -d --pull always
docker compose ps
curl http://127.0.0.1:21080/healthz
```

Set `WEBRTC_LIVE_TAG=v1.0.0` before `docker compose up` to deploy a fixed image
tag instead of `latest`.

Chat images are limited to 5 MB and stored under `UPLOAD_DIR/YYYY-MM-DD`.
The provided Compose configuration keeps this directory in the
`webrtc-live-data` volume.
