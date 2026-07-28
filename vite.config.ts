import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  server: { proxy: { "/api": "http://localhost:8787" } },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Зачётка — подготовка к экзамену",
        short_name: "Зачётка",
        description: "Тесты, письменные ответы и задачи по программированию",
        theme_color: "#171b23",
        background_color: "#f5f2e9",
        display: "standalone",
        start_url: "/",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }]
      }
    })
  ]
});
