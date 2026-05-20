import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
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
