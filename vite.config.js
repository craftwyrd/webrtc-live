import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), '')
  const backendOrigin = environment.VITE_BACKEND_ORIGIN || 'http://127.0.0.1:21080'

  return {
    plugins: [vue()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/healthz': backendOrigin,
        '/internal': backendOrigin,
        '/api': backendOrigin,
        '/uploads': backendOrigin,
        '/ws/presence': { target: backendOrigin, ws: true },
        '/rtc/srs-natmap.json': backendOrigin,
        '/rtc/livekit-natmap.json': backendOrigin,
        '/rtc/v1': backendOrigin,
        '/srs/api': backendOrigin,
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  }
})
