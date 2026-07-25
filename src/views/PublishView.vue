<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { Camera, CircleStop, LocateFixed, MonitorUp, Radio, RefreshCw, Send, Settings2 } from '@lucide/vue'
import { useNatMap } from '../composables/useNatMap'
import { useWhipPublisher } from '../composables/useWhipPublisher'

const preview = ref(null)
const actionError = ref('')
const eip = ref('')
const codec = ref('')
const protocol = ref(window.location.protocol === 'http:' ? 'http:' : 'https:')
const host = ref('')
const sourceUrl = ref('/rtc/v1/whip/?app=live&stream=livestream')
const settings = reactive({
  source: 'screen',
  app: 'live',
  stream: 'livestream',
  width: 1920,
  height: 1080,
  fps: 60,
  bitrate: 5000,
  systemAudio: true,
  microphone: false,
  cameraId: '',
  microphoneId: '',
})

const natmap = useNatMap()
const publisher = useWhipPublisher()
const statusTone = computed(() => publisher.state.value === 'error' ? 'danger' : publisher.state.value === 'connected' ? 'success' : 'neutral')
const hasValidEip = computed(() => natmap.isValidEip(eip.value))
const canStart = computed(() => Boolean(sourceUrl.value && settings.app && settings.stream && hasValidEip.value))

onMounted(async () => {
  publisher.attachPreview(preview.value)
  await Promise.allSettled([useCurrentMapping(), publisher.enumerateDevices()])
})

function selectSource(source) {
  settings.source = source
  if (source === 'camera' && settings.stream === 'livestream') settings.stream = 'camera'
  if (source === 'screen' && settings.stream === 'camera') settings.stream = 'livestream'
  updateSourceUrl()
}

watch([protocol, host, () => settings.app, () => settings.stream, eip, codec], updateSourceUrl)

watch(sourceUrl, () => {
  const url = parseSourceUrl()
  if (!url) return
  if (isAbsoluteUrl(sourceUrl.value)) {
    protocol.value = url.protocol
    host.value = url.host
  } else {
    host.value = ''
  }
  settings.app = url.searchParams.get('app') || ''
  settings.stream = url.searchParams.get('stream') || ''
  eip.value = url.searchParams.get('eip') || ''
  codec.value = url.searchParams.get('codec') || ''
})

async function start() {
  actionError.value = ''
  try {
    if (!eip.value) await applyCurrentMapping()
    if (!natmap.isValidEip(eip.value)) throw new Error('需要有效的 IPv4 eip 才能开始推流')
    if (!updateSourceUrl()) throw new Error('域名、IP 或端口格式无效')
    const url = parseSourceUrl()
    if (!url) throw new Error('原始推流地址格式无效')
    if (!url.searchParams.get('app') || !url.searchParams.get('stream')) {
      throw new Error('推流地址需要包含 app 和 stream 参数')
    }
    if (!natmap.isValidEip(url.searchParams.get('eip'))) {
      throw new Error('推流地址必须包含有效的 IPv4 eip')
    }
    await publisher.start(sourceUrl.value, { ...settings })
  } catch (error) {
    actionError.value = error?.message || String(error)
  }
}

async function useCurrentMapping() {
  actionError.value = ''
  try {
    await applyCurrentMapping()
  } catch (error) {
    actionError.value = error?.message || String(error)
  }
}

