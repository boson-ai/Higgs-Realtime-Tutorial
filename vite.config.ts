import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The `/api` proxy is the reason this tutorial never configures CORS.
// The browser only ever talks to http://localhost:5173, and Vite forwards
// /api/* to the token server on :3000 behind the scenes — so as far as the
// browser is concerned every request is same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
