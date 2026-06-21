import CloseIcon from "@mui/icons-material/Close";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSnackbar } from "notistack";
import { useRef, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { nodesApi, type Node, type NodeCreate, type SpeedTest } from "../lib/api";
import {
  isAbsolutePath,
  isBlank,
  isValidHost,
  isValidMac,
  isValidPort,
} from "../lib/validation";

function formatBps(n: number): string {
  if (n < 1024) return `${n.toFixed(0)} B/s`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB/s`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB/s`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB/s`;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
  return `${(n / 1024 ** 3).toFixed(1)} GiB`;
}

/** Rich snackbar body: headline peak speeds plus a per-file-size breakdown. */
function speedSnackContent(title: string, speed: SpeedTest) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
      <Typography variant="body2" fontWeight={600}>
        {title}
      </Typography>
      <Typography variant="body2">
        ↑ {formatBps(speed.upload_bps)} · ↓ {formatBps(speed.download_bps)} (peak)
      </Typography>
      {speed.samples.map((s) => (
        <Typography key={s.size_bytes} variant="caption">
          {formatSize(s.size_bytes)}: ↑ {formatBps(s.upload_bps)} · ↓ {formatBps(s.download_bps)}
        </Typography>
      ))}
    </Box>
  );
}

function nodeErrors(f: NodeCreate): Partial<Record<keyof NodeCreate, string>> {
  const e: Partial<Record<keyof NodeCreate, string>> = {};
  if (isBlank(f.name)) e.name = "Name is required";
  if (isBlank(f.ip)) e.ip = "IP address is required";
  else if (!isValidHost(f.ip)) e.ip = "Enter a valid IP address or hostname";
  if (isBlank(f.mac)) e.mac = "MAC address is required";
  else if (!isValidMac(f.mac)) e.mac = "Format: 00:1A:2B:3C:4D:5E";
  if (isBlank(f.ssh_user)) e.ssh_user = "SSH user is required";
  if (!isValidPort(f.ssh_port ?? 22)) e.ssh_port = "Port must be between 1 and 65535";
  const root = f.sftp_root ?? "/";
  if (isBlank(root)) e.sftp_root = "SFTP root is required";
  else if (!isAbsolutePath(root)) e.sftp_root = "Must be an absolute path (start with /)";
  return e;
}

const EMPTY: NodeCreate = {
  name: "",
  mac: "",
  ip: "",
  ssh_user: "",
  ssh_port: 22,
  sftp_root: "/",
  allow_shutdown: true,
};

export function Nodes() {
  const qc = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [editing, setEditing] = useState<Node | null>(null);
  const [form, setForm] = useState<NodeCreate>(EMPTY);
  const [attempted, setAttempted] = useState(false);
  // Per-row button status only; detailed results/errors surface via snackbars.
  const [testResult, setTestResult] = useState<Record<number, { ok: boolean | null }>>({});
  const { enqueueSnackbar } = useSnackbar();

  const keyInputRef = useRef<HTMLInputElement>(null);
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [keyContent, setKeyContent] = useState<string | undefined>(undefined);
  const [removeKey, setRemoveKey] = useState(false);

  // confirm dialogs
  const [deleteTarget, setDeleteTarget] = useState<Node | null>(null);
  const [shutdownTarget, setShutdownTarget] = useState<Node | null>(null);

  const { data: nodes, isLoading } = useQuery({
    queryKey: ["nodes"],
    queryFn: nodesApi.list,
  });

  const saveMut = useMutation({
    mutationFn: async (f: NodeCreate) => {
      const body = keyContent ? { ...f, ssh_key_content: keyContent } : f;
      const saved = editing
        ? await nodesApi.update(editing.id, body)
        : await nodesApi.create(body);
      if (removeKey && editing) await nodesApi.deleteSSHKey(editing.id);
      return saved;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nodes"] });
      setIsOpen(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: nodesApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nodes"] }),
  });

  const refreshMut = useMutation({ mutationFn: nodesApi.refreshFiles });
  const wakeMut = useMutation({
    mutationFn: nodesApi.wake,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nodes"] }),
  });
  const shutdownMut = useMutation({
    mutationFn: nodesApi.shutdown,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nodes"] }),
  });

  function resetKeyState() {
    setKeyFile(null);
    setKeyContent(undefined);
    setRemoveKey(false);
    if (keyInputRef.current) keyInputRef.current.value = "";
  }

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setAttempted(false);
    resetKeyState();
    setIsOpen(true);
  }

  function openEdit(node: Node) {
    setEditing(node);
    setForm({
      name: node.name,
      mac: node.mac,
      ip: node.ip,
      ssh_user: node.ssh_user,
      ssh_port: node.ssh_port,
      sftp_root: node.sftp_root,
      allow_shutdown: node.allow_shutdown,
    });
    setAttempted(false);
    resetKeyState();
    setIsOpen(true);
  }

  function handleSave() {
    if (Object.keys(nodeErrors(form)).length > 0) {
      setAttempted(true);
      return;
    }
    saveMut.mutate(form);
  }

  async function handleKeyFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setKeyFile(file);
    setKeyContent(await file.text());
    setRemoveKey(false);
  }

  async function testConn(node: Node) {
    setTestResult((p) => ({ ...p, [node.id]: { ok: null } }));
    try {
      const res = await nodesApi.testConnection(node.id);
      setTestResult((p) => ({ ...p, [node.id]: { ok: res.reachable } }));

      if (!res.reachable) {
        enqueueSnackbar(`${node.name}: ${res.error ?? "SSH connection failed"}`, {
          variant: "error",
          autoHideDuration: 12000,
        });
      } else if (res.speed?.error) {
        enqueueSnackbar(`${node.name} reachable, but speed test failed: ${res.speed.error}`, {
          variant: "warning",
          autoHideDuration: 12000,
        });
      } else if (res.speed) {
        enqueueSnackbar(speedSnackContent(`${node.name} is online`, res.speed), {
          variant: "success",
        });
      } else {
        enqueueSnackbar(`${node.name} is online — SSH connection OK`, { variant: "success" });
      }
    } catch (e) {
      setTestResult((p) => ({ ...p, [node.id]: { ok: false } }));
      enqueueSnackbar(`${node.name}: ${e instanceof Error ? e.message : "Test failed"}`, {
        variant: "error",
        autoHideDuration: 12000,
      });
    }
  }

  function field<K extends keyof NodeCreate>(key: K) {
    return String(form[key] ?? "");
  }

  function set<K extends keyof NodeCreate>(key: K, value: NodeCreate[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const existingKeyIntact = editing?.has_ssh_key && !removeKey && !keyContent;

  const errors = nodeErrors(form);
  const hasErrors = Object.keys(errors).length > 0;
  const showError = (k: keyof NodeCreate) => (attempted ? errors[k] : undefined);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Typography variant="h5" fontWeight={700}>
          Nodes
        </Typography>
        <Button variant="contained" onClick={openCreate}>
          Add node
        </Button>
      </Box>

      <TableContainer component={Paper}>
        <Table aria-label="Nodes">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>IP</TableCell>
              <TableCell>MAC</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Cache refreshed</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} align="center" sx={{ py: 4, color: "text.secondary" }}>
                  Loading…
                </TableCell>
              </TableRow>
            ) : !nodes?.length ? (
              <TableRow>
                <TableCell colSpan={6} align="center" sx={{ py: 4, color: "text.secondary" }}>
                  No nodes configured yet.
                </TableCell>
              </TableRow>
            ) : (
              nodes.map((node) => {
                const isOnline = node.status === "online";
                return (
                  <TableRow key={node.id}>
                    <TableCell>
                      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                        {node.name}
                        {node.has_ssh_key && (
                          <Typography
                            component="span"
                            variant="caption"
                            color="text.secondary"
                            title="SSH key on file"
                          >
                            🔑
                          </Typography>
                        )}
                      </Box>
                    </TableCell>
                    <TableCell>{node.ip}</TableCell>
                    <TableCell sx={{ fontFamily: "monospace", fontSize: "0.8125rem" }}>
                      {node.mac}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={node.status}
                        size="small"
                        variant="outlined"
                        color={
                          node.status === "online"
                            ? "success"
                            : node.status === "waking"
                              ? "warning"
                              : node.status === "offline"
                                ? "error"
                                : "default"
                        }
                      />
                    </TableCell>
                    <TableCell>
                      {node.last_cache_refresh
                        ? new Date(node.last_cache_refresh).toLocaleString()
                        : "Never"}
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() => openEdit(node)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() => testConn(node)}
                        >
                          {!testResult[node.id]
                            ? "Test"
                            : testResult[node.id].ok === null
                              ? "Testing…"
                              : testResult[node.id].ok
                                ? "✓ Online"
                                : "✗ Failed"}
                        </Button>
                        {isOnline ? (
                          <Button
                            size="small"
                            variant="outlined"
                            color="warning"
                            disabled={(shutdownMut.isPending && shutdownMut.variables === node.id) || node.allow_shutdown === false}
                            startIcon={
                              shutdownMut.isPending && shutdownMut.variables === node.id ? (
                                <CircularProgress size={12} />
                              ) : undefined
                            }
                            onClick={() => setShutdownTarget(node)}
                          >
                            Shutdown
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            variant="outlined"
                            disabled={wakeMut.isPending && wakeMut.variables === node.id}
                            startIcon={
                              wakeMut.isPending && wakeMut.variables === node.id ? (
                                <CircularProgress size={12} />
                              ) : undefined
                            }
                            onClick={() => wakeMut.mutate(node.id)}
                          >
                            Wake
                          </Button>
                        )}
                        <Button
                          size="small"
                          variant="outlined"
                          disabled={refreshMut.isPending}
                          startIcon={
                            refreshMut.isPending ? (
                              <CircularProgress size={12} />
                            ) : undefined
                          }
                          onClick={() => refreshMut.mutate(node.id)}
                        >
                          Refresh cache
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          color="error"
                          onClick={() => setDeleteTarget(node)}
                        >
                          Delete
                        </Button>
                      </Box>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Edit / Create dialog */}
      <Dialog
        open={isOpen}
        onClose={() => setIsOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ pr: 6 }}>
          {editing ? "Edit node" : "Add node"}
          <IconButton
            onClick={() => setIsOpen(false)}
            sx={{ position: "absolute", right: 8, top: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 2,
              pt: 0.5,
            }}
          >
            <TextField
              label="Name"
              value={field("name")}
              onChange={(e) => set("name", e.target.value)}
              required
              size="small"
              fullWidth
              error={!!showError("name")}
              helperText={showError("name")}
            />
            <TextField
              label="IP address"
              value={field("ip")}
              onChange={(e) => set("ip", e.target.value)}
              required
              size="small"
              fullWidth
              error={!!showError("ip")}
              helperText={showError("ip")}
            />
            <TextField
              label="MAC address"
              value={field("mac")}
              onChange={(e) => set("mac", e.target.value)}
              required
              size="small"
              fullWidth
              inputProps={{ style: { fontFamily: "monospace" } }}
              error={!!showError("mac")}
              helperText={showError("mac")}
            />
            <TextField
              label="SSH user"
              value={field("ssh_user")}
              onChange={(e) => set("ssh_user", e.target.value)}
              required
              size="small"
              fullWidth
              error={!!showError("ssh_user")}
              helperText={showError("ssh_user")}
            />
            <TextField
              label="SSH port"
              type="number"
              value={field("ssh_port")}
              onChange={(e) => set("ssh_port", Number(e.target.value))}
              size="small"
              fullWidth
              error={!!showError("ssh_port")}
              helperText={showError("ssh_port")}
            />
            <TextField
              label="SFTP root"
              value={field("sftp_root")}
              onChange={(e) => set("sftp_root", e.target.value)}
              size="small"
              fullWidth
              error={!!showError("sftp_root")}
              helperText={showError("sftp_root")}
            />

            <Box sx={{ gridColumn: "1 / -1" }}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={form.allow_shutdown ?? true}
                    onChange={(e) => set("allow_shutdown", e.target.checked)}
                    size="small"
                  />
                }
                label="Allow shutdown after job"
              />
              <Typography variant="caption" color="text.secondary" display="block" sx={{ ml: 3.5, mt: -0.5 }}>
                When disabled, the job runner will never power off this node
              </Typography>
            </Box>

            <Box sx={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 1 }}>
              <Typography variant="body2" fontWeight={500}>
                SSH key
              </Typography>

              {existingKeyIntact && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Chip label="Key on file" size="small" color="success" variant="outlined" />
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    onClick={() => setRemoveKey(true)}
                  >
                    Remove
                  </Button>
                </Box>
              )}

              {removeKey && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Chip
                    label="Key will be removed on save"
                    size="small"
                    color="warning"
                    variant="outlined"
                  />
                  <Button size="small" variant="text" onClick={() => setRemoveKey(false)}>
                    Undo
                  </Button>
                </Box>
              )}

              {keyContent && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Chip
                    label={keyFile?.name ?? "Key ready"}
                    size="small"
                    color="success"
                    variant="outlined"
                  />
                  <Button size="small" variant="text" onClick={() => resetKeyState()}>
                    Clear
                  </Button>
                </Box>
              )}

              {!keyContent && !removeKey && (
                <>
                  <Box>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => keyInputRef.current?.click()}
                    >
                      {existingKeyIntact ? "Replace key" : "Upload SSH key"}
                    </Button>
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    Accepts PEM, OpenSSH, or any private key format
                  </Typography>
                </>
              )}

              <input
                ref={keyInputRef}
                type="file"
                style={{ display: "none" }}
                accept=".pem,.key,.ppk,*"
                onChange={handleKeyFile}
              />
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button variant="text" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={saveMut.isPending || (attempted && hasErrors)}
            startIcon={
              saveMut.isPending ? <CircularProgress size={14} color="inherit" /> : undefined
            }
            onClick={handleSave}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!shutdownTarget}
        title="Shut down node"
        message={`Send a shutdown command to "${shutdownTarget?.name}"? The node will power off immediately.`}
        confirmLabel="Shut down"
        confirmColor="warning"
        onConfirm={() => shutdownMut.mutate(shutdownTarget!.id)}
        onClose={() => setShutdownTarget(null)}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete node"
        message={`Permanently delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => deleteMut.mutate(deleteTarget!.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </Box>
  );
}
