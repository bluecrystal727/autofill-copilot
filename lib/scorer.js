const SCORER_URL = 'https://resume-scorer.fly.dev/score/both';

export async function scoreResumeWithService(resumeText, jobDescription, apiKey = '', fetchImpl = globalThis.fetch) {
  if (!String(resumeText || '').trim()) throw new Error('Cannot score an empty resume.');
  if (!String(jobDescription || '').trim()) throw new Error('Cannot score without a job description.');

  const headers = { 'Content-Type': 'application/json' };
  if (String(apiKey || '').trim()) headers['X-API-Key'] = String(apiKey).trim();
  let response;
  try {
    response = await fetchImpl(SCORER_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ resume_text: resumeText, jd_text: jobDescription }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError'
      ? 'The resume scoring service timed out.'
      : `Could not connect to the resume scoring service: ${error?.message || String(error)}`;
    throw new Error(reason);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`The resume scoring service returned an invalid response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const detail = typeof result?.detail === 'string' ? result.detail : `HTTP ${response.status}`;
    throw new Error(`Resume scoring failed: ${detail}`);
  }

  const ats = result?.ats?.total_score ?? result?.summary?.ats_score;
  const hr = result?.hr?.overall_score ?? result?.summary?.hr_score;
  if (typeof ats !== 'number' || !Number.isFinite(ats) || ats < 0 || ats > 100) {
    throw new Error('The resume scoring service did not return a valid ATS score.');
  }
  if (typeof hr !== 'number' || !Number.isFinite(hr) || hr < 0 || hr > 100) {
    throw new Error('The resume scoring service did not return a valid HR score.');
  }

  return { ats, hr };
}
