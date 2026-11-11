// Service worker: orchestrates scan -> (cache | LLM) -> fill for the active tab.
import { completeJSON } from './lib/llm.js';
import { FORM_FILL_SYSTEM, TAILOR_RESUME_SYSTEM, buildFormFillUser, buildTailorResumeUser } from './lib/prompts.js';
import { bytesToBase64 } from './lib/resume.js';
import { createResumePdf } from './lib/pdf-writer.js';
import { scoreResumeWithService } from './lib/scorer.js';
import { buildCandidateFilename, buildJobContext, buildTailoredFilename, createJobHistoryEntry, findPriorApplication } from './lib/tailor.js';
import {
  activeModel,
  addJobHistoryEntry,
  recordAIUsage,
  getActiveJobInfo,
  getCache,
  getExtras,
  getJobHistory,
  getProfile,
  getResumeFileForAutofill,
  getResumeText,
  getSettings,
  hasProfile,
  putCacheEntries,
} from './lib/storage.js';

const MAX_FIELDS = 200;
const LONG_KINDS = new Set(['textarea', 'contenteditable']);

// ---------- per-tab state (survives popup closing; cleared when the tab closes) ----------

const stateKey = (tabId) => `tab:${tabId}`;

async function getTabState(tabId) {
  const key = stateKey(tabId);
  return (await chrome.storage.session.get(key))[key] || null;
}

async function setTabState(tabId, state) {
  await chrome.storage.session.set({ [stateKey(tabId)]: { ...state, updatedAt: Date.now() } });
  chrome.runtime.sendMessage({ type: 'stateChanged', tabId }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(stateKey(tabId)));

async function setBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    /* tab may be gone */
  }
}

// ---------- helpers ----------

const normKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function cacheKey(host, f) {
  return [host, f.kind, normKey(f.label), normKey(f.question), normKey(f.name), normKey(f.section), (f.options || []).map(normKey).join('|')].join('§');
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isEmptyValue(v) {
  return v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
}

function fileAccepts(accept, file) {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  return accept
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .some((a) => (a.startsWith('.') ? name.endsWith(a) : a.endsWith('/*') ? file.type.startsWith(a.slice(0, -1)) : a === file.type));
}

async function inject(tabId) {
  const target = { tabId, allFrames: true };
  await chrome.scripting.executeScript({ target, files: ['content/scanner.js', 'content/filler.js'] });
  await chrome.scripting.insertCSS({ target, files: ['content/highlight.css'] }).catch(() => {});
}

// ---------- step 1: scan every frame ----------

async function scanTab(tabId, settings) {
  const scans = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (opts) => globalThis.__afcScanner?.scan(opts) ?? null,
    args: [{ overwriteExisting: settings.overwriteExisting, fillSensitive: settings.fillSensitive }],
  });

  const out = { fields: [], fileInputs: [], page: null, topUrl: '', skippedSensitive: 0, skippedFilled: 0 };
  for (const { frameId, result } of scans) {
    if (!result) continue;
    if (frameId === 0) {
      out.page = result.page;
      out.topUrl = result.url;
    }
    out.skippedSensitive += result.skippedSensitive;
    out.skippedFilled += result.skippedFilled;
    // Global ids are "frameId:localId" so fields from different iframes never collide.
    for (const f of result.fields) out.fields.push({ ...f, frameId, localId: f.id, id: `${frameId}:${f.id}` });
    for (const f of result.files) out.fileInputs.push({ ...f, frameId, localId: f.id });
  }
  return out;
}

async function readJobPage(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content/scanner.js'] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => globalThis.__afcScanner?.readJobInfo() ?? null,
  });
  if (!result) throw new Error('Could not read job information from this page.');
  return result;
}

async function attachTailoredResume(tabId, resumeFile, settings) {
  if (!resumeFile || typeof resumeFile.base64 !== 'string' || typeof resumeFile.name !== 'string') {
    throw new Error('The tailored resume file is missing or invalid.');
  }
  await inject(tabId);
  const { fileInputs } = await scanTab(tabId, settings);
  const accepted = fileInputs.filter((input) => input.isResume && fileAccepts(input.accept, resumeFile));
  if (!accepted.length) return { filesAttached: 0, message: 'No compatible resume upload field was found.' };

  const byFrame = new Map();
  for (const input of accepted) {
    if (!byFrame.has(input.frameId)) byFrame.set(input.frameId, []);
    byFrame.get(input.frameId).push(input.localId);
  }
  let filesAttached = 0;
  const errors = [];
  for (const [frameId, fileIds] of byFrame) {
    try {
      const result = await fillFrame(tabId, frameId, [{ fills: [], resumeFile, fileIds }, [], [], false]);
      if (result.stale) throw new Error('The page changed while attaching the tailored resume.');
      filesAttached += result.filesAttached;
    } catch (e) {
      errors.push(e?.message || String(e));
    }
  }
  return {
    filesAttached,
    message:
      filesAttached > 0
        ? ''
        : errors.join(' ') || 'The website did not accept the tailored resume automatically.',
  };
}

