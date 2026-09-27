# Docker deployment bundle

This directory is a self-contained deployment template. Copy it to the target
server, edit `.env`, and install the service-specific configuration files.

```sh
cp -a deploy /opt/webrtc-live
cd /opt/webrtc-live
cp .env.example .env
cp srs/rtc.conf.example srs/rtc.conf
cp livekit/livekit.yaml.example livekit/livekit.yaml
```

Edit `.env` and set the image, public SRS candidate, and LiveKit credentials.
The LiveKit values can stay empty when only SRS, video, and chat are needed.
Edit the copied SRS and LiveKit files before starting the optional voice stack.
Replace the placeholder SRS bearer token and keep both copied files out of Git.
When voice is enabled, set `LIVEKIT_API_URL=http://livekit:7880` and use the
same API key and secret in `.env` and `livekit/livekit.yaml`.

The NATMap callback scripts are in `natmap/`. Set their `SRS_NATMAP_SYNC_URL`
and `LIVEKIT_NATMAP_SYNC_URL` environment variables before installing them on
the router. The LiveKit callback is optional.

Start the SRS deployment:

```sh
docker compose up -d
docker compose ps
curl http://127.0.0.1:21080/healthz
```

Start LiveKit and Redis when voice is enabled:

```sh
docker compose --profile voice up -d
```

The home-server Nginx template is `home-nginx-20080.conf.example`. The public
HTTPS edge template is `public-nginx.conf.example`. Replace their domain,
private-network, and certificate placeholders before installing them.
