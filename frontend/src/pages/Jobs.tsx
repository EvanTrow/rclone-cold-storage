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
  FormHelperText,
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
import { isBlank, isValidCron } from "../lib/validation";

function jobErrors(f: JobCreate): Record<string, string> {
  const e: Record<string, string> = {};
  const isDel = f.operation === "delete";
  if (isBlank(f.name)) e.name = "Job name is required";
  if (!f.source_node_id) e.source_node = isDel ? "Select a node" : "Select a source node";
  const paths = isDel ? f.target_paths ?? [] : f.source_paths ?? [];
  if (paths.length === 0) {
    e.paths = isDel ? "Add at least one path to delete" : "Add at least one source path";
  }
  if (!isDel) {
    if (!f.dest_node_id) e.dest_node = "Select a destination node";
    if (isBlank(f.dest_path)) e.dest_path = "Destination path is required";
  }
  if (!isBlank(f.schedule_cron) && !isValidCron(f.schedule_cron!)) {
    e.schedule = "Invalid cron — expects 5 fields, e.g. 0 2 * * 0";
  }
  return e;
}

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

// Single source of truth for how severe each operation is. Drives the table
// chip color, the inline warnings, and the run-confirmation color so they stay
// consistent.
function opSeverity(op: Job["operation"]): "info" | "warning" | "error" {
  if (op === "delete") return "error";
  if (op === "move" || op === "sync") return "warning";
  return "info"; // copy
}

function opColor(op: Job["operation"]): "default" | "warning" | "error" {
  const sev = opSeverity(op);
  return sev === "info" ? "default" : sev;
}

function opLabel(op: Job["operation"]): string {
  return op[0].toUpperCase() + op.slice(1);
}

// Paths carry a trailing slash for directories; use that to report how many
// files and folders an operation will touch.
function describeItems(paths: string[] | null | undefined): string {
  const list = paths ?? [];
  const folders = list.filter((p) => p.endsWith("/")).length;
  const files = list.length - folders;
  const parts: string[] = [];
  if (folders) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
  if (files) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" and ") : "nothing";
}

