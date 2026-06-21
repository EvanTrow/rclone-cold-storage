import MenuIcon from "@mui/icons-material/Menu";
import {
  AppBar,
  Box,
  Button,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Toolbar,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, NavLink, Navigate, Outlet, useNavigate } from "react-router-dom";
import { authApi, runsApi } from "../lib/api";
import { useIsMobile } from "../lib/useIsMobile";
import { useServerEvents } from "../lib/useServerEvents";

export function Layout() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { data: user, isLoading, isError } = useQuery({
    queryKey: ["me"],
    queryFn: authApi.me,
    retry: false,
  });

  const { data: unreadRuns } = useQuery({
    queryKey: ["runs", "unread"],
    queryFn: () => runsApi.list({ unread_only: true, status: "failed" }),
    enabled: !!user,
    refetchInterval: 60_000,
  });

  useServerEvents(!!user);

  if (isLoading) return null;
  if (isError) return <Navigate to="/login" replace />;

  const unreadCount = unreadRuns?.length ?? 0;

  async function handleLogout() {
    await authApi.logout();
    navigate("/login");
  }

  const navItems = [
    { to: "/", label: "Dashboard", end: true },
    { to: "/nodes", label: "Nodes" },
    { to: "/jobs", label: "Jobs" },
    { to: "/history", label: `History${unreadCount > 0 ? ` (${unreadCount})` : ""}` },
    { to: "/settings", label: "Settings" },
  ];

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <AppBar
        position="sticky"
        color="default"
        elevation={0}
        sx={{ borderBottom: 1, borderColor: "divider" }}
      >
        <Toolbar variant="dense" sx={{ gap: { xs: 1, md: 3 } }}>
          {isMobile && (
            <IconButton
              edge="start"
              aria-label="Open navigation"
              onClick={() => setDrawerOpen(true)}
            >
              <MenuIcon />
            </IconButton>
          )}
          <Link
            to="/"
            style={{ textDecoration: "none", color: "inherit", fontWeight: 700, fontSize: 14, flexShrink: 0 }}
          >
            rclone-cold-storage
          </Link>

          {!isMobile && (
            <>
              <Box sx={{ display: "flex", gap: 2.5, flex: 1 }}>
                {navItems.map(({ to, label, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    style={({ isActive }) => ({
                      textDecoration: "none",
                      fontSize: 14,
                      fontWeight: isActive ? 600 : undefined,
                      opacity: isActive ? 1 : 0.6,
                      color: "inherit",
                      transition: "opacity 0.15s",
                    })}
                  >
                    {label}
                  </NavLink>
                ))}
              </Box>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexShrink: 0 }}>
                <Typography variant="body2" color="text.secondary">
                  {user?.username} ({user?.role})
                </Typography>
                <Button size="small" variant="text" onClick={handleLogout}>
                  Logout
                </Button>
              </Box>
            </>
          )}

          {/* On mobile, push the unread badge / title spacing with a spacer */}
          {isMobile && <Box sx={{ flex: 1 }} />}
        </Toolbar>
      </AppBar>

      <Drawer
        anchor="left"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        PaperProps={{ sx: { width: 260 } }}
      >
        <Box sx={{ p: 2 }}>
          <Typography variant="subtitle2" fontWeight={700}>
            {user?.username}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {user?.role}
          </Typography>
        </Box>
        <Divider />
        <List sx={{ flex: 1 }}>
          {navItems.map(({ to, label, end }) => (
            <ListItemButton
              key={to}
              component={NavLink}
              to={to}
              end={end}
              onClick={() => setDrawerOpen(false)}
              sx={{
                "&.active": {
                  bgcolor: "action.selected",
                  "& .MuiListItemText-primary": { fontWeight: 600 },
                },
              }}
            >
              <ListItemText primary={label} />
            </ListItemButton>
          ))}
        </List>
        <Divider />
        <Box sx={{ p: 2 }}>
          <Button fullWidth variant="outlined" onClick={handleLogout}>
            Logout
          </Button>
        </Box>
      </Drawer>

      <Box
        component="main"
        sx={{ maxWidth: 1280, mx: "auto", px: { xs: 1.5, sm: 2 }, py: { xs: 2, sm: 4 } }}
      >
        <Outlet />
      </Box>
    </Box>
  );
}
