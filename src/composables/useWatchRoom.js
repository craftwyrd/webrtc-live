import { computed, reactive, ref } from 'vue'
import { createDefaultRoom, fetchRoom, roomColors, roomKey } from './useRoomDirectory'

const PROFILE_STORAGE_KEY = 'craftwyrd-live.viewer-profile'
const VIEWER_ID_STORAGE_KEY = 'craftwyrd-live.viewer-id'
const CONNECTION_ID_STORAGE_KEY = 'craftwyrd-live.connection-id'
const CHAT_TEXT_MAX_LENGTH = 50
const avatarOptions = roomColors
const CUTE_VIEWER_NAMES = [
  '樱花绵绵',
  '蜜桃苏打',
  '草莓奶霜',
  '月见莓莓',
  '星糖小夏',
  '桃气柚柚',
  '奶油小葵',
  '云朵布丁',
  '铃兰泡芙',
  '薄荷千夏',
  '初雪莓酱',
  '蜜糖奈奈',
  '晴空小莓',
  '花音软糖',
  '晚樱可可',
  '星野桃桃',
  '琉璃小满',
  '柚子纱纱',
  '蔷薇露露',
  '甜橙美羽',
  '白桃圆圆',
  '海盐啵啵',
  '星月棉花',
  '杏仁千穗',
  '樱桃莉莉',
  '云间铃铃',
  '蜜柚芽衣',
  '桃桃美咲',
  '花见知夏',
  '柠檬诗织',
  '雪糕弥生',
  '奶糖真央',
  '星砂优奈',
  '晴莓遥香',
  '月光穗乃',
  '软糖璃奈',
  '花露心音',
  '甜梦结衣',
  '晚霞七海',
  '晨露凛音',
  '奶霜萌萌',
  '春樱和音',
  '杏桃纱月',
  '蜜瓜小羽',
  '雪花爱莉',
  '星愿美月',
  '花茶奈绪',
  '柚香千寻',
  '草莓诗音',
  '桃花绘梨',
  '香草小町',
  '月莓姬奈',
  '晴夏铃音',
  '樱色优衣',
  '蜜糖纱奈',
  '白露花音',
  '云莓千夏',
  '桃香莉奈',
  '雪见心晴',
  '星野柚香',
  '花火奈奈',
  '柠香美羽',
  '甜莓小春',
  '月色纱织',
  '晴空爱音',
  '樱桃穗香',
  '奶油美咲',
  '花见小夏',
  '星糖优奈',
  '蜜桃心音',
  '雪莓结衣',
  '云朵七海',
  '铃兰遥香',
  '薄荷凛音',
  '初晴萌萌',
  '晚樱和音',
  '琉璃纱月',
  '甜橙小羽',
  '白桃爱莉',
  '海盐美月',
  '星月奈绪',
  '杏仁千寻',
  '樱花诗音',
  '云间绘梨',
  '蜜柚小町',
  '桃桃姬奈',
  '花见铃音',
  '柠檬优衣',
  '雪糕纱奈',
  '奶糖花音',
  '星砂千夏',
  '晴莓莉奈',
  '月光心晴',
  '软糖柚香',
  '花露奈奈',
  '甜梦美羽',
  '晚霞小春',
  '晨露纱织',
  '奶霜爱音',
  '春樱穗香',
]
const CHAT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_CHAT_IMAGE_SIZE = 5 * 1024 * 1024
const MAX_CHAT_IMAGE_EDGE = 1600

function readStoredProfile() {
  if (typeof window === 'undefined') return null
  try {
    const stored = JSON.parse(window.localStorage.getItem(PROFILE_STORAGE_KEY) || 'null')
    if (!stored || typeof stored.name !== 'string') return null
    const name = stored.name.trim().slice(0, 18)
    const color = avatarOptions.some((option) => option.id === stored.color) ? stored.color : 'gold'
    return name.length >= 2 ? { name, color } : null
  } catch {
    return null
  }
}

function persistProfile(profile) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ name: profile.name, color: profile.color }))
  } catch {
    // Private browsing or a full storage quota should not block room entry.
  }
}

