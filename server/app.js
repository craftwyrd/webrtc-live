'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = parsePort(process.env.PORT || '21080', 'PORT');
const NATMAP_STATE_FILE = process.env.NATMAP_STATE_FILE || path.join(ROOT_DIR, '.data', 'natmap.json');
const SRS_API_ORIGIN = process.env.SRS_API_ORIGIN || 'http://127.0.0.1:1985';
const SRS_HTTP_ORIGIN = process.env.SRS_HTTP_ORIGIN || 'http://127.0.0.1:8080';

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

function createSrsProxy(target, targetBasePath) {
  return createProxyMiddleware({
    target,
    changeOrigin: false,
    proxyTimeout: 15000,
    timeout: 15000,
    pathRewrite: (requestPath) => `${targetBasePath}${requestPath}`,
    on: {
      error(error, request) {
        console.error(`Proxy error for ${request.method} ${request.originalUrl}:`, error.message);
      },
    },
  });
}

function createApp() {
  const app = express();
  const store = new NatMapStore(NATMAP_STATE_FILE);

  app.disable('x-powered-by');
  app.enable('strict routing');
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.on('finish', () => {
      console.log(`${request.method} ${request.originalUrl} ${response.statusCode}`);
    });
    next();
  });

  app.get('/healthz', (request, response) => {
    response.json({ status: 'ok' });
  });

  app.post('/internal/natmap', express.json({ limit: '4kb' }), async (request, response, next) => {
    try {
      const state = validateMapping(request.body || {});
      await store.write(state);
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

  app.get('/rtc/natmap.json', async (request, response, next) => {
    try {
      const state = await store.read();
      response.set('Cache-Control', 'no-store');
      if (!state) {
        response.status(503).json({ error: 'NATMap mapping is not available' });
        return;
      }
      response.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.use('/rtc/v1', createSrsProxy(SRS_API_ORIGIN, '/rtc/v1'));
  app.use('/srs/api', createSrsProxy(SRS_API_ORIGIN, '/api'));
  app.use('/players', createSrsProxy(SRS_HTTP_ORIGIN, '/players'));

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
    console.error(error);
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error.type === 'entity.parse.failed') {
      response.status(400).json({ error: 'invalid JSON body' });
      return;
    }
    response.status(500).json({ error: 'internal server error' });
  });

  return app;
}

if (require.main === module) {
  const server = createApp().listen(PORT, HOST, () => {
    console.log(`webrtc-live listening on http://${HOST}:${PORT}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

module.exports = { createApp, validateMapping };
