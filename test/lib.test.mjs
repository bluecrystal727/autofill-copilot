// Run with: node --test test/
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { completeJSON, LLMError, parseJSONLoose } from '../lib/llm.js';
import {
  DEFAULT_TAILORING_PROMPT,
  FORM_FILL_SYSTEM,
  RESUME_PARSE_SYSTEM,
  TAILOR_RESUME_SYSTEM,
  buildFormFillUser,
  buildResumeParseUser,
  buildTailorResumeUser,
} from '../lib/prompts.js';
import { base64ToBytes, bytesToBase64 } from '../lib/resume.js';
import { scoreResumeWithService } from '../lib/scorer.js';
import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  activeModel,
  addJobHistoryEntry,
  clearJobHistory,
  deleteJobHistoryEntry,
  emptyProfile,
  getActiveJobInfo,
  getJobHistory,
  getLastTailoredResume,
  getCurrentJobInfo,
  getAIUsage,
  getResumeFileForAutofill,
  getSettings,
  hasProfile,
  normalizeExtras,
  normalizeProfile,
  saveCurrentJobInfo,
  saveActiveJobInfo,
  saveLastTailoredResume,
  recordAIUsage,
  clearAIUsage,
  updateJobHistoryEntry,
} from '../lib/storage.js';
import { buildCandidateFilename, buildJobContext, buildTailoredFilename, createJobHistoryEntry, findPriorApplication, normalizeJobUrl } from '../lib/tailor.js';
import '../content/scanner.js';

test('scanner recognizes text inputs with autocomplete=email as email fields', () => {
  assert.equal(globalThis.__afcScanner.inputKind('text', 'email'), 'email');
  assert.equal(globalThis.__afcScanner.inputKind('text', 'section-contact email'), 'email');
  assert.equal(globalThis.__afcScanner.inputKind('text', 'username'), 'text');
  assert.equal(globalThis.__afcScanner.inputKind('email', ''), 'email');
});

test('job-page reader decodes HTML entities in titles and keeps Unicode punctuation', () => {
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  const originalDOMParser = globalThis.DOMParser;
  const decodeEntities = (value) => value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
  globalThis.document = {
    title: 'Job page',
    createElement() {
      let value = '';
      return {
        set innerHTML(input) { value = decodeEntities(input); },
        get value() { return value; },
      };
    },
    querySelectorAll() {
      return [{
        textContent: JSON.stringify({
          '@type': 'JobPosting',
          title: 'Customer Care Agent (all genders) &#8211; 100% Home-Office',
          hiringOrganization: { name: 'Abc &amp; Co.' },
        }),
      }];
    },
    querySelector() { return null; },
  };
  globalThis.DOMParser = class {
    parseFromString(value) {
      const textContent = decodeEntities(value);
      return { body: { textContent, innerText: textContent } };
    }
  };
  globalThis.location = { href: 'https://example.com/job/1', origin: 'https://example.com', pathname: '/job/1' };
  try {
    const job = globalThis.__afcScanner.readJobInfo();
    assert.equal(job.title, 'Customer Care Agent (all genders) – 100% Home-Office');
    assert.equal(job.company, 'Abc & Co.');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
    if (originalDOMParser === undefined) delete globalThis.DOMParser;
    else globalThis.DOMParser = originalDOMParser;
  }
});

