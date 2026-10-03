/**
 * Visual-QA fixtures for the native 3D terrain (docs/plans/native-terrain.md):
 * a GeoPDF overlay and a trail at Yosemite Valley and at Mont-Sainte-Anne, so
 * the screenshot matrix can show PDF maps and trails draped on the relief.
 * Served to a QA build (EXPO_PUBLIC_TERRAIN_QA=1) and imported through the
 * deep-link harness (`inukshuk://?tqa=1&pdf=<url>&gpx=<url>`).
 *
 * Usage: npx tsx scripts/qa/terrain-qa-fixtures.ts <outDir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { parseGeoPdf } from '../../src/core/geo/geopdf';
import { attachGeoViewport } from '../../src/core/geo/geopdf/write';

type Bbox = [number, number, number, number]; // w, s, e, n

interface Place {
  id: string;
  title: string;
  bbox: Bbox;
  trail: [number, number][]; // [lat, lng]
}

const PLACES: Place[] = [
  {
    id: 'yosemite',
    title: 'Yosemite Valley — QA overlay',
    bbox: [-119.66, 37.71, -119.52, 37.765],
    trail: [
      [37.7323, -119.5577], // Happy Isles
      [37.7296, -119.5521],
      [37.7272, -119.544], // Vernal Fall
      [37.7262, -119.5395],
      [37.7246, -119.5338], // Nevada Fall
      [37.7319, -119.5299],
      [37.7405, -119.5318],
      [37.7459, -119.5332], // Half Dome
    ],
  },
  {
    id: 'mont-sainte-anne',
    title: 'Mont-Sainte-Anne — QA overlay',
    bbox: [-70.96, 47.045, -70.86, 47.105],
    trail: [
      [47.0874, -70.8947],
      [47.0851, -70.8986],
      [47.0826, -70.9013],
      [47.0801, -70.9035],
      [47.0779, -70.9052],
      [47.0756, -70.9067], // summit
    ],
  },
];

async function overlayPdf(p: Place): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const W = 792;
  const H = 612;
  const page = doc.addPage([W, H]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const m = 24;
  const fw = W - 2 * m;
  const fh = H - 2 * m;
  page.drawRectangle({ x: m, y: m, width: fw, height: fh, color: rgb(0.97, 0.95, 0.88) });
  // A map-like grid every 1/10 of the frame, with a heavier frame.
  for (let i = 1; i < 10; i++) {
    const x = m + (fw * i) / 10;
    const y = m + (fh * i) / 10;
    page.drawLine({
      start: { x, y: m },
      end: { x, y: m + fh },
      thickness: 0.8,
      color: rgb(0.3, 0.45, 0.7),
    });
    page.drawLine({
      start: { x: m, y },
      end: { x: m + fw, y },
      thickness: 0.8,
      color: rgb(0.3, 0.45, 0.7),
    });
  }
  // Concentric "contours" so the drape reads on slopes.
  for (let r = 30; r < 300; r += 30) {
    page.drawEllipse({
      x: m + fw * 0.62,
      y: m + fh * 0.55,
      xScale: r * 1.4,
      yScale: r,
      borderColor: rgb(0.62, 0.42, 0.2),
      borderWidth: 1.2,
    });
  }
  page.drawRectangle({
    x: m,
    y: m,
    width: fw,
    height: fh,
    borderColor: rgb(0.15, 0.15, 0.15),
    borderWidth: 4,
  });
  page.drawText(p.title, {
    x: m + 18,
    y: m + fh - 34,
    size: 22,
    font,
    color: rgb(0.15, 0.15, 0.15),
  });
  const [w, s, e, n] = p.bbox;
  attachGeoViewport(
    doc,
    page,
    { x: m, y: m, w: fw, h: fh },
    { topLeft: [w, n], topRight: [e, n], bottomRight: [e, s], bottomLeft: [w, s] },
  );
  const bytes = await doc.save();
  const parsed = parseGeoPdf(bytes);
  if (parsed.georeferences.length !== 1) throw new Error(`${p.id}: ${parsed.warnings.join('; ')}`);
  return bytes;
}

function trailGpx(p: Place): string {
  const pts: string[] = [];
  for (let i = 0; i + 1 < p.trail.length; i++) {
    const [a, b] = [p.trail[i]!, p.trail[i + 1]!];
    for (let k = 0; k < 12; k++) {
      const t = k / 12;
      pts.push(
        `<trkpt lat="${(a[0] + (b[0] - a[0]) * t).toFixed(6)}" lon="${(a[1] + (b[1] - a[1]) * t).toFixed(6)}"/>`,
      );
    }
  }
  const last = p.trail[p.trail.length - 1]!;
  pts.push(`<trkpt lat="${last[0]}" lon="${last[1]}"/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="inukshuk-qa" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${p.title.replace(' — QA overlay', '')} trail</name></metadata>
<trk><name>QA trail</name><trkseg>
${pts.join('\n')}
</trkseg></trk></gpx>
`;
}

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) throw new Error('usage: terrain-qa-fixtures.ts <outDir>');
  mkdirSync(out, { recursive: true });
  for (const p of PLACES) {
    writeFileSync(join(out, `${p.id}.pdf`), await overlayPdf(p));
    writeFileSync(join(out, `${p.id}.gpx`), trailGpx(p));
  }
  console.log(`wrote ${PLACES.length * 2} fixtures to ${out}`);
}

void main();
