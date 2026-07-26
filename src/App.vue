<script setup>
import { computed } from 'vue'
import { RadioTower, Wifi } from '@lucide/vue'
import { RouterView, useRoute } from 'vue-router'

const route = useRoute()
const immersiveMode = computed(() => route.path === '/admin' || route.path === '/watch' || route.path.startsWith('/rtc/whep'))
</script>

<template>
  <div class="app-shell">
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <header v-if="!immersiveMode" class="topbar">
      <div class="brand" aria-label="CraftWyrd Live">
        <span class="brand-mark"><RadioTower :size="19" /></span>
        <span>CraftWyrd Live</span>
      </div>

      <div class="service-indicator" title="SRS 服务">
        <Wifi :size="15" />
        <span>SRS online</span>
      </div>
    </header>

    <main id="main-content" class="page-frame" :class="{ 'watch-page-frame': immersiveMode }">
      <RouterView />
    </main>
  </div>
</template>
