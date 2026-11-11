import {
  PROVIDERS,
  activeModel,
  getActiveJobInfo,
  getCurrentJobInfo,
  getLastTailoredResume,
  getProfile,
  getResumeText,
  getSettings,
  hasProfile,
  saveActiveJobInfo,
  saveLastTailoredResume,
  saveCurrentJobInfo,
} from '../lib/storage.js';

const $ = (id) => document.getElementById(id);
let tabId = null;
let pageUrl = '';
let tailoredFile = null;
let jobSaveQueue = Promise.resolve();
let initializing = true;
let tabSwitchGeneration = 0;

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, tabId, ...extra }).then((res) => {
    if (!res?.ok) throw new Error(res?.error || 'Unknown error');
    return res.result;
  });
}

function setStatus(kind, msg, details = []) {
  const box = $('status');
  box.hidden = false;
  box.className = `card ${kind === 'running' ? '' : kind}`;
  $('spinner').hidden = kind !== 'running';
  $('status-msg').textContent = msg;
  $('status-details').replaceChildren(...details.map((d) => Object.assign(document.createElement('li'), { textContent: d })));
}

function renderState(state) {
  const btn = $('autofill-btn');
  btn.disabled = state?.status === 'running';
  btn.textContent = state?.status === 'done' ? 'Autofill again' : 'Autofill this page';
  $('clear-btn').hidden = state?.status !== 'done';

  if (!state) {
    $('status').hidden = true;
    renderReview([]);
    return;
  }
  if (state.status === 'running') {
    setStatus('running', state.step || 'Working…');
  } else if (state.status === 'error') {
    setStatus('error', state.error);
  } else {
    const details = [];
    if (state.filesAttached) details.push(`Attached your resume to ${state.filesAttached} upload field(s).`);
    if (state.pending?.length) details.push(`${state.pending.length} drafted answer(s) waiting for review below.`);
    if (state.unanswered) details.push(`The AI returned no answer for ${state.unanswered} field(s). Add relevant details to your resume/profile or answer these manually.`);
    if (state.tokenUsage) {
      details.push(
        `AI usage: ${state.tokenUsage.input ?? '?'} input + ${state.tokenUsage.output ?? '?'} output tokens${state.tokenUsage.total == null ? '' : ` (${state.tokenUsage.total} total)`}.`
      );
    }
    if (state.skippedFilled) details.push(`${state.skippedFilled} already-filled field(s) left untouched.`);
    if (state.skippedSensitive) details.push(`${state.skippedSensitive} sensitive field(s) skipped (SSN, DOB, bank…).`);
    if (state.truncated) details.push('Very large form: only the first 200 fields were processed.');
    if (state.total && state.filled < state.total) details.push('Fields with a dashed orange outline need your attention.');
    if (state.error) details.push(state.error);
    const msg = state.note || `Filled ${state.filled} of ${state.total} field(s). Review the form before submitting.`;
    setStatus(state.error ? 'warn' : 'ok', msg, details);
  }
  renderReview(state.pending || []);
}

function currentJob() {
  return {
    title: $('job-title').value.trim(),
    company: $('job-company').value.trim(),
    url: $('job-url').value.trim(),
    jobDescription: $('job-description').value.trim(),
  };
}

function restoreJobInfo(job) {
  $('job-title').value = job?.title || '';
  $('job-company').value = job?.company || '';
  $('job-url').value = job?.url || '';
  $('job-description').value = job?.jobDescription || '';
  $('job-form').hidden = !job;
}

