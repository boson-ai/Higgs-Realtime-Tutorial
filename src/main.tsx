import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// StrictMode is left ON deliberately. In development it mounts every component
// twice, which is exactly the condition that breaks a naive WebSocket connect
// (see Part 1 — "StrictMode opens two sockets"). Better to hit that on your
// own machine than to leave it lurking.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
