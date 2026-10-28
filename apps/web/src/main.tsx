import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmProvider } from "@/components/confirm";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyTheme, storedTheme } from "@/lib/theme";
import { router } from "./router";
import "./index.css";

applyTheme(storedTheme());
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={300}>
        <Toaster>
          <ConfirmProvider>
            <RouterProvider router={router} />
          </ConfirmProvider>
        </Toaster>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