function renderTailoredResult(result) {
  if (!result?.file?.base64) {
    tailoredFile = null;
    $('tailor-result').hidden = true;
    return;
  }
  tailoredFile = result.file;
  $('tailored-preview').value = result.resumeText || '';
  $('tailor-result-msg').textContent =
    result.filesAttached > 0
      ? `Downloaded as ${result.filename}; upload filename is ${result.uploadFilename || result.file.name}. Attached it to ${result.filesAttached} resume upload field(s). Review the PDF and form before submitting.`
      : `Downloaded as ${result.filename}; upload filename is ${result.uploadFilename || result.file.name}. It could not be attached: ${result.attachmentMessage || 'no compatible PDF upload field was found'}. Upload it manually if needed.`;
  const scores = result.scores;
  $('score-results').hidden = false;
  $('score-status').textContent = result.scoreError
    ? `Scoring unavailable: ${result.scoreError}`
    : 'Scores from the ApplyIQ Resume Scorer.';
  $('score-status').className = `small ${result.scoreError ? 'error-text' : 'muted'}`;
  const formatScore = (value) => Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
  const formatDelta = (before, after) => Number.isFinite(before) && Number.isFinite(after)
    ? `${after - before > 0 ? '+' : ''}${(after - before).toFixed(1)} pts`
    : '—';
  $('original-ats-score').textContent = formatScore(scores?.original?.ats);
  $('original-hr-score').textContent = formatScore(scores?.original?.hr);
  $('tailored-ats-score').textContent = formatScore(scores?.tailored?.ats);
  $('tailored-hr-score').textContent = formatScore(scores?.tailored?.hr);
  $('ats-score-delta').textContent = formatDelta(scores?.original?.ats, scores?.tailored?.ats);
  $('hr-score-delta').textContent = formatDelta(scores?.original?.hr, scores?.tailored?.hr);
  $('tailor-result').hidden = false;
}

async function downloadTailoredResume(file) {
  const url = `data:${file.type};base64,${file.base64}`;
  await chrome.downloads.download({ url, filename: file.name, saveAs: false });
}

function persistJobInfo() {
  const job = currentJob();
  jobSaveQueue = jobSaveQueue
    .then(() => saveActiveJobInfo(job))
    .then(() => setTailorStatus('Job information saved.', 'ok-text'))
    .catch((e) => setTailorStatus(`Could not save job information: ${e.message}`, 'error-text'));
}

function setTailorStatus(message, kind = 'muted') {
  $('tailor-status').textContent = message;
  $('tailor-status').className = `small ${kind}`;
}

async function requestPageAccess() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab?.id) {
    throw new Error('Cannot identify the active page. Select a webpage and try again.');
  }
  if (activeTab.id !== tabId || (activeTab.url && activeTab.url !== pageUrl)) {
    await switchActiveTab(activeTab.id, true);
  }
  if (!pageUrl) {
    const currentTab = await chrome.tabs.get(activeTab.id);
    pageUrl = currentTab.url || '';
    tabId = currentTab.id;
  }

  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    throw new Error('Cannot determine the active page URL. Select a regular HTTP or HTTPS webpage and try again.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Chrome does not allow access to ${url.protocol} pages. Select a regular HTTP or HTTPS webpage and try again.`);
  }

  const permission = { origins: ['http://*/*', 'https://*/*'] };
  if (await chrome.permissions.contains(permission)) return;
  if (!(await chrome.permissions.request(permission))) {
    throw new Error('Page access is required for this feature. Allow access to HTTP and HTTPS websites in Chrome.');
  }
}

async function switchActiveTab(nextTabId, force = false) {
  if (initializing || (nextTabId === tabId && !force)) return;
  const generation = ++tabSwitchGeneration;
  await jobSaveQueue;
  const tab = await chrome.tabs.get(nextTabId);
  if (generation !== tabSwitchGeneration) return;
  tabId = nextTabId;
  pageUrl = tab.url || '';
  const state = await send('getState');
  if (generation !== tabSwitchGeneration) return;
  $('duplicate-confirm').hidden = true;
  renderState(state);
}