test('job-page reader prefers Chrome-translated visible text over original structured data', () => {
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  const originalDOMParser = globalThis.DOMParser;
  const nodes = {
    h1: { innerText: 'Customer Care Agent – 100% Home-Office (English)', textContent: 'Customer Care Agent – 100% Home-Office (English)' },
    company: { innerText: 'Example Company', textContent: 'Example Company' },
    description: { innerText: 'Provide customer support in English.', textContent: 'Provide customer support in English.' },
    main: { innerText: 'Translated job page content.', textContent: 'Translated job page content.' },
  };
  globalThis.document = {
    title: 'German job page',
    body: nodes.main,
    createElement() {
      let value = '';
      return {
        set innerHTML(input) { value = input; },
        get value() { return value; },
      };
    },
    querySelectorAll() {
      return [{
        textContent: JSON.stringify({
          '@type': 'JobPosting',
          title: 'Kundenbetreuer (m/w/d) – 100% Homeoffice',
          hiringOrganization: { name: 'Beispielunternehmen' },
          description: 'Unterstützung von Kunden auf Deutsch.',
        }),
      }];
    },
    querySelector(selector) {
      if (selector === 'h1') return nodes.h1;
      if (selector.startsWith('[data-company-name]')) return nodes.company;
      if (selector.startsWith('[itemprop="description"]')) return nodes.description;
      if (selector.startsWith('main,')) return nodes.main;
      return null;
    },
  };
  globalThis.DOMParser = class {
    parseFromString(value) {
      return { body: { textContent: value, innerText: value } };
    }
  };
  globalThis.location = { href: 'https://example.com/job/1', origin: 'https://example.com', pathname: '/job/1' };
  try {
    const job = globalThis.__afcScanner.readJobInfo();
    assert.equal(job.title, 'Customer Care Agent – 100% Home-Office (English)');
    assert.equal(job.company, 'Example Company');
    assert.equal(job.jobDescription, 'Provide customer support in English.');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
    if (originalDOMParser === undefined) delete globalThis.DOMParser;
    else globalThis.DOMParser = originalDOMParser;
  }
});

test('parseJSONLoose handles plain, fenced and prose-wrapped JSON', () => {
  assert.deepEqual(parseJSONLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJSONLoose('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseJSONLoose('Sure! Here it is: {"fills":[{"id":"f1","value":"x"}]} Hope that helps.'), {
    fills: [{ id: 'f1', value: 'x' }],
  });
  assert.throws(() => parseJSONLoose(''), LLMError);
  assert.throws(() => parseJSONLoose('no json here'), LLMError);
});

test('normalizeProfile fills missing keys and coerces types from messy LLM output', () => {
  const p = normalizeProfile({
    personal: { firstName: 'Jane', phone: 5550100, location: { city: 'Austin' } },
    totalYearsExperience: '7.5',
    workExperience: [{ company: 'Acme', current: 'true' }, 'garbage', null],
    skills: ['Go', '', '  TypeScript '],
    education: 'not a list',
    unexpected: 'dropped',
  });
  assert.equal(p.personal.firstName, 'Jane');
  assert.equal(p.personal.phone, '5550100');
  assert.equal(p.personal.lastName, '');
  assert.equal(p.personal.location.city, 'Austin');
  assert.equal(p.personal.location.country, '');
  assert.equal(p.totalYearsExperience, 7.5);
  assert.equal(p.workExperience.length, 1);
  assert.equal(p.workExperience[0].current, true);
  assert.equal(p.workExperience[0].title, '');
  assert.deepEqual(p.skills, ['Go', 'TypeScript']);
  assert.deepEqual(p.education, []);
  assert.equal('unexpected' in p, false);
  assert.equal(normalizeProfile({ totalYearsExperience: 'n/a' }).totalYearsExperience, null);
  assert.deepEqual(normalizeProfile(undefined), emptyProfile());
});

test('normalizeExtras keeps defaults and cleans custom Q&A', () => {
  const e = normalizeExtras({ desiredSalary: '100k', customQA: [{ question: 'Q', answer: 'A' }, 5] });
  assert.equal(e.desiredSalary, '100k');
  assert.equal(e.gender, 'Decline to self-identify');
  assert.deepEqual(e.customQA, [{ question: 'Q', answer: 'A' }]);
});

test('hasProfile and activeModel', () => {
  assert.equal(hasProfile(emptyProfile()), false);
  assert.equal(hasProfile(normalizeProfile({ personal: { email: 'a@b.c' } })), true);
  const s = structuredClone(DEFAULT_SETTINGS);
  assert.equal(activeModel(s), PROVIDERS.openai.defaultModel);
  s.models.openai = '  custom-model ';
  assert.equal(activeModel(s), 'custom-model');
  s.provider = 'gemini';
  assert.equal(activeModel(s), PROVIDERS.gemini.defaultModel);
});