async function attachTailoredFile(tabId, resumeFile) {
  if (tabId == null) throw new Error('No active page is available.');
  return attachTailoredResume(tabId, resumeFile, await getSettings());
}

async function tailorResume(tabId, job, confirmedDuplicate = false) {
  if (tabId == null) throw new Error('No active page is available.');
  if (!job || !String(job.jobDescription || '').trim()) throw new Error('Read or enter the job description before tailoring your resume.');

  const [settings, resumeText, history, profile] = await Promise.all([
    getSettings(),
    getResumeText(),
    getJobHistory(),
    getProfile(),
  ]);
  if (!settings.apiKeys[settings.provider]) throw new Error('Add your AI API key in the extension options first.');
  if (!resumeText.trim()) throw new Error('Upload or paste your default resume in the extension options first.');

  const prior = findPriorApplication(history, job);
  if (prior && !confirmedDuplicate) return { needsConfirmation: true, prior };

  const user = buildTailorResumeUser(settings.tailoringPrompt, resumeText, buildJobContext(job));
  const response = await completeJSON({
    provider: settings.provider,
    apiKey: settings.apiKeys[settings.provider],
    model: activeModel(settings),
    system: TAILOR_RESUME_SYSTEM,
    user,
    maxTokens: 16000,
    onUsage: (usage) => recordAIUsage(settings.provider, activeModel(settings), usage),
  });
  const tailoredText = typeof response?.resume === 'string' ? response.resume.trim() : '';
  if (tailoredText.length < 40) throw new Error('The AI returned an empty or incomplete tailored resume. Please try again.');

  const candidateName =
    [profile.personal.firstName, profile.personal.middleName, profile.personal.lastName].filter(Boolean).join(' ').trim() ||
    resumeText.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ||
    '';
  const bytes = createResumePdf(tailoredText, candidateName);
  const filename = buildTailoredFilename(job);
  const resumeFile = {
    name: buildCandidateFilename(candidateName),
    type: 'application/pdf',
    size: bytes.length,
    base64: bytesToBase64(bytes),
    savedAt: Date.now(),
  };
  let scores = null;
  let scoreError = '';
  try {
    scores = {};
    scores.original = await scoreResumeWithService(resumeText, job.jobDescription, settings.scorerApiKey);
    scores.tailored = await scoreResumeWithService(tailoredText, job.jobDescription, settings.scorerApiKey);
  } catch (e) {
    scoreError = e?.message || String(e);
  }
  if (!scores?.original && !scores?.tailored) scores = null;
  const downloadFile = { ...resumeFile, name: filename };

  let historyMessage = '';
  try {
    await addJobHistoryEntry(createJobHistoryEntry(job, filename));
  } catch (e) {
    historyMessage = `Resume generated, but could not save job history: ${e?.message || String(e)}`;
  }
  let attachment;
  try {
    attachment = await attachTailoredResume(tabId, resumeFile, settings);
  } catch (e) {
    attachment = { filesAttached: 0, message: e?.message || String(e) };
  }
  return {
    filename,
    resumeText: tailoredText,
    scores,
    scoreError,
    uploadFilename: resumeFile.name,
    file: resumeFile,
    downloadFile,
    filesAttached: attachment.filesAttached,
    attachmentMessage: attachment.message,
    historyMessage,
  };
}

// ---------- step 2+3: answers from cache, then the LLM ----------

