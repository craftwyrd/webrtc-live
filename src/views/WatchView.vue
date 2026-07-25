<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { CircleStop, LocateFixed, Play, Radio, RefreshCw, RotateCw } from '@lucide/vue'
import { useNatMap } from '../composables/useNatMap'
import { useWhepPlayer } from '../composables/useWhepPlayer'

const app = ref('live')
const stream = ref('livestream')
const eip = ref('')
const codec = ref('')
const protocol = ref(window.location.protocol === 'http:' ? 'http:' : 'https:')
const host = ref('')
const sourceUrl = ref('/rtc/v1/whep/?app=live&stream=livestream')
const video = ref(null)
const actionError = ref('')

const natmap = useNatMap()
const player = useWhepPlayer()
const isLive = computed(() => player.state.value === 'connected')
const statusTone = computed(() => player.state.value === 'error' ? 'danger' : isLive.value ? 'success' : 'neutral')

onMounted(() => {
  player.attachVideo(video.value)
  natmap.refresh().catch(() => {})
})

watch([protocol, host, app, stream, eip, codec], updateSourceUrl)

watch(sourceUrl, () => {
  const url = parseSourceUrl()
  if (!url) return
  if (isAbsoluteUrl(sourceUrl.value)) {
    protocol.value = url.protocol
    host.value = url.host
  } else {
    host.value = ''
  }
  app.value = url.searchParams.get('app') || ''
  stream.value = url.searchParams.get('stream') || ''
  eip.value = url.searchParams.get('eip') || ''
  codec.value = url.searchParams.get('codec') || ''
})

async function start() {
  actionError.value = ''
  try {
    if (!updateSourceUrl()) throw new Error('域名、IP 或端口格式无效')
    const url = parseSourceUrl()
    if (!url) throw new Error('原始拉流地址格式无效')
    if (!url.searchParams.get('app') || !url.searchParams.get('stream')) {
      throw new Error('拉流地址需要包含 app 和 stream 参数')
    }
    await player.start(sourceUrl.value)
  } catch (error) {
    actionError.value = error?.message || String(error)
  }
}

function stop() {
  actionError.value = ''
  player.stop()
}

async function useCurrentMapping() {
  actionError.value = ''
  try {
    const mapping = await natmap.refresh()
    eip.value = mapping.eip
  } catch (error) {
    actionError.value = error?.message || String(error)
  }
}

function parseSourceUrl() {
  try {
    return new URL(sourceUrl.value, window.location.href)
  } catch {
    return null
  }
}

function updateSourceUrl() {
  let url = parseSourceUrl()
  if (!url) return false

  if (host.value) {
    try {
      const origin = new URL(`${protocol.value}//${host.value}`)
      url.protocol = origin.protocol
      url.host = origin.host
    } catch {
      return false
    }
  }

  setQueryParameter(url, 'app', app.value)
  setQueryParameter(url, 'stream', stream.value)
  setQueryParameter(url, 'eip', eip.value)
  setQueryParameter(url, 'codec', codec.value)
  sourceUrl.value = formatSourceUrl(url, Boolean(host.value))
  return true
}

