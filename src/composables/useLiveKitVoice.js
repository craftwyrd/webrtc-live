import { computed, onScopeDispose, ref } from 'vue'
import { Room, RoomEvent, Track } from 'livekit-client'

export function useLiveKitVoice() {
  const state = ref('idle')
  const message = ref('语音房未连接')
  const error = ref('')
  const microphoneEnabled = ref(false)
  const participants = ref([])
  const activeSpeakerIds = ref([])

  let room = null
  let audioContainer = null
  const attachedTracks = new Map()

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
      message.value = '已连接语音房，麦克风默认关闭'
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
    currentRoom.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) attachTrack(track)
    })
    currentRoom.on(RoomEvent.TrackUnsubscribed, (track) => detachTrack(track))
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
    const elements = track.attach()
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
    try {
      const next = !microphoneEnabled.value
      await room.localParticipant.setMicrophoneEnabled(next)
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
      },
      ...remote.map((participant) => ({
        id: participant.identity,
        name: participant.name || participant.identity,
        isLocal: false,
        speaking: activeSpeakerIds.value.includes(participant.identity),
        microphoneEnabled: Array.from(participant.audioTrackPublications.values()).some((publication) => !publication.isMuted),
      })),
    ]
  }

  function disconnect(resetState = true) {
    for (const { track, elements } of attachedTracks.values()) {
      track.detach()
      elements.forEach((element) => element.remove())
    }
    attachedTracks.clear()
    if (room) room.disconnect()
    room = null
    microphoneEnabled.value = false
    activeSpeakerIds.value = []
    participants.value = []
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
    participants,
    active: computed(() => ['connecting', 'connected', 'reconnecting'].includes(state.value)),
    attachAudioContainer,
    connect,
    toggleMicrophone,
    disconnect,
  }
}