async function runTailoring(confirmedDuplicate = false) {
  $('tailor-btn').disabled = true;
  $('duplicate-confirm').hidden = true;
  $('tailor-result').hidden = true;
  setTailorStatus('Tailoring resume…', 'muted');
  try {
    await requestPageAccess();
    const generated = await send('tailorResume', { job: currentJob(), confirmedDuplicate });
    if (generated.needsConfirmation) {
      const prior = generated.prior;
      const date = prior.createdAt ? new Date(prior.createdAt).toLocaleDateString() : 'unknown date';
      $('duplicate-msg').textContent = `History shows this job as “${prior.status}” (${date}). Continue tailoring anyway?`;
      $('duplicate-confirm').hidden = false;
      setTailorStatus('Possible duplicate application found.', 'warn-text');
      return;
    }

    const lastTailoredResume = {
      filename: generated.filename,
      uploadFilename: generated.uploadFilename,
      resumeText: generated.resumeText,
      file: generated.file,
      scores: generated.scores,
      scoreError: generated.scoreError,
      downloadFile: generated.downloadFile,
      filesAttached: generated.filesAttached,
      attachmentMessage: generated.attachmentMessage,
      historyMessage: generated.historyMessage,
      generatedAt: Date.now(),
    };
    renderTailoredResult(lastTailoredResume);
    const warnings = [];
    try {
      await saveLastTailoredResume(lastTailoredResume);
    } catch (e) {
      warnings.push(`Could not keep the generated resume available in this browser session: ${e.message}`);
    }
    try {
      await downloadTailoredResume(generated.downloadFile);
    } catch (e) {
      warnings.push(`Automatic download failed: ${e.message}`);
    }
    if (generated.historyMessage) warnings.push(generated.historyMessage);
    if (generated.scoreError) warnings.push(`Scoring unavailable: ${generated.scoreError}`);
    setTailorStatus(
      warnings.length
        ? `Resume generated. ${warnings.join(' ')}`
        : 'Tailored resume generated, downloaded, and scored.',
      warnings.length ? 'error-text' : 'ok-text'
    );
  } catch (e) {
    setTailorStatus(e.message, 'error-text');
  } finally {
    $('tailor-btn').disabled = false;
  }
}

async function readJobInfo() {
  $('read-job-btn').disabled = true;
  setTailorStatus('Reading job information from this page…');
  try {
    await requestPageAccess();
    const job = await send('readJobPage');
    $('job-title').value = job.title || '';
    $('job-company').value = job.company || '';
    $('job-url').value = job.url || '';
    $('job-description').value = job.jobDescription || '';
    $('job-form').hidden = false;
    $('tailor-result').hidden = true;
    $('duplicate-confirm').hidden = true;
    await Promise.all([saveActiveJobInfo(currentJob()), saveCurrentJobInfo(pageUrl, currentJob())]);
    setTailorStatus(job.jobDescription ? 'Job information read. Review it before tailoring.' : 'No job description was detected; paste it into the field below.');
  } catch (e) {
    setTailorStatus(e.message, 'error-text');
  } finally {
    $('read-job-btn').disabled = false;
  }
}

function buildReviewItem(p) {
  const node = $('review-item').content.firstElementChild.cloneNode(true);
  node.dataset.key = p.key;
  node.querySelector('.q').textContent = p.label;
  const ta = node.querySelector('textarea');
  ta.value = p.value;
  const count = node.querySelector('.count');
  const updateCount = () => {
    count.textContent = p.maxLength ? `${ta.value.length} / ${p.maxLength}` : `${ta.value.length} chars`;
    count.classList.toggle('over', Boolean(p.maxLength && ta.value.length > p.maxLength));
  };
  ta.addEventListener('input', updateCount);
  updateCount();
  node.querySelector('.insert').addEventListener('click', () => apply([{ key: p.key, value: ta.value }], []));
  node.querySelector('.dismiss').addEventListener('click', () => apply([], [p.key]));
  node.querySelector('.copy').addEventListener('click', async (e) => {
    await navigator.clipboard.writeText(ta.value);
    e.target.textContent = 'Copied';
    setTimeout(() => (e.target.textContent = 'Copy'), 1200);
  });
  return node;
}

function renderReview(pending) {
  $('review').hidden = !pending.length;
  $('review-count').textContent = pending.length;
  const list = $('review-list');
  // Reuse existing nodes so in-progress edits survive re-renders.
  const existing = new Map([...list.children].map((el) => [el.dataset.key, el]));
  list.replaceChildren(...pending.map((p) => existing.get(p.key) || buildReviewItem(p)));
}

