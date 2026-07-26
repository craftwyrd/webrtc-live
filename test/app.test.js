'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');
const WebSocket = require('ws');

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
  process.env.ROOMS_STATE_FILE = path.join(testRoot, 'rooms.json');
  process.env.UPLOAD_DIR = path.join(testRoot, 'uploads');
  process.env.SRS_API_ORIGIN = `http://127.0.0.1:${fakeSrsPort}`;
  process.env.SRS_HTTP_ORIGIN = `http://127.0.0.1:${fakeSrsPort}`;

  const { createServer } = require('../server/app');
  appServer = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => appServer.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
});

test.after(async () => {
  await close(appServer);
  await close(fakeSrs);
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('serves the Vue application at the watch, admin, and publish routes', async () => {
  for (const route of ['/rtc/whep', '/rtc/whep/', '/watch', '/admin', '/publish']) {
    const page = await fetch(`${baseUrl}${route}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<div id="app"><\/div>/);
    assert.match(html, /\/assets\/index-[^"']+\.js/);
  }
});

test('persists room metadata by app and stream', async () => {
  const unconfigured = await fetch(`${baseUrl}/api/rooms/live/new-stream`);
  assert.equal(unconfigured.status, 200);
  assert.equal((await unconfigured.json()).configured, false);

  const room = {
    title: 'Alice 的游戏夜',
    description: '今晚双人合作，不剧透',
    host: { name: 'Alice', color: 'mint' },
  };
  const saved = await fetch(`${baseUrl}/api/rooms/live/alice`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(room),
  });
  assert.equal(saved.status, 200);
  const savedRoom = await saved.json();
  assert.deepEqual({ ...savedRoom, updatedAt: '<timestamp>' }, {
    id: 'live/alice',
    app: 'live',
    stream: 'alice',
    title: room.title,
    description: room.description,
    category: '游戏',
    capacity: 8,
    host: { id: 'host:live/alice', name: 'Alice', avatar: 'A', color: 'mint' },
    updatedAt: '<timestamp>',
    configured: true,
  });
  assert.match(savedRoom.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const current = await fetch(`${baseUrl}/api/rooms/live/alice`);
  assert.equal(current.status, 200);
  assert.equal((await current.json()).host.name, 'Alice');

  const list = await fetch(`${baseUrl}/api/rooms`);
  assert.equal(list.status, 200);
  assert.equal((await list.json()).rooms[0].id, 'live/alice');
  assert.equal(fs.existsSync(path.join(testRoot, 'rooms.json')), true);
});

test('stores validated chat images and serves them with their detected type', async () => {
  const uploaded = await uploadTestPng();
  assert.match(uploaded.url, /^\/uploads\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.png$/);
  assert.equal(uploaded.mimeType, 'image/png');

  const image = await fetch(`${baseUrl}${uploaded.url}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), testPng());

  const invalid = new FormData();
  invalid.append('image', new Blob(['<svg></svg>'], { type: 'image/svg+xml' }), 'unsafe.svg');
  const rejected = await fetch(`${baseUrl}/api/chat/images`, { method: 'POST', body: invalid });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'image must be JPEG, PNG, or WebP');
});

test('scopes online users by room and deduplicates tabs by user', async () => {
  const aliceFirst = await connectPresence('live', 'alice', 'viewer-1', 'tab-1', '小樱花');
  assert.equal((await aliceFirst.next((message) => message.type === 'presence')).users[0].connections, 1);

  const aliceSecond = await connectPresence('live', 'alice', 'viewer-1', 'tab-2', '小樱花');
  const aliceWithTwoTabs = await aliceSecond.next((message) => message.type === 'presence');
  assert.equal(aliceWithTwoTabs.roomId, 'live/alice');
  assert.equal(aliceWithTwoTabs.users.length, 1);
  assert.equal(aliceWithTwoTabs.users[0].connections, 2);

  const bob = await connectPresence('live', 'bob', 'viewer-1', 'tab-3', '小樱花');
  const bobPresence = await bob.next((message) => message.type === 'presence');
  assert.equal(bobPresence.roomId, 'live/bob');
  assert.equal(bobPresence.users.length, 1);
  assert.equal(bobPresence.users[0].connections, 1);

  aliceSecond.socket.send(JSON.stringify({ type: 'profile', requestId: 'rename-shared-user', name: '新昵称', color: 'mint' }));
  const renameResult = await aliceSecond.next((message) => message.type === 'profile_result' && message.requestId === 'rename-shared-user');
  assert.equal(renameResult.ok, true);
  const renamed = await aliceFirst.next((message) => message.type === 'presence' && message.users[0]?.name === '新昵称');
  assert.equal(renamed.users[0].color, 'mint');

  aliceSecond.socket.close();
  const aliceWithOneTab = await aliceFirst.next((message) => message.type === 'presence' && message.users[0]?.connections === 1);
  assert.equal(aliceWithOneTab.users.length, 1);

  await Promise.all([closeWebSocket(aliceFirst.socket), closeWebSocket(bob.socket)]);
});

test('rejects a profile name already used by another online user', async () => {
  const alice = await connectPresence('live', 'unique-names', 'viewer-alice', 'tab-alice', '小樱花');
  const bob = await connectPresence('live', 'unique-names', 'viewer-bob', 'tab-bob', '糖糖');

  bob.socket.send(JSON.stringify({ type: 'profile', requestId: 'duplicate-name', name: '小樱花', color: 'mint' }));
  const rejected = await bob.next((message) => message.type === 'profile_result' && message.requestId === 'duplicate-name');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, '该用户名已被其他用户使用');

  bob.socket.send(JSON.stringify({ type: 'chat', text: '我的名字没有变' }));
  const chatAfterRejection = await alice.next((message) => message.type === 'chat_message' && message.message.text === '我的名字没有变');
  assert.equal(chatAfterRejection.message.name, '糖糖');

  bob.socket.send(JSON.stringify({ type: 'profile', requestId: 'available-name', name: '新昵称', color: 'mint' }));
  const accepted = await bob.next((message) => message.type === 'profile_result' && message.requestId === 'available-name');
  assert.equal(accepted.ok, true);
  const presence = await alice.next((message) => message.type === 'presence' && message.users.some((user) => user.name === '新昵称'));
  assert.equal(presence.users.find((user) => user.id === 'viewer-bob').color, 'mint');

  await Promise.all([closeWebSocket(alice.socket), closeWebSocket(bob.socket)]);
});