function createRandomProfile() {
  const name = CUTE_VIEWER_NAMES[Math.floor(Math.random() * CUTE_VIEWER_NAMES.length)]
  return { name, color: 'gold' }
}

function messageId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `message-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function useWatchRoom() {
  const storedProfile = readStoredProfile()
  const initialProfile = storedProfile || createRandomProfile()
  if (!storedProfile) persistProfile(initialProfile)
  const visitorId = persistentId(window.localStorage, VIEWER_ID_STORAGE_KEY, 'viewer')
  const connectionId = persistentId(window.sessionStorage, CONNECTION_ID_STORAGE_KEY, 'connection')
  const roomMeta = reactive(createDefaultRoom())
  const currentRoomKey = ref(roomMeta.id)
  const roomLoading = ref(false)
  const roomError = ref('')
  const viewerProfile = reactive({
    id: visitorId,
    name: initialProfile.name,
    color: initialProfile.color,
  })
  const messages = ref([])
  const onlineUsers = ref([])
  const presenceConnected = ref(false)
  let presenceSocket = null
  let reconnectTimer = null
  let presenceGeneration = 0
  let activeRoom = { app: 'live', stream: 'livestream' }
  const profileRequests = new Map()

  const presenceIdentity = computed(() => ({
    roomId: currentRoomKey.value,
    userId: visitorId,
    connectionId,
  }))

  async function loadRoom(app, stream) {
    const nextKey = roomKey(app, stream)
    const roomChanged = currentRoomKey.value !== nextKey
    roomLoading.value = true
    roomError.value = ''
    try {
      const nextRoom = await fetchRoom(app, stream) || createDefaultRoom(app, stream)
      Object.assign(roomMeta, nextRoom)
      Object.assign(roomMeta.host, nextRoom.host)
      currentRoomKey.value = nextKey
      if (roomChanged) messages.value = []
      connectPresence(app, stream)
      return roomMeta
    } catch (reason) {
      roomError.value = reason.message || String(reason)
      throw reason
    } finally {
      roomLoading.value = false
    }
  }

  async function updateProfile(name, color) {
    const normalized = String(name || '').trim().slice(0, 18)
    if (normalized.length < 2) throw new Error('用户名至少需要 2 个字符')
    if (presenceSocket?.readyState !== WebSocket.OPEN) throw new Error('房间连接中，请稍后再试')
    const nextColor = avatarOptions.some((option) => option.id === color) ? color : viewerProfile.color
    const requestId = messageId()
    await new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        profileRequests.delete(requestId)
        reject(new Error('用户名校验超时，请重试'))
      }, 5000)
      profileRequests.set(requestId, { resolve, reject, timer })
      try {
        presenceSocket.send(JSON.stringify({ type: 'profile', requestId, name: normalized, color: nextColor }))
      } catch (error) {
        window.clearTimeout(timer)
        profileRequests.delete(requestId)
        reject(error)
      }
    })
    viewerProfile.name = normalized
    viewerProfile.color = nextColor
    persistProfile(viewerProfile)
  }

  function connectPresence(app, stream) {
    activeRoom = { app, stream }
    const generation = ++presenceGeneration
    window.clearTimeout(reconnectTimer)
    rejectProfileRequests('房间连接已切换，请重试')
    presenceSocket?.close()
    presenceConnected.value = false
    onlineUsers.value = []

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const query = new URLSearchParams({
      app,
      stream,
      userId: visitorId,
      connectionId,
      name: viewerProfile.name,
      color: viewerProfile.color,
    })
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/presence?${query}`)
    presenceSocket = socket

    socket.addEventListener('open', () => {
      if (generation === presenceGeneration) presenceConnected.value = true
    })
    socket.addEventListener('message', (event) => {
      if (generation !== presenceGeneration) return
      try {
        const message = JSON.parse(event.data)
        if (message.roomId !== currentRoomKey.value) return
        if (message.type === 'presence') {
          onlineUsers.value = message.users.sort((left, right) => Number(right.id === visitorId) - Number(left.id === visitorId))
        } else if (message.type === 'chat_history') {
          messages.value = message.messages.map(normalizeMessage)
        } else if (message.type === 'chat_message') {
          messages.value.push(normalizeMessage(message.message))
        } else if (message.type === 'profile_result') {
          const pending = profileRequests.get(message.requestId)
          if (!pending) return
          window.clearTimeout(pending.timer)
          profileRequests.delete(message.requestId)
          if (message.ok) pending.resolve()
          else pending.reject(new Error(message.error || '用户名保存失败'))
        }
      } catch {
        // Ignore malformed room messages.
      }
    })
    socket.addEventListener('close', () => {
      if (generation !== presenceGeneration) return
      presenceConnected.value = false
      onlineUsers.value = []
      rejectProfileRequests('房间连接已断开，请重试')
      reconnectTimer = window.setTimeout(() => connectPresence(activeRoom.app, activeRoom.stream), 1500)
    })
  }

  function disconnectPresence() {
    presenceGeneration += 1
    window.clearTimeout(reconnectTimer)
    rejectProfileRequests('房间连接已断开，请重试')
    presenceSocket?.close()
    presenceSocket = null
    presenceConnected.value = false
    onlineUsers.value = []
  }

  function rejectProfileRequests(message) {
    for (const pending of profileRequests.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    profileRequests.clear()
  }

  function sendMessage(text) {
    const normalized = String(text || '').trim()
    if (!normalized || presenceSocket?.readyState !== WebSocket.OPEN) return false
    presenceSocket.send(JSON.stringify({ type: 'chat', text: normalized.slice(0, CHAT_TEXT_MAX_LENGTH) }))
    return true
  }

  function prepareImage(file) {
    return prepareChatImage(file)
  }

  async function sendImage(image, text = '') {
    if (presenceSocket?.readyState !== WebSocket.OPEN) throw new Error('聊天服务正在连接')
    const form = new FormData()
    form.append('image', image.blob, `chat-image.${imageExtension(image.blob.type)}`)
    const response = await fetch('/api/chat/images', { method: 'POST', body: form })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || `图片上传失败（HTTP ${response.status}）`)
    if (presenceSocket?.readyState !== WebSocket.OPEN) throw new Error('聊天连接已断开，请重新发送')
    presenceSocket.send(JSON.stringify({
      type: 'chat_image',
      imageUrl: payload.url,
      width: image.width,
      height: image.height,
      text: String(text || '').trim().slice(0, CHAT_TEXT_MAX_LENGTH),
    }))
  }

  function clearMessages() {
    messages.value = [{ id: messageId(), type: 'system', text: '聊天记录已在本地清空' }]
  }

  return {
    roomMeta,
    avatarOptions,
    viewerProfile,
    onlineUsers,
    messages,
    currentRoomKey,
    roomLoading,
    roomError,
    presenceIdentity,
    presenceConnected,
    loadRoom,
    disconnectPresence,
    updateProfile,
    sendMessage,
    prepareImage,
    sendImage,
    clearMessages,
  }
}