function formatSourceUrl(url, absolute = isAbsoluteUrl(sourceUrl.value)) {
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
</script>

<template>
  <section class="workspace watch-workspace">
    <header class="page-heading">
      <div>
        <p class="eyebrow">WHEP PLAYER</p>
        <h1>直播观看</h1>
      </div>
      <div class="mapping-status" :class="{ unavailable: natmap.error.value }">
        <span class="signal-dot" />
        <div>
          <span>IPv4 媒体端点</span>
          <strong>{{ natmap.endpoint.value }}</strong>
        </div>
        <button class="icon-button" type="button" title="刷新 IPv4 媒体端点" :disabled="natmap.loading.value" @click="natmap.refresh().catch(() => {})">
          <RefreshCw :size="16" :class="{ spinning: natmap.loading.value }" />
        </button>
      </div>
    </header>

    <div class="watch-grid">
      <div class="stage-panel">
        <div class="stage-toolbar">
          <div class="status-line" :data-tone="statusTone">
            <span class="status-led" />
            {{ player.message.value }}
          </div>
          <span class="stream-label">{{ app }}/{{ stream }}</span>
        </div>

        <div class="video-stage">
          <video ref="video" controls playsinline autoplay />
          <div v-if="!player.active.value" class="video-empty">
            <Radio :size="36" stroke-width="1.4" />
            <span>{{ player.state.value === 'error' ? '连接中断' : '等待直播信号' }}</span>
          </div>
        </div>

        <div class="stats-strip" aria-label="播放统计">
          <div><span>接收码率</span><strong>{{ player.stats.bitrate }} kb/s</strong></div>
          <div><span>画面</span><strong>{{ player.stats.resolution }}</strong></div>
          <div><span>帧率</span><strong>{{ player.stats.fps }} fps</strong></div>
          <div><span>丢包</span><strong>{{ player.stats.packetsLost }}</strong></div>
          <div><span>RTT</span><strong>{{ player.stats.rtt }}</strong></div>
        </div>
      </div>

      <aside class="control-panel">
        <div class="panel-title">
          <div>
            <p class="eyebrow">SOURCE</p>
            <h2>播放源</h2>
          </div>
        </div>

        <label class="field source-url-field">
          <span>原始拉流地址</span>
          <textarea v-model.trim="sourceUrl" name="watch-source-url" rows="3" :disabled="player.active.value" spellcheck="false" />
        </label>

        <div class="origin-fields">
          <label class="field protocol-field">
            <span>协议</span>
            <select v-model="protocol" name="watch-protocol" :disabled="player.active.value || !host">
              <option value="https:">HTTPS</option>
              <option value="http:">HTTP</option>
            </select>
          </label>
          <label class="field host-field">
            <span>域名 / IP 与端口</span>
            <input v-model.trim="host" name="watch-host" placeholder="留空使用当前站点" :disabled="player.active.value" autocomplete="url" />
          </label>
        </div>

        <div class="field-row">
          <label class="field">
          <span>应用名</span>
          <input v-model.trim="app" name="watch-app" :disabled="player.active.value" autocomplete="off" />
          </label>
          <label class="field">
          <span>流名称</span>
          <input v-model.trim="stream" name="watch-stream" :disabled="player.active.value" autocomplete="off" />
          </label>
        </div>

        <label class="field eip-field">
          <span>IPv4 eip</span>
          <div class="input-with-action">
            <input v-model.trim="eip" name="watch-eip" placeholder="留空时自动同步" :disabled="player.active.value" autocomplete="off" />
            <button type="button" title="填入当前 NATMap IPv4 端点" :disabled="player.active.value || natmap.loading.value" @click="useCurrentMapping">
              <LocateFixed :size="16" />
            </button>
          </div>
        </label>

        <label class="field">
          <span>视频编码</span>
          <select v-model="codec" name="watch-codec" :disabled="player.active.value">
            <option value="">自动协商</option>
            <option value="h264">H.264</option>
            <option value="hevc">HEVC / H.265</option>
          </select>
        </label>

        <div class="endpoint-preview">
          <span>最终请求地址</span>
          <code>{{ sourceUrl }}</code>
        </div>

        <p v-if="actionError || natmap.error.value" class="inline-error">{{ actionError || natmap.error.value }}</p>

        <div class="control-actions">
          <button v-if="!player.active.value" class="primary-button" type="button" :disabled="!sourceUrl || !app || !stream" @click="start">
            <Play :size="18" fill="currentColor" />
            开始播放
          </button>
          <template v-else>
            <button class="primary-button" type="button" @click="start">
              <RotateCw :size="18" />
              重新连接
            </button>
            <button class="secondary-button danger-button" type="button" @click="stop">
              <CircleStop :size="18" />
              停止
            </button>
          </template>
        </div>
      </aside>
    </div>
  </section>
</template>
