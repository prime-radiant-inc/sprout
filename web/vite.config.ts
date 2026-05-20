import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@host": resolve(__dirname, "../src/host"),
      "@kernel": resolve(__dirname, "../src/kernel"),
      "@shared": resolve(__dirname, "../src/shared"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:7777",
    },
  },
});
