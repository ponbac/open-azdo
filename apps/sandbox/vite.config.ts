import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 4317,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4318,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
})
