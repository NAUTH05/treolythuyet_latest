import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  base: '/lythuyet/',
  resolve: {
    alias: {
      'socket.io-client': 'socket.io-client/dist/socket.io.js',
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/lythuyet/api': {
        target: 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/lythuyet/, ''),
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'public',
    emptyOutDir: true,
  },
})
