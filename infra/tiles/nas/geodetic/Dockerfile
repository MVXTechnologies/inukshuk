# Python runtime for the geodetic-points pipeline (../geodetic.sh) and the
# Québec datasheet harvester (enrich_qc.py). The NAS's own python3 has no pip
# and its CA bundle lacks Sectigo R46 (Québec's servers), hence an image.
#   docker build -t inukshuk-geodetic-py:1 infra/tiles/nas/geodetic
FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d
RUN pip install --no-cache-dir pypdf==6.19.0 pyproj==3.8.0 certifi==2026.7.22
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
