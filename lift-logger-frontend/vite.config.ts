/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['fonts/*.woff2', 'icons/*.png'],
      manifest: {
        name: 'Lift Logger',
        short_name: 'Lift Logger',
        description: 'Sweat-on-glass workout tracker',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: /\/api\//,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /\/fonts\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'fonts',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  build: {
    outDir: '../lift-logger-api/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Listen on all interfaces so `tailscale serve` (which proxies from the
    // tailnet IP, not loopback) can reach the dev server. Harmless on plain
    // localhost dev — the loopback request still binds.
    host: true,
    // Vite blocks Host headers it doesn't recognize. Allow this Mac's tailnet
    // hostname so iPhone-over-Tailscale requests aren't rejected as XSS.
    allowedHosts: ['.tail2a85a6.ts.net'],
    proxy: {
      // Port can be overridden via VITE_API_PORT if needed.
      '/api': `http://localhost:${process.env.VITE_API_PORT ?? '3000'}`,
    },
    // When loading the dev server through Tailscale Serve (HTTPS on :443),
    // the browser-side HMR websocket has to dial back to :443, not the
    // default :5173 (which isn't exposed). TAILSCALE_DEV=1 flips that. Plain
    // localhost dev leaves `hmr` undefined so Vite uses its sensible default.
    ...(process.env.TAILSCALE_DEV === '1'
      ? { hmr: { clientPort: 443, protocol: 'wss' } }
      : {}),
  },
  test: {
    globals: true,
    environment: 'node',
  },
})
