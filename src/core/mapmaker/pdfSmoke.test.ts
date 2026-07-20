import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Smoke test for the pdf-lib dependency: everything the made-map composer
 * relies on (page creation, vector ops, standard-14 fonts without fontkit,
 * Uint8Array save) works in a plain-JS environment. Hermes has the same
 * surface (no Node Buffer, no DOM), so passing here is a strong signal the
 * library behaves on-device.
 */
test('pdf-lib creates a page with vector ops and standard fonts', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4 portrait, points
  const font = await doc.embedFont(StandardFonts.Helvetica);

  page.drawLine({
    start: { x: 24, y: 100 },
    end: { x: 200, y: 100 },
    thickness: 1,
    color: rgb(0.2, 0.2, 0.2),
  });
  page.drawText('Inukshuk smoke', { x: 24, y: 110, size: 12, font });

  const bytes = await doc.save();
  expect(bytes).toBeInstanceOf(Uint8Array);
  // "%PDF" header.
  expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF');
  expect(bytes.length).toBeGreaterThan(500);
});
