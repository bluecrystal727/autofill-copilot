// Shared storage helpers used by the background worker, popup, and options page.
// Everything lives in chrome.storage.local on this device; nothing is synced.

import { DEFAULT_TAILORING_PROMPT } from './tailor.js';

export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-6-luna',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
  },
  anthropic: {
    label: 'Anthropic Claude',
    defaultModel: 'claude-haiku-5-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-…',
  },
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-3.5-flash-lite',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza…',
  },
};

export const DEFAULT_SETTINGS = {
  provider: 'openai',
  apiKeys: { openai: '', anthropic: '', gemini: '' },
  models: { openai: '', anthropic: '', gemini: '' }, // '' = provider default
  scorerApiKey: '',
  reviewLongAnswers: true, // drafted open-ended answers wait for approval in the popup
  overwriteExisting: false, // leave fields the user (or the site) already filled
  fillSensitive: false, // never fill SSN / DOB / bank / passport style fields unless enabled
  attachResume: true, // try to attach the stored resume file to "Resume/CV" upload inputs
  useCache: true, // remember short answers per site to save tokens
  tailoringPrompt: DEFAULT_TAILORING_PROMPT,
};

export const DEFAULT_EXTRAS = {
  workAuthorization: '',
  requiresSponsorship: '',
  workAuthorizationDetails: '',
  over18: '',
  willingToRelocate: '',
  workPreference: '',
  desiredSalary: '',
  noticePeriod: '',
  earliestStartDate: '',
  howDidYouHear: '',
  pronouns: '',
  gender: 'Decline to self-identify',
  ethnicity: 'Decline to self-identify',
  veteranStatus: 'Decline to self-identify',
  disabilityStatus: 'Decline to self-identify',
  customQA: [],
  additionalInstructions: '',
};

export function emptyProfile() {
  return {
    personal: {
      firstName: '',
      middleName: '',
      lastName: '',
      preferredName: '',
      email: '',
      phone: '',
      location: { address: '', city: '', state: '', postalCode: '', country: '' },
      linkedin: '',
      github: '',
      portfolio: '',
      website: '',
    },
    headline: '',
    summary: '',
    totalYearsExperience: null,
    workExperience: [],
    education: [],
    projects: [],
    certifications: [],
    skills: [],
    languages: [],
  };
}