test('prompts include the profile template, fields, and only non-empty answers', () => {
  assert.match(RESUME_PARSE_SYSTEM, /"workExperience"/);
  assert.match(RESUME_PARSE_SYSTEM, /Never invent/);
  assert.match(buildResumeParseUser('RESUME BODY'), /<resume>\nRESUME BODY\n<\/resume>/);
  assert.match(FORM_FILL_SYSTEM, /"fills"/);
  assert.match(FORM_FILL_SYSTEM, /Return a separate fill for every answerable field using its exact ID/);
  assert.match(FORM_FILL_SYSTEM, /OPEN-ENDED QUESTIONS: Generate separate, tailored, first-person answers/);
  assert.match(FORM_FILL_SYSTEM, /Follow specified word limits/);

  const user = buildFormFillUser({
    profile: normalizeProfile({ personal: { firstName: 'Jane' } }),
    extras: normalizeExtras({ desiredSalary: '', noticePeriod: '2 weeks', customQA: [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: '' }] }),
    page: { title: 'Application form', activeJob: { title: 'Engineer', company: 'Acme', jobDescription: 'Build tools.' } },
    fields: [{ id: 'f0', kind: 'text', label: 'First name' }],
    resumeText: 'Built and operated distributed systems.',
    today: '2026-11-08',
  });
  assert.match(user, /"firstName":"Jane"/);
  assert.match(user, /"noticePeriod":"2 weeks"/);
  assert.doesNotMatch(user, /desiredSalary/);
  assert.match(user, /"question":"Q1"/);
  assert.doesNotMatch(user, /Q2/);
  assert.match(user, /\[\{"id":"f0","kind":"text","label":"First name"\}\]/);
  assert.match(user, /## Original resume text \(source of candidate experience\)\nBuilt and operated distributed systems\./);
  assert.match(user, /2026-11-08/);
  assert.match(user, /"activeJob":\{"title":"Engineer","company":"Acme","jobDescription":"Build tools\."\}/);
});

test('completeJSON reports normalized token usage for each provider', async () => {
  const originalFetch = globalThis.fetch;
  const responses = {
    openai: {
      output_text: '{"ok":true}',
      usage: { input_tokens: 120, output_tokens: 8, total_tokens: 128 },
    },
    anthropic: {
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 100, output_tokens: 10 },
    },
    gemini: {
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
      usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 10, totalTokenCount: 100 },
    },
  };
  globalThis.fetch = async (url) => {
    const provider = url.includes('openai.com') ? 'openai' : url.includes('anthropic.com') ? 'anthropic' : 'gemini';
    return { ok: true, json: async () => responses[provider] };
  };
  try {
    for (const [provider, expected] of Object.entries({
      openai: { input: 120, output: 8, total: 128 },
      anthropic: { input: 100, output: 10, total: 110 },
      gemini: { input: 90, output: 10, total: 100 },
    })) {
      let usage;
      const result = await completeJSON({
        provider,
        apiKey: 'test-key',
        model: 'test-model',
        system: 'Return JSON.',
        user: 'Return {"ok":true}.',
        onUsage: (reported) => {
          usage = reported;
        },
      });
      assert.deepEqual(result, { ok: true });
      assert.deepEqual(usage, expected);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('tailoring prompt substitutes resume and job description and requires both placeholders', () => {
  const user = buildTailorResumeUser(DEFAULT_TAILORING_PROMPT, 'RESUME CONTENT', 'JOB DESCRIPTION');
  assert.match(user, /RESUME CONTENT/);
  assert.match(user, /JOB DESCRIPTION/);
  assert.match(user, /valid JSON only/);
  assert.match(user, /\{"resume":"the complete rewritten resume as plain text"\}/);
  assert.match(DEFAULT_TAILORING_PROMPT, /Do not invent experience or credentials/);
  assert.match(DEFAULT_TAILORING_PROMPT, /work-history roles in reverse chronological order/i);
  assert.match(TAILOR_RESUME_SYSTEM, /current or present roles first/i);
  assert.match(TAILOR_RESUME_SYSTEM, /overrides any instruction to prioritize entire roles by relevance/i);
  assert.throws(() => buildTailorResumeUser('Tailor this resume', 'resume', 'job'), /must include both/);
});

test('scores original and tailored resume text through ApplyIQ with an optional API key', async () => {
  let request;
  const scores = await scoreResumeWithService(
    'Original resume text',
    'Target job description',
    'rb_test_key',
    async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return { ats: { total_score: 82.5 }, hr: { overall_score: 74 } };
        },
      };
    }
  );
  assert.deepEqual(scores, { ats: 82.5, hr: 74 });
  assert.equal(request.url, 'https://resume-scorer.fly.dev/score/both');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-API-Key'], 'rb_test_key');
  assert.deepEqual(JSON.parse(request.options.body), {
    resume_text: 'Original resume text',
    jd_text: 'Target job description',
  });
});

