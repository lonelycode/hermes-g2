import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// `host: true` lets the phone reach the dev server over LAN / Tailscale for QR sideload.
// Set VITE_HMR_HOST to your LAN/tailnet IP if hot reload keeps disconnecting on device.
//
// Production builds deliberately ignore every .env file: anything in a released .ehpk can be
// extracted, so gateway URLs and keys must come from the phone settings page, never the bundle.
// (VITE_* variables set in the shell are still honoured for intentional, local-only builds.)
export default defineConfig(({ command }) => ({
  envDir: command === 'build' ? fileURLToPath(new URL('./.env-none/', import.meta.url)) : undefined,
  server: {
    host: true,
    port: 5173,
    hmr: process.env.VITE_HMR_HOST ? { host: process.env.VITE_HMR_HOST } : undefined,
  },
  build: { target: 'esnext' },
}))
