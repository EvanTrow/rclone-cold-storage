import CloseIcon from "@mui/icons-material/Close";
import {
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataCard } from "../components/DataCard";
import { settingsApi, type ApiKeyRecord, type UserRecord } from "../lib/api";
import { useIsMobile } from "../lib/useIsMobile";

// ─── General tab ──────────────────────────────────────────────────────────────

function GeneralTab() {
  const qc = useQueryClient();
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: settingsApi.get,
  });

  const saveMut = useMutation({
    mutationFn: () => settingsApi.update(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      setDirty(false);
    },
  });

  const testMut = useMutation({ mutationFn: settingsApi.testWebhook });

  function field(key: string) {
    return form[key] ?? settings?.[key] ?? "";
  }

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
          gap: 2,
          maxWidth: 640,
        }}
      >
        <TextField
          label="WoL broadcast address"
          value={field("wol_broadcast")}
          onChange={(e) => set("wol_broadcast", e.target.value)}
          placeholder="255.255.255.255"
          size="small"
          fullWidth
        />
        <TextField
          label="WoL max retries"
          type="number"
          value={field("wol_max_retries")}
          onChange={(e) => set("wol_max_retries", e.target.value)}
          size="small"
          fullWidth
        />
        <TextField
          label="Session expiry (days)"
          type="number"
          value={field("session_expiry_days")}
          onChange={(e) => set("session_expiry_days", e.target.value)}
          size="small"
          fullWidth
        />
        <TextField
          label="Cache max depth"
          type="number"
          value={field("cache_max_depth")}
          onChange={(e) => set("cache_max_depth", e.target.value)}
          size="small"
          fullWidth
        />
      </Box>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, maxWidth: 480 }}>
        <Typography variant="body2" fontWeight={600}>
          Idle shutdown
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={field("idle_shutdown_enabled") === "true"}
              onChange={(e) => set("idle_shutdown_enabled", e.target.checked ? "true" : "false")}
              size="small"
            />
          }
          label="Shut down node when idle"
        />
        <TextField
          label="Idle timeout (minutes)"
          type="number"
          value={Math.round(parseInt(field("idle_shutdown_timeout") || "3600") / 60)}
          onChange={(e) => set("idle_shutdown_timeout", String(parseInt(e.target.value || "60") * 60))}
          size="small"
          disabled={field("idle_shutdown_enabled") !== "true"}
          sx={{ maxWidth: 220 }}
        />
      </Box>

      <Box
        sx={{ display: "flex", flexDirection: "column", gap: 1.5, maxWidth: 480 }}
      >
        <Typography variant="body2" fontWeight={600}>
          Notifications
        </Typography>
        <TextField
          label="Webhook URL"
          value={field("notification_webhook")}
          onChange={(e) => set("notification_webhook", e.target.value)}
          placeholder="https://ntfy.sh/my-topic"
          size="small"
          fullWidth
        />
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <Button
            variant="outlined"
            size="small"
            disabled={testMut.isPending}
            startIcon={
              testMut.isPending ? (
                <CircularProgress size={12} />
              ) : undefined
            }
            onClick={() => testMut.mutate()}
          >
            Test webhook
          </Button>
          {testMut.data && (
            <Typography
              variant="body2"
              color={testMut.data.ok ? "success.main" : "error.main"}
            >
              Response: {testMut.data.status_code}{" "}
              {testMut.data.ok ? "✓" : "✗"}
            </Typography>
          )}
        </Box>
      </Box>

      {dirty && (
        <Box>
          <Button
            variant="contained"
            disabled={saveMut.isPending}
            startIcon={
              saveMut.isPending ? (
                <CircularProgress size={14} color="inherit" />
              ) : undefined
            }
            onClick={() => saveMut.mutate()}
          >
            Save changes
          </Button>
        </Box>
      )}
    </Box>
  );
}

// ─── Users tab ────────────────────────────────────────────────────────────────

