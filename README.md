# Autofill Copilot

AI-powered Chrome extension that fills job applications and profile forms from your resume, using **your own API key** (OpenAI, Anthropic Claude, or Google Gemini).

**Developed by Blue Crystal.**

- Upload your resume as **PDF, Word (.docx), or text**. The AI turns it into an editable profile.
- Click **Autofill** (or press **Alt+Shift+F**) on any application form.
- Fields are filled in a way React / Angular / Vue sites recognise, and highlighted on the page:
  - 🟩 **solid green**: filled
  - 🟧 **dashed orange**: not filled, needs your attention
  - 🟦 **solid indigo**: AI-drafted long answer waiting for your review in the side panel
- **The extension never submits the form.** You review and click Submit yourself.

## Install (developer mode)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this folder (`d:\Projects\autofill-copilot`).
3. The options page opens automatically on first install. You can also right-click the toolbar icon and choose **Options**.
4. Pin the extension from the puzzle-piece menu so it's easy to reach.

To see tracked token usage, right-click the pinned extension icon and choose **Options**, then look under **1. AI provider → Tracked token usage**. Click the extension icon itself to open its side panel while using a page.

Requires Chrome 141 or newer. The extension opens in Chrome's side panel, which stays open while you interact with the page. Use the × button to close it. The extension reads the active tab's URL to identify the site. The first time you use page-reading, autofill, or upload, Chrome asks once for access to HTTP and HTTPS websites. The extension only reads or changes a page after you click the corresponding action; it does not run in the background on sites you visit. No build step is needed.

## First-time setup (Options page)

1. **AI provider:** pick OpenAI, Anthropic, or Gemini, paste your API key, and click **Test connection**. Leave *Model* blank to use the default:

   | Provider  | Default model           | Get a key                                   |
   |-----------|-------------------------|---------------------------------------------|
   | OpenAI    | `gpt-6-luna`            | https://platform.openai.com/api-keys        |
   | Anthropic | `claude-haiku-5-5`      | https://console.anthropic.com/settings/keys |
   | Gemini    | `gemini-3.5-flash-lite` | https://aistudio.google.com/apikey          |

   These are cheap, fast models. You can type any other model ID your account has access to (e.g. `claude-sonnet-5-5` or `gpt-6.1-sol`) for better writing quality.
2. **Resume:** drop in a PDF / DOCX / TXT, or paste the text, then click **Parse with AI**.
3. **Profile:** check what the AI extracted and fix anything wrong, then click **Save profile**. Autofill only uses what's here.
4. **Application answers:** work authorization, sponsorship, salary, notice period, and so on. Questions you leave blank are **skipped** rather than guessed. Self-identification (EEO) answers use dropdowns and default to "Decline to self-identify". You can also add reusable custom Q&A and extra instructions for the AI.
5. **Preferences:**
   - Review long answers before inserting *(on)*
   - Attach a resume file to upload fields *(on; uses the latest tailored resume when available, otherwise your saved default resume)*
   - Remember answers per site *(on)*
   - Overwrite already-filled fields *(off)*
   - Fill sensitive fields *(off)*
6. **Tailoring prompt:** review or customize the prompt used to create a role-specific PDF. Keep `{resume_text}` and `{job_description}` in the prompt. Work-history roles remain in reverse chronological order (current or newest first), even when achievement bullets are prioritized for the target role.

## Using it

1. Open a job application and click the extension icon, then **Autofill this page** (or press **Alt+Shift+F**).
2. Short fields are filled immediately. Long, AI-written answers ("Why do you want to work here?", cover-letter boxes) appear in the side panel, where you can edit, **Insert**, **Copy**, or **Dismiss** each one.
3. Check the highlighted form, complete anything left in orange, and submit it yourself.
4. On multi-step forms, click Autofill again on each step.

Change the shortcut at `chrome://extensions/shortcuts`.

### Tailor a resume for a job

1. Open a job page and click the extension icon, then **Read job information**. Review or edit the detected title, company, URL, and description. The active job details stay in the side panel when you switch to a separate application URL and are restored when you reopen the panel. Click **Read job information** again to replace them with details from the current page. Job details are also saved locally per source page URL.
2. Click **Tailor and attach PDF**. The generated resume uses a modern, clean single-column layout with sans-serif typography, a clear name and contact header, subtle blue section accents, and readable spacing. The extension also scores the original and tailored resumes against the job description using ApplyIQ's hosted scorer and displays ATS/HR scores and changes. Each comparison scores two resumes and uses the scorer's quota. Add an optional scorer API key in Options → AI provider to use your scorer account; anonymous scoring has a limited free allowance. If the full URL (including its query string) matches a history entry marked Applied, Interview, Offer, Rejected, or Withdrawn, confirm before continuing.
3. The extension automatically downloads the PDF with a company-job-title-date filename, then attaches it to detected resume upload fields with your name as the upload filename. Use **Upload tailored resume** to retry attachment. The generated resume remains available in the side panel for the current browser session, including after switching tabs or reopening the panel. It never submits the form.
4. A local job-history entry is saved after generation; update its status to **Applied** after submitting so a later duplicate check can warn you. Manage entries in the compact table, or delete, clear, or export them as XLSX in Options → Job history.

The tailoring prompt and resume/job description are sent to the AI provider configured in Options. Autofill also uses the active job as context for application answers, including when the application is on a different URL. All unanswered fields are sent in one request; each written-answer field gets a separate answer matched back by its field ID. As with other generated content, review the resume and application form before submitting.

