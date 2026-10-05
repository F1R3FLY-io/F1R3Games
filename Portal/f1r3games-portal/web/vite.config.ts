import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// In development the portal talks to f1r3games-service on :8640.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8640" } },
  build: { target: "es2022" },
  test: { environment: "jsdom", setupFiles: ["src/test/setup.ts"], testTimeout: 30000 },
});
