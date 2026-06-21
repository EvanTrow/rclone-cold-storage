FROM python:3.12-slim AS backend-base

# rclone from the distro is too old (Debian ships ~1.60, which lacks newer
# `test speed` flags); install the official release instead. Bump RCLONE_VERSION
# to upgrade — versioned debs live at https://downloads.rclone.org/.
ARG RCLONE_VERSION=1.74.3
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssh-client \
        ca-certificates \
        curl \
    && dpkgArch="$(dpkg --print-architecture)" \
    && case "$dpkgArch" in \
         amd64) rcArch=amd64 ;; \
         arm64) rcArch=arm64 ;; \
         armhf) rcArch=arm-v7 ;; \
         *) echo "unsupported architecture: $dpkgArch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${rcArch}.deb" -o /tmp/rclone.deb \
    && apt-get install -y --no-install-recommends /tmp/rclone.deb \
    && rm -f /tmp/rclone.deb \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/* \
    && rclone version

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Frontend build ─────────────────────────────────────────────────────────
FROM node:22-slim AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ── Final image ────────────────────────────────────────────────────────────
FROM backend-base AS final

WORKDIR /app
COPY backend/ ./backend/
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

ENV ROLE=controller
ENV DATABASE_URL=sqlite+aiosqlite:////data/rccs.db

VOLUME /data

EXPOSE 8000

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
