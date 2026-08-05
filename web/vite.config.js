import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/candybong/",
  plugins: [react()],
  test: {
    environment: "jsdom",
    restoreMocks: true,
  },
});
