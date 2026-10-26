import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Read with an empty prefix so WEB_PORT/API_PORT stay server-side and never ship to the bundle.
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = env.API_PORT || "3000";

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      port: Number(env.WEB_PORT || 5173),
      strictPort: true,
      proxy: {
        "/api": `http://localhost:${apiPort}`,
      },
    },
  };
});
