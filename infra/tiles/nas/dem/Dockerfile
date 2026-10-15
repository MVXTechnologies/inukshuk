# Python runtime for the DEM pipeline (../dem.sh): the WebP → PNG transcoder
# and the LiDAR mask need Pillow (WebP + zlib); everything else is the
# standard library. Same pinned base as ../geodetic/Dockerfile.
#   docker build -t inukshuk-dem-py:1 infra/tiles/nas/dem
FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d
RUN pip install --no-cache-dir pillow==12.3.0
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
