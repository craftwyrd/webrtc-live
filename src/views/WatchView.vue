<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PhotoSwipeLightbox from 'photoswipe/lightbox'
import 'photoswipe/style.css'
import {
  Check,
  ChevronDown,
  CircleStop,
  Flower2,
  Heart,
  ImagePlus,
  LocateFixed,
  LoaderCircle,
  Play,
  Radio,
  RefreshCw,
  Send,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Users,
  X,
} from '@lucide/vue'
import { useNatMap } from '../composables/useNatMap'
import { useWatchRoom } from '../composables/useWatchRoom'
import { useWhepPlayer } from '../composables/useWhepPlayer'
import '../watch.css'

const video = ref(null)
const messageList = ref(null)
const sourceButton = ref(null)
const sourceCloseButton = ref(null)
const profileButton = ref(null)
const profileNameInput = ref(null)
const audienceButton = ref(null)
const audienceCloseButton = ref(null)
const clearChatButton = ref(null)
const clearChatCancelButton = ref(null)
const imageInput = ref(null)
const chatInput = ref(null)
const actionError = ref('')
const sourceDrawerOpen = ref(false)
const profileModalOpen = ref(false)
const profileSaving = ref(false)
const audienceOpen = ref(false)
const clearChatModalOpen = ref(false)
const chatText = ref('')
const imageUploading = ref(false)
const imageDraft = ref(null)
const toastText = ref('')
const toastVisible = ref(false)
let toastTimer

const imageLightbox = new PhotoSwipeLightbox({
  pswpModule: () => import('photoswipe'),
  mainClass: 'girl-photoswipe',
  bgOpacity: 0.72,
  showHideAnimationType: 'fade',
  showAnimationDuration: 180,
  hideAnimationDuration: 160,
  initialZoomLevel: 'fit',
  wheelToZoom: true,
  imageClickAction: 'zoom',
  bgClickAction: 'close',
  tapAction(_point, event) {
    if (event.target.closest?.('.pswp__img')) this.element?.classList.toggle('pswp--ui-visible')
    else this.close()
  },
  closeOnVerticalDrag: true,
  pinchToClose: true,
  counter: false,
  arrowPrev: false,
  arrowNext: false,
  zoom: false,
  closeTitle: '关闭图片预览',
  errorMsg: '图片加载失败',
  paddingFn: () => ({ top: 18, right: 18, bottom: 18, left: 18 }),
})
let imagePreviewHistoryActive = false
let imagePreviewClosingFromHistory = false

imageLightbox.on('beforeOpen', () => {
  window.history.pushState({ ...window.history.state, craftwyrdImagePreview: true }, '', window.location.href)
  imagePreviewHistoryActive = true
})

imageLightbox.on('close', () => {
  if (imagePreviewHistoryActive && !imagePreviewClosingFromHistory) {
    imagePreviewHistoryActive = false
    window.history.back()
  }
  imagePreviewClosingFromHistory = false
})

const route = useRoute()
const router = useRouter()
const IPV4_SOURCE_HOST = 'srs.drivod.top'
const IPV6_SOURCE_HOST = 'ipv6.drivod.top'
const IPV6_RTC_PORT = 8003
const IPV6_EIP = `${IPV6_SOURCE_HOST}:${IPV6_RTC_PORT}`
const initialApp = routeSegment(route.query.app, 'live')
const initialStream = routeSegment(route.query.stream, 'livestream')
const app = ref(initialApp)
const stream = ref(initialStream)
const eip = ref('')
const codec = ref('h264')
const protocol = ref('https:')
const host = ref('')
const sourceHostPreset = ref('current')
const sourceUrl = ref(`/rtc/v1/whep/?app=${encodeURIComponent(initialApp)}&stream=${encodeURIComponent(initialStream)}&codec=h264`)

const sourceDraft = reactive({
  rawUrl: sourceUrl.value,
  protocol: protocol.value,
  host: host.value,
  app: app.value,
  stream: stream.value,
  eip: eip.value,
  codec: codec.value,
})

const profileDraft = reactive({ name: '', color: 'gold' })

const natmap = useNatMap()
const player = useWhepPlayer()
const room = useWatchRoom()
const { roomMeta, avatarOptions, viewerProfile, onlineUsers, messages, presenceConnected } = room

