FROM python:3.12-slim

WORKDIR /app

# Install curl for healthcheck
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN pip install uv

COPY pyproject.toml pyproject.toml
COPY uv.lock uv.lock

RUN uv sync --frozen

COPY fast_sync_backend/ ./fast_sync_backend/

RUN mkdir -p /data

CMD ["uv", "run", "uvicorn", "fast_sync_backend.main:app", "--host", "0.0.0.0", "--port", "32400"]
