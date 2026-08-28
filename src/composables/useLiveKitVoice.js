import { computed, onScopeDispose, ref } from 'vue'
import { Room, RoomEvent, Track } from 'livekit-client'

export function useLiveKitVoice() {
  const state = ref('idle')
  const message = ref('语音房未连接')
  const error = ref('')
  const microphoneEnabled = ref(false)
  const microphoneBlocked = ref(false)
  const microphoneGain = ref(1)
  const roomVolume = ref(1)
  const participants = ref([])
  const activeSpeakerIds = ref([])

  let room = null
  let audioContainer = null
  let microphoneProcessor = null
  let lastAudibleRoomVolume = 1
  const attachedTracks = new Map()
  let participantVolumes = {}
  let lastAudibleParticipantVolumes = {}

  function attachAudioContainer(element) {
    audioContainer = element
    if (!audioContainer) return
    for (const entry of attachedTracks.values()) {
      for (const mediaElement of entry.elements) audioContainer.appendChild(mediaElement)
    }
  }

  async function connect(options) {
    disconnect()
    state.value = 'connecting'
    message.value = '正在连接语音房'
    error.value = ''

    try {
      const response = await fetch('/api/voice/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          app: options.app,
          stream: options.stream,
          identity: options.identity,
          name: options.name,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || `语音服务返回 ${response.status}`)
      if (!payload.url || !payload.token) throw new Error('LiveKit 地址或 Token 未配置')

      room = new Room({ adaptiveStream: false, dynacast: false })
      bindRoomEvents(room)
      await room.connect(payload.url, payload.token, { autoSubscribe: true })
      state.value = 'connected'
      syncLocalMicrophonePermission()
      if (!microphoneBlocked.value) message.value = '已连接语音房，麦克风默认关闭'
      refreshParticipants()
    } catch (connectError) {
      state.value = 'error'
      message.value = connectError.message || String(connectError)
      error.value = message.value
      disconnect(false)
      throw connectError
    }
  }

  function bindRoomEvents(currentRoom) {
    currentRoom.on(RoomEvent.ParticipantConnected, refreshParticipants)
    currentRoom.on(RoomEvent.ParticipantDisconnected, refreshParticipants)
    currentRoom.on(RoomEvent.ParticipantNameChanged, refreshParticipants)
    currentRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      activeSpeakerIds.value = speakers.map((speaker) => speaker.identity)
      refreshParticipants()
    })
    currentRoom.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind === Track.Kind.Audio) {
        attachTrack(track)
        applyRemoteVolume(participant)
      }
    })
    currentRoom.on(RoomEvent.TrackUnsubscribed, (track) => detachTrack(track))
    currentRoom.on(RoomEvent.TrackMuted, refreshParticipants)
    currentRoom.on(RoomEvent.TrackUnmuted, refreshParticipants)
    currentRoom.on(RoomEvent.ParticipantPermissionsChanged, (_previousPermissions, participant) => {
      if (participant === currentRoom.localParticipant) syncLocalMicrophonePermission()
      else refreshParticipants()
    })
    currentRoom.on(RoomEvent.ConnectionStateChanged, (connectionState) => {
      if (connectionState === 'reconnecting') {
        state.value = 'reconnecting'
        message.value = '语音房正在重连…'
      } else if (connectionState === 'connected') {
        state.value = 'connected'
        message.value = '语音房已连接'
      }
    })
    currentRoom.on(RoomEvent.Disconnected, () => {
      if (state.value !== 'idle') {
        state.value = 'idle'
        message.value = '已离开语音房'
      }
      refreshParticipants()
    })
  }

  function attachTrack(track) {
    detachTrack(track)
    const attachedElement = track.attach()
    const elements = Array.isArray(attachedElement) ? attachedElement : [attachedElement]
    elements.forEach((element) => {
      element.autoplay = true
      element.playsInline = true
      element.setAttribute('aria-hidden', 'true')
      element.className = 'girl-voice-audio-element'
      audioContainer?.appendChild(element)
    })
    attachedTracks.set(track.sid || track.mediaStreamTrack?.id, { track, elements })
  }

  function detachTrack(track) {
    const key = track.sid || track.mediaStreamTrack?.id
    const entry = attachedTracks.get(key)
    if (entry) {
      entry.track.detach()
      entry.elements.forEach((element) => element.remove())
      attachedTracks.delete(key)
    } else {
      track.detach().forEach((element) => element.remove())
    }
  }

  async function toggleMicrophone() {
    if (!room?.localParticipant) return false
    if (microphoneBlocked.value) {
      message.value = '主播已禁止你开麦'
      return false
    }
    try {
      const next = !microphoneEnabled.value
      if (next) ensureMicrophoneCaptureAvailable()
      const publication = await room.localParticipant.setMicrophoneEnabled(next, next ? {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      } : undefined)
      if (next) await enableMicrophoneGain(publication?.track)
      microphoneEnabled.value = next
      message.value = next ? '麦克风已开启' : '麦克风已关闭'
      refreshParticipants()
      return next
    } catch (toggleError) {
      error.value = toggleError.message || String(toggleError)
      message.value = error.value
      return microphoneEnabled.value
    }
  }

  async function enableMicrophoneGain(localTrack) {
    if (microphoneProcessor || typeof localTrack?.setProcessor !== 'function') return
    microphoneProcessor = createMicrophoneGainProcessor(microphoneGain.value)
    try {
      await localTrack.setProcessor(microphoneProcessor)
    } catch (processorError) {
      microphoneProcessor = null
      throw processorError
    }
  }

  function setMicrophoneGain(value) {
    microphoneGain.value = clampVolume(value, 2)
    microphoneProcessor?.setGain(microphoneGain.value)
  }

  function setRoomVolume(value) {
    roomVolume.value = clampVolume(value)
    if (roomVolume.value > 0) lastAudibleRoomVolume = roomVolume.value
    applyAllRemoteVolumes()
  }

  function toggleRoomMuted() {
    if (roomVolume.value > 0) {
      lastAudibleRoomVolume = roomVolume.value
      setRoomVolume(0)
    } else {
      setRoomVolume(lastAudibleRoomVolume || 1)
    }
  }

  function setParticipantVolume(identity, value) {
    const volume = clampVolume(value)
    participantVolumes = { ...participantVolumes, [identity]: volume }
    if (volume > 0) lastAudibleParticipantVolumes = { ...lastAudibleParticipantVolumes, [identity]: volume }
    const participant = room?.remoteParticipants.get(identity)
    if (participant) applyRemoteVolume(participant)
    refreshParticipants()
  }

  function toggleParticipantMuted(identity) {
    const volume = participantVolumes[identity] ?? 1
    if (volume > 0) {
      lastAudibleParticipantVolumes = { ...lastAudibleParticipantVolumes, [identity]: volume }
      setParticipantVolume(identity, 0)
    } else {
      setParticipantVolume(identity, lastAudibleParticipantVolumes[identity] || 1)
    }
  }

  function applyAllRemoteVolumes() {
    if (!room) return
    for (const participant of room.remoteParticipants.values()) applyRemoteVolume(participant)
  }

  function applyRemoteVolume(participant) {
    if (!participant) return
    const participantVolume = participantVolumes[participant.identity] ?? 1
    participant.setVolume(roomVolume.value * participantVolume)
  }

  function syncLocalMicrophonePermission() {
    const blocked = room?.localParticipant?.permissions?.canPublish === false
    const wasBlocked = microphoneBlocked.value
    microphoneBlocked.value = blocked
    if (blocked) {
      microphoneEnabled.value = false
      message.value = '主播已禁止你开麦'
      room?.localParticipant?.setMicrophoneEnabled(false).catch(() => {})
    } else if (wasBlocked) {
      message.value = '主播已解除禁麦，可以开麦'
    }
    refreshParticipants()
  }

  function refreshParticipants() {
    if (!room) {
      participants.value = []
      return
    }
    const local = room.localParticipant
    const remote = Array.from(room.remoteParticipants.values())
    participants.value = [
      {
        id: local.identity,
        name: local.name || local.identity,
        isLocal: true,
        speaking: activeSpeakerIds.value.includes(local.identity),
        microphoneEnabled: microphoneEnabled.value,
        microphoneBlocked: microphoneBlocked.value,
        microphoneGain: microphoneGain.value,
      },
      ...remote.map((participant) => ({
        id: participant.identity,
        name: participant.name || participant.identity,
        isLocal: false,
        speaking: activeSpeakerIds.value.includes(participant.identity),
        microphoneEnabled: Array.from(participant.audioTrackPublications.values()).some((publication) => !publication.isMuted),
        volume: participantVolumes[participant.identity] ?? 1,
      })),
    ]
  }

  function disconnect(resetState = true) {
    for (const { track, elements } of attachedTracks.values()) {
      track.detach()
      elements.forEach((element) => element.remove())
    }
    attachedTracks.clear()
    microphoneProcessor?.destroy().catch(() => {})
    microphoneProcessor = null
    if (room) room.disconnect()
    room = null
    microphoneEnabled.value = false
    microphoneBlocked.value = false
    activeSpeakerIds.value = []
    participants.value = []
    participantVolumes = {}
    lastAudibleParticipantVolumes = {}
    if (resetState) {
      state.value = 'idle'
      message.value = '语音房未连接'
      error.value = ''
    }
  }

  onScopeDispose(() => disconnect(false))

  return {
    state,
    message,
    error,
    microphoneEnabled,
    microphoneBlocked,
    microphoneGain,
    roomVolume,
    participants,
    active: computed(() => ['connecting', 'connected', 'reconnecting'].includes(state.value)),
    attachAudioContainer,
    connect,
    toggleMicrophone,
    setMicrophoneGain,
    setRoomVolume,
    toggleRoomMuted,
    setParticipantVolume,
    toggleParticipantMuted,
    disconnect,
  }
}

