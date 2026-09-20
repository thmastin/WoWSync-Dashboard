import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev proxy targets the API server by its IPv4 loopback address (the
// server binds 127.0.0.1 by default) and follows PORT like the server does.
const apiPort = process.env.PORT?.trim() || "4173";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
  build: {
    outDir: "dist",
  },
});
