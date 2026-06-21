import { Box, Card, CardContent, Typography } from "@mui/material";
import { Fragment, type ReactNode } from "react";

export interface CardField {
  label: string;
  value: ReactNode;
}

interface DataCardProps {
  /** Primary heading — usually the row's name. */
  title: ReactNode;
  /** Right-aligned element beside the title, e.g. a status chip or switch. */
  headerAction?: ReactNode;
  /** Label/value pairs rendered as a compact two-column list. */
  fields: CardField[];
  /** Button row shown at the bottom of the card. */
  actions?: ReactNode;
  onClick?: () => void;
}

/**
 * Stacked card used as the mobile equivalent of a single table row. Pages
 * render a list of these below the `sm` breakpoint instead of a wide table so
 * every field and action stays readable and tappable on a phone.
 */
export function DataCard({
  title,
  headerAction,
  fields,
  actions,
  onClick,
}: DataCardProps) {
  return (
    <Card
      variant="outlined"
      onClick={onClick}
      sx={onClick ? { cursor: "pointer" } : undefined}
    >
      <CardContent sx={{ "&:last-child": { pb: 2 } }}>
        <Box
          sx={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 1,
            mb: fields.length ? 1.5 : 0,
          }}
        >
          <Typography
            variant="subtitle1"
            fontWeight={600}
            sx={{ minWidth: 0, wordBreak: "break-word" }}
          >
            {title}
          </Typography>
          {headerAction && <Box sx={{ flexShrink: 0 }}>{headerAction}</Box>}
        </Box>

        {fields.length > 0 && (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              columnGap: 2,
              rowGap: 0.75,
              alignItems: "baseline",
            }}
          >
            {fields.map((f, i) => (
              <Fragment key={i}>
                <Typography variant="body2" color="text.secondary">
                  {f.label}
                </Typography>
                <Box sx={{ minWidth: 0, justifySelf: "end", textAlign: "right" }}>
                  {typeof f.value === "string" || typeof f.value === "number" ? (
                    <Typography variant="body2" sx={{ wordBreak: "break-word" }}>
                      {f.value}
                    </Typography>
                  ) : (
                    f.value
                  )}
                </Box>
              </Fragment>
            ))}
          </Box>
        )}

        {actions && (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mt: 2 }}>
            {actions}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
