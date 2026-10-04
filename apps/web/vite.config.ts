import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      // MCP + its OAuth server (Pro). Not /oauth/consent: that page is the SPA's.
      "/mcp": { target: "http://localhost:3000", changeOrigin: true },
      "/.well-known": { target: "http://localhost:3000", changeOrigin: true },
      "/oauth/authorize": { target: "http://localhost:3000", changeOrigin: true },
      "/oauth/token": { target: "http://localhost:3000", changeOrigin: true },
      "/oauth/register": { target: "http://localhost:3000", changeOrigin: true },
      "/oauth/revoke": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
