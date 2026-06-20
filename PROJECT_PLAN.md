# rclone-cold-storage

A self-hosted controller/node system for waking a cold storage server, syncing files over SFTP via rclone, then powering it back down. Single Docker image, role-switchable, managed entirely through a web UI.

## Concept

- **Controller** — runs where data is "hot" (always-on). Owns schedules, node registry, file-structure cache, and orchestrates wake → sync → shutdown.
- **Node** — the cold storage target. Normally powered off. Wakes on LAN, exposes SFTP, optionally reports readiness back to the controller, shuts down after the job (or on idle timeout as a fallback).

Same Docker image for both; role set via `ROLE=controller|node` env var or toggled in the web UI.

## Tech Stack

- **Backend**: FastAPI + SQLAlchemy + SQLite
- **Scheduler**: APScheduler (cron-style jobs inside the controller)
- **Transfer engine**: rclone (SFTP remote), invoked as subprocess
- **Wake**: WOL magic packet (e.g. `wakeonlan`/`etherwake`); IPMI as an alternative if available
- **Shutdown**: SSH to node, issue `poweroff`; node-side idle-timeout self-shutdown as a safety net
- **Frontend**: HeroUI v3 (React) — decide Vite vs Next.js before scaffolding
- **Containerization**: single Dockerfile, role-aware entrypoint

## Repo Layout (proposed)

```
/backend
  /api          # FastAPI routes
  /core
    wol.py
    rclone_runner.py
    ssh_client.py
    scheduler.py
    file_cache.py   # SFTP-based node filesystem crawler
  /models       # SQLAlchemy models
  /agent        # node-side logic (runs when ROLE=node)
  db/
  main.py
/frontend
  /src
    /pages      # Dashboard, Nodes, Jobs, History, Settings
    /components
      FileBrowser/  # tree component for browsing cached node FS
  vite.config / next.config
Dockerfile
docker-compose.yml   # example: controller + node for local testing
README.md
```

## Data Model

**users**
- id, username, password_hash (bcrypt), role (`admin`/`viewer`), created_at, last_login
- First-run: if table is empty, app redirects to setup wizard to create initial admin