test('always sends resume text to ApplyIQ instead of a resume file', async () => {
  let requestBody;
  const scores = await scoreResumeWithService(
    'PDF extracted resume text',
    'Target job description',
    '',
    async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return { ats: { total_score: 67 }, hr: { overall_score: 71 } };
        },
      };
    }
  );
  assert.deepEqual(scores, { ats: 67, hr: 71 });
  assert.deepEqual(requestBody, {
    resume_text: 'PDF extracted resume text',
    jd_text: 'Target job description',
  });
});

test('supports anonymous scorer requests and reports API and invalid-score errors', async () => {
  let requestHeaders;
  await assert.rejects(
    scoreResumeWithService('Resume', 'Job', '', async (_url, options) => {
      requestHeaders = options.headers;
      return {
        ok: false,
        status: 429,
        async json() { return { detail: 'Usage limit reached.' }; },
      };
    }),
    /Usage limit reached/
  );
  assert.equal(requestHeaders['X-API-Key'], undefined);
  await assert.rejects(
    scoreResumeWithService('Resume', 'Job', '', async () => ({
      ok: true,
      status: 200,
      async json() { return { ats: { total_score: 101 }, hr: { overall_score: 70 } }; },
    })),
    /valid ATS score/
  );
  await assert.rejects(scoreResumeWithService('', 'Job'), /empty resume/);
});

test('job context includes title, company and description for tailoring', () => {
  assert.equal(
    buildJobContext({ title: 'Engineer', company: 'Acme', jobDescription: 'Build reliable systems.' }),
    'Job title: Engineer\n\nCompany: Acme\n\nJob description:\nBuild reliable systems.'
  );
});

test('downloaded PDF filename uses company, title and date while upload filename uses candidate name', () => {
  assert.equal(
    buildTailoredFilename({ company: 'Acme Robotics', title: 'Senior Engineer' }, new Date('2026-11-09T12:00:00.000Z')),
    'Acme-Robotics-Senior-Engineer-2026-11-09.pdf'
  );
  assert.equal(
    buildTailoredFilename({ company: 'Abc', title: 'AI Engineer' }, new Date('2026-11-09T12:00:00.000Z')),
    'Abc-AI-Engineer-2026-11-09.pdf'
  );
  assert.equal(
    buildTailoredFilename({}, new Date('2026-11-09T12:00:00.000Z')),
    'unknown-company-untitled-job-2026-11-09.pdf'
  );
  assert.equal(buildCandidateFilename('Jane Q. Doe'), 'Jane Q. Doe.pdf');
  assert.equal(buildCandidateFilename('Jane/Doe'), 'Jane Doe.pdf');
  assert.equal(buildCandidateFilename(''), 'Tailored Resume.pdf');
});

test('job history duplicate matching normalizes URLs and falls back to title and company', () => {
  assert.equal(normalizeJobUrl('https://Example.com/jobs/123/?utm_source=feed#apply'), 'https://example.com/jobs/123/?utm_source=feed#apply');
  const applied = { id: 'one', title: 'Engineer', company: 'Acme', url: 'https://example.com/jobs/123?ref=feed', status: 'applied' };
  assert.equal(findPriorApplication([applied], { url: 'https://example.com/jobs/123?ref=feed' }), applied);
  assert.equal(findPriorApplication([applied], { url: 'https://example.com/jobs/123?ref=other' }), null);
  assert.equal(findPriorApplication([{ ...applied, url: '' }], { title: 'Engineer', company: 'Acme' }).id, applied.id);
  assert.equal(findPriorApplication([{ ...applied, url: '' }], { title: 'Engineer', company: 'Acme', url: 'https://jobs.example/123' }).id, applied.id);
  assert.equal(findPriorApplication([applied], { title: 'Engineer', company: 'Acme', url: 'https://jobs.example/123' }), null);
  assert.equal(findPriorApplication([{ ...applied, status: 'tailored' }], { url: applied.url }), null);
});

