'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { WebSocket, WebSocketServer } = require('ws');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = parsePort(process.env.PORT || '21080', 'PORT');
const SRS_NATMAP_STATE_FILE = process.env.SRS_NATMAP_STATE_FILE || process.env.NATMAP_STATE_FILE || path.join(ROOT_DIR, '.data', 'srs-natmap.json');
const LIVEKIT_NATMAP_STATE_FILE = process.env.LIVEKIT_NATMAP_STATE_FILE || path.join(ROOT_DIR, '.data', 'livekit-natmap.json');
const VOICE_MODERATION_STATE_FILE = process.env.VOICE_MODERATION_STATE_FILE || path.join(ROOT_DIR, '.data', 'voice-moderation.json');
const ROOMS_STATE_FILE = process.env.ROOMS_STATE_FILE || path.join(ROOT_DIR, '.data', 'rooms.json');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT_DIR, '.data', 'uploads');
const SRS_API_ORIGIN = process.env.SRS_API_ORIGIN || 'http://127.0.0.1:1985';
const SRS_HTTP_ORIGIN = process.env.SRS_HTTP_ORIGIN || 'http://127.0.0.1:8080';
const LIVEKIT_PUBLIC_URL = String(process.env.LIVEKIT_PUBLIC_URL || '').trim();
const LIVEKIT_API_URL = String(process.env.LIVEKIT_API_URL || '').trim();
const LIVEKIT_API_KEY = String(process.env.LIVEKIT_API_KEY || '').trim();
const LIVEKIT_API_SECRET = String(process.env.LIVEKIT_API_SECRET || '').trim();
const VOICE_MODERATOR_TOKEN = String(process.env.VOICE_MODERATOR_TOKEN || '').trim();
const CHAT_TEXT_MAX_LENGTH = 50;
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
}).single('image');

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function logError(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args);
}

class NatMapStore {
  constructor(stateFile) {
    this.stateFile = stateFile;
  }

