# rclone-cold-storage

A self-hosted **controller/node** system for waking a cold-storage server on the LAN, syncing files to/from it over SFTP via [rclone](https://rclone.org/), then powering it back down — all orchestrated from a web UI. Ships as a **single Docker image** whose behavior is switched by a `ROLE` environment variable.

## Concept

| Role | Where it runs | Responsibilities |
|------|---------------|------------------|
| **Controller** | An always-on host where data is "hot" | Owns schedules, the node registry, the cached node filesystem, and the orchestration loop: wake → sync → validate → shut down. Serves the web UI. |
| **Node** | The cold-storage target (normally powered off) | Wakes on LAN (Wake-on-LAN), exposes SFTP, and self-powers-off after an idle timeout as a safety net. |

The same image runs both roles; set `ROLE=controller` or `ROLE=node`.

### Job flow

1. A job fires (cron schedule or manual "Run now").
2. The controller checks whether the node is already reachable over SSH/SFTP — if so, it skips Wake-on-LAN.
3. Otherwise it sends a WOL magic packet and polls SSH until the node is reachable (with timeout).
4. It acquires a per-node lock (concurrent jobs on the same node queue rather than double-waking it).
5. It runs the rclone operation:
   - **Copy** — transfer source → dest, leaving the source intact.
   - **Move** — copy, then verify (size + `rclone check --checksum`), and **only delete the source if validation passes**.
   - **Delete** — `purge` a directory tree or `delete` individual files.
6. On success it releases the lock and, if **shutdown-after** is set, SSHes in and runs `poweroff`.
7. On any failure it leaves the node powered on, logs the rclone output, marks the run failed, and raises an unread alert (and fires the notification webhook if configured).

## Features

- Web UI (Dashboard / Nodes / Jobs / History / Settings) with role-aware access.
- Wake-on-LAN + SSH-based shutdown, with a node-side idle-timeout self-shutdown fallback.
- Cron-scheduled or manually triggered copy / move / delete jobs.
- Checksum-validated moves — source is never deleted unless the copy verifies.
- SFTP filesystem cache with a checkbox tree browser for picking source/dest paths.
- Local users (bcrypt + JWT httpOnly cookies), role-based access (`admin` / `viewer`), and named API keys (`Authorization: Bearer rccs_…`).
- Failure notifications via a generic webhook (ntfy, Gotify, Discord, Slack, …).

## Tech stack

- **Backend:** FastAPI · SQLAlchemy (async) · SQLite (aiosqlite) · APScheduler · asyncssh · rclone (subprocess)
- **Frontend:** Vite · React 19 · TypeScript · MUI v6 + MUI X Tree View v7 · Tailwind CSS v4 (layout utilities)
- **Auth:** bcrypt passwords · JWT cookies · SHA-256-hashed API keys
- **Packaging:** single multi-stage Dockerfile (Python 3.12 + bundled `rclone`/`openssh-client`, frontend built with Node 22 and served by FastAPI)

---

## Deployment

The supported deployment is Docker. The image bundles `rclone`, `openssh-client`, the FastAPI backend, and the pre-built frontend; FastAPI serves the SPA in production (no separate web server needed).

### With docker-compose (controller + node)

The included [`docker-compose.yml`](docker-compose.yml) brings up a controller and a sample node:

```bash
docker compose up -d --build
```

| Service | Role | Published port | Data volume |
|---------|------|----------------|-------------|
| `controller` | `controller` | `8000` → UI/API | `controller-data:/data` |
| `node` | `node` | `8001` → `8000` | `node-data:/data`, plus `/srv/cold-storage:/mnt/storage:ro` |

Open the controller UI at **http://localhost:8000** and complete the first-run setup (below).

> **Wake-on-LAN caveat.** WOL magic packets are L2 broadcasts and will not cross Docker's default bridge network onto your physical LAN. In real deployments, run the **controller** with `network_mode: host` (Linux) so it can broadcast to the node's NIC, and make sure WOL is enabled in the node's BIOS/UEFI and NIC settings. The in-compose `node` service is for exercising the app's flow locally — a real node is a separate physical machine that boots its own OS and runs sshd + this image in `ROLE=node`.

### Single container

Controller only:

```bash
docker build -t rclone-cold-storage .
docker run -d --name rccs-controller \
  -e ROLE=controller \
  -e DATABASE_URL=sqlite+aiosqlite:////data/rccs.db \
  -v rccs-controller-data:/data \
  -p 8000:8000 \
  rclone-cold-storage
```

Node (on the cold-storage machine; mount the storage you want exposed over SFTP):

```bash
docker run -d --name rccs-node \
  -e ROLE=node \
  -v rccs-node-data:/data \
  -v /srv/cold-storage:/mnt/storage \
  -p 8000:8000 \
  rclone-cold-storage
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ROLE` | `controller` | `controller` or `node`. Controllers start the scheduler + node-status poller; nodes start the idle-shutdown monitor and expose a reduced UI. |
| `DATABASE_URL` | bundled `backend/db/rccs.db` | Async SQLAlchemy URL. In Docker, point at the persistent volume, e.g. `sqlite+aiosqlite:////data/rccs.db`. |

The JWT signing secret is **auto-generated on first run** and stored in the database — no secret env var to manage. Other operational settings (WOL broadcast address, SSH defaults, idle-shutdown timeout, session expiry, cache depth, notification webhook) live in the database and are edited from **Settings**; their defaults are in [`backend/core/config.py`](backend/core/config.py).

### Persistence

All state — users, nodes, jobs, run history, the SFTP cache, and the JWT secret — lives in the SQLite database. Persist `/data` (or wherever `DATABASE_URL` points) across container restarts; everything else in the image is disposable.

---

## Setup

### 1. First-run wizard

On first launch the `users` table is empty, so the API reports `needs_setup` and the UI routes you to **`/setup`**. Create the initial **admin** account (username + password, minimum 8 characters). All other routes are locked until this is done.

### 2. Register a node

As an admin, go to **Nodes → Add node** and provide:

- **Name**, **IP**, **MAC address** (for WOL)
- **SSH user / port** and the **SFTP root** the node exposes
- An SSH key for key-based auth (used for connectivity checks and `poweroff`)

Use **Test connection** to confirm SSH/SFTP reachability, then **Refresh file cache** to crawl the node's filesystem (respects the configurable cache depth, default 5 levels) so it's browsable when building jobs.

> The controller needs key-based SSH access to the node to issue `poweroff`. Configure passwordless `sudo poweroff` for the SSH user on the node.

### 3. Create a job

**Jobs → Add job:**

1. Pick the operation — **Copy**, **Move**, or **Delete**.
2. Choose the **source** node and select paths from the cached file tree (multi-select checkboxes; directories cascade to children).
3. For copy/move, choose the **destination** node + path.
4. Set a **cron** expression (e.g. `0 2 * * 0` = Sundays at 02:00) or choose **Run now** for a one-off / manual-only job.
5. Toggle **Shutdown after** to power the node down when the job finishes successfully.
6. **Delete** jobs require acknowledging a warning banner before saving.

---

## Usage

### Web UI

| Tab | What it does |
|-----|--------------|
| **Dashboard** | One card per node: status, last sync, next scheduled run, and a "Sync now" trigger. |
| **Nodes** *(controller, admin)* | CRUD nodes, test connections, refresh the file cache, wake/shutdown manually. |
| **Jobs** | CRUD jobs with the file-browser-based source/dest picker, cron input, and shutdown toggle. |
| **History** | Run log with status, duration, bytes/files transferred, and the full rclone output per run. Failed runs raise an unread badge; "Mark all read" clears it. |
| **Settings** | Role (controller/node), WOL/SSH defaults, idle-shutdown timeout, session expiry, cache depth, notification webhook, **Users** (admin), and **API keys**. |

Nodes running in `ROLE=node` show a reduced UI (Settings/status only — no Nodes/Jobs).

### Roles

- **admin** — full access: manage nodes, jobs, settings, users, and trigger runs.
- **viewer** — read-only: Dashboard, Nodes, Jobs, and History; cannot create, edit, delete, or trigger.

### API access & API keys

Every endpoint requires either the JWT session cookie or a Bearer API key; the only exemptions are `POST /api/auth/login`, `GET /api/health`, and `POST /api/setup` (active only while no users exist).

Create named keys under **Settings → API Keys**. The full key (`rccs_<base64url>`) is shown **once** at creation — only its SHA-256 hash is stored. A key's role is capped at its owner's role and can carry an optional expiry. Use it as:

```bash
curl -H "Authorization: Bearer rccs_xxxxxxxx" http://localhost:8000/api/nodes
```

### REST API overview

Interactive docs are served at **`/docs`** (Swagger UI) and **`/redoc`**. Key route groups:

| Prefix | Endpoints |
|--------|-----------|
| `/api/setup` | `GET /status`, `POST ` (create first admin) |
| `/api/auth` | `POST /login`, `POST /logout`, `GET /me` |
| `/api/nodes` | CRUD · `POST /{id}/test-connection` · `POST /{id}/wake` · `POST /{id}/shutdown` · `GET /{id}/files` · `POST /{id}/files/refresh` |
| `/api/jobs` | CRUD · `POST /{id}/trigger` |
| `/api/runs` | `GET` (history) · `GET /{id}` · `POST /mark-all-read` · `POST /{id}/cancel` · `PATCH /{id}/read` |
| `/api/settings` | `GET`/`PUT` settings · `POST /test-webhook` · `/users` CRUD · `/api-keys` CRUD |
| `/api/health` | `GET /health` (unauthenticated) |

---

## Local development

The backend and frontend run as two processes in dev: the Vite dev server proxies `/api` to the backend on port 8000 (see [`vite.config.ts`](frontend/vite.config.ts)). You'll also need `rclone` and an SSH client on your PATH for the transfer/wake/shutdown features to work end-to-end.

### Prerequisites

- Python 3.12+
- Node 22+
- `rclone` and `openssh-client` available on your PATH (bundled automatically in the Docker image)

### Backend

```bash
cd backend
python -m venv .venv
# Windows:  .venv\Scripts\activate
# Unix:     source .venv/bin/activate
pip install -r requirements.txt

# Run from the repo root so the `backend` package imports resolve:
cd ..
uvicorn backend.main:app --reload --port 8000
```

This serves the API on `http://localhost:8000`. The SQLite schema is created automatically on startup (`init_db`), defaulting to `backend/db/rccs.db` unless `DATABASE_URL` is set. Set `ROLE=controller` (default) to run the scheduler, or `ROLE=node` to run the agent's idle monitor.

> On Windows the app automatically switches to the `SelectorEventLoop` policy, which `asyncssh` requires.

### Frontend

```bash
cd frontend
npm install
npm run dev      # Vite dev server (proxies /api → http://localhost:8000)
```

Visit the URL Vite prints (typically `http://localhost:5173`). With both processes running, complete the `/setup` wizard to create your admin account.

### Production build

```bash
cd frontend
npm run build    # type-checks (tsc -b) then builds to frontend/dist/
```

When `frontend/dist/` exists, FastAPI mounts it and serves the SPA — so a single backend process serves both the API and the UI. This is exactly what the Docker image does.

### Project layout

```
backend/
  api/        FastAPI routers (auth, setup, nodes, files, jobs, runs, settings, health)
  core/       wol · ssh_client · rclone_runner · file_cache · scheduler ·
              job_runner · node_status · security · config
  models/     SQLAlchemy models (users, api_keys, nodes, node_file_cache,
              jobs, node_locks, runs, settings)
  agent/      node-side idle-shutdown monitor (ROLE=node)
  db/         async session + SQLite
  main.py     app factory, role-aware lifespan, SPA serving
frontend/
  src/pages/        Login · Setup · Dashboard · Nodes · Jobs · History · Settings
  src/components/    FileBrowser (MUI X tree) · Layout · ConfirmDialog
  src/lib/           api client · react-query client
Dockerfile           multi-stage: frontend build → Python runtime + rclone/ssh
docker-compose.yml   sample controller + node
PROJECT_PLAN.md      full design spec and data model
```

See [`PROJECT_PLAN.md`](PROJECT_PLAN.md) for the complete design rationale, data model, and safety/edge-case handling.
