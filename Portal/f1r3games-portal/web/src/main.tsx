import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./ui/App";
import { PortalProvider } from "./ui/PortalContext";
import { loadWallet } from "./wasm-loader";
import "./ui/styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <PortalProvider loadWasm={loadWallet}>
        <App />
      </PortalProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
