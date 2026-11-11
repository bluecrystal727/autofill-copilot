// Prompt templates for resume parsing and form filling.

import { emptyProfile } from './storage.js';
export { DEFAULT_TAILORING_PROMPT, TAILOR_RESUME_SYSTEM, buildTailorResumeUser } from './tailor.js';

// ---------- Resume -> structured profile ----------

const PROFILE_TEMPLATE = (() => {
  const p = emptyProfile();
  p.workExperience = [
    { company: '', title: '', location: '', startDate: 'YYYY-MM', endDate: 'YYYY-MM or Present', current: false, description: '- bullet\n- bullet' },
  ];
  p.education = [{ school: '', degree: '', field: '', location: '', startDate: 'YYYY-MM', endDate: 'YYYY-MM', gpa: '' }];
  p.projects = [{ name: '', url: '', description: '' }];
  p.certifications = [{ name: '', issuer: '', date: 'YYYY-MM' }];
  p.skills = ['skill'];
  p.languages = ['English (Native)'];
  p.totalYearsExperience = 0;
  return JSON.stringify(p, null, 2);
})();

export const RESUME_PARSE_SYSTEM = `You are a precise resume parser. Convert the resume text into a JSON object that matches this template exactly (same keys, same nesting):

${PROFILE_TEMPLATE}

Rules:
- Use only information that appears in the resume. Never invent or embellish anything.
- Unknown strings are "", unknown lists are [], unknown numbers are null.
- Split the person's name into firstName / middleName / lastName.
- Dates use "YYYY-MM" (or "YYYY" when the month is unknown). Use endDate "Present" and current: true for ongoing roles.
- List work experience and education most recent first.
- Keep job descriptions as bullet lines, each starting with "- ", joined with "\\n".
- URLs must be absolute (add "https://" when missing). Put LinkedIn, GitHub, portfolio and other sites in their own fields.
- skills: a flat list of individual skills/technologies (no categories).
- headline: the candidate's current or target title in a few words.
- summary: the resume's summary/objective if present, otherwise a faithful 2-3 sentence summary of the resume.
- totalYearsExperience: estimate full-time professional experience in years (one decimal) from the work history, or null.
- Respond with the JSON object only.`;

export function buildResumeParseUser(resumeText) {
  return `Parse this resume into the JSON template.\n\n<resume>\n${resumeText}\n</resume>`;
}

// ---------- Form fields -> values ----------

export const FORM_FILL_SYSTEM = `You fill out job application and profile forms on behalf of a candidate. You receive the candidate's parsed profile, original resume text, saved application answers, custom Q&A, additional instructions, webpage context, and form fields.

Return ONLY a JSON object:
{"fills":[{"id":"<field id>","value":<value>,"long":<true|false>}]}

RULES:

- Process every field independently. Return a separate fill for every answerable field using its exact ID. Never stop after the first answerable field.
- Use supplied candidate information as the factual foundation. Never invent employers, titles, dates, degrees, certifications, metrics, achievements, or contact details.
- If information is unavailable, omit the field rather than guess.
- Field values must match their required types:
  - text, email, tel, url, number, textarea, contenteditable, combobox: strings; number fields contain digits only.
  - date: YYYY-MM-DD. Month: YYYY-MM.
  - select/radio: exact matching option.
  - select/combobox/dropdown without options: natural answer text.
  - checkbox: true/false.
  - checkbox-group/multiselect: array of exact options.
- Never accept terms, give consent, or certify anything on the candidate's behalf.
- Match names, email, phone, and location to the appropriate profile fields.
- Map repeated employment sections in field order, most recent first.
- Work authorization, sponsorship, relocation, remote preference, salary, notice period, start date, age, and voluntary self-identification must ONLY use saved application answers. If unavailable, omit.
- Prefer matching custom Q&A answers over generated answers.
- OPEN-ENDED QUESTIONS: Generate separate, tailored, first-person answers using the resume, profile, and active job description. Write naturally as the candidate. Use professional reasoning to construct realistic explanations, technical approaches, and hypothetical examples consistent with documented experience. Never present hypothetical events as verified personal experiences. Do not invent qualifications, employers, achievements, or metrics. Use STAR for behavioral questions. Avoid generic language, disclaimers, and robotic writing. Follow specified word limits; otherwise aim for 120–200 words. Always stay within maxLength. Set "long": true for open-ended answers and false for all other fields.
- Skip password, captcha, search fields, and anything requiring unavailable information.
- Follow additional candidate instructions.
- Output valid JSON only. No Markdown, explanations, or comments.`;

const MAX_RESUME_CONTEXT_CHARS = 30000;

function compactAnswers(extras) {
  const { customQA = [], additionalInstructions = '', ...rest } = extras || {};
  const answers = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== '' && v !== null && v !== undefined));
  const qa = customQA.filter((q) => q.question && q.answer);
  return { answers, qa, additionalInstructions: (additionalInstructions || '').trim() };
}

export function buildFormFillUser({ profile, extras, page, fields, resumeText, today }) {
  const { answers, qa, additionalInstructions } = compactAnswers(extras);
  const sections = [
    'Fill the form fields below and respond with the JSON object only.',
    `\n## Today\n${today}`,
    `\n## Page context\n${JSON.stringify(page || {})}`,
    `\n## Candidate profile\n${JSON.stringify(profile)}`,
    `\n## Saved application answers\n${JSON.stringify(answers)}`,
  ];
  if (qa.length) sections.push(`\n## Custom Q&A\n${JSON.stringify(qa)}`);
  if (additionalInstructions) sections.push(`\n## Additional instructions from the candidate\n${additionalInstructions}`);
  if (resumeText?.trim()) {
    const resumeContext = resumeText.slice(0, MAX_RESUME_CONTEXT_CHARS);
    sections.push(`\n## Original resume text (source of candidate experience)\n${resumeContext}`);
  }
  sections.push(`\n## Form fields\n${JSON.stringify(fields)}`);
  return sections.join('\n');
}
