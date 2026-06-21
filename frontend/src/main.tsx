import { createTheme, CssBaseline, ThemeProvider } from "@mui/material";
import useMediaQuery from "@mui/material/useMediaQuery";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { queryClient } from "./lib/queryClient";
import { router } from "./router";
import "./styles.css";

function App() {
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)", { noSsr: true });
  const theme = useMemo(
    () =>
      createTheme({
        palette: { mode: prefersDark ? "dark" : "light" },
        typography: {
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        },
      }),
    [prefersDark],
  );
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <RouterProvider router={router} />
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
