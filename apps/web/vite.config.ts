import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  envDir: "../../",  // load .env from monorepo root
  server: { port: 19834 },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