test('broadcasts chat while keeping unique-user join messages out of history', async () => {
  const alice = await connectPresence('live', 'chat', 'viewer-alice', 'tab-alice', '小樱花');
  const aliceJoined = await alice.next((message) => message.type === 'chat_message');
  assert.equal(aliceJoined.message.text, '小樱花 加入了房间');

  const aliceSecondTab = await connectPresence('live', 'chat', 'viewer-alice', 'tab-alice-2', '小樱花');
  const sameUserHistory = await aliceSecondTab.next((message) => message.type === 'chat_history');
  assert.equal(sameUserHistory.messages.length, 0);

  const bob = await connectPresence('live', 'chat', 'viewer-bob', 'tab-bob', '糖糖');
  const bobHistory = await bob.next((message) => message.type === 'chat_history');
  assert.equal(bobHistory.messages.length, 0);

  const bobJoinedForAlice = await alice.next((message) => message.type === 'chat_message' && message.message.type === 'system');
  assert.equal(bobJoinedForAlice.message.text, '糖糖 加入了房间');

  await closeWebSocket(aliceSecondTab.socket);
  await bob.next((message) => message.type === 'presence' && message.users.find((user) => user.id === 'viewer-alice')?.connections === 1);
  await assert.rejects(
    alice.next((message) => message.type === 'chat_message' && message.message.text === '小樱花 离开了房间', 100),
    /presence message timeout/,
  );

  alice.socket.send(JSON.stringify({ type: 'chat', text: '晚上好，能看到吗？' }));
  const received = await bob.next((message) => message.type === 'chat_message' && !message.message.type);
  assert.equal(received.roomId, 'live/chat');
  assert.equal(received.message.authorId, 'viewer-alice');
  assert.equal(received.message.name, '小樱花');
  assert.equal(received.message.text, '晚上好，能看到吗？');

  const uploaded = await uploadTestPng();
  alice.socket.send(JSON.stringify({ type: 'chat_image', imageUrl: uploaded.url, width: 1, height: 1, text: '这是刚才的截图' }));
  const receivedImage = await bob.next((message) => message.type === 'chat_message' && message.message.contentType === 'image');
  assert.equal(receivedImage.message.imageUrl, uploaded.url);
  assert.equal(receivedImage.message.width, 1);
  assert.equal(receivedImage.message.height, 1);
  assert.equal(receivedImage.message.text, '这是刚才的截图');

  const charlie = await connectPresence('live', 'chat', 'viewer-charlie', 'tab-charlie', '阿北');
  const charlieHistory = await charlie.next((message) => message.type === 'chat_history');
  assert.equal(charlieHistory.messages.some((message) => message.type === 'system'), false);
  assert.equal(charlieHistory.messages.some((message) => message.text === '晚上好，能看到吗？'), true);
  assert.equal(charlieHistory.messages.at(-1).imageUrl, uploaded.url);

  await closeWebSocket(alice.socket);
  const aliceLeft = await bob.next((message) => message.type === 'chat_message' && message.message.text === '小樱花 离开了房间');
  assert.equal(aliceLeft.message.text, '小樱花 离开了房间');

  await Promise.all([
    closeWebSocket(bob.socket),
    closeWebSocket(charlie.socket),
  ]);
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

async function connectPresence(app, stream, userId, connectionId, name) {
  const query = new URLSearchParams({ app, stream, userId, connectionId, name, color: 'gold' });
  const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws/presence?${query}`);
  const queue = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queue.push(message);
    }
  });
  await once(socket, 'open');
  return {
    socket,
    next(predicate = () => true, timeout = 2000) {
      const queuedIndex = queue.findIndex(predicate);
      if (queuedIndex >= 0) return Promise.resolve(queue.splice(queuedIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('presence message timeout'));
        }, timeout);
        waiters.push(waiter);
      });
    },
  };
}

async function closeWebSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, 'close');
  socket.close();
  await closed;
}

async function uploadTestPng() {
  const form = new FormData();
  form.append('image', new Blob([testPng()], { type: 'image/png' }), 'pixel.png');
  const response = await fetch(`${baseUrl}/api/chat/images`, { method: 'POST', body: form });
  assert.equal(response.status, 201);
  return response.json();
}

function testPng() {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
}
