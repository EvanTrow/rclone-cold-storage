import CloseIcon from "@mui/icons-material/Close";
import {
  Alert,
  Box,
  Button,
  Chip,
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
import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { FileBrowser } from "../components/FileBrowser";
import { jobsApi, nodesApi, type Job, type JobCreate } from "../lib/api";

const EMPTY_FORM: JobCreate = {
  name: "",
  operation: "copy",
  source_node_id: undefined,
  source_paths: [],
  dest_node_id: undefined,
  dest_path: "",
  target_paths: [],
  schedule_cron: "",
  shutdown_after: false,
  enabled: true,
  run_now: false,
};

function opColor(op: Job["operation"]): "default" | "warning" | "error" {
  if (op === "copy") return "default";
  if (op === "move") return "warning";
  return "error";
}

export function Jobs() {
  const qc = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [editing, setEditing] = useState<Job | null>(null);
  const [form, setForm] = useState<JobCreate>(EMPTY_FORM);
  const [pathInput, setPathInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Job | null>(null);

  const { data: jobs, isLoading } = useQuery({
    queryKey: ["jobs"],
    queryFn: jobsApi.list,
  });
  const { data: nodes } = useQuery({
    queryKey: ["nodes"],
    queryFn: nodesApi.list,
  });

  const saveMut = useMutation({
    mutationFn: (f: JobCreate) =>
      editing ? jobsApi.update(editing.id, f) : jobsApi.create(f),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      setIsOpen(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: jobsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const triggerMut = useMutation({
    mutationFn: jobsApi.trigger,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs"] }),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      jobsApi.update(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setPathInput("");
    setIsOpen(true);
  }

  function openEdit(job: Job) {
    setEditing(job);
    setForm({
      name: job.name,
      operation: job.operation,
      source_node_id: job.source_node_id ?? undefined,
      source_paths: job.source_paths ?? [],
      dest_node_id: job.dest_node_id ?? undefined,
      dest_path: job.dest_path ?? "",
      target_paths: job.target_paths ?? [],
      schedule_cron: job.schedule_cron ?? "",
      shutdown_after: job.shutdown_after,
      enabled: job.enabled,
      run_now: false,
    });
    setPathInput("");
    setIsOpen(true);
  }

  function addPath() {
    if (!pathInput.trim()) return;
    const field = form.operation === "delete" ? "target_paths" : "source_paths";
    setForm((f) => ({ ...f, [field]: [...(f[field] ?? []), pathInput.trim()] }));
    setPathInput("");
  }

  function removePath(idx: number) {
    const field = form.operation === "delete" ? "target_paths" : "source_paths";
    setForm((f) => ({ ...f, [field]: (f[field] ?? []).filter((_, i) => i !== idx) }));
  }

  const isDelete = form.operation === "delete";
  const activePaths = isDelete ? (form.target_paths ?? []) : (form.source_paths ?? []);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Typography variant="h5" fontWeight={700}>
          Jobs
        </Typography>
        <Button variant="contained" onClick={openCreate}>
          Add job
        </Button>
      </Box>

      <TableContainer component={Paper}>
        <Table aria-label="Jobs">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Operation</TableCell>
              <TableCell>Schedule</TableCell>
              <TableCell>Enabled</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4, color: "text.secondary" }}>
                  Loading…
                </TableCell>
              </TableRow>
            ) : !jobs?.length ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4, color: "text.secondary" }}>
                  No jobs yet.
                </TableCell>
              </TableRow>
            ) : (
              jobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>{job.name}</TableCell>
                  <TableCell>
                    <Chip
                      label={job.operation}
                      size="small"
                      variant="outlined"
                      color={opColor(job.operation)}
                    />
                  </TableCell>
                  <TableCell>
                    <Typography
                      component="span"
                      variant="body2"
                      sx={{ fontFamily: "monospace" }}
                    >
                      {job.schedule_cron ?? "manual"}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={job.enabled}
                      size="small"
                      onChange={(e) =>
                        toggleMut.mutate({ id: job.id, enabled: e.target.checked })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => openEdit(job)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={triggerMut.isPending}
                        startIcon={
                          triggerMut.isPending ? (
                            <CircularProgress size={12} />
                          ) : undefined
                        }
                        onClick={() => triggerMut.mutate(job.id)}
                      >
                        Run now
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        color="error"
                        onClick={() => setDeleteTarget(job)}
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

      <Dialog
        open={isOpen}
        onClose={() => setIsOpen(false)}
        maxWidth="md"
        fullWidth
        scroll="paper"
      >
        <DialogTitle sx={{ pr: 6 }}>
          {editing ? "Edit job" : "Add job"}
          <IconButton
            onClick={() => setIsOpen(false)}
            sx={{ position: "absolute", right: 8, top: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5, pt: 0.5 }}>
            <TextField
              label="Job name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
              size="small"
              fullWidth
            />

            <FormControl size="small" fullWidth>
              <InputLabel>Operation</InputLabel>
              <Select
                value={form.operation}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    operation: e.target.value as JobCreate["operation"],
                  }))
                }
                label="Operation"
              >
                <MenuItem value="copy">Copy</MenuItem>
                <MenuItem value="move">Move</MenuItem>
                <MenuItem value="delete">Delete</MenuItem>
              </Select>
            </FormControl>

            {isDelete && (
              <Alert severity="warning">
                Delete jobs permanently remove files from the node. This cannot be undone.
              </Alert>
            )}

            <FormControl size="small" fullWidth>
              <InputLabel>{isDelete ? "Node" : "Source node"}</InputLabel>
              <Select
                value={form.source_node_id ? String(form.source_node_id) : ""}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    source_node_id: e.target.value ? Number(e.target.value) : undefined,
                  }))
                }
                label={isDelete ? "Node" : "Source node"}
                displayEmpty
              >
                <MenuItem value=""><em>Select a node</em></MenuItem>
                {(nodes ?? []).map((n) => (
                  <MenuItem key={n.id} value={String(n.id)}>
                    {n.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Box>
              <Typography variant="body2" fontWeight={500} gutterBottom>
                {isDelete ? "Paths to delete" : "Source paths"}
              </Typography>
              <FileBrowser
                nodeId={form.source_node_id}
                selected={activePaths}
                onChange={(paths) => {
                  const field = isDelete ? "target_paths" : "source_paths";
                  setForm((f) => ({ ...f, [field]: paths }));
                }}
                multiSelect
              />
              <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
                <TextField
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  placeholder="Or type a path manually…"
                  size="small"
                  sx={{ flex: 1 }}
                  onKeyDown={(e) => e.key === "Enter" && addPath()}
                />
                <Button size="small" variant="outlined" onClick={addPath}>
                  Add
                </Button>
              </Box>
              {activePaths.length > 0 && (
                <Box sx={{ mt: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
                  {activePaths.map((p, i) => (
                    <Box
                      key={i}
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        bgcolor: "action.hover",
                        borderRadius: 1,
                        px: 1.5,
                        py: 0.75,
                      }}
                    >
                      <Typography
                        variant="body2"
                        sx={{ fontFamily: "monospace", wordBreak: "break-all" }}
                      >
                        {p}
                      </Typography>
                      <IconButton size="small" onClick={() => removePath(i)}>
                        <CloseIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Box>
                  ))}
                </Box>
              )}
            </Box>

            {!isDelete && (
              <>
                <FormControl size="small" fullWidth>
                  <InputLabel>Destination node</InputLabel>
                  <Select
                    value={form.dest_node_id ? String(form.dest_node_id) : ""}
                    onChange={(e) => {
                      const nodeId = e.target.value ? Number(e.target.value) : undefined;
                      const node = nodes?.find((n) => n.id === nodeId);
                      setForm((f) => ({
                        ...f,
                        dest_node_id: nodeId,
                        dest_path: f.dest_path || node?.sftp_root || "",
                      }));
                    }}
                    label="Destination node"
                    displayEmpty
                  >
                    <MenuItem value=""><em>Select a node</em></MenuItem>
                    {(nodes ?? []).map((n) => (
                      <MenuItem key={n.id} value={String(n.id)}>
                        {n.name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                <TextField
                  label="Destination path"
                  value={form.dest_path ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, dest_path: e.target.value }))
                  }
                  placeholder="/backups/"
                  size="small"
                  fullWidth
                />

                <Box>
                  <Typography variant="caption" color="text.secondary" gutterBottom display="block">
                    Or browse to select a destination directory:
                  </Typography>
                  <FileBrowser
                    nodeId={form.dest_node_id}
                    selected={form.dest_path ? [form.dest_path] : []}
                    onChange={(paths) =>
                      setForm((f) => ({ ...f, dest_path: paths[0] ?? "" }))
                    }
                    multiSelect={false}
                    dirsOnly
                  />
                </Box>
              </>
            )}

            <TextField
              label="Cron schedule (leave blank for manual only)"
              value={form.schedule_cron ?? ""}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  schedule_cron: e.target.value || undefined,
                }))
              }
              placeholder="0 2 * * 0"
              size="small"
              fullWidth
            />

            <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={form.shutdown_after}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, shutdown_after: e.target.checked }))
                    }
                  />
                }
                label="Shut down node after"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={form.enabled}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, enabled: e.target.checked }))
                    }
                  />
                }
                label="Enabled"
              />
              {!editing && (
                <FormControlLabel
                  control={
                    <Switch
                      checked={form.run_now ?? false}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, run_now: e.target.checked }))
                      }
                    />
                  }
                  label="Run now on save"
                />
              )}
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
        open={!!deleteTarget}
        title="Delete job"
        message={`Permanently delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => deleteMut.mutate(deleteTarget!.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </Box>
  );
}
