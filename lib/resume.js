// Turns an uploaded resume file (PDF, DOCX, TXT/MD) into plain text, and helpers
// to store the original file so it can be attached to "Upload resume" inputs.

import { extractDocxText } from './docx.js';

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'];

export class ResumeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResumeError';
  }
}

export function detectResumeType(name = '', bytes = new Uint8Array()) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.doc')) return 'doc';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.text')) return 'text';
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf'; // %PDF
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'docx'; // PK (zip)
  return 'unknown';
}

/**
 * @param {{name:string, arrayBuffer:() => Promise<ArrayBuffer>}} file a File/Blob with a name
 * @returns {Promise<string>}
 */
export async function extractResumeText(file) {
  if (file.size > MAX_RESUME_BYTES) throw new ResumeError('Resume file is larger than 5 MB.');
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const type = detectResumeType(file.name, bytes);

  let text;
  if (type === 'pdf') text = await extractPdfText(bytes);
  else if (type === 'docx') text = await extractDocxText(bytes);
  else if (type === 'text') text = new TextDecoder().decode(bytes);
  else if (type === 'doc') throw new ResumeError('Old Word .doc files are not supported. Save as .docx or PDF, or paste the text.');
  else throw new ResumeError('Unsupported file type. Use PDF, DOCX, or TXT.');

  text = (text || '').trim();
  if (text.length < 40) {
    throw new ResumeError(
      type === 'pdf'
        ? 'Could not find text in this PDF (it may be a scanned image). Try a DOCX, or paste the text instead.'
        : 'The resume looks empty. Try another file or paste the text instead.'
    );
  }
  return text;
}

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./pdf/pdf.min.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf/pdf.worker.min.mjs', import.meta.url).href;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/** Extracts text from a PDF, rebuilding lines from glyph positions, plus link URLs. */
export async function extractPdfText(bytes) {
  const pdfjs = await loadPdfjs();
  // verbosity 0 silences harmless font warnings: we only need the text layer, not rendering.
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  const pages = [];
  const links = new Set();
  try {
    const doc = await task.promise;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let out = '';
      let prev = null;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const [, , , , x, y] = item.transform;
        if (prev) {
          const fontSize = Math.hypot(item.transform[2], item.transform[3]) || 10;
          if (Math.abs(y - prev.y) > fontSize * 0.5) {
            if (!out.endsWith('\n')) out += '\n';
          } else if (x - prev.endX > fontSize * 0.15 && !/\s$/.test(out) && !/^\s/.test(item.str)) {
            out += ' ';
          }
        }
        out += item.str;
        if (item.hasEOL && !out.endsWith('\n')) out += '\n';
        prev = { y, endX: x + (item.width || 0) };
      }
      pages.push(out);
      for (const a of await page.getAnnotations()) {
        if (a.subtype === 'Link' && typeof a.url === 'string') links.add(a.url);
      }
      page.cleanup();
    }
  } finally {
    await task.destroy(); // destroys the document and its worker
  }
  let text = pages
    .join('\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (links.size) text += `\n\nLinks:\n${[...links].join('\n')}`;
  return text;
}

// ---------- storing the original file ----------

export function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function fileToStored(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectResumeType(file.name, bytes);
  const mime =
    file.type ||
    (type === 'pdf'
      ? 'application/pdf'
      : type === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'text/plain');
  return { name: file.name, type: mime, size: bytes.length, base64: bytesToBase64(bytes), savedAt: Date.now() };
}
