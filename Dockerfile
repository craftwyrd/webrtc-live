FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=21080 \
    SRS_NATMAP_STATE_FILE=/var/lib/webrtc-live/srs-natmap.json \
    LIVEKIT_NATMAP_STATE_FILE=/var/lib/webrtc-live/livekit-natmap.json \
    ROOMS_STATE_FILE=/var/lib/webrtc-live/rooms.json \
    UPLOAD_DIR=/var/lib/webrtc-live/uploads \
    SRS_API_ORIGIN=http://127.0.0.1:1985 \
    SRS_HTTP_ORIGIN=http://127.0.0.1:8080

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node server ./server
COPY --from=build --chown=node:node /app/dist ./dist

RUN mkdir -p /var/lib/webrtc-live && chown node:node /var/lib/webrtc-live

VOLUME ["/var/lib/webrtc-live"]
EXPOSE 21080

USER node

CMD ["node", "server/app.js"]