### Try it on the test form

Open `test/test-form.html` in Chrome. For local files, first enable **Allow access to file URLs** on the extension's details page. Then run Autofill. The form covers:
- text, select, date, and month fields
- radio and checkbox groups
- a custom ARIA dropdown
- a rich-text editor
- a React-style controlled input
- a resume upload field
- fields that must be skipped: an SSN field, a password field, and a "certify / agree to terms" checkbox

## Privacy & safety

- The profile, resume file, API keys, and settings live only in `chrome.storage.local` in your browser profile. Nothing is synced.
- Tracked token usage is stored locally by provider and model. It counts only successful provider responses from this extension; the usage bars compare input vs. output and do not represent provider quota or billing limits. Use your provider's dashboard for account-wide usage, including other applications.
- Job history (job details, status, and notes) is also stored locally. The latest tailored PDF is kept temporarily in extension session storage so it can be restored in the panel; it is not added to job history and is cleared when the browser session ends.
- Only the background service worker and the options page call the AI provider or hosted resume scorer. **Web pages never see your API keys.**
- When you autofill, the AI provider receives your profile, up to 30,000 characters of your saved original resume text, your saved answers, the form's field labels, up to 2,500 characters of the page's job text, and the active job details if present. The side panel reports provider-reported input and output token usage after an AI response. When you tailor a resume, the provider receives your saved resume text, job title, company, and job description.
- When scoring a tailored resume, ApplyIQ's hosted scorer receives the saved original resume text, tailored resume text, and job description, matching ApplyIQ's text-based scoring request. The scorer key is optional and is stored locally in this browser profile. Scoring usage/limits are managed by the scorer service and are separate from AI token usage.
- Page access to HTTP and HTTPS websites is optional and requested on your first use of page-reading, tailoring/upload, or autofill features. The extension only reads or changes a page after you click the corresponding action; it doesn't run in the background on sites you visit.
- **Always skipped:**
  - password, captcha, and search fields
  - fields that already have a value (unless you enable overwriting)
  - checkboxes that give legal consent, certify information, or accept terms
- Sensitive fields (SSN, date of birth, bank, passport, driver's license, credit card) are skipped unless you explicitly enable them.
- **Export** in Options never includes your API keys. **Delete all data** wipes everything.

## Known limitations

- **Resume upload fields:** attaching a resume works on standard `<input type="file">` fields that accept PDF. Some sites (and some Workday flows) use custom uploaders that reject files added by code. Download the tailored PDF and upload manually there.
- **Custom dropdowns:** Workday, Select2, React-Select and similar widgets are handled on a best-effort basis (open the list, then click the best-matching option). Anything not filled is outlined in orange.
- **Closed shadow DOM and cross-origin iframes:** iframes are supported (e.g. Greenhouse embeds). Closed shadow roots can't be reached.
- **Very large forms:** only the first 200 fields are processed per run.
- **Unsupported resume files:** old `.doc` files (Word 97–2003) aren't supported; save as .docx or PDF. Scanned/image-only PDFs have no text layer, so paste the text instead.
- **Accuracy:** AI output can be wrong. Always review before submitting.
- **Cost:** each autofill sends one request (cached answers are reused). With the default models that's usually well under a cent per form.

## Project layout

```
manifest.json      MV3 manifest (storage, activeTab, scripting, unlimitedStorage)
background.js      Service worker: scan → cache → LLM → fill; review queue; keyboard shortcut
lib/
  llm.js           OpenAI (Responses API), Anthropic (Messages API), Gemini (generateContent) → JSON
  prompts.js       Resume-parsing and form-filling prompts
  storage.js       Settings / profile / answers / job history / per-site cache in chrome.storage.local
  resume.js        PDF (pdf.js), DOCX, TXT → text; stores the original file for upload fields
  docx.js          Dependency-free .docx reader (built-in DecompressionStream + XML parsing)
  pdf-writer.js    Dependency-free, styled PDF writer for tailored resumes
  xlsx.js          Dependency-free .xlsx export for job history
  zip.js           Minimal ZIP writer shared by DOCX and XLSX generation
  tailor.js        Default prompt, prompt substitution, and duplicate-job matching
  pdf/             Bundled pdf.js 6.5.438 (Apache-2.0, see lib/pdf/LICENSE)
content/
  scanner.js       Finds fields (incl. open shadow DOM and iframes); infers labels/sections/options
  filler.js        Fills fields (native setters + events), fuzzy option matching, highlights, file attach
  highlight.css
popup/             Autofill button, live status, review queue for long answers
options/           Provider/key, resume upload & parsing, profile editor, answers, preferences, prompt, and job history
icons/             Generated by scripts/make-icons.mjs
test/              Node unit tests + test-form.html
```

## Development

The tests need Node 20+ and no dependencies:

```powershell
node --test test/            # DOCX, PDF, prompt, storage and JSON-parsing tests
node scripts/make-icons.mjs  # regenerate icons/
```

`npm.ps1` may be blocked by your PowerShell execution policy. Use `npm.cmd test` or the `node` commands above.

After editing extension files, click **Reload** on the extension card in `chrome://extensions`. Content scripts are re-injected on the next Autofill. Reload the page if behaviour seems stale.

To update pdf.js, copy `build/pdf.min.mjs`, `build/pdf.worker.min.mjs` and `LICENSE` from the `pdfjs-dist` npm package into `lib/pdf/`.