export function Jobs() {
  const qc = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [editing, setEditing] = useState<Job | null>(null);
  const [form, setForm] = useState<JobCreate>(EMPTY_FORM);
  const [attempted, setAttempted] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Job | null>(null);
  const [runTarget, setRunTarget] = useState<Job | null>(null);

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
    setAttempted(false);
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
    setAttempted(false);
    setPathInput("");
    setIsOpen(true);
  }

  function handleSave() {
    if (Object.keys(jobErrors(form)).length > 0) {
      setAttempted(true);
      return;
    }
    saveMut.mutate(form);
  }

  function addPath() {
    if (!pathInput.trim()) return;
    const field = form.operation === "delete" ? "target_paths" : "source_paths";
    // Sync operates on folders only — ensure a trailing slash so the backend
    // treats the path as a directory.
    let path = pathInput.trim();
    if (form.operation === "sync" && !path.endsWith("/")) path += "/";
    setForm((f) => ({ ...f, [field]: [...(f[field] ?? []), path] }));
    setPathInput("");
  }

  function removePath(idx: number) {
    const field = form.operation === "delete" ? "target_paths" : "source_paths";
    setForm((f) => ({ ...f, [field]: (f[field] ?? []).filter((_, i) => i !== idx) }));
  }

  const isDelete = form.operation === "delete";
  const isSync = form.operation === "sync";
  const activePaths = isDelete ? (form.target_paths ?? []) : (form.source_paths ?? []);

  const errors = jobErrors(form);
  const hasErrors = Object.keys(errors).length > 0;
  const showError = (k: string) => (attempted ? errors[k] : undefined);

  function nodeName(id: number | null): string {
    return nodes?.find((n) => n.id === id)?.name ?? "an unknown node";
  }

  function describeRun(job: Job): string {
    const src = nodeName(job.source_node_id);
    const dst = nodeName(job.dest_node_id);
    switch (job.operation) {
      case "copy":
        return `This will copy ${describeItems(job.source_paths)} from "${src}" to "${dst}" at ${job.dest_path || "the destination root"}. Existing files on the destination are left in place.`;
      case "move":
        return `This will move ${describeItems(job.source_paths)} from "${src}" to "${dst}" at ${job.dest_path || "the destination root"}. Each item is copied, verified by checksum, then deleted from the source.`;
      case "sync":
        return `This will sync ${describeItems(job.source_paths)} from "${src}" to "${dst}", making the destination identical to the source. Files on the destination that are not in the source will be permanently deleted.`;
      case "delete": {
        const node = nodeName(job.source_node_id ?? job.dest_node_id);
        return `This will permanently delete ${describeItems(job.target_paths)} from "${node}". This cannot be undone.`;
      }
    }
  }

  function runDetails(job: Job) {
    const paths =
      job.operation === "delete" ? job.target_paths ?? [] : job.source_paths ?? [];
    const showDest = job.operation !== "delete";
    return (
      <>
        <Box component="span" sx={{ display: "block", mb: 1.5 }}>
          {describeRun(job)}
        </Box>

        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
          {job.operation === "delete" ? "Paths to delete" : "Source paths"}
        </Typography>
        <Box component="ul" sx={{ mt: 0.5, mb: showDest ? 1.5 : 0, pl: 2.5 }}>
          {paths.length === 0 ? (
            <Typography
              component="li"
              variant="body2"
              color="text.secondary"
              sx={{ fontStyle: "italic" }}
            >
              none selected
            </Typography>
          ) : (
            paths.map((p) => (
              <Typography
                component="li"
                key={p}
                variant="body2"
                sx={{ fontFamily: "monospace", wordBreak: "break-all" }}
              >
                {p}
              </Typography>
            ))
          )}
        </Box>

        {showDest && (
          <>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              Destination
            </Typography>
            <Typography
              variant="body2"
              sx={{ fontFamily: "monospace", wordBreak: "break-all", mt: 0.5 }}
            >
              {nodeName(job.dest_node_id)}:{job.dest_path || "(root)"}
            </Typography>
          </>
        )}
      </>
    );
  }

  function runConfirmColor(op: Job["operation"]): "error" | "warning" | "primary" {
    const sev = opSeverity(op);
    return sev === "info" ? "primary" : sev;
  }

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
                        disabled={
                          triggerMut.isPending && triggerMut.variables === job.id
                        }
                        startIcon={
                          triggerMut.isPending &&
                          triggerMut.variables === job.id ? (
                            <CircularProgress size={12} />
                          ) : undefined
                        }
                        onClick={() => setRunTarget(job)}
                      >
                        {`Run ${opLabel(job.operation)}`}
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
              error={!!showError("name")}
              helperText={showError("name")}
            />

            <FormControl size="small" fullWidth>
              <InputLabel>Operation</InputLabel>
              <Select
                value={form.operation}
                onChange={(e) => {
                  const operation = e.target.value as JobCreate["operation"];
                  setForm((f) => ({
                    ...f,
                    operation,
                    // Sync operates on folders only — drop any already-selected files.
                    source_paths:
                      operation === "sync"
                        ? (f.source_paths ?? []).filter((p) => p.endsWith("/"))
                        : f.source_paths,
                  }));
                }}
                label="Operation"
              >
                <MenuItem value="copy">Copy</MenuItem>
                <MenuItem value="move">Move</MenuItem>
                <MenuItem value="sync">Sync</MenuItem>
                <MenuItem value="delete">Delete</MenuItem>
              </Select>
            </FormControl>

            {isDelete && (
              <Alert severity={opSeverity("delete")}>
                Delete jobs permanently remove files from the node. This cannot be undone.
              </Alert>
            )}

            {isSync && (
              <Alert severity={opSeverity("sync")}>
                Sync makes the destination identical to the source. Files on the destination
                that are not on the source will be permanently deleted.
              </Alert>
            )}

            <FormControl size="small" fullWidth error={!!showError("source_node")}>
              <InputLabel shrink>{isDelete ? "Node" : "Source node"}</InputLabel>
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
                notched
              >
                <MenuItem value=""><em>Select a node</em></MenuItem>
                {(nodes ?? []).map((n) => (
                  <MenuItem key={n.id} value={String(n.id)}>
                    {n.name}
                  </MenuItem>
                ))}
              </Select>
              {showError("source_node") && (
                <FormHelperText>{showError("source_node")}</FormHelperText>
              )}
            </FormControl>

            <Box>
              <Typography variant="body2" fontWeight={500} gutterBottom>
                {isDelete ? "Paths to delete" : isSync ? "Source folders" : "Source paths"}
              </Typography>
              {showError("paths") && (
                <FormHelperText error sx={{ mx: 0, mb: 0.5 }}>
                  {showError("paths")}
                </FormHelperText>
              )}
              <FileBrowser
                nodeId={form.source_node_id}
                selected={activePaths}
                onChange={(paths) => {
                  const field = isDelete ? "target_paths" : "source_paths";
                  setForm((f) => ({ ...f, [field]: paths }));
                }}
                multiSelect
                dirsOnly={isSync}
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
                <FormControl size="small" fullWidth error={!!showError("dest_node")}>
                  <InputLabel shrink>Destination node</InputLabel>
                  <Select
                    value={form.dest_node_id ? String(form.dest_node_id) : ""}
                    onChange={(e) => {
                      const nodeId = e.target.value ? Number(e.target.value) : undefined;
                      const node = nodes?.find((n) => n.id === nodeId);
                      setForm((f) => ({
                        ...f,
                        dest_node_id: nodeId,
                        dest_path: node?.sftp_root || "",
                      }));
                    }}
                    label="Destination node"
                    displayEmpty
                    notched
                  >
                    <MenuItem value=""><em>Select a node</em></MenuItem>
                    {(nodes ?? []).map((n) => (
                      <MenuItem key={n.id} value={String(n.id)}>
                        {n.name}
                      </MenuItem>
                    ))}
                  </Select>
                  {showError("dest_node") && (
                    <FormHelperText>{showError("dest_node")}</FormHelperText>
                  )}
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
                  error={!!showError("dest_path")}
                  helperText={showError("dest_path")}
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
              error={!!showError("schedule")}
              helperText={showError("schedule")}
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
        open={!!deleteTarget}
        title="Delete job"
        message={`Permanently delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => deleteMut.mutate(deleteTarget!.id)}
        onClose={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={!!runTarget}
        title={`Run "${runTarget?.name}"?`}
        message={runTarget ? runDetails(runTarget) : ""}
        confirmLabel={runTarget ? `Run ${opLabel(runTarget.operation)}` : "Run"}
        confirmColor={runTarget ? runConfirmColor(runTarget.operation) : "primary"}
        onConfirm={() => triggerMut.mutate(runTarget!.id)}
        onClose={() => setRunTarget(null)}
      />
    </Box>
  );
}
