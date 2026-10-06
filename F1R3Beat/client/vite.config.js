import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Served at <entry-base>/f1r3beat/ ; the gallery renderers at preview/pattern.html and preview/session.html.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, "index.html"), pattern: resolve(__dirname, "preview/pattern.html"), session: resolve(__dirname, "preview/session.html") },
    },
  },
  test: { environment: "jsdom", setupFiles: ["./test/setup.js"] },
});
