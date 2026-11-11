// Run with: node --test test/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { DocxError, decodeXmlEntities, extractDocxText, parseRels, readZipDirectory, readZipFiles, wordXmlToText } from '../lib/docx.js';
import { createDocx } from '../lib/docx-writer.js';
import { detectResumeType, extractPdfText } from '../lib/resume.js';
import { createResumePdf } from '../lib/pdf-writer.js';
import { createJobHistoryXlsx } from '../lib/xlsx.js';

// ---------- build a minimal but real .docx (ZIP) in memory ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function makeZip(files, { store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const comp = store ? data : deflateRawSync(data);
    const method = store ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const p = (...runs) => `<w:p>${runs.join('')}</w:p>`;
const r = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const bullet = (t) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${r(t)}</w:p>`;

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
${p(r('Jane '), r('Doe'))}
${p(r('jane@example.com'), '<w:r><w:tab/></w:r>', r('+1 555 0100'))}
${p('<w:hyperlink r:id="rId9">', r('LinkedIn'), '</w:hyperlink>')}
${p(r('EXPERIENCE'))}
${p(r('Senior Engineer &amp; Lead – Acme &lt;Robotics&gt;'))}
${bullet('Built Go services handling 10k req/s')}
${bullet('Mentored 4 engineers')}
<w:tbl><w:tr><w:tc>${p(r('Skills'))}</w:tc><w:tc>${p(r('TypeScript, Go'))}</w:tc></w:tr></w:tbl>
${p('<w:del w:id="1"><w:r><w:delText>deleted words</w:delText></w:r></w:del>', r('Kept text'))}
${p(r('Line one'), '<w:r><w:br/></w:r>', r('Line two'))}
${p(r('Caf&#233; &#x2713;'))}
</w:body></w:document>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://linkedin.com/in/janedoe?a=1&amp;b=2" TargetMode="External"/>
</Relationships>`;

const HEADER_XML = `<w:hdr ${W}>${p(r('Jane Doe – Resume'))}</w:hdr>`;

function sampleDocx(opts) {
  return makeZip(
    {
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': DOCUMENT_XML,
      'word/_rels/document.xml.rels': RELS_XML,
      'word/styles.xml': '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"/></w:styles>',
      'word/header1.xml': HEADER_XML,
      'word/media/logo.png': new Uint8Array([0, 1, 2, 255]),
    },
    opts
  );
}

function readStoredEntry(bytes, name) {
  const entry = readZipDirectory(bytes).get(name);
  assert.ok(entry, `missing ZIP entry ${name}`);
  assert.equal(entry.method, 0, 'test expects an uncompressed ZIP entry');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLength = view.getUint16(entry.offset + 26, true);
  const extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  return new TextDecoder().decode(bytes.subarray(start, start + entry.compSize));
}

// ---------- tests ----------

test('extracts paragraphs, runs, tabs, bullets, tables and entities from a deflated .docx', async () => {
  const text = await extractDocxText(sampleDocx());
  assert.match(text, /^Jane Doe – Resume/m, 'header comes first');
  assert.match(text, /^Jane Doe$/m, 'runs are joined');
  assert.match(text, /jane@example\.com\t\+1 555 0100/, 'tabs preserved');
  assert.match(text, /Senior Engineer & Lead – Acme <Robotics>/, 'XML entities decoded');
  assert.match(text, /^- Built Go services handling 10k req\/s$/m, 'numbered paragraphs become bullets');
  assert.match(text, /^- Mentored 4 engineers$/m);
  assert.match(text, /Skills\tTypeScript, Go/, 'table cells separated by tabs');
  assert.match(text, /^Line one\nLine two$/m, 'line breaks preserved');
  assert.match(text, /Café ✓/, 'numeric entities decoded');
  assert.match(text, /Kept text/);
  assert.doesNotMatch(text, /deleted words/, 'tracked deletions are dropped');
});

test('appends external hyperlink targets (e.g. LinkedIn URL hidden behind link text)', async () => {
  const text = await extractDocxText(sampleDocx());
  assert.match(text, /\n\nLinks:\nhttps:\/\/linkedin\.com\/in\/janedoe\?a=1&b=2$/);
});

test('works with stored (uncompressed) zip entries too', async () => {
  const text = await extractDocxText(sampleDocx({ store: true }));
  assert.match(text, /Senior Engineer & Lead/);
});

test('accepts an ArrayBuffer', async () => {
  const bytes = sampleDocx();
  const text = await extractDocxText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.match(text, /Jane Doe/);
});

test('rejects legacy .doc (OLE) files with a helpful message', async () => {
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(100).fill(0)]);
  await assert.rejects(extractDocxText(ole), (e) => e instanceof DocxError && /\.doc files are not supported/.test(e.message));
});

