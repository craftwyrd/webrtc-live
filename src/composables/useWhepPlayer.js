import { computed, onScopeDispose, reactive, ref } from 'vue'
import { useNatMap } from './useNatMap'
import { connectionLabel, waitForIceGathering } from './webrtc'

export function useWhepPlayer() {
  const { withCurrentEip } = useNatMap()
  const state = ref('idle')
  const message = ref('等待开始')
  const currentUrl = ref('')
  const stats = reactive({ bitrate: 0, fps: 0, resolution: '-', packetsLost: 0, rtt: '-' })
  let peerConnection = null
  let mediaStream = null
  let videoElement = null
  let statsTimer = null
  let previous = { bytes: 0, frames: 0, time: 0 }

  function attachVideo(element) {
    videoElement = element
    if (videoElement && mediaStream) videoElement.srcObject = mediaStream
  }

  async function start(baseUrl) {
    stop()
    state.value = 'connecting'
    message.value = '正在获取 IPv4 直连地址'

    try {
      currentUrl.value = await withCurrentEip(baseUrl)
      mediaStream = new MediaStream()
      if (videoElement) videoElement.srcObject = mediaStream

      peerConnection = new RTCPeerConnection({ bundlePolicy: 'max-bundle' })
      peerConnection.addTransceiver('audio', { direction: 'recvonly' })
      peerConnection.addTransceiver('video', { direction: 'recvonly' })
      peerConnection.addEventListener('track', ({ track }) => {
        if (!mediaStream.getTracks().some((current) => current.id === track.id)) {
          mediaStream.addTrack(track)
        }
        if (videoElement) videoElement.play().catch(() => {})
      })
      peerConnection.addEventListener('connectionstatechange', handleConnectionState)

      const offer = await peerConnection.createOffer()
      await peerConnection.setLocalDescription(offer)
      await waitForIceGathering(peerConnection)

      message.value = '正在与 SRS 协商'
      const response = await fetch(currentUrl.value, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
        body: peerConnection.localDescription.sdp,
      })
      if (!response.ok) throw new Error(`SRS 返回 ${response.status}`)

      await peerConnection.setRemoteDescription({ type: 'answer', sdp: await response.text() })
      startStats()
    } catch (error) {
      state.value = 'error'
      message.value = error.message || String(error)
      closePeerConnection()
      throw error
    }
  }

  function handleConnectionState() {
    if (!peerConnection) return
    const next = peerConnection.connectionState
    state.value = next
    message.value = connectionLabel(next)
    if (next === 'failed' || next === 'closed') stopStats()
  }

  function startStats() {
    stopStats()
    previous = { bytes: 0, frames: 0, time: performance.now() }
    statsTimer = window.setInterval(readStats, 1000)
  }

  async function readStats() {
    if (!peerConnection) return
    const reports = await peerConnection.getStats()
    let inboundVideo
    let selectedPair
    reports.forEach((report) => {
      if (report.type === 'inbound-rtp' && report.kind === 'video') inboundVideo = report
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) selectedPair = report
    })

    if (inboundVideo) {
      const now = performance.now()
      const seconds = Math.max((now - previous.time) / 1000, 0.001)
      stats.bitrate = Math.max(0, Math.round(((inboundVideo.bytesReceived - previous.bytes) * 8) / seconds / 1000))
      const framesDecoded = inboundVideo.framesDecoded || 0
      stats.fps = Math.max(0, Math.round((framesDecoded - previous.frames) / seconds))
      stats.packetsLost = inboundVideo.packetsLost || 0
      previous = { bytes: inboundVideo.bytesReceived || 0, frames: framesDecoded, time: now }
    }
    if (videoElement?.videoWidth) stats.resolution = `${videoElement.videoWidth} × ${videoElement.videoHeight}`
    if (selectedPair?.currentRoundTripTime != null) stats.rtt = `${Math.round(selectedPair.currentRoundTripTime * 1000)} ms`
  }

  function stopStats() {
    if (statsTimer) window.clearInterval(statsTimer)
    statsTimer = null
  }

  function closePeerConnection() {
    stopStats()
    if (peerConnection) {
      peerConnection.removeEventListener('connectionstatechange', handleConnectionState)
      peerConnection.close()
    }
    peerConnection = null
    if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop())
    mediaStream = null
    if (videoElement) videoElement.srcObject = null
  }

  function stop() {
    closePeerConnection()
    state.value = 'idle'
    message.value = '已停止'
    currentUrl.value = ''
  }

  onScopeDispose(closePeerConnection)

  return {
    state,
    message,
    currentUrl,
    stats,
    active: computed(() => ['connecting', 'connected'].includes(state.value)),
    attachVideo,
    start,
    stop,
  }
}
