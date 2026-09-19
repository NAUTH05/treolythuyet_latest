import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const clientDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: {
    alias: {
      'socket.io-client': 'socket.io-client/dist/socket.io.js',
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
  build: {
    // Express serves path.join(__dirname, 'public') from the repository root.
    // Resolve from this config file so the output path never depends on cwd.
    outDir: path.resolve(clientDir, '..', 'public'),
    emptyOutDir: true,
  },
})
