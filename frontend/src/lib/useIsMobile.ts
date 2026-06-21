import useMediaQuery from "@mui/material/useMediaQuery";
import type { Theme } from "@mui/material/styles";

/**
 * True on phone-width viewports (below the MUI `sm` breakpoint, 600px).
 * Used to swap dense desktop layouts (tables, inline nav) for stacked,
 * touch-friendly equivalents. `noSsr` avoids a first-paint flash — this is a
 * client-only SPA so there is no server render to match.
 */
export function useIsMobile(): boolean {
  return useMediaQuery((theme: Theme) => theme.breakpoints.down("sm"), {
    noSsr: true,
  });
}
