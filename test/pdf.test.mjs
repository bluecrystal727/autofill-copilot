// Run with: node --test test/
// Builds a small real PDF in memory and extracts it with the bundled pdf.js build.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractPdfText, extractResumeText } from '../lib/resume.js';

function makePdf(lines, linkUrl) {
  const content = [
    'BT',
    '/F1 12 Tf',
    '14 TL',
    '72 720 Td',
    ...lines.map((l, i) => `${i ? 'T* ' : ''}(${l.replace(/[()\\]/g, '\\$&')}) Tj`),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    `<< /Type /Annot /Subtype /Link /Rect [72 600 300 620] /Border [0 0 0] /A << /S /URI /URI (${linkUrl}) >> >>`,
  ];

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

const LINES = ['Jane Doe', 'jane@example.com', 'Senior Engineer at Acme Robotics (2021 - Present)', 'Skills: Go, TypeScript, Kubernetes'];

test('extractPdfText rebuilds lines and appends link URLs', async () => {
  const text = await extractPdfText(makePdf(LINES, 'https://linkedin.com/in/janedoe'));
  for (const line of LINES) assert.match(text, new RegExp(`^${line.replace(/[()]/g, '\\$&')}$`, 'm'));
  assert.match(text, /\n\nLinks:\nhttps:\/\/linkedin\.com\/in\/janedoe$/);
});

test('extractResumeText routes .pdf files and rejects image-only/empty PDFs', async () => {
  const good = makePdf(LINES, 'https://example.com');
  const file = { name: 'cv.pdf', size: good.length, arrayBuffer: async () => good.buffer.slice(good.byteOffset, good.byteOffset + good.byteLength) };
  assert.match(await extractResumeText(file), /Senior Engineer/);

  const empty = makePdf([''], 'https://example.com');
  const emptyFile = { name: 'scan.pdf', size: empty.length, arrayBuffer: async () => empty.buffer.slice(empty.byteOffset, empty.byteOffset + empty.byteLength) };
  await assert.rejects(extractResumeText(emptyFile), /scanned image/);
});

test('extractResumeText handles plain text and rejects .doc', async () => {
  const txt = new TextEncoder().encode('Jane Doe\nSoftware engineer with 7 years of experience in Go and TypeScript.');
  assert.match(await extractResumeText({ name: 'cv.txt', size: txt.length, arrayBuffer: async () => txt.buffer }), /7 years/);
  await assert.rejects(extractResumeText({ name: 'cv.doc', size: 10, arrayBuffer: async () => new ArrayBuffer(10) }), /\.doc files are not supported/);
});