test('job history helpers persist and update local entries', async () => {
  const data = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (Array.isArray(key)) return Object.fromEntries(key.map((name) => [name, data[name]]));
          return { [key]: data[key] };
        },
        async set(values) {
          Object.assign(data, values);
        },
        async remove(key) {
          delete data[key];
        },
      },
      session: {
        async get(key) {
          if (Array.isArray(key)) return Object.fromEntries(key.map((name) => [name, data[name]]));
          return { [key]: data[key] };
        },
        async set(values) {
          Object.assign(data, values);
        },
      },
    },
  };
  try {
    assert.equal((await getSettings()).tailoringPrompt, DEFAULT_TAILORING_PROMPT);
    assert.equal((await getSettings()).scorerApiKey, '');
    await recordAIUsage('openai', 'test-model', { input: 20, output: 5, total: 25 });
    await recordAIUsage('openai', 'test-model', { input: 10, output: 3, total: 13 });
    const usage = await getAIUsage();
    assert.deepEqual({
      ...usage['openai:test-model'],
      lastUsedAt: Number.isFinite(usage['openai:test-model'].lastUsedAt),
    }, {
      provider: 'openai',
      model: 'test-model',
      inputTokens: 30,
      outputTokens: 8,
      totalTokens: 38,
      requests: 2,
      lastUsedAt: true,
    });
    await clearAIUsage();
    assert.deepEqual(await getAIUsage(), {});
    const pageUrl = 'https://example.com/job/1?source=career';
    const otherPageUrl = 'https://example.com/job/2?source=career';
    assert.equal(await getCurrentJobInfo(pageUrl), null);
    const job = { title: 'Engineer', company: 'Acme', url: pageUrl, jobDescription: 'Build tools.' };
    const otherJob = { title: 'Designer', company: 'Beta', url: otherPageUrl, jobDescription: 'Create products.' };
    await saveCurrentJobInfo(pageUrl, job);
    await saveCurrentJobInfo(otherPageUrl, otherJob);
    await saveActiveJobInfo(job);
    assert.deepEqual(await getCurrentJobInfo(pageUrl), job);
    assert.deepEqual(await getCurrentJobInfo(otherPageUrl), otherJob);
    assert.deepEqual(await getActiveJobInfo(), job);
    await saveActiveJobInfo(otherJob);
    assert.deepEqual(await getActiveJobInfo(), otherJob);
    const tailoredResume = { filename: 'acme-engineer.docx', resumeText: 'Tailored content', file: { name: 'acme-engineer.docx', base64: 'ZmlsZQ==' } };
    await saveLastTailoredResume(tailoredResume);
    assert.deepEqual(await getLastTailoredResume(), tailoredResume);
    data.resumeFile = { name: 'default.docx', base64: 'ZGVmYXVsdA==' };
    assert.deepEqual(await getResumeFileForAutofill(), tailoredResume.file);
    delete data.lastTailoredResume;
    assert.deepEqual(await getResumeFileForAutofill(), data.resumeFile);
    assert.equal(await getCurrentJobInfo('https://example.com/job/1?source=other'), null);
    const entry = createJobHistoryEntry({ title: 'Engineer', company: 'Acme', url: 'https://example.com/job/1' }, 'tailored-resume.docx', 123);
    await addJobHistoryEntry(entry);
    assert.equal((await getJobHistory())[0].status, 'tailored');
    await clearJobHistory();
    assert.deepEqual(await getJobHistory(), []);
    await addJobHistoryEntry(entry);
    await updateJobHistoryEntry(entry.id, { status: 'applied', notes: 'Submitted' });
    const saved = (await getJobHistory())[0];
    assert.deepEqual({ status: saved.status, notes: saved.notes }, { status: 'applied', notes: 'Submitted' });
    await deleteJobHistoryEntry(entry.id);
    assert.deepEqual(await getJobHistory(), []);
  } finally {
    delete globalThis.chrome;
  }
});

test('bytesToBase64 round-trips large binary data', () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
  assert.deepEqual(new Uint8Array(Buffer.from(bytesToBase64(bytes), 'base64')), bytes);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});
