import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "@/components/ui/theme-toggle";
import { WorkspaceToastProvider } from "@/components/ui/workspace-toasts";
import "katex/dist/katex.min.css";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <WorkspaceToastProvider>
        <App />
      </WorkspaceToastProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
