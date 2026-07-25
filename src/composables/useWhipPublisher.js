import { computed, onScopeDispose, reactive, ref } from 'vue'
import { useNatMap } from './useNatMap'
import { connectionLabel, waitForIceGathering } from './webrtc'

export function useWhipPublisher() {
  const { withCurrentEip } = useNatMap()
  const state = ref('idle')
  const message = ref('等待开始')
  const currentUrl = ref('')
  const devices = reactive({ cameras: [], microphones: [] })
  const stats = reactive({ bitrate: 0, fps: 0, resolution: '-', packetsSent: 0, rtt: '-' })

  let peerConnection = null
  let previewElement = null
  let previewStream = null
  let capturedStreams = []
  let audioContext = null
  let statsTimer = null
  let previous = { bytes: 0, frames: 0, time: 0 }

  function attachPreview(element) {
    previewElement = element
    if (previewElement && previewStream) previewElement.srcObject = previewStream
  }

  async function enumerateDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return devices
    const available = await navigator.mediaDevices.enumerateDevices()
    devices.cameras = available
      .filter((device) => device.kind === 'videoinput')
      .map((device, index) => ({ id: device.deviceId, label: device.label || `摄像头 ${index + 1}` }))
    devices.microphones = available
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({ id: device.deviceId, label: device.label || `麦克风 ${index + 1}` }))
    return devices
  }

  async function requestDeviceLabels() {
    const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
    permissionStream.getTracks().forEach((track) => track.stop())
    return enumerateDevices()
  }

  async function start(baseUrl, options) {
    cleanup()
    resetStats()
    state.value = 'connecting'
    message.value = options.source === 'screen' ? '正在选择共享内容' : '正在获取摄像头'

    try {
      currentUrl.value = await withCurrentEip(baseUrl)
      const media = options.source === 'screen'
        ? await captureScreen(options)
        : await captureCamera(options)

      previewStream = media
      if (previewElement) {
        previewElement.srcObject = previewStream
        await previewElement.play().catch(() => {})
      }

      peerConnection = new RTCPeerConnection({ bundlePolicy: 'max-bundle' })
      peerConnection.addEventListener('connectionstatechange', handleConnectionState)
      for (const track of media.getTracks()) {
        const sender = peerConnection.addTrack(track, media)
        if (track.kind === 'video') await setVideoBitrate(sender, options.bitrate)
      }

      const screenTrack = options.source === 'screen' ? media.getVideoTracks()[0] : null
      if (screenTrack) screenTrack.addEventListener('ended', stop, { once: true })

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
      await enumerateDevices()
      startStats()
    } catch (error) {
      cleanup()
      state.value = 'error'
      message.value = readableMediaError(error)
      throw error
    }
  }

  async function captureScreen(options) {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints(options),
      audio: Boolean(options.systemAudio),
    })
    capturedStreams.push(displayStream)

    let microphoneStream = null
    if (options.microphone) {
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: audioConstraints(options.microphoneId),
      })
      capturedStreams.push(microphoneStream)
    }

    const audioTracks = [
      ...displayStream.getAudioTracks(),
      ...(microphoneStream?.getAudioTracks() || []),
    ]
    const audioTrack = await combineAudioTracks(audioTracks)
    return new MediaStream([displayStream.getVideoTracks()[0], audioTrack])
  }

  async function captureCamera(options) {
    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...videoConstraints(options),
        ...(options.cameraId ? { deviceId: { exact: options.cameraId } } : {}),
      },
      audio: options.microphone ? audioConstraints(options.microphoneId) : false,
    })
    capturedStreams.push(cameraStream)
    const audioTrack = cameraStream.getAudioTracks()[0] || await createSilentAudioTrack()
    return new MediaStream([cameraStream.getVideoTracks()[0], audioTrack])
  }

  function videoConstraints(options) {
    return {
      width: { ideal: Number(options.width) },
      height: { ideal: Number(options.height) },
      frameRate: { ideal: Number(options.fps), max: Number(options.fps) },
    }
  }

  function audioConstraints(deviceId) {
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    }
  }

  async function combineAudioTracks(tracks) {
    if (!tracks.length) return createSilentAudioTrack()
    if (tracks.length === 1) return tracks[0]

    audioContext = new (window.AudioContext || window.webkitAudioContext)()
    const destination = audioContext.createMediaStreamDestination()
    for (const track of tracks) {
      const source = audioContext.createMediaStreamSource(new MediaStream([track]))
      source.connect(destination)
    }
    await audioContext.resume()
    return destination.stream.getAudioTracks()[0]
  }

  async function createSilentAudioTrack() {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)()
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    const destination = audioContext.createMediaStreamDestination()
    gain.gain.value = 0
    oscillator.connect(gain).connect(destination)
    oscillator.start()
    await audioContext.resume()
    return destination.stream.getAudioTracks()[0]
  }

  async function setVideoBitrate(sender, bitrateKbps) {
    const parameters = sender.getParameters()
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}]
    parameters.encodings[0].maxBitrate = Number(bitrateKbps) * 1000
    await sender.setParameters(parameters)
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
    let outboundVideo
    let selectedPair
    reports.forEach((report) => {
      if (report.type === 'outbound-rtp' && report.kind === 'video') outboundVideo = report
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) selectedPair = report
    })

    if (outboundVideo) {
      const now = performance.now()
      const seconds = Math.max((now - previous.time) / 1000, 0.001)
      stats.bitrate = Math.max(0, Math.round(((outboundVideo.bytesSent - previous.bytes) * 8) / seconds / 1000))
      const framesEncoded = outboundVideo.framesEncoded || 0
      stats.fps = Math.max(0, Math.round((framesEncoded - previous.frames) / seconds))
      stats.packetsSent = outboundVideo.packetsSent || 0
      previous = { bytes: outboundVideo.bytesSent || 0, frames: framesEncoded, time: now }
    }
    const settings = previewStream?.getVideoTracks()[0]?.getSettings()
    stats.resolution = settings?.width ? `${settings.width} × ${settings.height}` : '-'
    if (selectedPair?.currentRoundTripTime != null) stats.rtt = `${Math.round(selectedPair.currentRoundTripTime * 1000)} ms`
  }

  function stopStats() {
    if (statsTimer) window.clearInterval(statsTimer)
    statsTimer = null
  }

  function resetStats() {
    Object.assign(stats, { bitrate: 0, fps: 0, resolution: '-', packetsSent: 0, rtt: '-' })
  }

  function cleanup() {
    stopStats()
    if (peerConnection) {
      peerConnection.removeEventListener('connectionstatechange', handleConnectionState)
      peerConnection.close()
    }
    peerConnection = null
    capturedStreams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()))
    capturedStreams = []
    previewStream?.getTracks().forEach((track) => track.stop())
    previewStream = null
    if (previewElement) previewElement.srcObject = null
    if (audioContext) audioContext.close().catch(() => {})
    audioContext = null
  }

  function stop() {
    cleanup()
    resetStats()
    state.value = 'idle'
    message.value = '已停止'
    currentUrl.value = ''
  }

  onScopeDispose(cleanup)

  return {
    state,
    message,
    currentUrl,
    devices,
    stats,
    active: computed(() => ['connecting', 'connected'].includes(state.value)),
    attachPreview,
    enumerateDevices,
    requestDeviceLabels,
    start,
    stop,
  }
}

function readableMediaError(error) {
  if (error?.name === 'NotAllowedError') return '媒体权限未授予'
  if (error?.name === 'NotFoundError') return '没有找到可用设备'
  if (error?.name === 'NotReadableError') return '设备正被其他程序占用'
  return error?.message || String(error)
}