test('rejects non-zip input and zips without word/document.xml', async () => {
  await assert.rejects(extractDocxText(new TextEncoder().encode('just some text, definitely not a zip file')), DocxError);
  await assert.rejects(extractDocxText(makeZip({ 'hello.txt': 'hi' })), /not a Word \.docx/);
});

test('multi-row tables become one line per row with tab-separated cells', () => {
  const cell = (t) => `<w:tc>${p(r(t))}</w:tc>`;
  const xml = `<w:tbl><w:tr>${cell('A1')}${cell('B1')}</w:tr><w:tr>${cell('A2')}${cell('B2')}</w:tr></w:tbl>${p(r('After'))}`;
  assert.equal(wordXmlToText(xml).text, 'A1\tB1\nA2\tB2\nAfter\n');
});

test('wordXmlToText ignores mc:Fallback duplicates', () => {
  const xml = `<w:p><mc:AlternateContent><mc:Choice>${r('Box text')}</mc:Choice><mc:Fallback>${r('Box text')}</mc:Fallback></mc:AlternateContent></w:p>`;
  assert.equal(wordXmlToText(xml).text.match(/Box text/g).length, 1);
});

test('parseRels only keeps hyperlink relationships', () => {
  const rels = parseRels(RELS_XML);
  assert.equal(rels.size, 1);
  assert.equal(rels.get('rId9'), 'https://linkedin.com/in/janedoe?a=1&b=2');
});

test('decodeXmlEntities leaves unknown entities alone', () => {
  assert.equal(decodeXmlEntities('a &amp; b &foo; &#65;'), 'a & b &foo; A');
});

test('creates a valid DOCX from tailored resume text', async () => {
  const bytes = await createDocx('Jane Doe\nSenior Engineer\njane@example.com\n\nSUMMARY\nExperienced engineer\n\nEXPERIENCE\n- Built & shipped tools');
  const text = await extractDocxText(bytes);
  const files = await readZipFiles(bytes);
  const document = new TextDecoder().decode(files['word/document.xml']);
  const styles = new TextDecoder().decode(files['word/styles.xml']);
  assert.ok(files['word/numbering.xml']);
  assert.match(document, /w:val="ResumeName"/);
  assert.match(document, /w:val="ResumeTitle"/);
  assert.match(document, /w:val="ResumeContact"/);
  assert.match(document, /w:val="ResumeHeading"/);
  assert.match(document, /w:numId w:val="1"/);
  assert.match(styles, /w:color w:val="123B4A"/);
  assert.match(styles, /w:bottom[^>]*w:color="36A3A5"/);
  assert.match(text, /^Jane Doe\nSenior Engineer\njane@example\.com/m);
  assert.match(text, /SUMMARY\nExperienced engineer/);
  assert.match(text, /EXPERIENCE\n- Built & shipped tools/);
  assert.match(await extractDocxText(await createDocx('Safe\u0001 text')), /Safe text/);
  await assert.rejects(createDocx('  '), /empty resume/);
});

