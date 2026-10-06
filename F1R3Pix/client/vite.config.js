import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Served at <entry-base>/f1r3pix/ ; the gallery renderer at preview/canvas.html.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: { input: { main: resolve(__dirname, "index.html"), canvas: resolve(__dirname, "preview/canvas.html") } },
  },
  test: { environment: "jsdom", setupFiles: ["./test/setup.js"] },
});