async function getAnswers({ work, host, page, settings, profile, extras, resumeText, onStep }) {
  const answers = new Map(); // id -> { value, long, fromCache }
  if (settings.useCache) {
    const cache = await getCache();
    for (const f of work) {
      if (LONG_KINDS.has(f.kind)) continue;
      const hit = cache[cacheKey(host, f)];
      if (hit && !isEmptyValue(hit.v)) answers.set(f.id, { value: hit.v, long: false, fromCache: true });
    }
  }

  const todo = work.filter((f) => !answers.has(f.id));
  if (!todo.length) return { answers, tokenUsage: null };

  await onStep(`Asking AI about ${todo.length} field(s)…`);
  let tokenUsage = null;
  const res = await completeJSON({
    provider: settings.provider,
    apiKey: settings.apiKeys[settings.provider],
    model: activeModel(settings),
    system: FORM_FILL_SYSTEM,
    user: buildFormFillUser({
      profile,
      extras,
      page,
      resumeText,
      fields: todo.map(({ frameId, localId, ...f }) => f),
      today: new Date().toISOString().slice(0, 10),
    }),
    maxTokens: 16000,
    onUsage: (usage) => {
      tokenUsage = usage;
      return recordAIUsage(settings.provider, activeModel(settings), usage);
    },
  });

  const valid = new Set(todo.map((f) => f.id));
  for (const item of Array.isArray(res?.fills) ? res.fills : []) {
    if (!item || !valid.has(item.id) || isEmptyValue(item.value) || answers.has(item.id)) continue;
    answers.set(item.id, { value: item.value, long: Boolean(item.long), fromCache: false });
  }
  return { answers, tokenUsage };
}

// ---------- step 4: fill one frame ----------

/** Runs inside the page frame. Must be self-contained (it is serialized by chrome.scripting). */
async function fillInPage(payload, unfilledIds, reviewIds, clear) {
  const F = globalThis.__afcFiller;
  if (!F) return { filled: [], failed: [], filesAttached: 0, stale: true };
  if (clear) F.clearMarks();
  const r = await F.apply(payload);
  F.markUnfilled(unfilledIds.filter((id) => !r.filled.includes(id) && !reviewIds.includes(id)));
  for (const id of reviewIds) {
    const t = globalThis.__afcEls?.get(id)?.els[0];
    if (t?.isConnected) {
      t.classList.add('afc-review');
      t.setAttribute('data-afc', 'review');
    }
  }
  return r;
}

async function fillFrame(tabId, frameId, args) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: fillInPage, args });
  return result;
}

// ---------- main flow ----------

async function runAutofill(tabId) {
  const prev = await getTabState(tabId);
  if (prev?.status === 'running' && Date.now() - prev.updatedAt < 180_000) return prev;

  const fail = async (error) => {
    await setBadge(tabId, '!', '#dc2626');
    await setTabState(tabId, { status: 'error', error });
    return getTabState(tabId);
  };
  const onStep = (step) => setTabState(tabId, { status: 'running', step });

  const [settings, profile, extras, activeJob, resumeText] = await Promise.all([
    getSettings(),
    getProfile(),
    getExtras(),
    getActiveJobInfo(),
    getResumeText(),
  ]);
  if (!settings.apiKeys[settings.provider]) return fail('Add your AI API key in the extension options first.');
  if (!hasProfile(profile)) return fail('Upload your resume in the extension options first.');

  await onStep('Scanning the form…');
  await setBadge(tabId, '…', '#6366f1');

  let scan;
  try {
    await inject(tabId);
    scan = await scanTab(tabId, settings);
  } catch (e) {
    return fail(`Can't access this page (${e.message}). Chrome pages and the Web Store can't be autofilled.`);
  }
  const { fields, fileInputs, page, topUrl, skippedSensitive, skippedFilled } = scan;
  const host = hostOf(topUrl || page?.url);

  if (!fields.length && !fileInputs.length) {
    await setBadge(tabId, '', null);
    await setTabState(tabId, { status: 'done', filled: 0, total: 0, skippedSensitive, skippedFilled, pending: [], note: 'No empty form fields found on this page.' });
    return getTabState(tabId);
  }

  const work = fields.slice(0, MAX_FIELDS);
  let answers;
  let tokenUsage = null;
  try {
    const pageContext = activeJob ? { ...page, activeJob } : page;
    const result = await getAnswers({ work, host, page: pageContext, settings, profile, extras, resumeText, onStep });
    answers = result.answers;
    tokenUsage = result.tokenUsage;
  } catch (e) {
    return fail(e.message || String(e));
  }

  // Split into "fill now" and "review first".
  const byId = new Map(work.map((f) => [f.id, f]));
  const now = [];
  const pending = [];
  for (const [id, a] of answers) {
    const f = byId.get(id);
    const isLong = a.long || (LONG_KINDS.has(f.kind) && String(a.value).length > 160);
    if (settings.reviewLongAnswers && isLong) {
      pending.push({ key: id, frameId: f.frameId, localId: f.localId, label: f.label || f.name || 'Question', value: String(a.value), maxLength: f.maxLength || null });
    } else {
      now.push({ ...f, value: a.value, a });
    }
  }

  await onStep('Filling the form…');
  const resumeFile = settings.attachResume ? await getResumeFileForAutofill() : null;
  const frames = new Set([...work.map((f) => f.frameId), ...fileInputs.map((f) => f.frameId)]);
  let filledCount = 0;
  let filesAttached = 0;
  const filledIds = new Set();
  for (const frameId of frames) {
    const fills = now.filter((f) => f.frameId === frameId).map((f) => ({ id: f.localId, value: f.value }));
    const fileIds = resumeFile
      ? fileInputs.filter((f) => f.frameId === frameId && f.isResume && fileAccepts(f.accept, resumeFile)).map((f) => f.localId)
      : [];
    const unfilled = work.filter((f) => f.frameId === frameId).map((f) => f.localId);
    const review = pending.filter((p) => p.frameId === frameId).map((p) => p.localId);
    try {
      const r = await fillFrame(tabId, frameId, [{ fills, resumeFile: fileIds.length ? resumeFile : null, fileIds }, unfilled, review, true]);
      filledCount += r.filled.length;
      filesAttached += r.filesAttached;
      for (const id of r.filled) filledIds.add(`${frameId}:${id}`);
    } catch (e) {
      console.warn('Fill failed in frame', frameId, e);
    }
  }

  // Remember short answers that actually filled, to skip the LLM next time.
  if (settings.useCache) {
    await putCacheEntries(now.filter((f) => !f.a.fromCache && !f.a.long && filledIds.has(f.id)).map((f) => [cacheKey(host, f), f.value]));
  }

  await setBadge(tabId, pending.length ? String(pending.length) : filledCount ? '✓' : '', pending.length ? '#6366f1' : '#16a34a');
  await setTabState(tabId, {
    status: 'done',
    filled: filledCount,
    total: work.length,
    filesAttached,
    skippedSensitive,
    skippedFilled,
    truncated: fields.length > MAX_FIELDS,
    pending,
    tokenUsage,
    unanswered: work.length - answers.size,
  });
  return getTabState(tabId);
}