**api_keys**
- id, name, key_hash (SHA-256 of the full key), user_id (FK → users.id), role (`admin`/`viewer` — capped at owner's role, never elevated above it), created_at, last_used_at, expires_at (nullable)
- Full key shown exactly once at creation; only the hash is stored
- Key format: `rccs_<base64url(32 random bytes)>` — prefix makes keys identifiable in logs and scripts

**settings** (key/value store)
- key, value
- Used for: JWT signing secret (auto-generated on first run), WOL broadcast address, SSH defaults, idle-shutdown timeout, notification webhook URL, session expiry

**nodes**
- id, name, mac, ip, ssh_user, ssh_key_path, ssh_port, sftp_root, status, last_seen, last_cache_refresh

**node_file_cache**
- id, node_id, path, name, type (`file`/`dir`), size_bytes, modified_at
- Flat table; path is absolute from sftp_root; UI reconstructs tree view
- Entire cache for a node is replaced on each refresh (delete-all + re-insert)
- `last_cache_refresh` on the `nodes` row tracks when the last full crawl completed

**jobs**
- id, name, operation (`copy`/`move`/`delete`)
- source_node_id (FK → nodes.id, nullable — null means controller local filesystem)
- source_paths (JSON array of selected paths)
- dest_node_id (FK → nodes.id, nullable — null means controller local filesystem)
- dest_path (destination folder; null for delete)
- target_paths (JSON array of paths to delete; only for delete operation)
- schedule_cron (nullable — null means the job only runs when manually triggered)
- shutdown_after (bool)
- enabled
- Constraint: a job must have either a non-null `schedule_cron` OR be triggered manually ("Run now" at save time is a one-off trigger, not a field on the job itself)

**node_locks**
- node_id (FK → nodes.id, unique), locked_by_run_id (FK → runs.id), locked_at
- A job checks and atomically acquires this lock before waking a node; subsequent jobs targeting the same node queue until the lock is released

**runs** (history)
- id, job_id, started_at, finished_at, status (`success`/`failed`/`running`/`queued`)
- bytes_transferred, files_transferred, log_output
- validation_passed (bool, nullable — only relevant for move operations)
- alert_read (bool, default false — drives unread alert badges in UI)

## Authentication

**Local user table with JWT sessions (no env var required).**

- Passwords stored as bcrypt hashes in the `users` table
- JWT signed with a server secret stored in `settings` (auto-generated on first run)
- JWT delivered as `httpOnly, SameSite=Strict` cookie; refreshed on activity
- Session expiry configurable in Settings (default 30 days)
- Rate limiting on `POST /api/auth/login` (simple in-memory counter; 5 attempts → 15-minute lockout)

**First-run setup**
- If `users` table is empty on startup, all routes redirect to `/setup`
- `/setup` accepts a username + password to create the initial admin account, then redirects to login

**Roles**
- `admin` — full access: nodes CRUD, jobs CRUD, trigger runs, settings, user management
- `viewer` — read-only: can see Dashboard, Nodes, Jobs, History; cannot create/edit/delete/trigger

**User management**
- Settings → Users sub-section (admin only): list users, invite/add user, change any password, delete user, change role
- Users can change their own password from their profile

**API keys**
- Named keys created per-user from Settings → API Keys; role is set at creation and capped at the owner's role
- Authenticate via `Authorization: Bearer <key>` header — same role enforcement as JWT sessions
- Auth middleware checks Bearer header first, falls back to JWT cookie; both paths hit the same role enforcement
- Admins can view and revoke any user's keys; viewers can only manage their own
- Keys can have an optional expiry date; expired keys are rejected with `401`
- `last_used_at` updated on every successful request

**Protected endpoints**
- All API endpoints require either a valid JWT cookie or a valid Bearer API key
- Exempt: `POST /api/auth/login`, `GET /api/health`, `POST /api/setup` (only active when no users exist)

## Operations

**Copy** — transfer files from source to destination without modifying source.
- rclone `copy` source dest

**Move** — copy files to destination, validate transfer (size + checksum), then delete from source only on validation success.
- rclone `copy` source dest → verify → rclone `delete`/`purge` source paths
- If validation fails: do NOT delete source; log error; surface in UI; node stays up

**Delete** — remove selected files/folders from a node.
- If selected target is a directory → rclone `purge` (removes entire tree)
- If selected targets are individual files → rclone `delete`
- Requires explicit confirmation banner in the UI before the job is saved

## Schedules

There is no separate schedule entity. Each job owns its cron expression directly. `schedule_cron` is a standard cron string (e.g. `0 2 * * 0` = Sunday 2am).

When creating a job the user chooses:
- **Follow schedule** *(default)* — job fires per its cron expression; a valid cron is required
- **Run now** — triggers once immediately on save; if a cron is also set, future runs follow the schedule; if no cron is set, the job is manual-only thereafter

UI enforces: "Follow schedule" requires a filled, valid cron expression before the form can be submitted.

## Job Flow

1. User creates a job: selects operation, browses cached node file tree to pick source paths (and dest if copy/move), sets schedule or "run now"
2. At fire time: controller first checks SSH/SFTP reachability — if the node is already up, skip WOL
3. If node is not reachable: send WOL magic packet, then poll SSH/SFTP until reachable (timeout + retry)
4. If node never wakes within timeout → abort job, release node lock, log error, mark run `failed`, set `alert_read = false`
5. *(Optional, future)* node agent calls back `/api/nodes/{id}/ready` instead of pure polling
6. Controller acquires `node_locks` row; if already locked, run enters `queued` status and waits
7. Controller runs rclone operation per job config
8. **Copy/Move**: verify transfer (size + checksum); log result
9. **Move only**: if validation passes → delete/purge source paths; if validation fails → abort delete, log error, node stays up
10. **Delete**: execute purge/delete (no validation step)
11. On any failure: do **not** shut down node; log error, release node lock, set `alert_read = false`
12. On success: release node lock; if `shutdown_after`, controller SSHes node and runs `poweroff`
13. Node-side idle-timeout shutdown as fallback if controller never signals

## File Structure Cache

- Controller crawls the node's SFTP on demand (manual "Refresh" button on the Nodes page, or optionally auto-refresh when a node wakes — see Open Decisions)
- Crawl respects a configurable `cache_max_depth` (default: 5 levels); UI shows a "Load deeper" option for paths at the depth limit
- Entire cache for a node is replaced on refresh: delete all rows for that node, re-insert, update `nodes.last_cache_refresh`
- UI shows `last_cache_refresh` timestamp and a "Refresh" button next to the file browser
- File browser is a collapsible tree with checkboxes for multi-select; selecting a directory selects all visible children
- Cache is read-only from the controller's perspective — browsing never modifies the node

## Failure Notifications

- Every failed run sets `runs.alert_read = false`; the UI shows an unread badge on the History tab
- Settings → Notifications: optional webhook URL (compatible with ntfy, Gotify, Discord, Slack, etc.); controller POSTs a JSON payload on job failure
- Notification payload includes: job name, operation, node name, failure reason, timestamp
- No email built-in (use a webhook-to-email bridge if needed)

## Web UI (HeroUI v3)

Tabs: `Dashboard | Nodes | Jobs | History | Settings`

- **Dashboard** — card per node (status badge, last sync, next run, storage used), "Sync Now" button, progress bar on active transfers
- **Nodes** (controller only) — table of nodes; add/edit via modal + form (name, IP, MAC, SSH key, port, enabled); test-connection action; "Refresh File Cache" button with last-refreshed timestamp; delete with confirm dialog
- **Jobs** — table of jobs (node, operation badge, source/dest summary, schedule, enabled toggle); add/edit via modal:
  - Operation selector (Copy / Move / Delete)
  - Source side: node selector + file browser (tree from cache, multi-select with checkboxes, depth limit with "Load deeper")
  - Destination: node selector + path picker (for Copy/Move)
  - Cron expression input + human-readable preview ("Runs every Sunday at 2:00 AM")
  - "Run when" toggle: **Follow schedule** (default, requires cron) / **Run now**
  - Shutdown after toggle
  - Delete operation shows an extra warning banner before save
- **History** — table of runs (operation badge, status chip, duration, bytes/files transferred); unread alert badge on tab when failures exist; row click opens drawer with full rclone log and validation result; "Mark all read" button
- **Settings**
  - *General*: role selector (controller/node), WOL broadcast address, SSH defaults, idle-shutdown timeout, session expiry
  - *Notifications*: webhook URL, test-webhook button
  - *Users* (admin only): list users, add user, change role, delete user
  - *API Keys*: list own keys (name, role, last used, expiry); "Create Key" opens modal (name, role, optional expiry) and shows the full key once; revoke button per key; admins also see all users' keys with owner column
  - *Advanced*: SFTP root paths, agent callback port, cache max depth

Node role gets a reduced UI: Settings only (role/registration/local status) — no Nodes/Jobs tabs.

## Safety / Edge Cases

- Node fails to wake within timeout → abort job, release lock, log error, alert
- Node already awake at job fire time → skip WOL, proceed directly to transfer
- rclone exits non-zero → do not shut down node; retry policy configurable per job
- Move validation failure → source files preserved; error logged; node stays up
- Delete jobs require UI confirmation banner at job-creation time
- Idle-timeout fallback on node prevents it staying powered on indefinitely if controller dies mid-job
- Concurrent jobs targeting the same node acquire `node_locks`; subsequent jobs enter `queued` status and wait (no double-wake/double-shutdown)
- SSH key management: controller needs key-based auth to node for `poweroff`; setup flow in UI handles key generation/distribution
- Always confirm destructive UI actions (delete node, delete job) with a dialog
- File cache is read-only from the controller's perspective — browsing never modifies the node
- Viewer-role users cannot trigger jobs, modify nodes/jobs, or access user management

## Open Decisions (resolve early in implementation)

- [ ] Vite vs Next.js for frontend
- [ ] FastAPI serves built frontend vs. split services in dev/prod
- [ ] Polling vs. webhook callback for node-ready detection
- [x] rclone config stored per-node (SSH credentials live on the `nodes` row; no per-job rclone config)
- [ ] Does node run the full image with an agent, or just sshd + rclone-friendly base image with controller doing all orchestration?
- [ ] Auto-refresh file cache on node wake, or always manual?
- [ ] Move validation: size-only or size + checksum (checksum is slower but safer)?
- [ ] Source/dest for Copy/Move: controller-local paths supported, or only node SFTP? (affects whether rclone is always SFTP↔SFTP or can be local↔SFTP)

## Build Order

1. Repo scaffold: backend structure, Dockerfile, frontend shell (HeroUI v3 + chosen framework)
2. Data models + SQLite migrations (settings, users, nodes, node_file_cache, jobs, node_locks, runs)
3. Authentication: first-run setup wizard, login/logout endpoints, JWT middleware, API key creation/revocation endpoints, unified Bearer + cookie auth middleware, role enforcement
4. Core modules: `wol.py`, `ssh_client.py`, `rclone_runner.py` (each independently testable via CLI)
5. File cache: `file_cache.py` SFTP crawler (CLI-testable) + REST endpoint to trigger/serve cache
6. Scheduler integration (APScheduler) + node_locks + "run now" trigger
7. REST API: nodes CRUD, jobs CRUD, runs/history, manual trigger, file cache endpoints, notification webhook
8. Frontend: Login/setup → Nodes page (+ file cache refresh) → Jobs page (with file browser) → Dashboard → History → Settings (general + notifications + users + API keys)
9. Role-switch logic (controller vs. node behavior in entrypoint + UI)
10. docker-compose for local controller+node testing
11. Idle-timeout fallback + failure-path hardening (safety/edge-case list above)