const isLive = computed(() => player.state.value === 'connected')
const isConnecting = computed(() => player.state.value === 'connecting')
const canStart = computed(() => Boolean(sourceUrl.value && app.value && stream.value && natmap.isValidEip(eip.value)))
const statusTone = computed(() => player.state.value === 'error' ? 'danger' : isLive.value ? 'success' : isConnecting.value ? 'warning' : 'neutral')
const codecLabel = computed(() => ({ h264: 'H.264', hevc: 'HEVC / H.265' }[codec.value] || '自动协商'))
const viewerCount = computed(() => onlineUsers.value.length)
const draftSourceUrl = computed(() => buildSourceUrl(sourceDraft) || sourceDraft.rawUrl)

watch(() => messages.value.length, scrollMessagesToBottom)
watch(
  () => [sourceDraft.protocol, sourceDraft.host, sourceDraft.app, sourceDraft.stream, sourceDraft.eip, sourceDraft.codec],
  syncDraftRawUrl,
)

onMounted(async () => {
  player.attachVideo(video.value)
  imageLightbox.init()
  window.addEventListener('popstate', closeImagePreviewFromHistory)
  await Promise.allSettled([refreshCurrentMapping(false), room.loadRoom(app.value, stream.value)])
  await scrollMessagesToBottom()
})

onBeforeUnmount(() => {
  window.clearTimeout(toastTimer)
  window.removeEventListener('popstate', closeImagePreviewFromHistory)
  imagePreviewHistoryActive = false
  imageLightbox.destroy()
  clearImageDraft()
  room.disconnectPresence()
})

async function refreshCurrentMapping(showFeedback = true) {
  actionError.value = ''
  try {
    const mapping = await resolveEndpointForHost(host.value)
    eip.value = mapping.eip
    sourceUrl.value = buildSourceUrl({
      rawUrl: sourceUrl.value,
      protocol: protocol.value,
      host: host.value,
      app: app.value,
      stream: stream.value,
      eip: eip.value,
      codec: codec.value,
    })
    if (showFeedback) showToast(mapping.direct ? '已切换 IPv6 直连端点' : '已填入当前 NATMap 端点')
    return mapping
  } catch (error) {
    actionError.value = error?.message || String(error)
    throw error
  }
}

async function start() {
  actionError.value = ''
  try {
    if (!eip.value) await refreshCurrentMapping(false)
    if (!natmap.isValidEip(eip.value)) throw new Error('需要有效的 IP 或域名 eip 才能开始播放')
    sourceUrl.value = buildSourceUrl({
      rawUrl: sourceUrl.value,
      protocol: protocol.value,
      host: host.value,
      app: app.value,
      stream: stream.value,
      eip: eip.value,
      codec: codec.value,
    })
    if (!sourceUrl.value) throw new Error('拉流地址格式无效')
    await player.start(sourceUrl.value)
  } catch (error) {
    actionError.value = error?.message || String(error)
  }
}

function stop() {
  actionError.value = ''
  player.stop()
}

async function openSourceDrawer() {
  Object.assign(sourceDraft, {
    rawUrl: sourceUrl.value,
    protocol: protocol.value,
    host: host.value,
    app: app.value,
    stream: stream.value,
    eip: eip.value,
    codec: codec.value,
  })
  sourceHostPreset.value = sourceHostPresetFor(sourceDraft.host)
  actionError.value = ''
  sourceDrawerOpen.value = true
  await nextTick()
  sourceCloseButton.value?.focus()
}

async function closeSourceDrawer() {
  sourceDrawerOpen.value = false
  await nextTick()
  sourceButton.value?.focus()
}

async function syncDraftFromRawUrl() {
  try {
    const url = new URL(sourceDraft.rawUrl, window.location.href)
    if (isAbsoluteUrl(sourceDraft.rawUrl)) {
      sourceDraft.protocol = url.protocol
      sourceDraft.host = url.host
    } else {
      sourceDraft.protocol = window.location.protocol
      sourceDraft.host = window.location.host
    }
    sourceDraft.app = url.searchParams.get('app') || sourceDraft.app
    sourceDraft.stream = url.searchParams.get('stream') || sourceDraft.stream
    sourceDraft.eip = url.searchParams.get('eip') || sourceDraft.eip
    sourceDraft.codec = url.searchParams.get('codec') || sourceDraft.codec
    await handleDraftHostChange()
    actionError.value = ''
  } catch {
    actionError.value = 'WHEP 拉流地址格式无效'
  }
}