test('creates a styled, readable multi-page PDF resume', async () => {
  const resume = [
    'Jane Doe',
    'Senior Software Engineer',
    'jane@example.com | Seattle, WA | https://example.com',
    '',
    'SUMMARY',
    'Experienced engineer with 10+ years building reliable software.',
    '',
    'EXPERIENCE',
    ...Array.from({ length: 70 }, (_, index) => `- Built feature ${index + 1} and improved reliability for customers.`),
  ].join('\n');
  const pdf = createResumePdf(resume, 'Jane Doe');
  const source = new TextDecoder().decode(pdf);
  assert.equal(source.slice(0, 8), '%PDF-1.4');
  assert.match(source, /\/BaseFont \/Helvetica/);
  assert.match(source, /\/BaseFont \/Helvetica-Bold/);
  assert.match(source, /BT \/F2 23 Tf 0\.12 0\.16 0\.21 rg 1 0 0 1 54\.00 744\.00 Tm/, 'modern style uses a prominent left-aligned name');
  assert.match(source, /BT \/F2 9\.5 Tf 0\.12 0\.28 0\.43 rg/, 'section headings use subtle blue accents');
  assert.doesNotMatch(source, /\/BaseFont \/Times-| Tc /, 'modern style uses clean sans-serif type without letter spacing');
  const extracted = await extractPdfText(pdf);
  assert.match(extracted, /Jane Doe/);
  assert.match(extracted, /SUMMARY/);
  assert.match(extracted, /EXPERIENCE/);
  assert.match(extracted, /Built feature 70/);
  assert.match(extracted, /1/);
  assert.match(extracted, /2/);
  assert.doesNotMatch(extracted, /^\?\s/m, 'bullets are drawn as vector dots, not unsupported font glyphs');
  const oneBulletPdf = new TextDecoder().decode(createResumePdf('Jane Doe\njane@example.com\n\nEXPERIENCE\n- Built reliable systems.', 'Jane Doe'));
  const bulletY = Number(oneBulletPdf.match(/57 ([\d.]+) m/)?.[1]);
  const textY = Number(oneBulletPdf.match(/1 0 0 1 67\.00 ([\d.]+) Tm/)?.[1]);
  assert.ok(Number.isFinite(bulletY) && Number.isFinite(textY));
  assert.equal(bulletY - 2 - textY, 3, 'bullet center is aligned above the text baseline at the glyph center');

  const allCapsNameResume = await extractPdfText(createResumePdf([
    'BENJIENHADZ HERNANDEZ AMARO',
    'SOFTWARE ENGINEER',
    'Cuenca, Batangas, Philippines',
    '',
    'SUMMARY',
    'Experienced engineer.',
    '',
    'EXPERIENCE',
    '- Built reliable systems.',
  ].join('\n'), 'Benjienhadz Hernandez Amaro'));
  assert.equal((allCapsNameResume.match(/Benjienhadz Hernandez Amaro/gi) || []).length, 1);
  assert.match(allCapsNameResume, /SOFTWARE ENGINEER/);
  assert.match(allCapsNameResume, /SUMMARY/);

  const reorderedSections = await extractPdfText(createResumePdf([
    'Jane Doe',
    'jane@example.com',
    '',
    'SUMMARY',
    'A concise summary.',
    '',
    'EXPERIENCE',
    '- Built reliable systems.',
    '',
    'SKILLS',
    'TypeScript, Python, AWS',
  ].join('\n'), 'Jane Doe'));
  assert.ok(
    reorderedSections.indexOf('SUMMARY') < reorderedSections.indexOf('SKILLS') &&
      reorderedSections.indexOf('SKILLS') < reorderedSections.indexOf('EXPERIENCE'),
    'skills are rendered after summary and before experience, regardless of input order'
  );

  const spacedHeadings = await extractPdfText(createResumePdf('Jane Doe\njane@example.com\n\nP R O F E S S I O N A L S U M M A R Y\nA concise summary.', 'Jane Doe'));
  assert.match(spacedHeadings, /PROFESSIONAL SUMMARY/);
});

test('uses the default DOCX package and paragraph styles for tailored resume output', async () => {
  const bytes = await createDocx('SUMMARY\nTailored summary\n\nEXPERIENCE\n- New achievement', sampleDocx());
  const text = await extractDocxText(bytes);
  const files = await readZipFiles(bytes);
  const document = new TextDecoder().decode(files['word/document.xml']);
  assert.match(text, /^Jane Doe – Resume$/m, 'original header remains');
  assert.match(text, /SUMMARY\nTailored summary\n\nEXPERIENCE\n- New achievement/);
  assert.doesNotMatch(text, /Built Go services|Mentored 4 engineers/, 'old body content is replaced');
  assert.ok(files['word/styles.xml'], 'original styles are retained');
  assert.deepEqual(files['word/media/logo.png'], new Uint8Array([0, 1, 2, 255]), 'binary assets are preserved');
  assert.match(document, /<w:numPr>/, 'original bullet paragraph formatting is reused');
});

test('creates an XLSX job history workbook with escaped text cells', () => {
  const bytes = createJobHistoryXlsx([
    {
      title: 'Engineer <II>',
      company: 'A & B',
      url: 'https://example.com/job/1?ref=x',
      createdAt: Date.UTC(2026, 10, 9),
      filename: 'tailored-resume.docx',
      status: 'applied',
      notes: '=HYPERLINK("https://example.com")',
    },
  ]);
  const entries = readZipDirectory(bytes);
  assert.ok(entries.has('xl/workbook.xml'));
  assert.ok(entries.has('xl/worksheets/sheet1.xml'));
  const sheet = readStoredEntry(bytes, 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /Job Title/);
  assert.match(sheet, /Engineer &lt;II&gt;/);
  assert.match(sheet, /A &amp; B/);
  assert.match(sheet, /2026-11-09T00:00:00\.000Z/);
  assert.match(sheet, /t="inlineStr"/);
  assert.match(sheet, /=HYPERLINK/);
  assert.doesNotMatch(sheet, /<f>/, 'notes remain text, not executable spreadsheet formulas');
});

test('detectResumeType uses extension, then magic bytes', () => {
  assert.equal(detectResumeType('cv.PDF'), 'pdf');
  assert.equal(detectResumeType('cv.docx'), 'docx');
  assert.equal(detectResumeType('cv.doc'), 'doc');
  assert.equal(detectResumeType('cv.txt'), 'text');
  assert.equal(detectResumeType('blob', new Uint8Array([0x25, 0x50, 0x44, 0x46])), 'pdf');
  assert.equal(detectResumeType('blob', new Uint8Array([0x50, 0x4b, 3, 4])), 'docx');
  assert.equal(detectResumeType('blob', new Uint8Array([1, 2, 3])), 'unknown');
});