  async read() {
    try {
      return JSON.parse(await fs.promises.readFile(this.stateFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(state) {
    const directory = path.dirname(this.stateFile);
    const temporary = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporary, this.stateFile);
  }
}

class RoomStore {
  constructor(stateFile) {
    this.stateFile = stateFile;
  }

  async readAll() {
    try {
      const state = JSON.parse(await fs.promises.readFile(this.stateFile, 'utf8'));
      return state && typeof state.rooms === 'object' ? state : { version: 1, rooms: {} };
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, rooms: {} };
      throw error;
    }
  }

  async list() {
    const state = await this.readAll();
    return Object.values(state.rooms)
      .map((room) => ({ ...room, configured: true }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async read(app, stream) {
    const state = await this.readAll();
    const room = state.rooms[roomKey(app, stream)];
    return room ? { ...room, configured: true } : null;
  }

  async write(room) {
    const state = await this.readAll();
    state.rooms[room.id] = room;
    const directory = path.dirname(this.stateFile);
    const temporary = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporary, this.stateFile);
  }
}

class VoiceModerationStore {
  constructor(stateFile) {
    this.stateFile = stateFile;
  }

  async readAll() {
    try {
      const state = JSON.parse(await fs.promises.readFile(this.stateFile, 'utf8'));
      return state && typeof state.muted === 'object' ? state : { version: 1, muted: {} };
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, muted: {} };
      throw error;
    }
  }

  async isMuted(room, identity) {
    const state = await this.readAll();
    return state.muted[room]?.[identity] === true;
  }

  async setMuted(room, identity, muted) {
    const state = await this.readAll();
    if (muted) {
      state.muted[room] ||= {};
      state.muted[room][identity] = true;
    } else if (state.muted[room]) {
      delete state.muted[room][identity];
      if (Object.keys(state.muted[room]).length === 0) delete state.muted[room];
    }
    const directory = path.dirname(this.stateFile);
    const temporary = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporary, this.stateFile);
  }
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function validateMapping(payload) {
  const ip = String(payload.ip || '');
  if (!net.isIPv4(ip)) {
    throw new Error('ip must be an IPv4 address');
  }

  const port = parsePort(payload.port, 'port');
  const protocol = String(payload.protocol || 'UDP').toUpperCase();
  if (protocol !== 'UDP') {
    throw new Error('protocol must be UDP');
  }

  return {
    ip,
    port,
    eip: `${ip}:${port}`,
    protocol,
    updatedAt: new Date().toISOString(),
  };
}

function roomKey(app, stream) {
  return `${app}/${stream}`;
}

function defaultRoom(app, stream) {
  const isDefaultRoom = app === 'live' && stream === 'livestream';
  const hostName = isDefaultRoom ? 'CraftWyrd' : '主播';
  return {
    id: roomKey(app, stream),
    app,
    stream,
    title: isDefaultRoom ? '今晚继续推《双人成行》' : `${stream} 的直播间`,
    description: isDefaultRoom ? '朋友局 · 随便聊聊，不剧透也不赶进度' : '朋友们正在一起看直播',
    category: '游戏',
    capacity: 8,
    host: {
      id: `host:${roomKey(app, stream)}`,
      name: hostName,
      avatar: Array.from(hostName)[0],
      color: 'pink',
    },
    updatedAt: null,
    configured: false,
  };
}

function validateRoomSegment(value, name) {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(normalized)) {
    throw new Error(`${name} must use 1-64 letters, numbers, dots, underscores, or hyphens`);
  }
  return normalized;
}

function validateRoom(payload, routeApp, routeStream) {
  const app = validateRoomSegment(routeApp, 'app');
  const stream = validateRoomSegment(routeStream, 'stream');
  const title = String(payload.title || '').trim();
  const description = String(payload.description || '').trim();
  const hostName = String(payload.host?.name || '').trim();
  const hostColor = String(payload.host?.color || 'pink');
  const allowedColors = new Set(['pink', 'gold', 'mint', 'lavender', 'peach', 'sky']);

  if (title.length < 1 || title.length > 80) throw new Error('title must use 1-80 characters');
  if (description.length > 240) throw new Error('description must use at most 240 characters');
  if (hostName.length < 1 || hostName.length > 32) throw new Error('host name must use 1-32 characters');
  if (!allowedColors.has(hostColor)) throw new Error('host color is invalid');

  return {
    id: roomKey(app, stream),
    app,
    stream,
    title,
    description,
    category: '游戏',
    capacity: 8,
    host: {
      id: `host:${roomKey(app, stream)}`,
      name: hostName,
      avatar: Array.from(hostName)[0],
      color: hostColor,
    },
    updatedAt: new Date().toISOString(),
    configured: true,
  };
}

function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: 'png', mimeType: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', mimeType: 'image/jpeg' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { extension: 'webp', mimeType: 'image/webp' };
  }
  return null;
}

function createSrsProxy(target, targetBasePath) {
  return createProxyMiddleware({
    target,
    changeOrigin: false,
    proxyTimeout: 15000,
    timeout: 15000,
    pathRewrite: (requestPath) => `${targetBasePath}${requestPath}`,
    on: {
      error(error, request) {
        logError(`Proxy error for ${request.method} ${request.originalUrl}:`, error.message);
      },
    },
  });
}

