// Dependency-free .docx text extractor.
// A .docx is a ZIP archive of XML parts; we unzip with the built-in DecompressionStream
// ('deflate-raw') and pull text out of WordprocessingML. Works in Chrome and Node 18+.

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export class DocxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocxError';
  }
}

/** Reads the ZIP central directory. Returns Map<name, {method, compSize, offset}>. */
export function readZipDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DocxError('This file is not a valid .docx (ZIP) document.');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new DocxError('The .docx file appears to be corrupted.');
    }
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readZipEntryBytes(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.offset, true) !== SIG_LOCAL) throw new DocxError('The .docx file appears to be corrupted.');
  const nameLen = view.getUint16(entry.offset + 26, true);
  const extraLen = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLen + extraLen;
  const data = bytes.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data.slice();
  if (entry.method !== 8) throw new DocxError(`Unsupported ZIP compression method ${entry.method}.`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(bytes, entry) {
  return new TextDecoder().decode(await readZipEntryBytes(bytes, entry));
}

export async function readZipFiles(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const entries = readZipDirectory(bytes);
  const files = {};
  for (const [name, entry] of entries) files[name] = await readZipEntryBytes(bytes, entry);
  return files;
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeXmlEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code] ?? m;
  });
}

/** Map of relationship id -> external target URL for one .rels part. */
export function parseRels(xml) {
  const rels = new Map();
  for (const [tag] of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const attr = (name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    const id = attr('Id');
    const target = attr('Target');
    if (id && target && /hyperlink$/.test(attr('Type') || '')) rels.set(id, decodeXmlEntities(target));
  }
  return rels;
}

const TOKEN_RE =
  /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>|<w:numPr>|<\/w:p>|<\/w:tc>|<\/w:tr>|<w:hyperlink\b[^>]*?\br:id="([^"]+)"/g;

/** Converts one WordprocessingML part to plain text. Returns { text, linkIds }. */
export function wordXmlToText(xml) {
  // Drop legacy VML fallbacks (they duplicate text-box content) and deleted revisions.
  const clean = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '').replace(/<w:del\b[\s\S]*?<\/w:del>/g, '');
  let out = '';
  const linkIds = [];
  for (const m of clean.matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (m[1] !== undefined) out += decodeXmlEntities(m[1]);
    else if (m[2] !== undefined) linkIds.push(m[2]);
    else if (tok === '<w:tab/>') out += '\t';
    else if (tok === '<w:numPr>') out += '- ';
    // A cell's last paragraph already ended with '\n'; turn that break into a column separator.
    else if (tok === '</w:tc>') out = out.replace(/\n$/, '') + '\t';
    else if (tok === '</w:tr>') out = out.replace(/\t$/, '') + '\n';
    else out += '\n'; // </w:p>, <w:br/>, <w:cr/>
  }
  return { text: out, linkIds };
}

export function tidyText(text) {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t ]+$/g, '').replace(/^\t+/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts readable text (plus hyperlink targets) from a .docx file.
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<string>}
 */
export async function extractDocxText(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new DocxError('Old Word .doc files are not supported. Save the resume as .docx or PDF, or paste the text.');
  }
  const entries = readZipDirectory(bytes);
  if (!entries.has('word/document.xml')) throw new DocxError('This file is not a Word .docx document.');

  const partNames = [
    ...[...entries.keys()].filter((n) => /^word\/header\d*\.xml$/.test(n)).sort(),
    'word/document.xml',
    ...[...entries.keys()].filter((n) => /^word\/footer\d*\.xml$/.test(n)).sort(),
  ];

  const chunks = [];
  const links = new Set();
  for (const name of partNames) {
    const { text, linkIds } = wordXmlToText(await readZipEntry(bytes, entries.get(name)));
    if (text.trim()) chunks.push(text);
    const relsName = name.replace(/^word\//, 'word/_rels/') + '.rels';
    if (linkIds.length && entries.has(relsName)) {
      const rels = parseRels(await readZipEntry(bytes, entries.get(relsName)));
      for (const id of linkIds) if (rels.has(id)) links.add(rels.get(id));
    }
  }

  let result = tidyText(chunks.join('\n\n'));
  const urls = [...links].filter((u) => /^(https?:|mailto:)/i.test(u));
  if (urls.length) result += `\n\nLinks:\n${urls.join('\n')}`;
  return result;
}
