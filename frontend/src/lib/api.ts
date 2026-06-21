async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });

  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    if (body?.detail === "setup_required") {
      window.location.href = "/setup";
    }
  }

  if (res.status === 401) {
    window.location.href = "/login";
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err?.detail ?? "Request failed");
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

const json = (body: unknown) => JSON.stringify(body);

// Auth
export const authApi = {
  me: () => request<{ id: number; username: string; role: string }>("/api/auth/me"),
  login: (username: string, password: string) =>
    request("/api/auth/login", { method: "POST", body: json({ username, password }) }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
};

// Setup
export const setupApi = {
  status: () => request<{ needs_setup: boolean }>("/api/setup/status"),
  create: (username: string, password: string) =>
    request("/api/setup", { method: "POST", body: json({ username, password }) }),
};

// Nodes
export const nodesApi = {
  list: () => request<Node[]>("/api/nodes"),
  get: (id: number) => request<Node>(`/api/nodes/${id}`),
  create: (body: NodeCreate) =>
    request<Node>("/api/nodes", { method: "POST", body: json(body) }),
  update: (id: number, body: Partial<NodeCreate>) =>
    request<Node>(`/api/nodes/${id}`, { method: "PATCH", body: json(body) }),
  delete: (id: number) =>
    request(`/api/nodes/${id}`, { method: "DELETE" }),
  deleteSSHKey: (id: number) =>
    request(`/api/nodes/${id}/ssh-key`, { method: "DELETE" }),
  testConnection: (id: number) =>
    request<TestConnectionResult>(`/api/nodes/${id}/test-connection`, { method: "POST" }),
  getFiles: (id: number) =>
    request<CacheEntry[]>(`/api/nodes/${id}/files`),
  refreshFiles: (id: number) =>
    request<{ files: number; dirs: number }>(`/api/nodes/${id}/files/refresh`, { method: "POST" }),
  wake: (id: number) =>
    request(`/api/nodes/${id}/wake`, { method: "POST" }),
  shutdown: (id: number) =>
    request(`/api/nodes/${id}/shutdown`, { method: "POST" }),
};

// Jobs
export const jobsApi = {
  list: () => request<Job[]>("/api/jobs"),
  get: (id: number) => request<Job>(`/api/jobs/${id}`),
  create: (body: JobCreate) =>
    request<Job>("/api/jobs", { method: "POST", body: json(body) }),
  update: (id: number, body: Partial<JobCreate>) =>
    request<Job>(`/api/jobs/${id}`, { method: "PATCH", body: json(body) }),
  delete: (id: number) =>
    request(`/api/jobs/${id}`, { method: "DELETE" }),
  trigger: (id: number) =>
    request(`/api/jobs/${id}/trigger`, { method: "POST" }),
};

// Runs
export const runsApi = {
  list: (params?: { job_id?: number; status?: string; unread_only?: boolean }) => {
    const q = new URLSearchParams();
    if (params?.job_id !== undefined) q.set("job_id", String(params.job_id));
    if (params?.status) q.set("status", params.status);
    if (params?.unread_only) q.set("unread_only", "true");
    return request<Run[]>(`/api/runs?${q}`);
  },
  get: (id: number, logFrom = 0) =>
    request<Run>(`/api/runs/${id}${logFrom > 0 ? `?log_from=${logFrom}` : ''}`),
  cancel: (id: number) => request(`/api/runs/${id}/cancel`, { method: "POST" }),
  markAllRead: () => request("/api/runs/mark-all-read", { method: "POST" }),
  markRead: (id: number) => request(`/api/runs/${id}/read`, { method: "PATCH" }),
  clearAll: () => request<{ deleted: number }>("/api/runs", { method: "DELETE" }),
};

// Settings
export const settingsApi = {
  get: () => request<Record<string, string>>("/api/settings"),
  update: (body: Record<string, string>) =>
    request("/api/settings", { method: "PUT", body: json(body) }),
  testWebhook: () =>
    request<{ status_code: number; ok: boolean }>("/api/settings/test-webhook", { method: "POST" }),
  listUsers: () => request<UserRecord[]>("/api/settings/users"),
  createUser: (body: { username: string; password: string; role: string }) =>
    request<UserRecord>("/api/settings/users", { method: "POST", body: json(body) }),
  updateUser: (id: number, body: { password?: string; role?: string }) =>
    request<UserRecord>(`/api/settings/users/${id}`, { method: "PUT", body: json(body) }),
  deleteUser: (id: number) =>
    request(`/api/settings/users/${id}`, { method: "DELETE" }),
  listApiKeys: () => request<ApiKeyRecord[]>("/api/settings/api-keys"),
  createApiKey: (body: { name: string; role: string; expires_at?: string }) =>
    request<ApiKeyRecord & { key: string }>("/api/settings/api-keys", { method: "POST", body: json(body) }),
  revokeApiKey: (id: number) =>
    request(`/api/settings/api-keys/${id}`, { method: "DELETE" }),
};

// Types
export interface Node {
  id: number;
  name: string;
  mac: string;
  ip: string;
  ssh_user: string;
  ssh_key_path: string | null;
  has_ssh_key: boolean;
  ssh_port: number;
  sftp_root: string;
  allow_shutdown: boolean;
  status: "online" | "offline" | "waking" | "unknown";
  last_seen: string | null;
  last_cache_refresh: string | null;
}

export interface NodeCreate {
  name: string;
  mac: string;
  ip: string;
  ssh_user: string;
  ssh_key_content?: string;
  ssh_port?: number;
  sftp_root?: string;
  allow_shutdown?: boolean;
}

/** One speed measurement for a given file size. Speeds are bytes/sec. */
export interface SpeedSample {
  size_bytes: number;
  num_files: number;
  upload_bps: number;
  download_bps: number;
}

export interface SpeedTest {
  /** Peak speeds across all samples, bytes/sec. */
  upload_bps: number;
  download_bps: number;
  samples: SpeedSample[];
  error: string | null;
}

export interface TestConnectionResult {
  reachable: boolean;
  error: string | null;
  /** null when SSH was unreachable, so the speed test was skipped. */
  speed: SpeedTest | null;
}

export interface CacheEntry {
  id: number;
  path: string;
  name: string;
  type: "file" | "dir";
  size_bytes: number | null;
  modified_at: string | null;
}

export interface Job {
  id: number;
  name: string;
  operation: "copy" | "move" | "sync" | "delete";
  source_node_id: number | null;
  source_paths: string[] | null;
  dest_node_id: number | null;
  dest_path: string | null;
  target_paths: string[] | null;
  schedule_cron: string | null;
  shutdown_after: boolean;
  enabled: boolean;
  delete_on_success: boolean;
}

export interface JobCreate {
  name: string;
  operation: "copy" | "move" | "sync" | "delete";
  source_node_id?: number;
  source_paths?: string[];
  dest_node_id?: number;
  dest_path?: string;
  target_paths?: string[];
  schedule_cron?: string;
  shutdown_after?: boolean;
  enabled?: boolean;
  delete_on_success?: boolean;
  run_now?: boolean;
}

export interface Run {
  id: number;
  job_id: number | null;
  job_name: string | null;
  started_at: string | null;
  finished_at: string | null;
  status: "success" | "failed" | "running" | "queued" | "cancelled";
  bytes_transferred: number | null;
  files_transferred: number | null;
  validation_passed: boolean | null;
  alert_read: boolean;
  log_output?: string;
  log_length?: number;
}

export interface UserRecord {
  id: number;
  username: string;
  role: "admin" | "viewer";
  created_at: string | null;
  last_login: string | null;
}

export interface ApiKeyRecord {
  id: number;
  name: string;
  role: "admin" | "viewer";
  user_id: number;
  owner_username?: string;
  created_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
}
