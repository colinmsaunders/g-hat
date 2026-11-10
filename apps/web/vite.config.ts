import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "apps/web",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/config.json": "http://127.0.0.1:3001",
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
