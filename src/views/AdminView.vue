<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ArrowLeft, Check, Heart, Plus, Radio, RefreshCw, Save, Settings2, Sparkles, UserRound } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { createDefaultRoom, fetchRoom, fetchRooms, roomColors, roomKey, saveRoom } from '../composables/useRoomDirectory'
import '../admin.css'

const rooms = ref([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const selection = reactive({ app: 'live', stream: 'livestream' })
const draft = reactive(createDefaultRoom())

const selectedKey = computed(() => roomKey(selection.app, selection.stream))
const watchLocation = computed(() => ({ path: '/watch', query: { app: selection.app.trim(), stream: selection.stream.trim() } }))
const avatarLetter = computed(() => Array.from(draft.host.name.trim() || '主')[0])

onMounted(async () => {
  await refreshRooms()
  await loadSelectedRoom()
})

async function refreshRooms() {
  loading.value = true
  error.value = ''
  try {
    rooms.value = await fetchRooms()
  } catch (reason) {
    error.value = reason.message || String(reason)
  } finally {
    loading.value = false
  }
}

async function loadSelectedRoom() {
  loading.value = true
  error.value = ''
  notice.value = ''
  try {
    const room = await fetchRoom(selection.app, selection.stream)
    hydrateDraft(room || createDefaultRoom(selection.app, selection.stream))
    if (!room?.configured) notice.value = '这是一个尚未保存的新房间'
  } catch (reason) {
    error.value = translateError(reason.message || String(reason))
  } finally {
    loading.value = false
  }
}

function selectRoom(room) {
  selection.app = room.app
  selection.stream = room.stream
  hydrateDraft(room)
  error.value = ''
  notice.value = ''
}

function newRoom() {
  selection.app = 'live'
  selection.stream = ''
  hydrateDraft(createDefaultRoom('live', 'new-stream'))
  draft.stream = ''
  draft.title = ''
  draft.description = ''
  error.value = ''
  notice.value = '填写应用名和流名称后保存新房间'
}

async function submitRoom() {
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const saved = await saveRoom(selection.app, selection.stream, {
      title: draft.title,
      description: draft.description,
      host: { name: draft.host.name, color: draft.host.color },
    })
    hydrateDraft(saved)
    await refreshRooms()
    notice.value = '直播间资料已保存'
  } catch (reason) {
    error.value = translateError(reason.message || String(reason))
  } finally {
    saving.value = false
  }
}

function hydrateDraft(room) {
  Object.assign(draft, room)
  Object.assign(draft.host, room.host)
}

function translateError(message) {
  if (/app must use/.test(message)) return '应用名需要使用字母、数字、点、下划线或连字符'
  if (/stream must use/.test(message)) return '流名称需要使用字母、数字、点、下划线或连字符'
  if (/title must use/.test(message)) return '直播标题需要填写，最多 80 个字符'
  if (/description must use/.test(message)) return '直播描述最多 240 个字符'
  if (/host name must use/.test(message)) return '主播名称需要填写，最多 32 个字符'
  return message
}
</script>

<template>
  <section class="admin-page">
    <div class="admin-decoration" aria-hidden="true"><Sparkles /><Heart fill="currentColor" /></div>
    <div class="admin-shell">
      <header class="admin-topbar">
        <div class="admin-brand">
          <span><Settings2 :size="19" /></span>
          <div><strong>直播间管理</strong><small>Room Atelier ✿</small></div>
        </div>
        <RouterLink class="admin-watch-link" :to="watchLocation"><ArrowLeft :size="16" />返回观看页</RouterLink>
      </header>

      <div class="admin-heading">
        <div>
          <span class="admin-kicker"><Radio :size="13" /> ROOM DIRECTORY</span>
          <h1>为每一路直播准备自己的门牌</h1>
          <p>应用名与流名称共同确定房间，OBS 推流地址保持原样。</p>
        </div>
        <div class="admin-room-key"><small>当前房间</small><strong>{{ selectedKey }}</strong></div>
      </div>

      <div class="admin-layout">
        <aside class="admin-room-rail" aria-label="直播间列表">
          <div class="admin-rail-head">
            <div><strong>已配置房间</strong><span>{{ rooms.length }} 个</span></div>
            <button type="button" title="新建房间" aria-label="新建房间" @click="newRoom"><Plus :size="17" /></button>
          </div>
          <div v-if="rooms.length" class="admin-room-list">
            <button v-for="room in rooms" :key="room.id" type="button" :class="{ active: room.id === selectedKey }" @click="selectRoom(room)">
              <span class="admin-list-avatar" :data-color="room.host.color">{{ room.host.avatar }}</span>
              <span><strong>{{ room.title }}</strong><small>{{ room.id }} · {{ room.host.name }}</small></span>
            </button>
          </div>
          <div v-else class="admin-empty-room"><Heart :size="24" /><span>还没有保存过房间</span></div>
          <button class="admin-refresh-button" type="button" :disabled="loading" @click="refreshRooms"><RefreshCw :size="14" :class="{ spinning: loading }" />刷新列表</button>
        </aside>

        <form class="admin-editor" @submit.prevent="submitRoom">
          <header class="admin-editor-head">
            <div><span>ROOM PROFILE</span><h2>直播间资料</h2></div>
            <span class="admin-save-state" :class="{ success: notice && !error }"><Check v-if="notice && !error" :size="14" />{{ error || notice || '等待编辑' }}</span>
          </header>

          <div class="admin-key-fields">
            <label><span>应用名 <small>OBS / SRS app</small></span><input v-model.trim="selection.app" name="room-app" autocomplete="off" spellcheck="false" required></label>
            <label><span>流名称 <small>OBS / SRS stream</small></span><input v-model.trim="selection.stream" name="room-stream" autocomplete="off" spellcheck="false" required></label>
            <button type="button" :disabled="loading" @click="loadSelectedRoom">读取</button>
          </div>

          <div class="admin-divider"><span>观众会看到这些内容</span></div>

          <label class="admin-field"><span>直播标题 <small>{{ draft.title.length }} / 80</small></span><input v-model="draft.title" name="room-title" maxlength="80" autocomplete="off" placeholder="例如：今晚继续推《双人成行》…" required></label>
          <label class="admin-field"><span>直播描述 <small>{{ draft.description.length }} / 240</small></span><textarea v-model="draft.description" name="room-description" maxlength="240" rows="4" autocomplete="off" placeholder="写一点今晚的安排或房间约定…" /></label>

          <div class="admin-host-section">
            <div class="admin-host-preview">
              <span class="admin-host-avatar" :data-color="draft.host.color">{{ avatarLetter }}</span>
              <div><small>本房间主播</small><strong>{{ draft.host.name || '等待填写' }}</strong><span>{{ selectedKey }}</span></div>
            </div>
            <div class="admin-host-fields">
              <label class="admin-field"><span><UserRound :size="14" />主播显示名 <small>{{ draft.host.name.length }} / 32</small></span><input v-model="draft.host.name" name="host-name" maxlength="32" autocomplete="off" spellcheck="false" placeholder="例如：CraftWyrd…" required></label>
              <fieldset><legend>主播头像配色</legend><div><button v-for="color in roomColors" :key="color.id" type="button" :title="color.label" :aria-label="color.label" :aria-pressed="draft.host.color === color.id" :data-color="color.id" @click="draft.host.color = color.id" /></div></fieldset>
            </div>
          </div>

          <p v-if="error" class="admin-error" role="alert">{{ error }}</p>
          <footer class="admin-actions">
            <RouterLink :to="watchLocation">预览观看页</RouterLink>
            <button type="submit" :disabled="saving"><Save :size="16" />{{ saving ? '保存中…' : '保存直播间' }}</button>
          </footer>
        </form>
      </div>
    </div>
  </section>
</template>
