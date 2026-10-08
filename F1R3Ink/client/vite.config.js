import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Served at <entry-base>/f1r3ink/ ; the gallery renderers at preview/round.html and preview/flag.html.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, "index.html"), round: resolve(__dirname, "preview/round.html"), flag: resolve(__dirname, "preview/flag.html") },
    },
  },
  test: { environment: "jsdom", setupFiles: ["./test/setup.js"] },
});
