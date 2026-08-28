import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/healthz': 'http://127.0.0.1:21080',
      '/internal': 'http://127.0.0.1:21080',
      '/api': 'http://127.0.0.1:21080',
      '/uploads': 'http://127.0.0.1:21080',
      '/ws/presence': { target: 'ws://127.0.0.1:21080', ws: true },
      '/rtc/srs-natmap.json': 'http://127.0.0.1:21080',
      '/rtc/livekit-natmap.json': 'http://127.0.0.1:21080',
      '/rtc/v1': 'http://127.0.0.1:21080',
      '/srs/api': 'http://127.0.0.1:21080',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