export const LIST_ITEM_TEMPLATES = {
  workExperience: () => ({ company: '', title: '', location: '', startDate: '', endDate: '', current: false, description: '' }),
  education: () => ({ school: '', degree: '', field: '', location: '', startDate: '', endDate: '', gpa: '' }),
  projects: () => ({ name: '', url: '', description: '' }),
  certifications: () => ({ name: '', issuer: '', date: '' }),
  customQA: () => ({ question: '', answer: '' }),
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Deep-merge `value` onto `template` so every expected key exists with the right shape.
function conform(template, value) {
  if (Array.isArray(template)) return Array.isArray(value) ? value : template;
  if (isPlainObject(template)) {
    const out = {};
    const src = isPlainObject(value) ? value : {};
    for (const key of Object.keys(template)) out[key] = conform(template[key], src[key]);
    return out;
  }
  if (template === null) return value === undefined ? null : value;
  if (value === undefined || value === null) return template;
  if (typeof template === 'string') return String(value);
  if (typeof template === 'boolean') return value === true || value === 'true';
  return value;
}

export function normalizeProfile(raw) {
  const p = conform(emptyProfile(), raw);
  for (const [key, make] of Object.entries(LIST_ITEM_TEMPLATES)) {
    if (Array.isArray(p[key])) p[key] = p[key].filter(isPlainObject).map((it) => conform(make(), it));
  }
  p.skills = (p.skills || []).map(String).map((s) => s.trim()).filter(Boolean);
  p.languages = (p.languages || []).map(String).map((s) => s.trim()).filter(Boolean);
  const n = p.totalYearsExperience === '' || p.totalYearsExperience === null ? NaN : Number(p.totalYearsExperience);
  p.totalYearsExperience = Number.isFinite(n) ? n : null;
  return p;
}

export function normalizeExtras(raw) {
  const e = conform(DEFAULT_EXTRAS, raw);
  e.customQA = (e.customQA || []).filter(isPlainObject).map((it) => conform(LIST_ITEM_TEMPLATES.customQA(), it));
  return e;
}

export function hasProfile(profile) {
  if (!profile) return false;
  const p = profile.personal || {};
  return Boolean(p.firstName || p.lastName || p.email || (profile.workExperience || []).length);
}

export function activeModel(settings) {
  return (settings.models?.[settings.provider] || '').trim() || PROVIDERS[settings.provider]?.defaultModel;
}

// ---------- chrome.storage wrappers ----------

const local = () => chrome.storage.local;
const session = () => chrome.storage.session;

export async function getLastTailoredResume() {
  const { lastTailoredResume } = await session().get('lastTailoredResume');
  return lastTailoredResume || null;
}

export async function saveLastTailoredResume(result) {
  if (!result?.file?.base64 || !result.file.name) throw new Error('Cannot save an invalid tailored resume.');
  await session().set({ lastTailoredResume: result });
}

export async function getSettings() {
  const { settings } = await local().get('settings');
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  s.apiKeys = { ...DEFAULT_SETTINGS.apiKeys, ...(settings?.apiKeys || {}) };
  s.models = { ...DEFAULT_SETTINGS.models, ...(settings?.models || {}) };
  if (typeof s.scorerApiKey !== 'string') s.scorerApiKey = '';
  if (typeof s.tailoringPrompt !== 'string' || !s.tailoringPrompt.trim()) s.tailoringPrompt = DEFAULT_TAILORING_PROMPT;
  if (!PROVIDERS[s.provider]) s.provider = DEFAULT_SETTINGS.provider;
  return s;
}

export async function saveSettings(settings) {
  await local().set({ settings });
}

export async function getAIUsage() {
  const { aiUsage = {} } = await local().get('aiUsage');
  if (!isPlainObject(aiUsage)) return {};
  return Object.fromEntries(
    Object.entries(aiUsage)
      .filter(([, entry]) => isPlainObject(entry))
      .map(([key, entry]) => [
        key,
        {
          provider: String(entry.provider || ''),
          model: String(entry.model || ''),
          inputTokens: Math.max(0, Number(entry.inputTokens) || 0),
          outputTokens: Math.max(0, Number(entry.outputTokens) || 0),
          totalTokens: Math.max(0, Number(entry.totalTokens) || 0),
          requests: Math.max(0, Number(entry.requests) || 0),
          lastUsedAt: Math.max(0, Number(entry.lastUsedAt) || 0),
        },
      ])
  );
}

export async function recordAIUsage(provider, model, usage) {
  if (!PROVIDERS[provider]) throw new Error(`Cannot track usage for unknown AI provider "${provider}".`);
  if (!usage || !Number.isFinite(usage.input) || !Number.isFinite(usage.output)) {
    throw new Error('Cannot track AI usage without provider-reported input and output token counts.');
  }
  const aiUsage = await getAIUsage();
  const key = `${provider}:${model}`;
  const previous = aiUsage[key] || {
    provider,
    model,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
    lastUsedAt: 0,
  };
  const inputTokens = Math.max(0, usage.input);
  const outputTokens = Math.max(0, usage.output);
  aiUsage[key] = {
    ...previous,
    inputTokens: previous.inputTokens + inputTokens,
    outputTokens: previous.outputTokens + outputTokens,
    totalTokens: previous.totalTokens + (Number.isFinite(usage.total) ? Math.max(0, usage.total) : inputTokens + outputTokens),
    requests: previous.requests + 1,
    lastUsedAt: Date.now(),
  };
  await local().set({ aiUsage });
}

export async function clearAIUsage() {
  await local().remove('aiUsage');
}

export async function getProfile() {
  const { profile } = await local().get('profile');
  return normalizeProfile(profile);
}

export async function saveProfile(profile) {
  await local().set({ profile: normalizeProfile(profile) });
  await clearCache(); // cached answers may be stale now
}

export async function getExtras() {
  const { extras } = await local().get('extras');
  return normalizeExtras(extras);
}

export async function saveExtras(extras) {
  await local().set({ extras: normalizeExtras(extras) });
  await clearCache();
}

/** @returns {Promise<{name:string,type:string,base64:string,size:number,savedAt:number}|null>} */
export async function getResumeFile() {
  const { resumeFile } = await local().get('resumeFile');
  return resumeFile || null;
}

export async function getResumeFileForAutofill() {
  const tailoredResume = await getLastTailoredResume();
  return tailoredResume?.file || getResumeFile();
}

export async function saveResumeFile(resumeFile) {
  await local().set({ resumeFile });
}

export async function getResumeText() {
  const { resumeText } = await local().get('resumeText');
  return resumeText || '';
}

export async function saveResumeText(resumeText) {
  await local().set({ resumeText });
}

function normalizeCurrentJobInfo(job) {
  if (!isPlainObject(job)) return null;
  return {
    title: String(job.title || ''),
    company: String(job.company || ''),
    url: String(job.url || ''),
    jobDescription: String(job.jobDescription || ''),
  };
}

export async function getActiveJobInfo() {
  const { activeJobInfo } = await local().get('activeJobInfo');
  return normalizeCurrentJobInfo(activeJobInfo);
}

export async function saveActiveJobInfo(job) {
  const normalized = normalizeCurrentJobInfo(job);
  if (!normalized) throw new Error('Cannot save invalid active job information.');
  await local().set({ activeJobInfo: normalized });
}

export async function getCurrentJobInfo(pageUrl) {
  if (!pageUrl) return null;
  const { jobInfoByPageUrl = {}, currentJobInfo } = await local().get(['jobInfoByPageUrl', 'currentJobInfo']);
  const saved = jobInfoByPageUrl[pageUrl];
  if (saved) return normalizeCurrentJobInfo(saved.job || saved);
  if (currentJobInfo?.url === pageUrl) return normalizeCurrentJobInfo(currentJobInfo);
  return null;
}

export async function saveCurrentJobInfo(pageUrl, job) {
  if (!pageUrl) throw new Error('Cannot save job information without the page URL.');
  const { jobInfoByPageUrl = {} } = await local().get('jobInfoByPageUrl');
  const next = {
    ...jobInfoByPageUrl,
    [pageUrl]: {
      job: normalizeCurrentJobInfo(job),
      savedAt: Date.now(),
    },
  };
  const urls = Object.keys(next);
  if (urls.length > 100) {
    urls
      .sort((a, b) => (next[a].savedAt || 0) - (next[b].savedAt || 0))
      .slice(0, urls.length - 100)
      .forEach((url) => delete next[url]);
  }
  await local().set({ jobInfoByPageUrl: next });
}

export const JOB_HISTORY_STATUSES = ['tailored', 'applied', 'interview', 'offer', 'rejected', 'withdrawn'];
const JOB_STATUSES = new Set(JOB_HISTORY_STATUSES);

export function normalizeJobHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => isPlainObject(entry) && typeof entry.id === 'string')
    .map((entry) => ({
      id: entry.id,
      title: String(entry.title || ''),
      company: String(entry.company || ''),
      url: String(entry.url || ''),
      filename: String(entry.filename || ''),
      createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : Date.now(),
      updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : Number(entry.createdAt) || Date.now(),
      status: JOB_STATUSES.has(entry.status) ? entry.status : 'tailored',
      notes: String(entry.notes || ''),
    }));
}