function createApp() {
  const app = express();
  const srsNatMapStore = new NatMapStore(SRS_NATMAP_STATE_FILE);
  const liveKitNatMapStore = new NatMapStore(LIVEKIT_NATMAP_STATE_FILE);
  const roomStore = new RoomStore(ROOMS_STATE_FILE);
  const voiceModerationStore = new VoiceModerationStore(VOICE_MODERATION_STATE_FILE);

  app.disable('x-powered-by');
  app.enable('strict routing');
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.on('finish', () => {
      if (request.path !== '/healthz') {
        log(`${request.method} ${request.originalUrl} ${response.statusCode}`);
      }
    });
    next();
  });

  app.get('/healthz', (request, response) => {
    response.json({ status: 'ok' });
  });

  registerNatMapRoutes(app, '/internal/srs-natmap', '/rtc/srs-natmap.json', srsNatMapStore, 'SRS');
  registerNatMapRoutes(app, '/internal/livekit-natmap', '/rtc/livekit-natmap.json', liveKitNatMapStore, 'LiveKit');

  // Keep existing router scripts and bookmarked diagnostics working while
  // deployments transition to the explicit SRS names.
  registerNatMapRoutes(app, '/internal/natmap', '/rtc/natmap.json', srsNatMapStore, 'SRS');

  app.get('/api/rooms', async (request, response, next) => {
    try {
      response.set('Cache-Control', 'no-store').json({ rooms: await roomStore.list() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/rooms/:app/:stream', async (request, response, next) => {
    try {
      const appName = validateRoomSegment(request.params.app, 'app');
      const streamName = validateRoomSegment(request.params.stream, 'stream');
      const room = await roomStore.read(appName, streamName);
      response.set('Cache-Control', 'no-store').json(room || defaultRoom(appName, streamName));
    } catch (error) {
      if (/^(app|stream) /.test(error.message)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.put('/api/rooms/:app/:stream', express.json({ limit: '8kb' }), async (request, response, next) => {
    try {
      const room = validateRoom(request.body || {}, request.params.app, request.params.stream);
      await roomStore.write(room);
      response.set('Cache-Control', 'no-store').json(room);
    } catch (error) {
      if (error instanceof SyntaxError) {
        response.status(400).json({ error: 'invalid JSON body' });
        return;
      }
      if (/^(app|stream|title|description|host) /.test(error.message)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.post('/api/voice/token', express.json({ limit: '8kb' }), async (request, response, next) => {
    try {
      if (!LIVEKIT_PUBLIC_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
        response.status(503).json({ error: 'LiveKit voice service is not configured' });
        return;
      }
      const appName = validateRoomSegment(request.body?.app, 'app');
      const streamName = validateRoomSegment(request.body?.stream, 'stream');
      const identity = validateVoiceIdentity(request.body?.identity);
      const name = validateVoiceName(request.body?.name);
      const roomName = roomKey(appName, streamName);
      const microphoneBlocked = await voiceModerationStore.isMuted(roomName, identity);
      const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name });
      token.addGrant({ roomJoin: true, room: roomName, canPublish: !microphoneBlocked, canSubscribe: true });
      response.set('Cache-Control', 'no-store').json({
        url: LIVEKIT_PUBLIC_URL,
        roomName,
        token: await token.toJwt(),
      });
    } catch (error) {
      if (/^(app|stream|identity|name) /.test(error.message)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.post('/api/voice/moderation/microphone', express.json({ limit: '8kb' }), async (request, response, next) => {
    try {
      if (!LIVEKIT_API_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !VOICE_MODERATOR_TOKEN) {
        response.status(503).json({ error: 'LiveKit moderation service is not configured' });
        return;
      }
      if (!matchesModeratorToken(request.get('X-Voice-Moderator-Token'))) {
        response.status(403).json({ error: 'invalid moderator token' });
        return;
      }
      const appName = validateRoomSegment(request.body?.app, 'app');
      const streamName = validateRoomSegment(request.body?.stream, 'stream');
      const identity = validateVoiceIdentity(request.body?.identity);
      const muted = request.body?.muted;
      if (typeof muted !== 'boolean') throw new Error('muted must be boolean');

      const roomName = roomKey(appName, streamName);
      const roomService = new RoomServiceClient(LIVEKIT_API_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
      const participants = await roomService.listParticipants(roomName);
      const participant = participants.find((entry) => entry.identity === identity);
      if (participant) {
        await roomService.updateParticipant(roomName, identity, {
          permission: { ...participant.permission, canPublish: !muted },
        });
        if (muted) {
          await Promise.all(participant.tracks
            .filter((track) => track.type === 0)
            .map((track) => roomService.mutePublishedTrack(roomName, identity, track.sid, true)));
        }
      }
      await voiceModerationStore.setMuted(roomName, identity, muted);
      response.set('Cache-Control', 'no-store').json({ identity, muted, active: Boolean(participant) });
    } catch (error) {
      if (/^(app|stream|identity|muted) /.test(error.message)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.post('/api/chat/images', uploadImage, async (request, response, next) => {
    try {
      if (!request.file) {
        response.status(400).json({ error: 'image is required' });
        return;
      }
      const imageType = detectImageType(request.file.buffer);
      if (!imageType) {
        response.status(400).json({ error: 'image must be JPEG, PNG, or WebP' });
        return;
      }
      const dateFolder = uploadDateFolder();
      const targetDirectory = path.join(UPLOAD_DIR, dateFolder);
      await fs.promises.mkdir(targetDirectory, { recursive: true });
      const filename = `${randomUUID()}.${imageType.extension}`;
      await fs.promises.writeFile(path.join(targetDirectory, filename), request.file.buffer, { flag: 'wx', mode: 0o600 });
      response.status(201).set('Cache-Control', 'no-store').json({
        url: `/uploads/${dateFolder}/${filename}`,
        mimeType: imageType.mimeType,
        size: request.file.size,
      });
    } catch (error) {
      next(error);
    }
  });

  app.use('/rtc/v1', createSrsProxy(SRS_API_ORIGIN, '/rtc/v1'));
  app.use('/srs/api', createSrsProxy(SRS_API_ORIGIN, '/api'));
  app.use('/players', createSrsProxy(SRS_HTTP_ORIGIN, '/players'));

  app.use('/uploads', express.static(UPLOAD_DIR, {
    dotfiles: 'deny',
    fallthrough: true,
    immutable: true,
    maxAge: '7d',
    setHeaders(response) {
      response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      response.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
    },
  }));

  app.use(express.static(DIST_DIR, {
    dotfiles: 'deny',
    fallthrough: true,
    immutable: true,
    maxAge: '1h',
  }));

  app.use((request, response, next) => {
    if (request.method !== 'GET' || !request.accepts('html')) {
      next();
      return;
    }
    response.sendFile(path.join(DIST_DIR, 'index.html'));
  });

  app.use((request, response) => {
    response.status(404).json({ error: 'not found' });
  });
  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error.type === 'entity.parse.failed') {
      response.status(400).json({ error: 'invalid JSON body' });
      return;
    }
    if (error instanceof multer.MulterError) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'image must be 5 MB or smaller' : 'invalid image upload';
      response.status(status).json({ error: message });
      return;
    }
    logError(error);
    response.status(500).json({ error: 'internal server error' });
  });

  return app;
}

function registerNatMapRoutes(app, updatePath, readPath, store, serviceName) {
  app.post(updatePath, express.json({ limit: '4kb' }), async (request, response, next) => {
    try {
      const state = validateMapping(request.body || {});
      await store.write(state);
      log(`${serviceName} NATMap updated ${state.eip}/${state.protocol.toLowerCase()} -> ${store.stateFile}`);
      response.set('Cache-Control', 'no-store').json(state);
    } catch (error) {
      if (error instanceof SyntaxError) {
        response.status(400).json({ error: 'invalid JSON body' });
        return;
      }
      if (/^(ip|port|protocol) /.test(error.message)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.get(readPath, async (request, response, next) => {
    try {
      const state = await store.read();
      response.set('Cache-Control', 'no-store');
      if (!state) {
        response.status(503).json({ error: `${serviceName} NATMap mapping is not available` });
        return;
      }
      response.json(state);
    } catch (error) {
      next(error);
    }
  });
}

function createServer() {
  const server = http.createServer(createApp());
  attachPresence(server);
  return server;
}

function attachPresence(server) {
  const rooms = new Map();
  const webSocketServer = new WebSocketServer({ server, path: '/ws/presence', maxPayload: 4096 });

  webSocketServer.on('connection', (socket, request) => {
    let identity;
    try {
      identity = parsePresenceIdentity(request.url);
    } catch {
      socket.close(1008, 'invalid presence identity');
      return;
    }

    const room = rooms.get(identity.roomId) || { connections: new Map(), messages: [] };
    rooms.set(identity.roomId, room);
    const userAlreadyPresent = identity.role === 'viewer' && Array.from(room.connections.values()).some((connection) => (
      connection.role === 'viewer' && connection.userId === identity.userId
    ));
    const previous = room.connections.get(identity.connectionId);
    if (previous) previous.socket.close(4000, 'connection replaced');
    room.connections.set(identity.connectionId, { ...identity, socket });

    socket.send(JSON.stringify({ type: 'chat_history', roomId: identity.roomId, messages: room.messages }));
    if (identity.role === 'viewer' && !userAlreadyPresent) {
      const joined = {
        id: randomUUID(),
        type: 'system',
        text: `${identity.name} 加入了房间`,
        sentAt: new Date().toISOString(),
      };
      broadcastChatMessage(identity.roomId, room, joined);
    }

    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        const sender = room.connections.get(identity.connectionId);
        if (sender?.socket !== socket) return;
        if (sender.role === 'observer') return;
        if (message.type === 'profile') {
          const requestId = String(message.requestId || '').slice(0, 128);
          const name = String(message.name || '').trim().slice(0, 18);
          const color = String(message.color || 'gold');
          if (name.length < 2 || !['pink', 'gold', 'mint', 'lavender', 'peach', 'sky'].includes(color)) {
            sendProfileResult(socket, identity.roomId, requestId, false, '用户名格式无效');
            return;
          }
          const nameInUse = name !== sender.name && Array.from(room.connections.values()).some((connection) => (
            connection.role === 'viewer' && connection.userId !== sender.userId && connection.name === name
          ));
          if (nameInUse) {
            sendProfileResult(socket, identity.roomId, requestId, false, '该用户名已被其他用户使用');
            return;
          }
          for (const connection of room.connections.values()) {
            if (connection.role === 'viewer' && connection.userId === sender.userId) Object.assign(connection, { name, color });
          }
          sendProfileResult(socket, identity.roomId, requestId, true);
          broadcastPresence(identity.roomId, room);
          return;
        }

        const chatMessage = createChatMessage(message, sender);
        if (!chatMessage) return;
        appendChatMessage(room, chatMessage);
        broadcastChatMessage(identity.roomId, room, chatMessage);
      } catch {
        // Ignore malformed client messages and keep the room connection alive.
      }
    });

    socket.on('close', () => {
      const departing = room.connections.get(identity.connectionId);
      if (departing?.socket !== socket) return;
      room.connections.delete(identity.connectionId);
      const userStillPresent = departing.role === 'viewer' && Array.from(room.connections.values()).some((connection) => (
        connection.role === 'viewer' && connection.userId === departing.userId
      ));
      if (departing.role === 'viewer' && !userStillPresent) {
        const left = {
          id: randomUUID(),
          type: 'system',
          text: `${departing.name} 离开了房间`,
          sentAt: new Date().toISOString(),
        };
        broadcastChatMessage(identity.roomId, room, left);
      }
      if (room.connections.size === 0) rooms.delete(identity.roomId);
      broadcastPresence(identity.roomId, room);
    });

    broadcastPresence(identity.roomId, room);
  });

  function broadcastPresence(roomId, room) {
    const usersById = new Map();
    for (const connection of room.connections.values()) {
      if (connection.role === 'observer') continue;
      const user = usersById.get(connection.userId) || {
        id: connection.userId,
        name: connection.name,
        avatar: Array.from(connection.name)[0],
        color: connection.color,
        connections: 0,
      };
      user.name = connection.name;
      user.avatar = Array.from(connection.name)[0];
      user.color = connection.color;
      user.connections += 1;
      usersById.set(connection.userId, user);
    }
    const payload = JSON.stringify({ type: 'presence', roomId, users: Array.from(usersById.values()) });
    for (const connection of room.connections.values()) {
      if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(payload);
    }
  }

  function sendProfileResult(socket, roomId, requestId, ok, error) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'profile_result', roomId, requestId, ok, ...(error ? { error } : {}) }));
  }

  function appendChatMessage(room, message) {
    room.messages.push(message);
    if (room.messages.length > 100) room.messages.shift();
  }

  function broadcastChatMessage(roomId, room, message) {
    const payload = JSON.stringify({ type: 'chat_message', roomId, message });
    for (const connection of room.connections.values()) {
      if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(payload);
    }
  }

  return webSocketServer;
}

function createChatMessage(message, sender) {
  const base = {
    id: randomUUID(),
    authorId: sender.userId,
    name: sender.name,
    color: sender.color,
    sentAt: new Date().toISOString(),
  };
  if (message.type === 'chat') {
    const text = String(message.text || '').trim().slice(0, CHAT_TEXT_MAX_LENGTH);
    return text ? { ...base, text } : null;
  }
  if (message.type === 'chat_image') {
    const imageUrl = String(message.imageUrl || '');
    const width = Number(message.width);
    const height = Number(message.height);
    const text = String(message.text || '').trim().slice(0, CHAT_TEXT_MAX_LENGTH);
    if (!/^\/uploads\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/.test(imageUrl)) return null;
    if (!Number.isInteger(width) || width < 1 || width > 8192 || !Number.isInteger(height) || height < 1 || height > 8192) return null;
    return { ...base, contentType: 'image', imageUrl, width, height, ...(text ? { text } : {}) };
  }
  return null;
}

function uploadDateFolder(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parsePresenceIdentity(requestUrl) {
  const url = new URL(requestUrl, 'http://localhost');
  const app = validateRoomSegment(url.searchParams.get('app'), 'app');
  const stream = validateRoomSegment(url.searchParams.get('stream'), 'stream');
  const connectionId = String(url.searchParams.get('connectionId') || '');
  const role = String(url.searchParams.get('role') || 'viewer');
  if (!['viewer', 'observer'].includes(role) || !connectionId || connectionId.length > 128) {
    throw new Error('invalid identity');
  }
  if (role === 'observer') {
    return { roomId: roomKey(app, stream), connectionId, role };
  }

  const userId = String(url.searchParams.get('userId') || '');
  const name = String(url.searchParams.get('name') || '').trim().slice(0, 18);
  const color = String(url.searchParams.get('color') || 'gold');
  if (!userId || userId.length > 128 || name.length < 2) {
    throw new Error('invalid identity');
  }
  if (!['pink', 'gold', 'mint', 'lavender', 'peach', 'sky'].includes(color)) throw new Error('invalid color');
  return { roomId: roomKey(app, stream), userId, connectionId, name, color, role };
}

function validateVoiceIdentity(value) {
  const identity = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(identity)) throw new Error('identity is invalid');
  return identity;
}

function validateVoiceName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 32 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('name is invalid');
  return name;
}

function matchesModeratorToken(value) {
  const provided = Buffer.from(String(value || ''), 'utf8');
  const expected = Buffer.from(VOICE_MODERATOR_TOKEN, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

if (require.main === module) {
  const server = createServer().listen(PORT, HOST, () => {
    log(`webrtc-live listening on http://${HOST}:${PORT}; SRS NATMap: ${SRS_NATMAP_STATE_FILE}; LiveKit NATMap: ${LIVEKIT_NATMAP_STATE_FILE}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

module.exports = { createApp, createServer, validateMapping, validateRoom };
