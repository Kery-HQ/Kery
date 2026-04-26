import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  envDir: "../../",  // load .env from monorepo root
  server: {
    port: 11113,
    proxy: {
      // Match production nginx: SPA and API may differ by host/port; relative `/api/*` must reach the backend.
      "/api": { target: "http://localhost:11112", changeOrigin: true },
    },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
