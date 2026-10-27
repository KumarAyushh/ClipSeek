// Browser entry point: mounts the React app into <div id="root"> from index.html.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing <div id=\"root\">");

// StrictMode runs extra checks in development (e.g. renders twice to catch side effects)
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
