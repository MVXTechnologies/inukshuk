# Python runtime for the climbing-crags pipeline (../climbing.sh). The NAS's
# own python3 has no pip; the OpenBeta export is Parquet, hence pyarrow.
#   docker build -t inukshuk-climbing-py:1 infra/tiles/nas/climbing
FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d
RUN pip install --no-cache-dir pyarrow==25.0.1 certifi==2026.7.22
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