async function applyCurrentMapping() {
  const mapping = await natmap.refresh()
  eip.value = mapping.eip
  return mapping
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

  setQueryParameter(url, 'app', settings.app)
  setQueryParameter(url, 'stream', settings.stream)
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

async function requestDevices() {
  actionError.value = ''
  try {
    await publisher.requestDeviceLabels()
  } catch (error) {
    actionError.value = error?.message || String(error)
  }
}
</script>

<template>
  <section class="workspace publish-workspace">
    <header class="page-heading">
      <div>
        <p class="eyebrow">WHIP PUBLISHER</p>
        <h1>直播推流</h1>
      </div>
      <div class="mapping-status" :class="{ unavailable: natmap.error.value }">
        <span class="signal-dot" />
        <div>
          <span>IPv4 媒体端点</span>
          <strong>{{ natmap.endpoint.value }}</strong>
        </div>
        <button class="icon-button" type="button" title="刷新 IPv4 媒体端点" :disabled="natmap.loading.value" @click="useCurrentMapping">
          <RefreshCw :size="16" :class="{ spinning: natmap.loading.value }" />
        </button>
      </div>
    </header>

    <div class="publish-grid">
      <div class="stage-panel">
        <div class="stage-toolbar">
          <div class="status-line" :data-tone="statusTone">
            <span class="status-led" />
            {{ publisher.message.value }}
          </div>
          <span class="stream-label">{{ settings.app }}/{{ settings.stream }}</span>
        </div>

        <div class="video-stage preview-stage">
          <video ref="preview" muted playsinline autoplay />
          <div v-if="!publisher.active.value" class="video-empty">
            <MonitorUp v-if="settings.source === 'screen'" :size="36" stroke-width="1.4" />
            <Camera v-else :size="36" stroke-width="1.4" />
            <span>本地预览</span>
          </div>
          <span v-if="publisher.active.value" class="live-badge"><span /> LIVE</span>
        </div>

        <div class="stats-strip" aria-label="推流统计">
          <div><span>发送码率</span><strong>{{ publisher.stats.bitrate }} kb/s</strong></div>
          <div><span>画面</span><strong>{{ publisher.stats.resolution }}</strong></div>
          <div><span>帧率</span><strong>{{ publisher.stats.fps }} fps</strong></div>
          <div><span>已发送</span><strong>{{ publisher.stats.packetsSent }}</strong></div>
          <div><span>RTT</span><strong>{{ publisher.stats.rtt }}</strong></div>
        </div>
      </div>

      <aside class="control-panel publish-controls">
        <div class="panel-title">
          <div>
            <p class="eyebrow">CONTROL</p>
            <h2>推流设置</h2>
          </div>
          <Settings2 :size="18" />
        </div>

        <div class="segmented-control" aria-label="采集源">
          <button type="button" :class="{ active: settings.source === 'screen' }" :disabled="publisher.active.value" @click="selectSource('screen')">
            <MonitorUp :size="17" /> 屏幕
          </button>
          <button type="button" :class="{ active: settings.source === 'camera' }" :disabled="publisher.active.value" @click="selectSource('camera')">
            <Camera :size="17" /> 摄像头
          </button>
        </div>

        <label class="field source-url-field">
          <span>原始推流地址</span>
          <textarea v-model.trim="sourceUrl" name="publish-source-url" rows="3" :disabled="publisher.active.value" spellcheck="false" />
        </label>

        <div class="origin-fields">
          <label class="field protocol-field">
            <span>协议</span>
            <select v-model="protocol" name="publish-protocol" :disabled="publisher.active.value || !host">
              <option value="https:">HTTPS</option>
              <option value="http:">HTTP</option>
            </select>
          </label>
          <label class="field host-field">
            <span>域名 / IP 与端口</span>
            <input v-model.trim="host" name="publish-host" placeholder="留空使用当前站点" :disabled="publisher.active.value" autocomplete="url" />
          </label>
        </div>

        <div class="field-row">
          <label class="field"><span>应用名</span><input v-model.trim="settings.app" name="publish-app" :disabled="publisher.active.value" /></label>
          <label class="field"><span>流名称</span><input v-model.trim="settings.stream" name="publish-stream" :disabled="publisher.active.value" /></label>
        </div>

        <label class="field eip-field">
          <span>IPv4 eip</span>
          <div class="input-with-action">
            <input v-model.trim="eip" name="publish-eip" placeholder="175.155.112.28:29575" :disabled="publisher.active.value" autocomplete="off" required />
            <button type="button" title="填入当前 NATMap IPv4 端点" :disabled="publisher.active.value || natmap.loading.value" @click="useCurrentMapping">
              <LocateFixed :size="16" />
            </button>
          </div>
        </label>

        <label class="field">
          <span>视频编码</span>
          <select v-model="codec" name="publish-codec" :disabled="publisher.active.value">
            <option value="">自动协商</option>
            <option value="h264">H.264</option>
            <option value="hevc">HEVC / H.265</option>
          </select>
        </label>

        <div class="endpoint-preview">
          <span>最终请求地址</span>
          <code>{{ sourceUrl }}</code>
        </div>

        <label v-if="settings.source === 'camera'" class="field">
          <span>摄像头</span>
          <select v-model="settings.cameraId" name="camera-device" :disabled="publisher.active.value">
            <option value="">系统默认</option>
            <option v-for="device in publisher.devices.cameras" :key="device.id" :value="device.id">{{ device.label }}</option>
          </select>
        </label>

        <div class="field-row field-row-3">
          <label class="field"><span>宽度</span><input v-model.number="settings.width" name="video-width" type="number" min="320" max="3840" step="1" :disabled="publisher.active.value" /></label>
          <label class="field"><span>高度</span><input v-model.number="settings.height" name="video-height" type="number" min="240" max="2160" step="1" :disabled="publisher.active.value" /></label>
          <label class="field"><span>帧率</span><input v-model.number="settings.fps" name="video-fps" type="number" min="1" max="120" step="1" :disabled="publisher.active.value" /></label>
        </div>

        <label class="field bitrate-field">
          <span>视频码率 <strong>{{ settings.bitrate }} kb/s</strong></span>
          <input v-model.number="settings.bitrate" name="video-bitrate" type="range" min="500" max="20000" step="500" :disabled="publisher.active.value" />
        </label>

        <div class="toggle-group">
          <label v-if="settings.source === 'screen'" class="toggle-row">
            <span><strong>系统音频</strong><small>共享内容中的声音</small></span>
            <input v-model="settings.systemAudio" name="system-audio" type="checkbox" :disabled="publisher.active.value" />
          </label>
          <label class="toggle-row">
            <span><strong>麦克风</strong><small>语音输入</small></span>
            <input v-model="settings.microphone" name="microphone-enabled" type="checkbox" :disabled="publisher.active.value" />
          </label>
        </div>

        <label v-if="settings.microphone" class="field">
          <span>麦克风设备</span>
          <select v-model="settings.microphoneId" name="microphone-device" :disabled="publisher.active.value">
            <option value="">系统默认</option>
            <option v-for="device in publisher.devices.microphones" :key="device.id" :value="device.id">{{ device.label }}</option>
          </select>
        </label>

        <button v-if="!publisher.devices.cameras.some((device) => device.label && !device.label.startsWith('摄像头'))" class="text-button" type="button" @click="requestDevices">
          <Radio :size="15" /> 读取媒体设备
        </button>

        <p v-if="actionError || natmap.error.value" class="inline-error">{{ actionError || natmap.error.value }}</p>

        <div class="control-actions">
          <button v-if="!publisher.active.value" class="primary-button publish-button" type="button" :disabled="!canStart" @click="start">
            <Send :size="18" />
            开始推流
          </button>
          <button v-else class="secondary-button danger-button" type="button" @click="publisher.stop">
            <CircleStop :size="18" />
            停止推流
          </button>
        </div>
      </aside>
    </div>
  </section>
</template>