function createMicrophoneGainProcessor(initialGain) {
  let source
  let gain
  let destination
  let context

  const setGain = (value) => {
    if (!gain || !context) return
    gain.gain.setTargetAtTime(clampVolume(value, 2), context.currentTime, 0.015)
  }

  const setup = async ({ track, audioContext }) => {
    context = audioContext
    source = context.createMediaStreamSource(new MediaStream([track]))
    gain = context.createGain()
    destination = context.createMediaStreamDestination()
    source.connect(gain).connect(destination)
    setGain(initialGain)
    await context.resume().catch(() => {})
    processor.processedTrack = destination.stream.getAudioTracks()[0]
  }

  const processor = {
    name: 'microphone-gain',
    processedTrack: undefined,
    init: setup,
    async restart(options) {
      await processor.destroy()
      await setup(options)
    },
    async destroy() {
      source?.disconnect()
      gain?.disconnect()
      destination?.disconnect()
      processor.processedTrack?.stop()
      source = null
      gain = null
      destination = null
      context = null
      processor.processedTrack = undefined
    },
    setGain,
  }

  return processor
}

function clampVolume(value, maximum = 1) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 1
  return Math.min(maximum, Math.max(0, number))
}

function ensureMicrophoneCaptureAvailable() {
  const mediaDevices = globalThis.navigator?.mediaDevices
  if (globalThis.isSecureContext === false || typeof mediaDevices?.getUserMedia !== 'function') {
    throw new Error('手机麦克风需要通过 HTTPS 页面访问。请使用 https 域名，不要使用 http 内网 IP 或本地开发地址。')
  }
}
