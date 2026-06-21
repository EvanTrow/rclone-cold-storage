import CloseIcon from "@mui/icons-material/Close";
import { createTheme, CssBaseline, IconButton, ThemeProvider } from "@mui/material";
import useMediaQuery from "@mui/material/useMediaQuery";
import { QueryClientProvider } from "@tanstack/react-query";
import { closeSnackbar, SnackbarProvider } from "notistack";
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
      <SnackbarProvider
        maxSnack={3}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        autoHideDuration={8000}
        action={(snackbarId) => (
          <IconButton
            size="small"
            color="inherit"
            aria-label="Dismiss"
            onClick={() => closeSnackbar(snackbarId)}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        )}
      >
        <RouterProvider router={router} />
      </SnackbarProvider>
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
