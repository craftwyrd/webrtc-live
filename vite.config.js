import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/healthz': 'http://127.0.0.1:21080',
      '/internal': 'http://127.0.0.1:21080',
      '/rtc/natmap.json': 'http://127.0.0.1:21080',
      '/rtc/v1': 'http://127.0.0.1:21080',
      '/srs/api': 'http://127.0.0.1:21080',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