function syncDraftRawUrl() {
  const nextUrl = buildSourceUrl(sourceDraft)
  if (nextUrl) sourceDraft.rawUrl = nextUrl
}

async function refreshDraftMapping() {
  actionError.value = ''
  try {
    const mapping = await resolveEndpointForHost(sourceDraft.host)
    sourceDraft.eip = mapping.eip
    showToast(mapping.direct ? '已切换 IPv6 直连端点' : '已填入当前 NATMap 端点')
  } catch (error) {
    actionError.value = error?.message || String(error)
  }
}

async function syncDraftEndpointForHost() {
  if (!isKnownSourceHost(sourceDraft.host)) return
  await refreshDraftMapping()
}

async function handleDraftHostChange() {
  sourceHostPreset.value = sourceHostPresetFor(sourceDraft.host)
  if (sourceHostPreset.value === 'current') await applySourceHostPreset()
  else await syncDraftEndpointForHost()
}

async function applySourceHostPreset() {
  const preset = sourceHostPreset.value
  if (preset === 'custom') return
  if (preset === 'current') {
    sourceDraft.protocol = window.location.protocol
    sourceDraft.host = window.location.host
    await refreshDraftMapping()
  } else {
    sourceDraft.protocol = 'https:'
    sourceDraft.host = preset
    await syncDraftEndpointForHost()
  }
}

function sourceHostPresetFor(value) {
  const hostValue = value?.trim().toLowerCase()
  if (!hostValue || hostValue === window.location.host.toLowerCase()) return 'current'
  const hostname = sourceHostname(value)
  if (hostname === IPV4_SOURCE_HOST) return IPV4_SOURCE_HOST
  if (hostname === IPV6_SOURCE_HOST) return IPV6_SOURCE_HOST
  return 'custom'
}

async function resolveEndpointForHost(sourceHost) {
  if (sourceHostname(sourceHost) === IPV6_SOURCE_HOST) {
    return { ip: IPV6_SOURCE_HOST, port: IPV6_RTC_PORT, eip: IPV6_EIP, protocol: 'UDP', direct: true }
  }
  return natmap.refresh()
}

function isKnownSourceHost(value) {
  const hostname = sourceHostname(value)
  return hostname === IPV4_SOURCE_HOST || hostname === IPV6_SOURCE_HOST
}

function sourceHostname(value) {
  try {
    return new URL(`https://${value?.trim() || window.location.host}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

async function saveSourceSettings() {
  actionError.value = ''
  try {
    if (!sourceDraft.app.trim() || !sourceDraft.stream.trim()) throw new Error('应用名和流名称都需要填写')
    if (sourceHostPresetFor(sourceDraft.host) !== 'custom') {
      const mapping = await resolveEndpointForHost(sourceDraft.host)
      sourceDraft.eip = mapping.eip
    }
    if (!natmap.isValidEip(sourceDraft.eip.trim())) throw new Error('eip 需要使用有效的 IP 或域名:端口格式')
    const nextUrl = buildSourceUrl(sourceDraft)
    if (!nextUrl) throw new Error('域名、IP 或端口格式无效')

    app.value = sourceDraft.app.trim()
    stream.value = sourceDraft.stream.trim()
    eip.value = sourceDraft.eip.trim()
    codec.value = sourceDraft.codec
    protocol.value = sourceDraft.protocol
    host.value = sourceDraft.host.trim()
    sourceUrl.value = nextUrl
    await room.loadRoom(app.value, stream.value)
    await router.replace({ query: { ...route.query, app: app.value, stream: stream.value } })
    sourceDrawerOpen.value = false
    showToast('播放地址已保存')
    if (player.active.value) await start()
  } catch (error) {
    actionError.value = error?.message || String(error)
  }
}

function buildSourceUrl(config) {
  try {
    const raw = config.rawUrl?.trim() || '/rtc/v1/whep/'
    const url = new URL(raw, window.location.href)
    const absolute = Boolean(config.host?.trim()) || isAbsoluteUrl(raw)
    if (config.host?.trim()) {
      const origin = new URL(`${config.protocol}//${config.host.trim()}`)
      url.protocol = origin.protocol
      url.hostname = origin.hostname
      url.port = origin.port
    }
    setQueryParameter(url, 'app', config.app?.trim())
    setQueryParameter(url, 'stream', config.stream?.trim())
    setQueryParameter(url, 'eip', config.eip?.trim())
    setQueryParameter(url, 'codec', config.codec)
    return formatSourceUrl(url, absolute)
  } catch {
    return ''
  }
}

