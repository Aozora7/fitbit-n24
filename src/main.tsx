import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { AppProvider } from "./AppContext";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <AppProvider>
        <App />
      </AppProvider>
    </AuthProvider>
  </StrictMode>,
);
