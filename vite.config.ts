import { defineConfig } from 'vite'

// `host: true` lets the phone reach the dev server over LAN / Tailscale for QR sideload.
// Set VITE_HMR_HOST to your LAN/tailnet IP if hot reload keeps disconnecting on device.
export default defineConfig({
  server: {
    host: true,
    port: 5173,
    hmr: process.env.VITE_HMR_HOST ? { host: process.env.VITE_HMR_HOST } : undefined,
  },
  build: { target: 'esnext' },
})
