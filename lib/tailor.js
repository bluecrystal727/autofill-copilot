export const DEFAULT_TAILORING_PROMPT = `Use AI to optimize resume based on job description.
Task: Rewrite the user's resume to maximize ATS compatibility and match the Target Job Description (JD).

Input Data:

1. User Resume:
{resume_text}
2. Target Job Description:
{job_description}
Instructions:

1. **Semantic Mapping**: Replace generic terms with JD-specific keywords.

- Map existing skills/experience to the exact terminology used in the JD
- Ensure keywords appear naturally in context, not just listed
2. **Gap Analysis**: Identify the top 5 hard requirements in the JD. Ensure the Resume Summary explicitly addresses these skills with evidence.
3. **Prioritization**: Reorder bullets within each role to lead with the most relevant achievements for this specific role. Keep work-history roles in reverse chronological order (current or most recent first).
4. **Quantification**: Add metrics where possible (%, $, #) to strengthen impact statements.
5. **Format Requirements**:

- Keep total length to 1-2 pages maximum
- Use clear section headers: SUMMARY, EXPERIENCE, EDUCATION, SKILLS, CERTIFICATIONS
- Use bullet points for achievements
- Include relevant keywords in the Skills section
6. **Output Format**: Provide the complete rewritten resume in clean, professional format.
CRITICAL CONSTRAINT: Do not invent experience or credentials. Only reframe and highlight existing experience using the JD's terminology.`;

export const TAILOR_RESUME_SYSTEM = `You are a careful resume editor. Rewrite the candidate's resume for the target job using only facts in the provided resume. Do not invent or inflate skills, employers, titles, dates, degrees, achievements, metrics, or credentials. Preserve each role's actual employer, title, and dates. Always order work-history roles in reverse chronological order by end date: current or present roles first, followed by roles with the most recent end dates. This ordering rule overrides any instruction to prioritize entire roles by relevance; you may reorder achievement bullets within each role. Follow the user's other tailoring instructions while preserving factual accuracy. Return a JSON object with exactly one key, "resume", whose value is the complete rewritten resume as plain text with line breaks.`;

export function buildTailorResumeUser(prompt, resumeText, jobDescription) {
  const template = String(prompt || '');
  if (!template.includes('{resume_text}') || !template.includes('{job_description}')) {
    throw new Error('The tailoring prompt must include both {resume_text} and {job_description}.');
  }
  const filled = template.replace(/\{resume_text\}|\{job_description\}/g, (placeholder) =>
    placeholder === '{resume_text}' ? resumeText : jobDescription
  );
  return `${filled}\n\nReturn the result as valid JSON only, using this shape: {"resume":"the complete rewritten resume as plain text"}.`;
}

export function buildJobContext(job) {
  return [
    job?.title ? `Job title: ${job.title}` : '',
    job?.company ? `Company: ${job.company}` : '',
    job?.jobDescription ? `Job description:\n${job.jobDescription}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function normalizeJobUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.href;
  } catch {
    return '';
  }
}

const normalizeText = (value) =>
  String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function findPriorApplication(history, job) {
  const url = normalizeJobUrl(job?.url);
  const title = normalizeText(job?.title);
  const company = normalizeText(job?.company);
  const matches = (history || []).filter((entry) => {
    const entryUrl = normalizeJobUrl(entry.url);
    if (url && entryUrl) return url === entryUrl;
    return Boolean(title && company && title === normalizeText(entry.title) && company === normalizeText(entry.company));
  });
  return matches
    .filter((entry) => entry.status && entry.status !== 'tailored')
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0] || null;
}

export function createJobHistoryEntry(job, filename, now = Date.now()) {
  return {
    id: globalThis.crypto?.randomUUID?.() || `${now}-${Math.random().toString(36).slice(2)}`,
    title: String(job.title || '').trim(),
    company: String(job.company || '').trim(),
    url: String(job.url || '').trim(),
    filename,
    createdAt: now,
    updatedAt: now,
    status: 'tailored',
    notes: '',
  };
}

function filenamePart(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 45);
}

export function buildTailoredFilename(job, date = new Date()) {
  const company = filenamePart(job?.company) || 'unknown-company';
  const title = filenamePart(job?.title) || 'untitled-job';
  return `${company}-${title}-${date.toISOString().slice(0, 10)}.pdf`;
}

export function buildCandidateFilename(name) {
  const safeName = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return `${safeName || 'Tailored Resume'}.pdf`;
}
