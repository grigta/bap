import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    // ws: agents may also connect through the dev server
    proxy: { "/api": { target: process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:3000", ws: true } },
  },
});
