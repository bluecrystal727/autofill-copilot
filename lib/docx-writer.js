import { readZipFiles, wordXmlToText } from './docx.js';
import { zipStoredFiles } from './zip.js';

function xmlEscape(text) {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
}

function classifyPlainTextLines(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const firstContentIndex = lines.findIndex((line) => line.trim());
  const firstSectionIndex = lines.findIndex((line) => line.trim() && isSectionHeading(line));
  const nonemptyIndexes = lines.flatMap((line, index) => line.trim() ? [index] : []);
  const headerEndIndex = firstSectionIndex >= 0 ? firstSectionIndex : nonemptyIndexes[Math.min(2, nonemptyIndexes.length - 1)];
  return lines.map((line, index) => {
    if (!line.trim()) return { text: '', style: 'ResumeBody' };
    if (/^[-•*]\s/.test(line)) return { text: line.replace(/^[-•*]\s+/, ''), style: 'ResumeBullet' };
    if (index === firstContentIndex) return { text: line.trim(), style: 'ResumeName' };
    if (isSectionHeading(line)) return { text: line.trim().replace(/:$/, ''), style: 'ResumeHeading' };
    if (index < headerEndIndex) {
      return {
        text: line.trim(),
        style: /(?:@|https?:\/\/|www\.|\+?\d[\d\s().-]{7,})/i.test(line) ? 'ResumeContact' : 'ResumeTitle',
      };
    }
    return { text: line.trim(), style: 'ResumeBody' };
  });
}

function makeDocumentXml(text) {
  const paragraphs = classifyPlainTextLines(text)
    .map(({ text: line, style }) => {
      const numbering = style === 'ResumeBullet' ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : '';
      return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${numbering}</w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="900" w:bottom="720" w:left="900" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;
}

function makeFallbackStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:color w:val="263746"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="20"/><w:color w:val="263746"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ResumeName"><w:name w:val="Resume Name"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="60"/><w:jc w:val="center"/><w:keepNext/></w:pPr><w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display"/><w:b/><w:sz w:val="36"/><w:color w:val="123B4A"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ResumeTitle"><w:name w:val="Resume Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="40"/><w:jc w:val="center"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/><w:color w:val="167D8D"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ResumeContact"><w:name w:val="Resume Contact"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="100"/><w:jc w:val="center"/><w:keepNext/></w:pPr><w:rPr><w:sz w:val="18"/><w:color w:val="526575"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ResumeHeading"><w:name w:val="Resume Section Heading"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="210" w:after="70"/><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="4" w:color="36A3A5"/></w:pBdr></w:pPr><w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display"/><w:b/><w:caps/><w:sz w:val="22"/><w:color w:val="123B4A"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ResumeBody"><w:name w:val="Resume Body"/><w:basedOn w:val="Normal"/><w:pPr><w:widowControl/><w:spacing w:after="65" w:line="250" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="19"/><w:color w:val="263746"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ResumeBullet"><w:name w:val="Resume Bullet"/><w:basedOn w:val="ResumeBody"/><w:pPr><w:ind w:left="360" w:hanging="180"/><w:spacing w:after="45" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="19"/></w:rPr></w:style>
</w:styles>`;
}

function makeFallbackNumberingXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="360"/></w:tabs><w:ind w:left="360" w:hanging="180"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
}

function paragraphText(paragraph) {
  return wordXmlToText(paragraph).text.replace(/\n+$/, '');
}

function paragraphTemplateType(paragraph) {
  const text = paragraphText(paragraph).trim();
  if (/<w:numPr\b/.test(paragraph) || /^[-•]\s/.test(text)) return 'bullet';
  const style = paragraph.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/)?.[1] || '';
  if (/title|heading|subtitle/i.test(style) || (text && text.length < 80 && text === text.toLocaleUpperCase() && /[A-Z]/.test(text))) return 'heading';
  return text ? 'body' : 'blank';
}

function isSectionHeading(line) {
  const text = line.trim();
  return (
    text.length < 80 &&
    (text === text.toLocaleUpperCase() ||
      /^(professional\s+)?(summary|profile|experience|work\s+experience|employment|education|skills|certifications|projects|publications|awards|volunteer(?:\s+experience)?|languages|interests)\s*:?\s*$/i.test(text)) &&
    /[A-Za-z]/.test(text)
  );
}

function makeStyledParagraph(text, template, isBullet) {
  const properties = template?.match(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>|<w:pPr\b[^>]*\/>/)?.[0] || '';
  const runProperties = template?.match(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>|<w:rPr\b[^>]*\/>/)?.[0] || '';
  const value = isBullet && /^[-•]\s/.test(text) ? text.replace(/^[-•]\s+/, '') : text;
  return `<w:p>${properties}<w:r>${runProperties}<w:t xml:space="preserve">${xmlEscape(value)}</w:t></w:r></w:p>`;
}

function styledDocumentXml(text, templateXml) {
  const bodyMatch = templateXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) throw new Error('The saved default resume DOCX has an invalid document body.');
  const sourceBody = bodyMatch[1];
  const sectionProperties = sourceBody.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>|<w:sectPr\b[^>]*\/>/)?.[0] || '';
  const sourceParagraphs = [...sourceBody.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((match) => match[0]);
  const templates = {
    body: sourceParagraphs.find((paragraph) => paragraphTemplateType(paragraph) === 'body'),
    heading: sourceParagraphs.find((paragraph) => paragraphTemplateType(paragraph) === 'heading'),
    bullet: sourceParagraphs.find((paragraph) => paragraphTemplateType(paragraph) === 'bullet'),
    blank: sourceParagraphs.find((paragraph) => paragraphTemplateType(paragraph) === 'blank'),
  };
  templates.body ||= sourceParagraphs[0];
  templates.heading ||= templates.body;
  templates.bullet ||= templates.body;
  templates.blank ||= templates.body;
  if (!templates.body) throw new Error('The saved default resume DOCX has no paragraphs to use as style templates.');

  const paragraphs = String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      if (!line.trim()) return makeStyledParagraph('', templates.blank, false);
      const type = /^[-•]\s/.test(line) ? 'bullet' : isSectionHeading(line) ? 'heading' : 'body';
      return makeStyledParagraph(line, templates[type], type === 'bullet');
    })
    .join('');
  const newBody = `${paragraphs}${sectionProperties}`;
  const newDocument = templateXml.replace(/<w:body\b[^>]*>[\s\S]*?<\/w:body>/, (body) =>
    body.replace(/>[\s\S]*<\/w:body>$/, `>${newBody}</w:body>`)
  );
  return newDocument;
}

export async function createDocx(resumeText, templateBytes = null) {
  if (!String(resumeText || '').trim()) throw new Error('Cannot create a DOCX from an empty resume.');
  if (templateBytes) {
    const templateFiles = await readZipFiles(templateBytes);
    const documentXml = templateFiles['word/document.xml'];
    if (!documentXml) throw new Error('The saved default resume DOCX has no document content.');
    templateFiles['word/document.xml'] = new TextEncoder().encode(styledDocumentXml(resumeText, new TextDecoder().decode(documentXml)));
    return zipStoredFiles(templateFiles);
  }
  return zipStoredFiles({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`,
    'word/document.xml': makeDocumentXml(resumeText),
    'word/styles.xml': makeFallbackStylesXml(),
    'word/numbering.xml': makeFallbackNumberingXml(),
  });
}
