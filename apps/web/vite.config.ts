// Vite = dev server + bundler for the React app.
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The repo root, where the one .env file lives (this file is in apps/web/).
const ROOT_DIR = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  // Read the root .env here, in the config only. The "" prefix loads every variable, but
  // none of them reach the browser code (that would need a VITE_ prefix).
  const env = loadEnv(mode, ROOT_DIR, "");
  const apiPort = env.API_PORT;
  if (!apiPort) throw new Error("API_PORT is missing from the root .env");
  const api = `http://localhost:${apiPort}`;

  return {
    plugins: [
      react(), // JSX support + fast refresh (edits show up without a full reload)
      tailwindcss(), // turns Tailwind classes used in the code into real CSS
    ],
    server: {
      port: 5173,
      // Proxy: the page calls /videos, /search, /thumbs on ITS OWN origin (localhost:5173) and
      // Vite forwards them to the Express API. The browser sees one origin, so no CORS setup is
      // needed, and <video>/<img> tags can use the same relative paths. Range headers pass
      // through untouched, so seeking in the player still gets 206 Partial Content.
      proxy: {
        "/videos": api,
        "/search": api,
        "/thumbs": api,
      },
    },
  };
});
