import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  envDir: "../../",  // load .env from monorepo root
  server: { port: 5173 }
});