async function apply(approved, dismissed) {
  const buttons = document.querySelectorAll('#review button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    renderState(await send('applyPending', { approved, dismissed }));
  } catch (e) {
    setStatus('error', e.message);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  pageUrl = tab?.url || '';

  const [settings, profile, resumeText, activeJobInfo, pageJobInfo, lastTailoredResume] = await Promise.all([
    getSettings(),
    getProfile(),
    getResumeText(),
    getActiveJobInfo(),
    getCurrentJobInfo(pageUrl),
    getLastTailoredResume(),
  ]);
  restoreJobInfo(activeJobInfo || pageJobInfo);
  renderTailoredResult(lastTailoredResume);
  const needsKey = !settings.apiKeys[settings.provider];
  const needsProfile = !hasProfile(profile);
  if (needsKey || needsProfile) {
    $('setup').hidden = false;
    $('setup-msg').textContent = needsKey
      ? `Add your ${PROVIDERS[settings.provider].label} API key to get started.`
      : 'Upload your resume (PDF, DOCX, or text) to get started.';
    $('autofill-btn').disabled = true;
  }
  $('tailor-btn').disabled = needsKey || !resumeText.trim();
  if (!needsProfile) {
    const name = [profile.personal.firstName, profile.personal.lastName].filter(Boolean).join(' ');
    $('profile-line').textContent = `Filling as ${name || profile.personal.email} · ${PROVIDERS[settings.provider].label} (${activeModel(settings)})`;
  }

  if (tabId != null && !needsKey && !needsProfile) renderState(await send('getState'));
  initializing = false;
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id != null && (activeTab.id !== tabId || activeTab.url !== pageUrl)) {
    await switchActiveTab(activeTab.id, true);
  }
}

$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('close-panel').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId == null) throw new Error('Could not find the current browser window.');
    await chrome.sidePanel.close({ windowId: tab.windowId });
  } catch (e) {
    setTailorStatus(`Could not close the side panel: ${e.message}`, 'error-text');
  }
});
$('setup-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('read-job-btn').addEventListener('click', readJobInfo);
$('job-form').querySelectorAll('input, textarea').forEach((input) => {
  input.addEventListener('input', persistJobInfo);
  input.addEventListener('change', persistJobInfo);
});
$('tailor-btn').addEventListener('click', () => runTailoring(false));
$('continue-tailor').addEventListener('click', () => runTailoring(true));
$('upload-tailored').addEventListener('click', async () => {
  if (!tailoredFile) return;
  $('upload-tailored').disabled = true;
  setTailorStatus('Uploading tailored resume to the page…');
  try {
    await requestPageAccess();
    const result = await send('attachTailoredResume', { resumeFile: tailoredFile });
    setTailorStatus(
      result.filesAttached
        ? `Attached ${tailoredFile.name} to ${result.filesAttached} upload field(s).`
        : result.message || 'Could not attach the tailored resume. Download it and upload it manually.',
      result.filesAttached ? 'ok-text' : 'error-text'
    );
  } catch (e) {
    setTailorStatus(e.message, 'error-text');
  } finally {
    $('upload-tailored').disabled = false;
  }
});

$('autofill-btn').addEventListener('click', async () => {
  if (tabId == null) return;
  renderState({ status: 'running', step: 'Starting…' });
  try {
    await requestPageAccess();
    renderState(await send('autofill'));
  } catch (e) {
    renderState({ status: 'error', error: e.message });
  }
});

$('clear-btn').addEventListener('click', async () => {
  await send('clearHighlights');
  renderState(null);
});

$('insert-all').addEventListener('click', () => {
  const approved = [...document.querySelectorAll('#review-list .review-item')].map((el) => ({
    key: el.dataset.key,
    value: el.querySelector('textarea').value,
  }));
  apply(approved, []);
});

// Live progress while the background worker runs (e.g. started via the keyboard shortcut).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'stateChanged' && msg.tabId === tabId) send('getState').then(renderState).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId: activeTabId }) => switchActiveTab(activeTabId).catch((e) => setTailorStatus(e.message, 'error-text')));
chrome.tabs.onUpdated.addListener((updatedTabId, changeInfo, tab) => {
  if (tab.active && changeInfo.url) switchActiveTab(updatedTabId, true).catch((e) => setTailorStatus(e.message, 'error-text'));
});

init().catch((e) => setStatus('error', e.message));
