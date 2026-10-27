// Vite = dev server + bundler for the React app.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    react(), // JSX support + fast refresh (edits show up without a full reload)
    tailwindcss(), // turns Tailwind classes used in the code into real CSS
  ],
  server: {
    port: 5173,
  },
});