export async function getJobHistory() {
  const { jobHistory } = await local().get('jobHistory');
  return normalizeJobHistory(jobHistory);
}

export async function saveJobHistory(jobHistory) {
  await local().set({ jobHistory: normalizeJobHistory(jobHistory) });
}

export async function clearJobHistory() {
  await local().remove('jobHistory');
}

export async function updateJobHistoryEntry(id, changes) {
  const history = await getJobHistory();
  const index = history.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error('The job history entry no longer exists.');
  history[index] = {
    ...history[index],
    ...(changes.status !== undefined ? { status: changes.status } : {}),
    ...(changes.notes !== undefined ? { notes: changes.notes } : {}),
    updatedAt: Date.now(),
  };
  await saveJobHistory(history);
  return history[index];
}

export async function deleteJobHistoryEntry(id) {
  const history = await getJobHistory();
  await saveJobHistory(history.filter((entry) => entry.id !== id));
}

export async function addJobHistoryEntry(entry) {
  const history = await getJobHistory();
  history.push(entry);
  await saveJobHistory(history);
  return entry;
}

// ---------- per-site answer cache ----------

const CACHE_LIMIT = 2000;

export async function getCache() {
  const { answerCache } = await local().get('answerCache');
  return answerCache || {};
}

export async function putCacheEntries(entries) {
  if (!entries.length) return;
  const cache = await getCache();
  const now = Date.now();
  for (const [key, value] of entries) cache[key] = { v: value, t: now };
  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    keys
      .sort((a, b) => cache[a].t - cache[b].t)
      .slice(0, keys.length - CACHE_LIMIT)
      .forEach((k) => delete cache[k]);
  }
  await local().set({ answerCache: cache });
}

export async function clearCache() {
  await local().remove('answerCache');
}

export async function clearAllData() {
  await local().clear();
}
