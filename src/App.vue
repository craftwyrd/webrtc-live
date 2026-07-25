<script setup>
import { RadioTower, Wifi } from '@lucide/vue'
import { RouterView } from 'vue-router'
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand" aria-label="Drivod Live">
        <span class="brand-mark"><RadioTower :size="19" /></span>
        <span>Drivod Live</span>
      </div>

      <div class="service-indicator" title="SRS 服务">
        <Wifi :size="15" />
        <span>SRS online</span>
      </div>
    </header>

    <main class="page-frame">
      <RouterView />
    </main>
  </div>
</template>