// ---------- review queue (long answers) ----------

/** @param {Array<{key:string, value:string}>} approved  @param {string[]} dismissed */
async function applyPending(tabId, approved = [], dismissed = []) {
  const state = await getTabState(tabId);
  if (!state?.pending?.length) return state;
  const byKey = new Map(state.pending.map((p) => [p.key, p]));
  let filled = 0;
  const failedKeys = [];

  const perFrame = new Map();
  for (const { key, value } of approved) {
    const p = byKey.get(key);
    if (!p || !String(value).trim()) continue;
    if (!perFrame.has(p.frameId)) perFrame.set(p.frameId, []);
    perFrame.get(p.frameId).push({ id: p.localId, value: String(value), key });
  }
  for (const [frameId, fills] of perFrame) {
    try {
      const r = await fillFrame(tabId, frameId, [{ fills: fills.map(({ id, value }) => ({ id, value })) }, [], [], false]);
      if (r.stale) throw new Error('The page changed. Run Autofill again.');
      filled += r.filled.length;
      for (const f of fills) if (!r.filled.includes(f.id)) failedKeys.push(f.key);
    } catch (e) {
      failedKeys.push(...fills.map((f) => f.key));
      console.warn('Could not apply reviewed answer', e);
    }
  }

  const done = new Set([...approved.map((a) => a.key), ...dismissed]);
  const pending = state.pending.filter((p) => !done.has(p.key) || failedKeys.includes(p.key));
  const next = {
    ...state,
    filled: (state.filled || 0) + filled,
    pending,
    error: failedKeys.length ? 'Some answers could not be inserted. The page may have changed; try Autofill again.' : undefined,
  };
  await setTabState(tabId, next);
  await setBadge(tabId, pending.length ? String(pending.length) : '✓', pending.length ? '#6366f1' : '#16a34a');
  return getTabState(tabId);
}

// ---------- wiring ----------

async function clearHighlights(tabId) {
  await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, func: () => globalThis.__afcFiller?.clearMarks() })
    .catch(() => {});
  await chrome.storage.session.remove(stateKey(tabId));
  await setBadge(tabId, '', null);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const handlers = {
    autofill: () => runAutofill(msg.tabId),
    getState: () => getTabState(msg.tabId),
    applyPending: () => applyPending(msg.tabId, msg.approved, msg.dismissed),
    clearHighlights: () => clearHighlights(msg.tabId),
    readJobPage: () => readJobPage(msg.tabId),
    tailorResume: () => tailorResume(msg.tabId, msg.job, msg.confirmedDuplicate),
    attachTailoredResume: () => attachTailoredFile(msg.tabId, msg.resumeFile),
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(handler)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true; // async response
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'run-autofill') return;
  const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (tabId != null) runAutofill(tabId).catch((e) => console.error(e));
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.error('Could not configure side panel', e));
