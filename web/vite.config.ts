import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, /api is proxied to a running k2ctl backend (default :8085).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: process.env.K2CTL_BACKEND || 'http://localhost:8085', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
})
