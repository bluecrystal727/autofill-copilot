const encoder = new TextEncoder();
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LEFT = 54;
const RIGHT = 54;
const BODY_WIDTH = PAGE_WIDTH - LEFT - RIGHT;
const CP1252 = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86],
  [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95],
  [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);
const COLORS = {
  ink: '0.12 0.16 0.21',
  muted: '0.38 0.43 0.49',
  navy: '0.12 0.28 0.43',
  rule: '0.78 0.82 0.86',
};

function cleanText(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\u2022/g, '•');
}

function encodeWinAnsi(text) {
  let out = '';
  for (const char of cleanText(text)) {
    const point = char.codePointAt(0);
    if (point <= 0xff) out += point.toString(16).padStart(2, '0');
    else if (CP1252.has(point)) out += CP1252.get(point).toString(16).padStart(2, '0');
    else {
      const fallback = char.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      for (const part of fallback) {
        const code = part.codePointAt(0);
        out += (code <= 0xff ? code : 0x3f).toString(16).padStart(2, '0');
      }
    }
  }
  return out.toUpperCase();
}

function measure(text, size, bold = false) {
  let units = 0;
  for (const char of text) {
    if (/[ilI.,:;'!|]/.test(char)) units += 0.25;
    else if (/[MW@%&]/.test(char)) units += 0.82;
    else if (/[A-Z]/.test(char)) units += 0.64;
    else if (/\s/.test(char)) units += 0.28;
    else units += 0.51;
  }
  return units * size * (bold ? 1.04 : 1);
}

function wrapText(text, maxWidth, size, bold = false) {
  const words = cleanText(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, size, bold) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const STANDARD_HEADINGS = [
  'professional summary',
  'summary',
  'profile',
  'core competencies',
  'core skills',
  'skills',
  'technical skills',
  'professional experience',
  'experience',
  'work experience',
  'employment',
  'projects',
  'education',
  'certifications',
  'publications',
  'awards',
  'volunteer experience',
  'languages',
  'interests',
];

function isSectionHeading(line) {
  const compact = line.trim().replace(/:/g, '').replace(/\s+/g, '').toLowerCase();
  return STANDARD_HEADINGS.some((heading) => heading.replace(/\s+/g, '') === compact);
}

function normalizeHeading(line) {
  const text = line.trim().replace(/:$/, '');
  const compact = text.replace(/\s+/g, '').toLowerCase();
  return STANDARD_HEADINGS.find((heading) => heading.replace(/\s+/g, '') === compact) || text;
}

function arrangeResumeSections(lines, start) {
  const content = lines.slice(start);
  const blocks = [];
  let block = [];
  for (const line of content) {
    if (isSectionHeading(line) && block.some((part) => part.trim())) {
      blocks.push(block);
      block = [];
    }
    block.push(line);
  }
  if (block.length) blocks.push(block);

  const headingOf = (section) => normalizeHeading(section.find((line) => line.trim()) || '').toLocaleLowerCase();
  const summaryIndex = blocks.findIndex((section) => /^(professional\s+)?(summary|profile)$/.test(headingOf(section)));
  const skillsIndex = blocks.findIndex((section) => /^(core competencies|core skills|skills|technical skills)$/.test(headingOf(section)));
  const experienceIndex = blocks.findIndex((section) => /^(professional\s+)?(experience|work experience|employment)$/.test(headingOf(section)));
  if (summaryIndex < 0 || skillsIndex < 0 || experienceIndex < 0 || skillsIndex === summaryIndex + 1) {
    return lines;
  }

  const [skills] = blocks.splice(skillsIndex, 1);
  const nextSummaryIndex = blocks.findIndex((section) => /^(professional\s+)?(summary|profile)$/.test(headingOf(section)));
  blocks.splice(nextSummaryIndex + 1, 0, skills);
  return [...lines.slice(0, start), ...blocks.flat()];
}

function textCommand(text, x, y, size, font, color, alignment = 'left') {
  const width = measure(text, size, font === 'F2');
  const left = alignment === 'center' ? x - width / 2 : alignment === 'right' ? x - width : x;
  return `BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${left.toFixed(2)} ${y.toFixed(2)} Tm <${encodeWinAnsi(text)}> Tj ET\n`;
}

function newPage(pages, fullName, pageNumber) {
  const page = { commands: '', y: PAGE_HEIGHT - 76 };
  if (pageNumber === 1) {
    if (fullName) page.commands += textCommand(fullName, LEFT, PAGE_HEIGHT - 48, 23, 'F2', COLORS.ink);
  }
  pages.push(page);
  return page;
}

function drawSectionHeading(page, heading) {
  page.commands += textCommand(heading.toLocaleUpperCase(), LEFT, page.y, 9.5, 'F2', COLORS.navy);
  page.y -= 6;
  page.commands += `q ${COLORS.rule} RG 0.7 w ${LEFT} ${page.y} m ${PAGE_WIDTH - RIGHT} ${page.y} l S Q\n`;
  page.y -= 15;
}

function nextContentLine(lines, start) {
  for (let index = start; index < lines.length; index++) {
    if (lines[index].trim()) return lines[index].trim();
  }
  return '';
}

function isDateLine(line) {
  return /(?:\b\d{1,2}\/\d{4}\b|\b(?:19|20)\d{2}\b).*(?:present|current|(?:19|20)\d{2}|\d{1,2}\/\d{4})/i.test(line);
}

function makePages(resumeText, candidateName) {
  let lines = cleanText(resumeText).replace(/\r\n?/g, '\n').split('\n');
  const nonempty = lines.flatMap((line, index) => line.trim() ? [index] : []);
  const firstSection = lines.findIndex((line) => line.trim() && isSectionHeading(line));
  const headerEnd = firstSection >= 0 ? firstSection : nonempty[Math.min(2, nonempty.length - 1)] + 1;
  if (firstSection >= 0) lines = arrangeResumeSections(lines, headerEnd);
  const name = String(candidateName || '').trim() || (nonempty.length ? lines[nonempty[0]].trim() : '');
  const sourceHeaderLines = lines.slice(0, headerEnd < 0 ? nonempty.length : headerEnd).map((line) => line.trim()).filter(Boolean);
  const normalizeName = (value) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const headerLines = sourceHeaderLines[0] && normalizeName(sourceHeaderLines[0]) === normalizeName(name)
    ? sourceHeaderLines.slice(1)
    : sourceHeaderLines;
  const pages = [];
  let page = newPage(pages, name, 1);
  let section = '';

  if (headerLines.length) {
    const contact = headerLines.join('  |  ');
    const contactLines = wrapText(contact, BODY_WIDTH, 8.2);
    for (const line of contactLines) {
      page.commands += textCommand(line, LEFT, page.y, 8.2, 'F1', COLORS.muted);
      page.y -= 11;
    }
  }
  page.y -= 8;

  for (let index = headerEnd < 0 ? nonempty.length : headerEnd; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) {
      page.y -= 2;
      continue;
    }
    if (isSectionHeading(line)) {
      if (page.y < 65) {
        page = newPage(pages, name, pages.length + 1);
      }
      drawSectionHeading(page, normalizeHeading(line));
      section = normalizeHeading(line).toLocaleLowerCase();
      continue;
    }

    const isBullet = /^[-•*]\s/.test(line);
    const content = isBullet ? line.replace(/^[-•*]\s+/, '') : line;
    const previousContent = nextContentLine(lines, index + 1);
    const groupedEntrySection = /experience|employment|education|project/.test(section);
    const isDate = !isBullet && isDateLine(content);
    const groupedTitle = groupedEntrySection && !isBullet && !isDate && isDateLine(previousContent);
    const groupedOrganization = groupedEntrySection && !isBullet && !isDate && !groupedTitle && isDateLine(nextContentLine(lines, index + 2));
    const isSubheading = !isBullet && (groupedTitle || groupedOrganization || content.length < 125 && (
      /\s[|·]\s/.test(content) ||
      /(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|present|current)/i.test(content)
    ));
    const font = isDate ? 'F3' : isSubheading ? 'F2' : 'F1';
    const size = isDate ? 8.7 : isSubheading ? 9.5 : 9.3;
    const indent = isBullet ? 13 : 0;
    const wrapped = wrapText(content, BODY_WIDTH - indent, size, font === 'F2');
    const lineHeight = 12;
    const required = wrapped.length * lineHeight + 2;
    if (page.y - required < 52) {
      page = newPage(pages, name, pages.length + 1);
    }
    if (isBullet) {
      const bulletY = page.y + 3;
      page.commands += `q ${COLORS.ink} rg ${LEFT + 3} ${bulletY + 2} m ${LEFT + 4.2} ${bulletY + 2} ${LEFT + 5} ${bulletY + 1.2} ${LEFT + 5} ${bulletY} c ${LEFT + 5} ${bulletY - 1.2} ${LEFT + 4.2} ${bulletY - 2} ${LEFT + 3} ${bulletY - 2} c ${LEFT + 1.8} ${bulletY - 2} ${LEFT + 1} ${bulletY - 1.2} ${LEFT + 1} ${bulletY} c ${LEFT + 1} ${bulletY + 1.2} ${LEFT + 1.8} ${bulletY + 2} ${LEFT + 3} ${bulletY + 2} c f Q\n`;
    }
    for (const wrappedLine of wrapped) {
      page.commands += textCommand(wrappedLine, LEFT + indent, page.y, size, font, isDate ? COLORS.muted : COLORS.ink);
      page.y -= lineHeight;
    }
    page.y -= isBullet ? 2 : 3;
  }
  return pages;
}

function joinBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function createResumePdf(resumeText, candidateName = '') {
  if (!String(resumeText || '').trim()) throw new Error('Cannot create a PDF from an empty resume.');
  const pages = makePages(resumeText, candidateName);
  const objects = new Map();
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const pageIds = pages.map((_, index) => 6 + index * 2);
  objects.set(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.set(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  objects.set(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');
  pages.forEach((page, index) => {
    const pageId = pageIds[index];
    const streamId = pageId + 1;
    const stream = encoder.encode(page.commands);
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${streamId} 0 R >>`);
    objects.set(streamId, { stream });
  });

  const chunks = [encoder.encode('%PDF-1.4\n')];
  const offsets = [0];
  let offset = chunks[0].length;
  const objectCount = Math.max(...objects.keys());
  for (let id = 1; id <= objectCount; id++) {
    const value = objects.get(id);
    offsets[id] = offset;
    let bytes;
    if (value?.stream) {
      const header = encoder.encode(`${id} 0 obj\n<< /Length ${value.stream.length} >>\nstream\n`);
      const footer = encoder.encode('\nendstream\nendobj\n');
      bytes = joinBytes([header, value.stream, footer]);
    } else {
      bytes = encoder.encode(`${id} 0 obj\n${value}\nendobj\n`);
    }
    chunks.push(bytes);
    offset += bytes.length;
  }
  const xrefOffset = offset;
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objectCount; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(encoder.encode(xref));
  return joinBytes(chunks);
}