function formatSourceUrl(url, absolute) {
  let output = absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`
  const endpoint = url.searchParams.get('eip')
  if (endpoint) output = output.replace(`eip=${encodeURIComponent(endpoint)}`, `eip=${endpoint}`)
  return output
}

function isAbsoluteUrl(value) {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value) || value.startsWith('//')
}

function setQueryParameter(url, name, value) {
  if (value) url.searchParams.set(name, value)
  else url.searchParams.delete(name)
}

function routeSegment(value, fallback) {
  const normalized = Array.isArray(value) ? value[0] : value
  return typeof normalized === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(normalized) ? normalized : fallback
}

async function openProfileModal() {
  profileDraft.name = viewerProfile.name
  profileDraft.color = viewerProfile.color
  actionError.value = ''
  profileModalOpen.value = true
  await nextTick()
  profileNameInput.value?.focus()
}

async function closeProfileModal() {
  profileModalOpen.value = false
  actionError.value = ''
  await nextTick()
  profileButton.value?.focus()
}

async function openAudience() {
  audienceOpen.value = true
  await nextTick()
  audienceCloseButton.value?.focus()
}

async function closeAudience() {
  audienceOpen.value = false
  await nextTick()
  audienceButton.value?.focus()
}

function closeActiveOverlay() {
  if (clearChatModalOpen.value) closeClearChatModal()
  else if (sourceDrawerOpen.value) closeSourceDrawer()
  else if (profileModalOpen.value) closeProfileModal()
  else if (audienceOpen.value) closeAudience()
}

async function saveProfile() {
  if (profileSaving.value) return
  profileSaving.value = true
  actionError.value = ''
  try {
    await room.updateProfile(profileDraft.name, profileDraft.color)
    await closeProfileModal()
    showToast('用户名已保存')
  } catch (error) {
    actionError.value = error?.message || String(error)
  } finally {
    profileSaving.value = false
  }
}

async function submitChat() {
  if (imageUploading.value) return
  if (imageDraft.value) {
    imageUploading.value = true
    try {
      await room.sendImage(imageDraft.value, chatText.value)
      clearImageDraft()
      chatText.value = ''
      await scrollMessagesToBottom()
    } catch (error) {
      showToast(error?.message || String(error))
    } finally {
      imageUploading.value = false
    }
    return
  }
  if (!room.sendMessage(chatText.value)) return
  chatText.value = ''
  await scrollMessagesToBottom()
}

function openImagePicker() {
  if (!imageUploading.value) imageInput.value?.click()
}

async function sendSelectedImage(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  await stageChatImage(file)
}

function pasteChatImage(event) {
  const imageItem = Array.from(event.clipboardData?.items || []).find((item) => item.type.startsWith('image/'))
  const file = imageItem?.getAsFile()
  if (!file) return
  event.preventDefault()
  stageChatImage(file)
}

async function stageChatImage(file) {
  if (!file || imageUploading.value) return
  imageUploading.value = true
  try {
    const image = await room.prepareImage(file)
    clearImageDraft()
    imageDraft.value = { ...image, previewUrl: URL.createObjectURL(image.blob) }
    await nextTick()
    chatInput.value?.focus()
  } catch (error) {
    showToast(error?.message || String(error))
  } finally {
    imageUploading.value = false
  }
}

function clearImageDraft() {
  if (imageDraft.value?.previewUrl) URL.revokeObjectURL(imageDraft.value.previewUrl)
  imageDraft.value = null
}

function openImagePreview(message) {
  imageLightbox.loadAndOpen(0, [{
    src: message.imageUrl,
    width: message.width,
    height: message.height,
    alt: `${message.name} 发送的图片`,
  }])
}

function closeImagePreviewFromHistory() {
  if (!imagePreviewHistoryActive) return
  imagePreviewHistoryActive = false
  imagePreviewClosingFromHistory = true
  imageLightbox.pswp?.close()
}

async function openClearChatModal() {
  clearChatModalOpen.value = true
  await nextTick()
  clearChatCancelButton.value?.focus()
}

async function closeClearChatModal() {
  clearChatModalOpen.value = false
  await nextTick()
  clearChatButton.value?.focus()
}

async function confirmClearChat() {
  clearChatModalOpen.value = false
  room.clearMessages()
  await scrollMessagesToBottom()
  showToast('聊天记录已清空')
  await nextTick()
  clearChatButton.value?.focus()
}

function insertFlower() {
  chatText.value = `${chatText.value}✿`
}

async function scrollMessagesToBottom() {
  await nextTick()
  if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight
}

function avatarClass(color) {
  return `girl-avatar-${color || 'pink'}`
}

function thumbnailAspect(message) {
  const ratio = Math.min(1.5, Math.max(0.75, message.width / message.height))
  return String(ratio)
}

function showToast(text) {
  toastText.value = text
  toastVisible.value = true
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toastVisible.value = false }, 1800)
}
</script>

<template>
  <section class="girl-watch-page" @keydown.esc="closeActiveOverlay">
    <div class="girl-decoration" aria-hidden="true">
      <Sparkles class="girl-deco girl-deco-1" />
      <Heart class="girl-deco girl-deco-2" />
      <Flower2 class="girl-deco girl-deco-3" />
      <Sparkles class="girl-deco girl-deco-4" />
    </div>

    <div class="girl-watch-shell">
      <header class="girl-topbar">
        <div class="girl-brand" aria-label="CraftWyrd Live 樱花放映室">
          <span class="girl-brand-mark"><Heart :size="20" fill="currentColor" /></span>
          <div>
            <strong>CraftWyrd Live</strong>
            <span>樱花放映室 ✿</span>
          </div>
        </div>

        <div class="girl-topbar-actions">
          <button ref="audienceButton" class="girl-viewer-count" type="button" title="查看在线用户" aria-controls="audience-sheet" :aria-expanded="audienceOpen" @click="openAudience">
            <span class="girl-live-dot" />
            <span><strong>{{ viewerCount }}</strong><span class="girl-viewer-label"> 人正在看</span></span>
            <ChevronDown :size="13" />
          </button>
          <button ref="sourceButton" class="girl-source-button" type="button" title="直播地址设置" @click="openSourceDrawer">
            <SlidersHorizontal :size="16" />
            <span>播放源</span>
          </button>
          <button ref="profileButton" class="girl-profile-button" type="button" title="编辑用户名" @click="openProfileModal">
            <span class="girl-avatar girl-profile-avatar" :class="avatarClass(viewerProfile.color)">{{ viewerProfile.name.slice(0, 1) }}</span>
            <span class="girl-profile-name">{{ viewerProfile.name }}</span>
            <ChevronDown :size="14" />
          </button>
        </div>
      </header>

      <header class="girl-stream-head">
        <span class="girl-live-tag"><span /> LIVE</span>
        <div class="girl-stream-copy">
          <h1>{{ roomMeta.title }}</h1>
          <p>{{ roomMeta.description }} ♡</p>
        </div>
        <div class="girl-stream-meta">
          <span>主播 <strong>{{ roomMeta.host.name }}</strong></span>
          <i />
          <span>{{ app }}/{{ stream }}</span>
          <i />
          <span>{{ codecLabel }}</span>
          <i />
          <span>延迟约 <strong>{{ player.stats.rtt === '-' ? '等待统计' : player.stats.rtt }}</strong></span>
        </div>
      </header>

      <div class="girl-watch-grid">
        <section class="girl-stage-panel" aria-label="直播播放器">
          <div class="girl-stage-toolbar">
            <span class="girl-status-led" :data-tone="statusTone" />
            <span class="girl-status-message">{{ player.message.value }}</span>
            <span class="girl-stream-label">{{ app }}/{{ stream }}</span>
          </div>

          <div class="girl-video-stage">
            <video ref="video" controls playsinline autoplay />
            <div v-if="!isLive" class="girl-video-empty">
              <Radio :size="34" />
              <strong>{{ player.state.value === 'error' ? '直播连接中断' : isConnecting ? '正在连接直播' : '等待直播信号' }}</strong>
              <span>{{ actionError || '准备好后连接 SRS WHEP 播放源' }}</span>
              <button type="button" :disabled="isConnecting || !canStart" @click="start">
                <RefreshCw v-if="player.state.value === 'error'" :size="16" />
                <Play v-else :size="16" fill="currentColor" />
                {{ player.state.value === 'error' ? '重新连接' : '连接直播' }}
              </button>
            </div>
            <span v-if="isLive" class="girl-live-badge"><span /> LIVE</span>
          </div>

          <div class="girl-stats-strip" aria-label="播放统计">
            <div><span>接收码率</span><strong>{{ player.stats.bitrate }} kb/s</strong></div>
            <div><span>画面</span><strong>{{ player.stats.resolution }}</strong></div>
            <div><span>帧率</span><strong>{{ player.stats.fps }} fps</strong></div>
            <div><span>丢包</span><strong>{{ player.stats.packetsLost }}</strong></div>
            <div><span>RTT</span><strong>{{ player.stats.rtt }}</strong></div>
          </div>

          <div v-if="player.active.value" class="girl-stage-actions">
            <button type="button" @click="start"><RefreshCw :size="15" />重新连接</button>
            <button type="button" @click="stop"><CircleStop :size="15" />停止播放</button>
          </div>
        </section>

        <aside class="girl-social-panel" :class="{ 'has-image-draft': imageDraft }" aria-label="直播聊天">
          <header class="girl-social-title">
            <span class="girl-social-mark"><Heart :size="15" fill="currentColor" /></span>
            <div><h2>一起看</h2><span>{{ viewerCount }} 人在线 · 只有房间里的朋友 ✿</span></div>
            <button ref="clearChatButton" type="button" title="清空本地聊天记录" aria-label="清空本地聊天记录" @click="openClearChatModal"><Trash2 :size="15" /></button>
          </header>

          <div ref="messageList" class="girl-message-list" role="log" aria-live="polite" aria-relevant="additions text">
            <template v-for="message in messages" :key="message.id">
              <div v-if="message.type === 'system'" class="girl-system-message">✿ {{ message.text }}</div>
              <article v-else class="girl-message" :class="{ 'is-mine': message.authorId === viewerProfile.id }">
                <span class="girl-avatar girl-message-avatar" :class="avatarClass(message.color)">{{ message.name.slice(0, 1) }}</span>
                <div class="girl-message-body">
                  <div class="girl-message-head">
                    <strong :class="{ 'is-host': message.host }">{{ message.name }}</strong>
                    <time>{{ message.time }}</time>
                  </div>
                  <template v-if="message.contentType === 'image'">
                    <button
                      type="button"
                      class="girl-chat-image"
                      :style="{ aspectRatio: thumbnailAspect(message) }"
                      :aria-label="`查看 ${message.name} 发送的图片`"
                      @click="openImagePreview(message)"
                    >
                      <img :src="message.imageUrl" :alt="`${message.name} 发送的图片`" loading="lazy">
                    </button>
                    <p v-if="message.text" class="girl-image-caption">{{ message.text }}</p>
                  </template>
                  <p v-else>{{ message.text }}</p>
                </div>
              </article>
            </template>
          </div>

          <form class="girl-chat-form" @submit.prevent="submitChat">
            <div v-if="imageDraft" class="girl-image-draft">
              <img :src="imageDraft.previewUrl" alt="待发送图片预览">
              <div><strong>待发送图片</strong><span>{{ imageDraft.width }} × {{ imageDraft.height }}</span></div>
              <button type="button" title="移除待发送图片" aria-label="移除待发送图片" @click="clearImageDraft"><X :size="15" /></button>
            </div>
            <div class="girl-chat-input">
              <button type="button" title="插入花朵" aria-label="插入花朵" @click="insertFlower"><Flower2 :size="16" /></button>
              <button type="button" title="发送图片" aria-label="发送图片" :disabled="imageUploading" @click="openImagePicker">
                <LoaderCircle v-if="imageUploading" class="spinning" :size="16" />
                <ImagePlus v-else :size="16" />
              </button>
              <input ref="imageInput" class="girl-image-input" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" @change="sendSelectedImage">
              <input ref="chatInput" v-model="chatText" type="text" name="chat-message" maxlength="180" autocomplete="off" aria-label="聊天消息" placeholder="对房间里的朋友说点什么… ✿" @paste="pasteChatImage">
            </div>
            <button class="girl-send-button" type="submit" title="发送消息" aria-label="发送消息" :disabled="imageUploading"><Send :size="18" /></button>
          </form>
        </aside>
      </div>
    </div>

    <div v-if="audienceOpen" class="girl-audience-mask" @click.self="closeAudience">
      <section id="audience-sheet" class="girl-audience-sheet" role="dialog" aria-modal="true" aria-labelledby="audience-title">
        <header class="girl-audience-sheet-head">
          <div>
            <span><Users :size="16" />{{ viewerCount }} 人正在看</span>
            <h2 id="audience-title">在线用户</h2>
          </div>
          <button ref="audienceCloseButton" type="button" title="关闭" aria-label="关闭在线用户列表" @click="closeAudience"><X :size="17" /></button>
        </header>
        <div class="girl-audience-status"><span :class="{ online: presenceConnected }" />{{ presenceConnected ? `${app}/${stream} · 实时同步` : '正在连接房间…' }}</div>
        <div v-if="onlineUsers.length" class="girl-audience-list">
          <div v-for="user in onlineUsers" :key="user.id" class="girl-audience-row" :class="{ 'is-me': user.id === viewerProfile.id }">
            <span class="girl-avatar" :class="avatarClass(user.color)">{{ user.avatar || user.name.slice(0, 1) }}</span>
            <div><strong>{{ user.name }}</strong><span>{{ user.id === viewerProfile.id ? '当前账号' : '正在观看' }}</span></div>
            <small v-if="user.id === viewerProfile.id">我</small>
          </div>
        </div>
        <div v-else class="girl-audience-sheet-empty">等待用户加入</div>
      </section>
    </div>

    <div v-if="sourceDrawerOpen" class="girl-drawer-mask" @click.self="closeSourceDrawer">
      <aside class="girl-source-drawer" role="dialog" aria-modal="true" aria-labelledby="source-title">
        <header class="girl-drawer-head">
          <span><SlidersHorizontal :size="19" /></span>
          <div><h2 id="source-title">直播地址设置</h2><p>换一个信号，也别错过朋友的弹幕 ✿</p></div>
          <button ref="sourceCloseButton" type="button" title="关闭" aria-label="关闭播放源设置" @click="closeSourceDrawer"><X :size="17" /></button>
        </header>

        <form class="girl-drawer-body" @submit.prevent="saveSourceSettings">
          <div class="girl-drawer-note"><Radio :size="16" /><span>保存后会用新地址重新建立 WHEP 连接，聊天和用户名保持不变。</span></div>

          <label class="girl-field girl-source-url-field">
            <span>WHEP 拉流地址 <small>支持相对或完整地址</small></span>
            <textarea v-model.trim="sourceDraft.rawUrl" name="whep-url" rows="3" autocomplete="off" spellcheck="false" @change="syncDraftFromRawUrl" />
          </label>

          <div class="girl-origin-grid">
            <label class="girl-field"><span>协议</span><select v-model="sourceDraft.protocol" name="source-protocol"><option value="https:">HTTPS</option><option value="http:">HTTP</option></select></label>
            <label class="girl-field"><span>域名 / IP 与端口</span><div class="girl-host-combo"><input v-model.trim="sourceDraft.host" name="source-host" inputmode="url" placeholder="留空使用当前站点…" autocomplete="off" spellcheck="false" @change="handleDraftHostChange"><select v-model="sourceHostPreset" name="source-host-preset" aria-label="选择线路域名" @change="applySourceHostPreset"><option value="current">当前站点</option><option :value="IPV4_SOURCE_HOST">IPv4 打洞</option><option :value="IPV6_SOURCE_HOST">IPv6 直连</option></select></div></label>
          </div>

          <div class="girl-field-grid">
            <label class="girl-field"><span>应用名</span><input v-model.trim="sourceDraft.app" name="source-app" autocomplete="off" spellcheck="false"></label>
            <label class="girl-field"><span>流名称</span><input v-model.trim="sourceDraft.stream" name="source-stream" autocomplete="off" spellcheck="false"></label>
          </div>

          <label class="girl-field">
            <span>媒体 eip <small>随所选线路联动</small></span>
            <div class="girl-input-action">
              <input v-model.trim="sourceDraft.eip" name="source-eip" inputmode="url" placeholder="例如 175.155.112.28:29575…" autocomplete="off" spellcheck="false">
              <button type="button" title="刷新所选线路的媒体端点" aria-label="刷新所选线路的媒体端点" :disabled="natmap.loading.value" @click="refreshDraftMapping">
                <RefreshCw :size="16" :class="{ spinning: natmap.loading.value }" />
              </button>
            </div>
          </label>

          <label class="girl-field"><span>视频编码</span><select v-model="sourceDraft.codec" name="source-codec"><option value="">自动协商</option><option value="h264">H.264</option><option value="hevc">HEVC / H.265</option></select></label>

          <div class="girl-source-preview"><span>最终请求地址</span><code>{{ draftSourceUrl }}</code></div>
          <p v-if="actionError || natmap.error.value" class="girl-inline-error">{{ actionError || natmap.error.value }}</p>

          <footer class="girl-drawer-actions">
            <button type="button" @click="closeSourceDrawer">取消</button>
            <button type="submit"><Check :size="16" />保存{{ player.active.value ? '并重连' : '' }} ✿</button>
          </footer>
        </form>
      </aside>
    </div>

    <div v-if="profileModalOpen" class="girl-modal-mask" @click.self="closeProfileModal">
      <section class="girl-profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <header class="girl-profile-head">
          <Heart :size="30" fill="currentColor" />
          <div><h2 id="profile-title">编辑我的用户名</h2><p>房内朋友靠这个认出你 ✿</p></div>
          <button type="button" title="关闭" aria-label="关闭用户名编辑" @click="closeProfileModal"><X :size="16" /></button>
        </header>
        <div class="girl-profile-body">
          <label class="girl-field"><span>昵称 <small>2-18 字符</small></span><input ref="profileNameInput" v-model="profileDraft.name" name="viewer-name" maxlength="18" autocomplete="nickname" spellcheck="false"></label>
          <fieldset class="girl-color-field"><legend>头像配色</legend><div><button v-for="option in avatarOptions" :key="option.id" type="button" :title="option.label" :aria-label="option.label" :aria-pressed="profileDraft.color === option.id" class="girl-color-option" :class="avatarClass(option.id)" @click="profileDraft.color = option.id" /></div></fieldset>
          <p v-if="actionError" class="girl-inline-error">{{ actionError }}</p>
        </div>
        <footer class="girl-profile-actions"><button type="button" @click="closeProfileModal">取消</button><button type="button" :disabled="profileSaving" @click="saveProfile">{{ profileSaving ? '保存中…' : '保存 ✿' }}</button></footer>
      </section>
    </div>

    <div v-if="clearChatModalOpen" class="girl-modal-mask" @click.self="closeClearChatModal">
      <section class="girl-clear-modal" role="alertdialog" aria-modal="true" aria-labelledby="clear-chat-title" aria-describedby="clear-chat-description">
        <div class="girl-clear-icon"><Trash2 :size="23" /></div>
        <div class="girl-clear-copy">
          <span>聊天记录整理</span>
          <h2 id="clear-chat-title">要清空聊天记录吗？</h2>
          <p id="clear-chat-description">当前浏览器里的聊天消息将被移除，不会影响房间里的其他观众。</p>
        </div>
        <footer class="girl-clear-actions">
          <button ref="clearChatCancelButton" type="button" @click="closeClearChatModal">保留记录</button>
          <button type="button" @click="confirmClearChat"><Trash2 :size="15" />确认清空</button>
        </footer>
      </section>
    </div>

    <div class="girl-toast" :class="{ show: toastVisible }" role="status"><Check :size="15" /><span>{{ toastText }}</span></div>
  </section>
</template>
