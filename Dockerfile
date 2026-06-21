FROM python:3.12-slim AS backend-base

RUN apt-get update && apt-get install -y --no-install-recommends \
    rclone \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

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
