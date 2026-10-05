# GDAL (exact pixel-window crops that keep PROJ's GeoTIFF metadata) + pyproj
# 3.8.0 / PROJ 9.8.1 (the validation gate: the same PROJ as the app) for
# ../projgrids.sh.
#   docker build -t inukshuk-projgrids:1 infra/tiles/nas/projgrids
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.11.4
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages pyproj==3.8.0 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
