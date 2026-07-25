'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webrtc-live-test-'));
const requests = [];
const fakeSrs = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    requests.push({
      method: request.method,
      url: request.url,
      contentType: request.headers['content-type'],
      body: Buffer.concat(chunks).toString('utf8'),
    });
    response.writeHead(201, { 'Content-Type': 'application/sdp' });
    response.end('v=0\r\na=ice-lite\r\n');
  });
});

let appServer;
let baseUrl;

test.before(async () => {
  await listen(fakeSrs);
  const fakeSrsPort = fakeSrs.address().port;
  process.env.NATMAP_STATE_FILE = path.join(testRoot, 'natmap.json');
  process.env.SRS_API_ORIGIN = `http://127.0.0.1:${fakeSrsPort}`;
  process.env.SRS_HTTP_ORIGIN = `http://127.0.0.1:${fakeSrsPort}`;

  const { createApp } = require('../server/app');
  appServer = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => appServer.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
});

test.after(async () => {
  await close(appServer);
  await close(fakeSrs);
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('serves the Vue application at the watch and publish routes', async () => {
  for (const route of ['/rtc/whep', '/rtc/whep/', '/watch', '/publish']) {
    const page = await fetch(`${baseUrl}${route}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<div id="app"><\/div>/);
    assert.match(html, /\/assets\/index-[^"']+\.js/);
  }
});

test('persists and returns NATMap state', async () => {
  const payload = { ip: '175.155.112.28', port: 29575, protocol: 'UDP' };
  const updated = await fetch(`${baseUrl}/internal/natmap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).eip, '175.155.112.28:29575');

  const current = await fetch(`${baseUrl}/rtc/natmap.json`);
  assert.equal(current.status, 200);
  assert.equal(current.headers.get('cache-control'), 'no-store');
  assert.equal((await current.json()).eip, '175.155.112.28:29575');
  assert.equal(fs.existsSync(path.join(testRoot, 'natmap.json')), true);
});

test('proxies an unchanged WHEP SDP request to the local SRS path', async () => {
  const offer = 'v=0\r\na=ice-ufrag:test\r\n';
  const response = await fetch(`${baseUrl}/rtc/v1/whep/?app=live&stream=livestream&eip=175.155.112.28%3A29575`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: offer,
  });

  assert.equal(response.status, 201);
  assert.equal(await response.text(), 'v=0\r\na=ice-lite\r\n');
  assert.deepEqual(requests.at(-1), {
    method: 'POST',
    url: '/rtc/v1/whep/?app=live&stream=livestream&eip=175.155.112.28%3A29575',
    contentType: 'application/sdp',
    body: offer,
  });
});

test('proxies an unchanged WHIP SDP request to the local SRS path', async () => {
  const offer = 'v=0\r\na=sendonly\r\n';
  const response = await fetch(`${baseUrl}/rtc/v1/whip/?app=live&stream=camera&eip=175.155.112.28%3A29575`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: offer,
  });

  assert.equal(response.status, 201);
  assert.equal(await response.text(), 'v=0\r\na=ice-lite\r\n');
  assert.deepEqual(requests.at(-1), {
    method: 'POST',
    url: '/rtc/v1/whip/?app=live&stream=camera&eip=175.155.112.28%3A29575',
    contentType: 'application/sdp',
    body: offer,
  });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