function UsersTab() {
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [isOpen, setIsOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("viewer");
  const [deleteTarget, setDeleteTarget] = useState<UserRecord | null>(null);

  const { data: users, isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: settingsApi.listUsers,
  });

  const saveMut = useMutation({
    mutationFn: () =>
      editingUser
        ? settingsApi.updateUser(editingUser.id, {
            password: password || undefined,
            role,
          })
        : settingsApi.createUser({ username, password, role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setIsOpen(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: settingsApi.deleteUser,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });

  function openCreate() {
    setEditingUser(null);
    setUsername("");
    setPassword("");
    setRole("viewer");
    setIsOpen(true);
  }

  function openEdit(u: UserRecord) {
    setEditingUser(u);
    setUsername(u.username);
    setPassword("");
    setRole(u.role);
    setIsOpen(true);
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
        <Button size="small" variant="contained" onClick={openCreate}>
          Add user
        </Button>
      </Box>
      {isMobile ? (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          {isLoading ? (
            <Typography color="text.secondary" align="center" sx={{ py: 4 }}>
              Loading…
            </Typography>
          ) : !users?.length ? (
            <Typography color="text.secondary" align="center" sx={{ py: 4 }}>
              No users.
            </Typography>
          ) : (
            users.map((u) => (
              <DataCard
                key={u.id}
                title={u.username}
                fields={[
                  { label: "Role", value: u.role },
                  {
                    label: "Last login",
                    value: u.last_login
                      ? new Date(u.last_login).toLocaleString()
                      : "Never",
                  },
                ]}
                actions={
                  <>
                    <Button size="small" variant="outlined" onClick={() => openEdit(u)}>
                      Edit
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      color="error"
                      onClick={() => setDeleteTarget(u)}
                    >
                      Delete
                    </Button>
                  </>
                }
              />
            ))
          )}
        </Box>
      ) : (
        <TableContainer component={Paper}>
          <Table aria-label="Users">
            <TableHead>
              <TableRow>
                <TableCell>Username</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Last login</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    align="center"
                    sx={{ py: 4, color: "text.secondary" }}
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              ) : !users?.length ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    align="center"
                    sx={{ py: 4, color: "text.secondary" }}
                  >
                    No users.
                  </TableCell>
                </TableRow>
              ) : (
                users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>{u.username}</TableCell>
                    <TableCell>{u.role}</TableCell>
                    <TableCell>
                      {u.last_login
                        ? new Date(u.last_login).toLocaleString()
                        : "Never"}
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: "flex", gap: 1 }}>
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() => openEdit(u)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          color="error"
                          onClick={() => setDeleteTarget(u)}
                        >
                          Delete
                        </Button>
                      </Box>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog
        open={isOpen}
        onClose={() => setIsOpen(false)}
        maxWidth="xs"
        fullWidth
        fullScreen={isMobile}
      >
        <DialogTitle sx={{ pr: 6 }}>
          {editingUser ? `Edit ${editingUser.username}` : "Add user"}
          <IconButton
            onClick={() => setIsOpen(false)}
            sx={{ position: "absolute", right: 8, top: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 0.5 }}>
            {!editingUser && (
              <TextField
                label="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                size="small"
                autoComplete="off"
                fullWidth
              />
            )}
            <TextField
              label={
                editingUser
                  ? "New password (leave blank to keep)"
                  : "Password"
              }
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required={!editingUser}
              size="small"
              autoComplete="new-password"
              fullWidth
            />
            <FormControl size="small" fullWidth>
              <InputLabel>Role</InputLabel>
              <Select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                label="Role"
              >
                <MenuItem value="admin">Admin</MenuItem>
                <MenuItem value="viewer">Viewer</MenuItem>
              </Select>
            </FormControl>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button variant="text" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={saveMut.isPending}
            startIcon={
              saveMut.isPending ? (
                <CircularProgress size={14} color="inherit" />
              ) : undefined
            }
            onClick={() => saveMut.mutate()}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete user"
        message={`Permanently delete "${deleteTarget?.username}"? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => deleteMut.mutate(deleteTarget!.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </Box>
  );
}

// ─── API Keys tab ─────────────────────────────────────────────────────────────

function ApiKeysTab() {
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [isOpen, setIsOpen] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [role, setRole] = useState("viewer");
  const [expiresAt, setExpiresAt] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRecord | null>(null);

  const { data: keys, isLoading } = useQuery({
    queryKey: ["api-keys"],
    queryFn: settingsApi.listApiKeys,
  });

  const createMut = useMutation({
    mutationFn: () =>
      settingsApi.createApiKey({
        name: keyName,
        role,
        expires_at: expiresAt || undefined,
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      setNewKey(data.key);
    },
  });

  const revokeMut = useMutation({
    mutationFn: settingsApi.revokeApiKey,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  function openCreate() {
    setKeyName("");
    setRole("viewer");
    setExpiresAt("");
    setNewKey(null);
    setIsOpen(true);
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
        <Button size="small" variant="contained" onClick={openCreate}>
          Create key
        </Button>
      </Box>
      {isMobile ? (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          {isLoading ? (
            <Typography color="text.secondary" align="center" sx={{ py: 4 }}>
              Loading…
            </Typography>
          ) : !(keys as ApiKeyRecord[])?.length ? (
            <Typography color="text.secondary" align="center" sx={{ py: 4 }}>
              No API keys.
            </Typography>
          ) : (
            (keys as ApiKeyRecord[]).map((k) => (
              <DataCard
                key={k.id}
                title={k.name}
                fields={[
                  { label: "Role", value: k.role },
                  { label: "Owner", value: k.owner_username ?? "—" },
                  {
                    label: "Last used",
                    value: k.last_used_at
                      ? new Date(k.last_used_at).toLocaleString()
                      : "Never",
                  },
                  {
                    label: "Expires",
                    value: k.expires_at
                      ? new Date(k.expires_at).toLocaleDateString()
                      : "Never",
                  },
                ]}
                actions={
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    onClick={() => setRevokeTarget(k)}
                  >
                    Revoke
                  </Button>
                }
              />
            ))
          )}
        </Box>
      ) : (
        <TableContainer component={Paper}>
          <Table aria-label="API keys">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Owner</TableCell>
                <TableCell>Last used</TableCell>
                <TableCell>Expires</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    align="center"
                    sx={{ py: 4, color: "text.secondary" }}
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              ) : !(keys as ApiKeyRecord[])?.length ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    align="center"
                    sx={{ py: 4, color: "text.secondary" }}
                  >
                    No API keys.
                  </TableCell>
                </TableRow>
              ) : (
                (keys as ApiKeyRecord[]).map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>{k.name}</TableCell>
                    <TableCell>{k.role}</TableCell>
                    <TableCell>{k.owner_username ?? "—"}</TableCell>
                    <TableCell>
                      {k.last_used_at
                        ? new Date(k.last_used_at).toLocaleString()
                        : "Never"}
                    </TableCell>
                    <TableCell>
                      {k.expires_at
                        ? new Date(k.expires_at).toLocaleDateString()
                        : "Never"}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="small"
                        variant="outlined"
                        color="error"
                        onClick={() => setRevokeTarget(k)}
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog
        open={isOpen}
        onClose={() => {
          setIsOpen(false);
          setNewKey(null);
        }}
        maxWidth="xs"
        fullWidth
        fullScreen={isMobile}
      >
        <DialogTitle sx={{ pr: 6 }}>
          Create API key
          <IconButton
            onClick={() => {
              setIsOpen(false);
              setNewKey(null);
            }}
            sx={{ position: "absolute", right: 8, top: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {newKey ? (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
              <Typography variant="body2" color="success.main">
                Key created — copy it now, it won't be shown again.
              </Typography>
              <Box
                component="pre"
                sx={{
                  fontSize: "0.75rem",
                  bgcolor: "action.hover",
                  borderRadius: 1,
                  p: 1.5,
                  wordBreak: "break-all",
                  whiteSpace: "pre-wrap",
                  userSelect: "all",
                  m: 0,
                  fontFamily: "monospace",
                }}
              >
                {newKey}
              </Box>
              <Button
                variant="outlined"
                fullWidth
                onClick={() => navigator.clipboard.writeText(newKey)}
              >
                Copy to clipboard
              </Button>
            </Box>
          ) : (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 0.5 }}>
              <TextField
                label="Name"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                required
                size="small"
                fullWidth
              />
              <FormControl size="small" fullWidth>
                <InputLabel>Role</InputLabel>
                <Select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  label="Role"
                >
                  <MenuItem value="admin">Admin</MenuItem>
                  <MenuItem value="viewer">Viewer</MenuItem>
                </Select>
              </FormControl>
              <TextField
                label="Expires at (optional)"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                size="small"
                fullWidth
                InputLabelProps={{ shrink: true }}
              />
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          {newKey ? (
            <Button variant="contained" onClick={() => setIsOpen(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="text"
                onClick={() => {
                  setIsOpen(false);
                  setNewKey(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="contained"
                disabled={createMut.isPending}
                startIcon={
                  createMut.isPending ? (
                    <CircularProgress size={14} color="inherit" />
                  ) : undefined
                }
                onClick={() => createMut.mutate()}
              >
                Create
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!revokeTarget}
        title="Revoke API key"
        message={`Revoke key "${revokeTarget?.name}"? Any clients using it will lose access immediately.`}
        confirmLabel="Revoke"
        onConfirm={() => revokeMut.mutate(revokeTarget!.id)}
        onClose={() => setRevokeTarget(null)}
      />
    </Box>
  );
}

// ─── Settings page ────────────────────────────────────────────────────────────

export function Settings() {
  const [tab, setTab] = useState(0);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Typography variant="h5" fontWeight={700}>
        Settings
      </Typography>

      <Card>
        <CardContent sx={{ pt: 0 }}>
          <Tabs
            value={tab}
            onChange={(_, v) => setTab(v)}
            aria-label="Settings sections"
            sx={{ borderBottom: 1, borderColor: "divider", mb: 3 }}
          >
            <Tab label="General" />
            <Tab label="Users" />
            <Tab label="API keys" />
          </Tabs>
          {tab === 0 && <GeneralTab />}
          {tab === 1 && <UsersTab />}
          {tab === 2 && <ApiKeysTab />}
        </CardContent>
      </Card>
    </Box>
  );
}
