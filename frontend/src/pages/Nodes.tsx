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
import { useRef, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { nodesApi, type Node, type NodeCreate } from "../lib/api";

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
  const [testResult, setTestResult] = useState<
    Record<number, { ok: boolean | null; error?: string }>
  >({});

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
    resetKeyState();
    setIsOpen(true);
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
    const res = await nodesApi.testConnection(node.id);
    setTestResult((p) => ({
      ...p,
      [node.id]: { ok: res.reachable, error: res.error ?? undefined },
    }));
  }

  function field<K extends keyof NodeCreate>(key: K) {
    return String(form[key] ?? "");
  }

  function set<K extends keyof NodeCreate>(key: K, value: NodeCreate[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const existingKeyIntact = editing?.has_ssh_key && !removeKey && !keyContent;

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
                        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
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
                          {testResult[node.id]?.error && (
                            <Typography
                              variant="caption"
                              color="error"
                              sx={{ maxWidth: 192 }}
                            >
                              {testResult[node.id].error}
                            </Typography>
                          )}
                        </Box>
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
            />
            <TextField
              label="IP address"
              value={field("ip")}
              onChange={(e) => set("ip", e.target.value)}
              required
              size="small"
              fullWidth
            />
            <TextField
              label="MAC address"
              value={field("mac")}
              onChange={(e) => set("mac", e.target.value)}
              required
              size="small"
              fullWidth
              inputProps={{ style: { fontFamily: "monospace" } }}
            />
            <TextField
              label="SSH user"
              value={field("ssh_user")}
              onChange={(e) => set("ssh_user", e.target.value)}
              required
              size="small"
              fullWidth
            />
            <TextField
              label="SSH port"
              type="number"
              value={field("ssh_port")}
              onChange={(e) => set("ssh_port", Number(e.target.value))}
              size="small"
              fullWidth
            />
            <TextField
              label="SFTP root"
              value={field("sftp_root")}
              onChange={(e) => set("sftp_root", e.target.value)}
              size="small"
              fullWidth
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
            disabled={saveMut.isPending}
            startIcon={
              saveMut.isPending ? <CircularProgress size={14} color="inherit" /> : undefined
            }
            onClick={() => saveMut.mutate(form)}
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
