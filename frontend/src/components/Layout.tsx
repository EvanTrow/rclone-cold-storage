import { AppBar, Box, Button, Toolbar, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { Link, NavLink, Navigate, Outlet, useNavigate } from "react-router-dom";
import { authApi, runsApi } from "../lib/api";

export function Layout() {
  const navigate = useNavigate();
  const { data: user, isLoading, isError } = useQuery({
    queryKey: ["me"],
    queryFn: authApi.me,
    retry: false,
  });

  const { data: unreadRuns } = useQuery({
    queryKey: ["runs", "unread"],
    queryFn: () => runsApi.list({ unread_only: true }),
    enabled: !!user,
    refetchInterval: 30_000,
  });

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
        <Toolbar variant="dense" sx={{ gap: 3 }}>
          <Link
            to="/"
            style={{ textDecoration: "none", color: "inherit", fontWeight: 700, fontSize: 14, flexShrink: 0 }}
          >
            rclone-cold-storage
          </Link>
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
        </Toolbar>
      </AppBar>

      <Box component="main" sx={{ maxWidth: 1280, mx: "auto", px: 2, py: 4 }}>
        <Outlet />
      </Box>
    </Box>
  );
}
