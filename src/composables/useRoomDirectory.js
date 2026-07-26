export const roomColors = Object.freeze([
  { id: 'pink', label: '樱花粉' },
  { id: 'gold', label: '奶油黄' },
  { id: 'mint', label: '薄荷绿' },
  { id: 'lavender', label: '薰衣草' },
  { id: 'peach', label: '蜜桃橙' },
  { id: 'sky', label: '天空蓝' },
])

export function roomKey(app, stream) {
  return `${String(app || '').trim()}/${String(stream || '').trim()}`
}

export function createDefaultRoom(app = 'live', stream = 'livestream') {
  const normalizedApp = String(app || 'live').trim()
  const normalizedStream = String(stream || 'livestream').trim()
  const isDefaultRoom = normalizedApp === 'live' && normalizedStream === 'livestream'
  return {
    id: roomKey(normalizedApp, normalizedStream),
    app: normalizedApp,
    stream: normalizedStream,
    title: isDefaultRoom ? '今晚继续推《双人成行》' : `${normalizedStream} 的直播间`,
    description: isDefaultRoom ? '朋友局 · 随便聊聊，不剧透也不赶进度' : '朋友们正在一起看直播',
    category: '游戏',
    capacity: 8,
    host: {
      id: `host:${roomKey(normalizedApp, normalizedStream)}`,
      name: isDefaultRoom ? 'CraftWyrd' : '主播',
      avatar: isDefaultRoom ? 'C' : '主',
      color: 'pink',
    },
    updatedAt: null,
    configured: false,
  }
}

export async function fetchRooms() {
  const response = await fetch('/api/rooms', { cache: 'no-store', headers: { Accept: 'application/json' } })
  if (!response.ok) throw await responseError(response, '读取直播间列表失败')
  return (await response.json()).rooms || []
}

export async function fetchRoom(app, stream) {
  const response = await fetch(roomEndpoint(app, stream), { cache: 'no-store', headers: { Accept: 'application/json' } })
  if (!response.ok) throw await responseError(response, '读取直播间失败')
  return response.json()
}

export async function saveRoom(app, stream, room) {
  const response = await fetch(roomEndpoint(app, stream), {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(room),
  })
  if (!response.ok) throw await responseError(response, '保存直播间失败')
  return response.json()
}

function roomEndpoint(app, stream) {
  return `/api/rooms/${encodeURIComponent(String(app || '').trim())}/${encodeURIComponent(String(stream || '').trim())}`
}

async function responseError(response, fallback) {
  try {
    const body = await response.json()
    return new Error(body.error || `${fallback} (${response.status})`)
  } catch {
    return new Error(`${fallback} (${response.status})`)
  }
}
