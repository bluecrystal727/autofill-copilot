import { LLMError, completeJSON, testConnection } from '../lib/llm.js';
import { DEFAULT_TAILORING_PROMPT, RESUME_PARSE_SYSTEM, buildResumeParseUser, buildTailorResumeUser } from '../lib/prompts.js';
import { extractResumeText, fileToStored } from '../lib/resume.js';
import { createJobHistoryXlsx } from '../lib/xlsx.js';
import {
  JOB_HISTORY_STATUSES,
  LIST_ITEM_TEMPLATES,
  PROVIDERS,
  activeModel,
  clearAllData,
  clearCache,
  clearAIUsage,
  clearJobHistory,
  deleteJobHistoryEntry,
  getExtras,
  getAIUsage,
  getJobHistory,
  getProfile,
  getResumeFile,
  getResumeText,
  getSettings,
  normalizeProfile,
  saveExtras,
  saveProfile,
  saveResumeFile,
  saveResumeText,
  saveSettings,
  recordAIUsage,
  updateJobHistoryEntry,
} from '../lib/storage.js';

const $ = (id) => document.getElementById(id);

let settings;
let profile;
let extras;
let pendingFile = null; // File chosen but not yet saved

// ---------- small helpers ----------

function status(id, msg, kind = 'ok', timeout = kind === 'ok' ? 3000 : 0) {
  const el = $(id);
  el.textContent = msg;
  el.className = `status ${kind}`;
  if (timeout) setTimeout(() => el.textContent === msg && (el.textContent = ''), timeout);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

/**
 * Builds a labelled input bound to `model[path]`.
 * type: text|email|tel|url|number|textarea|checkbox|select|list (comma-separated array)
 */
function field(model, path, label, type = 'text', opts = {}) {
  const value = getPath(model, path);
  let input;
  if (type === 'textarea') {
    input = el('textarea', { rows: opts.rows || 3, value: value ?? '', placeholder: opts.placeholder || '' });
  } else if (type === 'select') {
    input = el('select', {}, ...opts.options.map((o) => el('option', { value: o, textContent: o || '—' })));
    if (value && !opts.options.includes(value)) {
      input.prepend(el('option', { value, textContent: value }));
    }
    input.value = value ?? '';
  } else if (type === 'checkbox') {
    input = el('input', { type: 'checkbox', checked: Boolean(value) });
    input.addEventListener('change', () => setPath(model, path, input.checked));
    return el('label', { class: 'check' }, input, label);
  } else if (type === 'list') {
    input = el('input', { type: 'text', value: (value || []).join(', '), placeholder: opts.placeholder || 'comma, separated' });
  } else {
    input = el('input', { type, value: value ?? '', placeholder: opts.placeholder || '', spellcheck: false });
  }
  const sync = () => {
    let v = input.value;
    if (type === 'list') v = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (type === 'number') v = v === '' ? null : Number(v);
    setPath(model, path, v);
  };
  input.addEventListener('input', sync);
  input.addEventListener('change', sync);
  return el('label', { class: opts.wide ? 'wide' : '' }, label, input);
}

// ---------- profile form ----------

const LIST_SECTIONS = {
  workExperience: {
    title: 'Work experience',
    add: 'job',
    fields: [
      ['title', 'Job title'],
      ['company', 'Company'],
      ['location', 'Location'],
      ['startDate', 'Start (YYYY-MM)'],
      ['endDate', 'End (YYYY-MM or Present)'],
      ['current', 'I currently work here', 'checkbox'],
      ['description', 'Description', 'textarea', { wide: true, rows: 4 }],
    ],
  },
  education: {
    title: 'Education',
    add: 'school',
    fields: [
      ['school', 'School'],
      ['degree', 'Degree'],
      ['field', 'Field of study'],
      ['location', 'Location'],
      ['startDate', 'Start (YYYY-MM)'],
      ['endDate', 'End (YYYY-MM)'],
      ['gpa', 'GPA'],
    ],
  },
  projects: {
    title: 'Projects',
    add: 'project',
    fields: [
      ['name', 'Name'],
      ['url', 'URL', 'url'],
      ['description', 'Description', 'textarea', { wide: true }],
    ],
  },
  certifications: {
    title: 'Certifications',
    add: 'certification',
    fields: [
      ['name', 'Name'],
      ['issuer', 'Issuer'],
      ['date', 'Date (YYYY-MM)'],
    ],
  },
};

function listSection(model, key, spec, rerender) {
  const items = model[key];
  return el(
    'fieldset',
    {},
    el('legend', {}, spec.title),
    items.map((item, i) =>
      el(
        'div',
        { class: 'item' },
        el('button', { class: 'remove', type: 'button', textContent: 'Remove', onclick: () => (items.splice(i, 1), rerender()) }),
        el('div', { class: 'grid' }, spec.fields.map(([path, label, type, opts]) => field(item, path, label, type, opts)))
      )
    ),
    el('button', {
      class: 'secondary',
      type: 'button',
      textContent: `+ Add ${spec.add}`,
      onclick: () => (items.push(LIST_ITEM_TEMPLATES[key]()), rerender()),
    })
  );
}

function renderProfile() {
  const p = profile;
  $('profile-form').replaceChildren(
    el(
      'fieldset',
      {},
      el('legend', {}, 'Personal'),
      el(
        'div',
        { class: 'grid' },
        field(p, 'personal.firstName', 'First name'),
        field(p, 'personal.middleName', 'Middle name'),
        field(p, 'personal.lastName', 'Last name'),
        field(p, 'personal.preferredName', 'Preferred name'),
        field(p, 'personal.email', 'Email', 'email'),
        field(p, 'personal.phone', 'Phone', 'tel'),
        field(p, 'personal.location.address', 'Street address'),
        field(p, 'personal.location.city', 'City'),
        field(p, 'personal.location.state', 'State / province'),
        field(p, 'personal.location.postalCode', 'Postal code'),
        field(p, 'personal.location.country', 'Country'),
        field(p, 'personal.linkedin', 'LinkedIn URL', 'url'),
        field(p, 'personal.github', 'GitHub URL', 'url'),
        field(p, 'personal.portfolio', 'Portfolio URL', 'url'),
        field(p, 'personal.website', 'Other website', 'url')
      )
    ),
    el(
      'fieldset',
      {},
      el('legend', {}, 'Summary & skills'),
      el(
        'div',
        { class: 'grid' },
        field(p, 'headline', 'Headline / current title'),
        field(p, 'totalYearsExperience', 'Years of experience', 'number'),
        field(p, 'summary', 'Summary', 'textarea', { wide: true, rows: 4 }),
        field(p, 'skills', 'Skills', 'list', { wide: true }),
        field(p, 'languages', 'Languages', 'list', { wide: true, placeholder: 'English (Native), Spanish (Professional)' })
      )
    ),
    ...Object.entries(LIST_SECTIONS).map(([key, spec]) => listSection(p, key, spec, renderProfile))
  );
}

// ---------- application answers ----------

const YES_NO = ['', 'Yes', 'No'];
const DECLINE = 'Decline to self-identify';
const GENDER_OPTIONS = [
  '',
  DECLINE,
  'Female',
  'Male',
  'Non-binary',
  'Self-describe',
];
const ETHNICITY_OPTIONS = [
  '',
  DECLINE,
  'American Indian or Alaska Native',
  'Asian',
  'Black or African American',
  'Hispanic or Latino',
  'Native Hawaiian or Other Pacific Islander',
  'White',
  'Two or more races',
  'Self-describe',
];
const VETERAN_OPTIONS = [
  '',
  DECLINE,
  'I am not a protected veteran',
  'I identify as a protected veteran',
];
const DISABILITY_OPTIONS = ['', DECLINE, 'Yes', 'No'];

function renderAnswers() {
  const e = extras;
  $('answers-form').replaceChildren(
    el(
      'div',
      { class: 'grid' },
      field(e, 'workAuthorization', 'Legally authorized to work in the job’s country?', 'select', { options: YES_NO }),
      field(e, 'requiresSponsorship', 'Will you require visa sponsorship?', 'select', { options: YES_NO }),
      field(e, 'workAuthorizationDetails', 'Work authorization details', 'text', { placeholder: 'e.g. US citizen, H-1B, EU citizen' }),
      field(e, 'over18', 'Are you 18 or older?', 'select', { options: YES_NO }),
      field(e, 'willingToRelocate', 'Willing to relocate?', 'select', { options: YES_NO }),
      field(e, 'workPreference', 'Work preference', 'select', { options: ['', 'Remote', 'Hybrid', 'On-site', 'Any'] }),
      field(e, 'desiredSalary', 'Desired salary', 'text', { placeholder: 'e.g. 120,000 USD / year' }),
      field(e, 'noticePeriod', 'Notice period', 'text', { placeholder: 'e.g. 2 weeks' }),
      field(e, 'earliestStartDate', 'Earliest start date', 'text', { placeholder: 'e.g. 2027-01-15 or Immediately' }),
      field(e, 'howDidYouHear', '“How did you hear about us?” default', 'text', { placeholder: 'e.g. LinkedIn' }),
      field(e, 'pronouns', 'Pronouns', 'text')
    ),
    el('h3', {}, 'Voluntary self-identification'),
    el('p', { class: 'small muted' }, 'Used only for optional EEO / diversity questions. Default is to decline.'),
    el(
      'div',
      { class: 'grid' },
      field(e, 'gender', 'Gender', 'select', { options: GENDER_OPTIONS }),
      field(e, 'ethnicity', 'Race / ethnicity', 'select', { options: ETHNICITY_OPTIONS }),
      field(e, 'veteranStatus', 'Veteran status', 'select', { options: VETERAN_OPTIONS }),
      field(e, 'disabilityStatus', 'Disability status', 'select', { options: DISABILITY_OPTIONS })
    )
  );
  renderQA();
  $('additional-instructions').value = e.additionalInstructions;
}

function renderQA() {
  const list = extras.customQA;
  $('qa-list').replaceChildren(
    ...list.map((qa, i) =>
      el(
        'div',
        { class: 'item' },
        el('button', { class: 'remove', type: 'button', textContent: 'Remove', onclick: () => (list.splice(i, 1), renderQA()) }),
        field(qa, 'question', 'Question'),
        field(qa, 'answer', 'Answer', 'textarea', { rows: 3 })
      )
    )
  );
}

// ---------- AI provider ----------

function renderAI() {
  const sel = $('provider');
  sel.replaceChildren(...Object.entries(PROVIDERS).map(([id, p]) => el('option', { value: id, textContent: p.label })));
  sel.value = settings.provider;
  $('scorer-api-key').value = settings.scorerApiKey || '';
  showProvider();
  renderAIUsage().catch((e) => status('usage-status', `Could not load token usage: ${e.message}`, 'err'));
}

async function renderAIUsage() {
  const usage = await getAIUsage();
  const entries = Object.values(usage).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  const container = $('ai-usage-list');
  if (!entries.length) {
    container.replaceChildren(el('p', { class: 'small muted', textContent: 'No provider token usage has been recorded yet.' }));
    return;
  }
  container.replaceChildren(
    ...entries.map((entry) => {
      const total = entry.inputTokens + entry.outputTokens;
      const inputShare = total ? (entry.inputTokens / total) * 100 : 0;
      const outputShare = total ? (entry.outputTokens / total) * 100 : 0;
      return el(
        'div',
        { class: 'usage-row' },
        el('div', { class: 'row usage-heading' },
          el('strong', { textContent: `${PROVIDERS[entry.provider]?.label || entry.provider} · ${entry.model}` }),
          el('span', { class: 'small muted', textContent: `${entry.requests.toLocaleString()} request${entry.requests === 1 ? '' : 's'}` })
        ),
        el('div', { class: 'usage-meter', role: 'img', 'aria-label': `${inputShare.toFixed(0)}% input tokens, ${outputShare.toFixed(0)}% output tokens` },
          el('span', { class: 'usage-input', style: `width:${inputShare}%` }),
          el('span', { class: 'usage-output', style: `width:${outputShare}%` })
        ),
        el('p', { class: 'small usage-counts', textContent: `${entry.inputTokens.toLocaleString()} input · ${entry.outputTokens.toLocaleString()} output · ${entry.totalTokens.toLocaleString()} total tokens` })
      );
    })
  );
}

function showProvider() {
  const id = $('provider').value;
  const info = PROVIDERS[id];
  $('model').value = settings.models[id] || '';
  $('model').placeholder = info.defaultModel;
  $('api-key').value = settings.apiKeys[id] || '';
  $('api-key').placeholder = info.keyHint;
  $('key-link').href = info.keyUrl;
  $('key-link').textContent = info.keyUrl.replace(/^https:\/\//, '');
}

function readAI() {
  const id = $('provider').value;
  settings.provider = id;
  settings.apiKeys[id] = $('api-key').value.trim();
  settings.models[id] = $('model').value.trim();
  settings.scorerApiKey = $('scorer-api-key').value.trim();
}

$('provider').addEventListener('change', showProvider);
$('toggle-key').addEventListener('click', () => {
  const k = $('api-key');
  k.type = k.type === 'password' ? 'text' : 'password';
  $('toggle-key').textContent = k.type === 'password' ? 'Show' : 'Hide';
});
$('save-ai').addEventListener('click', async () => {
  readAI();
  await saveSettings(settings);
  status('ai-status', 'Saved.');
});
$('test-ai').addEventListener('click', async () => {
  readAI();
  status('ai-status', 'Testing…', 'busy');
  $('test-ai').disabled = true;
  try {
    await testConnection({
      provider: settings.provider,
      apiKey: settings.apiKeys[settings.provider],
      model: activeModel(settings),
      onUsage: (usage) => recordAIUsage(settings.provider, activeModel(settings), usage),
    });
    await saveSettings(settings);
    await renderAIUsage();
    status('ai-status', `Connected to ${activeModel(settings)} and saved.`, 'ok', 6000);
  } catch (e) {
    status('ai-status', e.message, 'err');
  } finally {
    $('test-ai').disabled = false;
  }
});

// ---------- resume upload & parsing ----------

async function handleFile(file) {
  if (!file) return;
  status('resume-status', `Reading ${file.name}…`, 'busy');
  try {
    const text = await extractResumeText(file);
    $('resume-text').value = text;
    $('paste-box').open = false;
    pendingFile = file;
    $('file-info').textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB · ${text.length.toLocaleString()} characters extracted. Click “Parse with AI”.`;
    status('resume-status', 'Text extracted.', 'ok');
  } catch (e) {
    pendingFile = null;
    status('resume-status', e.message, 'err');
  }
}

const drop = $('drop');
drop.addEventListener('click', () => $('file').click());
drop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && $('file').click());
$('file').addEventListener('change', (e) => handleFile(e.target.files[0]));
drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('over')));
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  handleFile(e.dataTransfer.files[0]);
});

$('parse').addEventListener('click', async () => {
  const text = $('resume-text').value.trim();
  if (text.length < 40) return status('resume-status', 'Upload a resume or paste its text first.', 'err');
  readAI();
  const apiKey = settings.apiKeys[settings.provider];
  if (!apiKey) return status('resume-status', 'Add your API key in step 1 first.', 'err');

  $('parse').disabled = true;
  status('resume-status', `Parsing with ${activeModel(settings)}… (10–60 s)`, 'busy');
  try {
    const parsed = await completeJSON({
      provider: settings.provider,
      apiKey,
      model: activeModel(settings),
      system: RESUME_PARSE_SYSTEM,
      user: buildResumeParseUser(text.slice(0, 60000)),
      maxTokens: 16000,
      onUsage: (usage) => recordAIUsage(settings.provider, activeModel(settings), usage),
    });
    await renderAIUsage();
    profile = normalizeProfile(parsed);
    await saveSettings(settings);
    await saveProfile(profile);
    await saveResumeText(text);
    if (pendingFile) {
      await saveResumeFile(await fileToStored(pendingFile));
      pendingFile = null;
    }
    renderProfile();
    await refreshFileInfo();
    status('resume-status', 'Profile created. Review it below and fix anything that looks off.', 'ok', 8000);
    $('profile').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    status('resume-status', e instanceof LLMError ? e.message : `Parsing failed: ${e.message}`, 'err');
  } finally {
    $('parse').disabled = false;
  }
});

async function refreshFileInfo() {
  const f = await getResumeFile();
  if (f && !pendingFile) {
    $('file-info').textContent = `Saved resume file: ${f.name} (${(f.size / 1024).toFixed(0)} KB) – attached to resume upload fields when possible.`;
  }
}

// ---------- save profile / answers / preferences ----------

$('save-profile').addEventListener('click', async () => {
  await saveProfile(profile);
  profile = await getProfile();
  status('profile-status', 'Profile saved.');
});

$('add-qa').addEventListener('click', () => {
  extras.customQA.push(LIST_ITEM_TEMPLATES.customQA());
  renderQA();
});
$('additional-instructions').addEventListener('input', (e) => (extras.additionalInstructions = e.target.value));
$('save-answers').addEventListener('click', async () => {
  await saveExtras(extras);
  extras = await getExtras();
  status('answers-status', 'Answers saved.');
});

const PREF_KEYS = ['reviewLongAnswers', 'attachResume', 'useCache', 'overwriteExisting', 'fillSensitive'];

function renderPrefs() {
  for (const k of PREF_KEYS) $(k).checked = Boolean(settings[k]);
}

function renderTailoring() {
  $('tailoring-prompt').value = settings.tailoringPrompt || DEFAULT_TAILORING_PROMPT;
}

$('save-tailoring').addEventListener('click', async () => {
  const prompt = $('tailoring-prompt').value;
  try {
    buildTailorResumeUser(prompt, '', '');
    settings.tailoringPrompt = prompt;
    await saveSettings(settings);
    status('tailoring-status', 'Tailoring prompt saved.');
  } catch (e) {
    status('tailoring-status', e.message, 'err');
  }
});

$('reset-tailoring').addEventListener('click', async () => {
  $('tailoring-prompt').value = DEFAULT_TAILORING_PROMPT;
  settings.tailoringPrompt = DEFAULT_TAILORING_PROMPT;
  await saveSettings(settings);
  status('tailoring-status', 'Default tailoring prompt restored.');
});

$('save-prefs').addEventListener('click', async () => {
  readAI();
  for (const k of PREF_KEYS) settings[k] = $(k).checked;
  await saveSettings(settings);
  if (!settings.useCache) await clearCache();
  status('prefs-status', 'Preferences saved.');
});

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

async function renderJobHistory() {
  try {
    const history = (await getJobHistory()).sort((a, b) => b.createdAt - a.createdAt);
    if (!history.length) {
      $('history-list').replaceChildren(el('p', { class: 'muted', textContent: 'No jobs have been tailored yet.' }));
      return;
    }

    const table = el(
      'table',
      { class: 'history-table' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          ...['Job', 'Company', 'Created', 'Status', 'Notes', 'Actions'].map((heading) => el('th', { scope: 'col', textContent: heading }))
        )
      )
    );
    const body = el('tbody');
    for (const entry of history) {
      const date = new Date(entry.createdAt);
      const url = safeHttpUrl(entry.url);
      const title = entry.title || 'Untitled job';
      const select = el(
        'select',
        { 'aria-label': `Status for ${title}` },
        ...JOB_HISTORY_STATUSES.map((value) => el('option', { value, textContent: value[0].toUpperCase() + value.slice(1) }))
      );
      select.value = entry.status;
      const notes = el('textarea', { rows: 1, placeholder: 'Notes', value: entry.notes, 'aria-label': `Notes for ${title}` });
      const saveButton = el('button', {
        class: 'secondary history-action',
        type: 'button',
        textContent: 'Save',
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            await updateJobHistoryEntry(entry.id, { status: select.value, notes: notes.value });
            status('history-status', 'History entry updated.');
          } catch (e) {
            status('history-status', e.message, 'err');
          } finally {
            button.disabled = false;
          }
        },
      });
      const deleteButton = el('button', {
        class: 'danger history-action',
        type: 'button',
        textContent: 'Delete',
        onclick: async () => {
          if (!confirm(`Delete the history entry for ${title}?`)) return;
          try {
            await deleteJobHistoryEntry(entry.id);
            status('history-status', 'History entry deleted.');
            await renderJobHistory();
          } catch (e) {
            status('history-status', e.message, 'err');
          }
        },
      });
      body.append(
        el(
          'tr',
          {},
          el(
            'td',
            { class: 'history-job' },
            url ? el('a', { href: url, target: '_blank', rel: 'noopener', textContent: title }) : el('strong', { textContent: title }),
            entry.filename ? el('span', { class: 'history-filename muted small', textContent: entry.filename }) : null
          ),
          el('td', { textContent: entry.company || '—' }),
          el('td', { class: 'history-date', textContent: Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString() }),
          el('td', {}, select),
          el('td', {}, notes),
          el('td', { class: 'history-actions' }, saveButton, deleteButton)
        )
      );
    }
    table.append(body);
    $('history-list').replaceChildren(el('div', { class: 'history-table-wrap' }, table));
  } catch (e) {
    status('history-status', `Could not load job history: ${e.message}`, 'err');
  }
}

$('export-history-xlsx').addEventListener('click', async () => {
  try {
    const history = await getJobHistory();
    const bytes = createJobHistoryXlsx(history);
    const date = new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(
      new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    );
    el('a', { href: url, download: `job-history-${date}.xlsx` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('history-status', `Exported ${history.length} job history entr${history.length === 1 ? 'y' : 'ies'} to XLSX.`);
  } catch (e) {
    status('history-status', `Could not export job history: ${e.message}`, 'err');
  }
});

$('clear-history').addEventListener('click', async () => {
  if (!confirm('Delete all job history? This cannot be undone.')) return;
  try {
    await clearJobHistory();
    await renderJobHistory();
    status('history-status', 'All job history deleted.');
  } catch (e) {
    status('history-status', `Could not clear job history: ${e.message}`, 'err');
  }
});

// ---------- import / export / delete ----------

$('export').addEventListener('click', () => {
  const data = { app: 'autofill-copilot', version: 1, exportedAt: new Date().toISOString(), profile, extras };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  el('a', { href: url, download: 'autofill-copilot-profile.json' }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('data-status', 'Exported (API keys are never included).');
});

$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.profile && !data.extras) throw new Error('No profile found in this file.');
    if (data.profile) await saveProfile(data.profile);
    if (data.extras) await saveExtras(data.extras);
    [profile, extras] = await Promise.all([getProfile(), getExtras()]);
    renderProfile();
    renderAnswers();
    status('data-status', 'Imported.');
  } catch (err) {
    status('data-status', `Import failed: ${err.message}`, 'err');
  }
});

$('clear-cache').addEventListener('click', async () => {
  await clearCache();
  status('data-status', 'Remembered answers cleared.');
});

$('clear-all').addEventListener('click', async () => {
  if (!confirm('Delete your profile, resume, answers, and API keys from this browser?')) return;
  await clearAllData();
  await init();
  $('resume-text').value = '';
  $('file-info').textContent = '';
  status('data-status', 'All data deleted.');
});

// ---------- init ----------

async function init() {
  [settings, profile, extras] = await Promise.all([getSettings(), getProfile(), getExtras()]);
  renderAI();
  renderProfile();
  renderAnswers();
  renderPrefs();
  renderTailoring();
  await renderJobHistory();
  const text = await getResumeText();
  if (text) $('resume-text').value = text;
  await refreshFileInfo();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.aiUsage) {
    renderAIUsage().catch((e) => status('usage-status', `Could not refresh token usage: ${e.message}`, 'err'));
  }
});

$('clear-ai-usage').addEventListener('click', async () => {
  try {
    await clearAIUsage();
    await renderAIUsage();
    status('usage-status', 'Tracked usage cleared.');
  } catch (e) {
    status('usage-status', `Could not clear tracked usage: ${e.message}`, 'err');
  }
});

init().catch((e) => console.error(e));