function persistentId(storage, key, prefix) {
  try {
    const existing = storage.getItem(key)
    if (existing) return existing
    const value = uniqueId(prefix)
    storage.setItem(key, value)
    return value
  } catch {
    return uniqueId(prefix)
  }
}

function uniqueId(prefix) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}:${crypto.randomUUID()}`
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}`
}

function normalizeMessage(message) {
  return {
    ...message,
    time: message.sentAt
      ? new Date(message.sentAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : '',
  }
}

async function prepareChatImage(file) {
  if (!(file instanceof Blob) || !CHAT_IMAGE_TYPES.has(file.type)) throw new Error('请选择 JPEG、PNG 或 WebP 图片')
  if (file.size > MAX_CHAT_IMAGE_SIZE) throw new Error('图片不能超过 5 MB')

  const bitmap = await createImageBitmap(file)
  const width = bitmap.width
  const height = bitmap.height
  const scale = Math.min(1, MAX_CHAT_IMAGE_EDGE / Math.max(width, height))
  if (scale === 1 && file.size <= 1024 * 1024) {
    bitmap.close()
    return { blob: file, width, height }
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const compressed = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82))
  if (!compressed) throw new Error('图片压缩失败')
  if (compressed.size < file.size) return { blob: compressed, width: canvas.width, height: canvas.height }
  return { blob: file, width, height }
}

function imageExtension(mimeType) {
  return mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg'
}
