// Injected on demand (chrome.scripting) into every frame of the active tab.
// Finds fillable form controls, infers a human-readable label for each, and keeps
// element references in globalThis.__afcEls so filler.js can find them again.
(() => {
  const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'search', 'color', 'range', 'password']);
  const SENSITIVE_RE =
    /\b(ssn|social\s*security|sin|national\s*(id|insurance)|tax\s*(id|number)|tin|date\s*of\s*birth|birth\s*date|birthday|dob|bank|routing|iban|swift|account\s*number|passport|driver'?s?\s*licen[cs]e|credit\s*card|card\s*number|cvv|cvc|mother'?s\s*maiden)\b/i;
  const SKIP_RE = /captcha|honeypot|\bsearch\b/i;
  // Legal consent/attestation boxes are always left for the user to tick themselves.
  const CONSENT_RE = /\b(i agree|agree to|certify|consent|acknowledge|attest|terms (and|&) conditions|terms of (use|service)|privacy (policy|notice)|accurate and complete)\b/i;
  const RESUME_RE = /resume|résumé|\bcv\b|curriculum/i;
  const MAX_OPTIONS = 80;

  const clean = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  function decodeHtmlEntities(value) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = String(value ?? '');
    return textarea.value;
  }

  function getById(el, id) {
    const root = el.getRootNode();
    return (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
  }

  /** Text of a node without the text of nested controls (e.g. a <select>'s options). */
  function labelText(node) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    clone.querySelectorAll?.('input,select,textarea,option,button,script,style,svg,[aria-hidden="true"]').forEach((n) => n.remove());
    return clean(clone.textContent);
  }

  function isShown(el) {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') {
        return false;
      }
    }
    return true;
  }

  const hasControl = (n) => n.matches?.('input,select,textarea') || n.querySelector?.('input:not([type=hidden]),select,textarea');

  /** Closest preceding text near the element (for unlabeled fields). */
  function nearbyText(el) {
    let node = el;
    for (let depth = 0; depth < 5 && node && node !== document.body; depth++) {
      let sib = node.previousElementSibling;
      for (let i = 0; sib && i < 3; i++, sib = sib.previousElementSibling) {
        if (hasControl(sib)) return '';
        const t = labelText(sib);
        if (t && t.length < 250) return t;
      }
      node = node.parentElement;
      if (node && node.querySelectorAll('input:not([type=hidden]),select,textarea').length > 1) {
        // Climbed into a container with other fields; only its leading text node can still be ours.
        const first = [...node.childNodes].find((c) => c.nodeType === 3 && c.textContent.trim());
        return first ? clean(first.textContent) : '';
      }
    }
    return '';
  }

  function ariaLabel(el) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => labelText(getById(el, id))).join(' '));
      if (t) return t;
    }
    return clean(el.getAttribute('aria-label'));
  }

  function labelFor(el) {
    const a = ariaLabel(el);
    if (a) return a;
    if (el.labels?.length) {
      const t = clean([...el.labels].map(labelText).join(' '));
      if (t) return t;
    }
    if (el.id) {
      const l = el.getRootNode().querySelector?.(`label[for="${CSS.escape(el.id)}"]`);
      const t = labelText(l);
      if (t) return t;
    }
    return nearbyText(el) || clean(el.getAttribute('placeholder') || el.getAttribute('title'));
  }

  const CONTROLS = 'input:not([type=hidden]),select,textarea';
  const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role="heading"]';

  /** Label for a whole radio/checkbox group. */
  function groupLabel(els) {
    const first = els[0];
    // Only trust a fieldset/group wrapper if it wraps exactly this group (not a whole form section).
    const group = first.closest('fieldset,[role="radiogroup"],[role="group"]');
    if (group && group.querySelectorAll(CONTROLS).length === els.length) {
      const legend = group.matches('fieldset') ? group.querySelector(':scope > legend') : null;
      const t = labelText(legend) || ariaLabel(group);
      if (t) return t;
    }
    let container = first.parentElement;
    while (container && container !== document.body && !els.every((e) => container.contains(e))) container = container.parentElement;
    return container ? nearbyText(container) || nearbyText(first) : '';
  }

  /** Nearest heading/legend that introduces the section this field is in. */
  function sectionOf(el) {
    let node = el;
    for (let depth = 0; depth < 10 && node && node !== document.body; depth++) {
      let sib = node.previousElementSibling;
      for (let i = 0; sib && i < 15; i++, sib = sib.previousElementSibling) {
        if (sib.matches(`${HEADINGS},legend`)) return clean(labelText(sib), 120);
        // Look inside a sibling only if it is a pure heading wrapper (not another block of fields).
        if (!hasControl(sib)) {
          const h = [...sib.querySelectorAll(HEADINGS)].pop();
          if (h) return clean(labelText(h), 120);
        }
      }
      node = node.parentElement;
      if (node?.matches('fieldset')) {
        const legend = node.querySelector(':scope > legend');
        if (legend) return clean(labelText(legend), 120);
      }
    }
    return '';
  }

  function hintFor(el) {
    const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    return clean(ids.map((id) => labelText(getById(el, id))).join(' '), 200);
  }

  function optionText(el) {
    return clean(el.labels?.length ? [...el.labels].map(labelText).join(' ') : ariaLabel(el) || el.value, 150);
  }

  /** Collects elements, piercing open shadow roots. */
  function collect(root, selector, out = []) {
    root.querySelectorAll(selector).forEach((e) => out.push(e));
    root.querySelectorAll('*').forEach((e) => e.shadowRoot && collect(e.shadowRoot, selector, out));
    return out;
  }

  const SELECTOR = [
    'input',
    'select',
    'textarea',
    '[contenteditable="true"]:not([contenteditable="true"] [contenteditable="true"])',
    '[role="combobox"]:not(input)',
    'button[aria-haspopup="listbox"]',
  ].join(',');

  function inputKind(type, autocomplete = '') {
    if (['email', 'tel', 'url', 'number', 'date', 'month'].includes(type)) return type;
    const autocompleteTokens = String(autocomplete).toLowerCase().split(/\s+/);
    if (type === 'text' && autocompleteTokens.includes('email')) return 'email';
    return 'text';
  }

  function pageContext() {
    const main = document.querySelector('main,[role="main"],article,.job-description,#content') || document.body;
    return {
      title: clean(document.title, 200),
      url: location.origin + location.pathname,
      heading: clean(document.querySelector('h1')?.textContent, 200),
      jobText: clean(main?.innerText || main?.textContent, 2500),
    };
  }

  function readJobInfo() {
    const readables = [];
    const flatten = (value) => {
      if (Array.isArray(value)) value.forEach(flatten);
      else if (value && typeof value === 'object') {
        const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
        if (types.some((type) => String(type).split(/[\/#]/).pop() === 'JobPosting')) readables.push(value);
        if (value['@graph']) flatten(value['@graph']);
      }
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        flatten(JSON.parse(script.textContent));
      } catch {
        // Pages often contain unrelated or malformed structured data.
      }
    }

    const posting = readables[0] || {};
    const plainText = (value) => {
      const doc = new DOMParser().parseFromString(String(value || ''), 'text/html');
      return String(doc.body?.innerText || doc.body?.textContent || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    };
    const organization = typeof posting.hiringOrganization === 'string' ? posting.hiringOrganization : posting.hiringOrganization?.name;
    const companyNode = document.querySelector('[data-company-name], [itemprop="hiringOrganization"], .company-name, [class*="companyName"]');
    const descriptionNode = document.querySelector(
      '[itemprop="description"], [data-job-description], .job-description, [class*="jobDescription"], #job-description'
    );
    const main = document.querySelector('main,[role="main"],article,#content') || document.body;
    const visibleDescription = String(descriptionNode?.innerText || descriptionNode?.textContent || main?.innerText || main?.textContent || '');
    const jobDescription = (visibleDescription || plainText(posting.description))
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 30000);
    const titleNode = document.querySelector('h1');
    const visibleTitle = titleNode?.innerText || titleNode?.textContent;
    const visibleCompany = companyNode?.innerText || companyNode?.textContent || companyNode?.getAttribute?.('data-company-name');

    return {
      title: clean(decodeHtmlEntities(visibleTitle || posting.title || document.title), 200),
      company: clean(decodeHtmlEntities(visibleCompany || organization || document.querySelector('meta[property="og:site_name"]')?.content), 200),
      url: String(document.querySelector('link[rel="canonical"]')?.href || location.href).trim(),
      jobDescription,
    };
  }

  function scan(opts = {}) {
    const els = new Map();
    const fields = [];
    const files = [];
    let skippedSensitive = 0;
    let skippedFilled = 0;
    let n = 0;
    const seenGroups = new Set();

    const push = (desc, entry) => {
      const text = `${desc.label} ${desc.name || ''} ${desc.autocomplete || ''}`;
      if (SKIP_RE.test(text)) return;
      if (desc.kind === 'checkbox' && CONSENT_RE.test(`${desc.label} ${desc.question || ''}`)) return;
      if (!opts.fillSensitive && SENSITIVE_RE.test(text)) return void skippedSensitive++;
      if (!opts.overwriteExisting && desc.hasValue) return void skippedFilled++;
      delete desc.hasValue;
      for (const k of Object.keys(desc)) if (desc[k] === '' || desc[k] === false || desc[k] == null) delete desc[k];
      const id = `f${n++}`;
      els.set(id, entry);
      fields.push({ id, ...desc });
    };

    for (const el of collect(document, SELECTOR)) {
      if (el.disabled || el.readOnly || el.closest('[inert]')) continue;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();

      if (tag === 'input' && type === 'file') {
        const label = labelFor(el) || sectionOf(el);
        const id = `f${n++}`;
        els.set(id, { kind: 'file', els: [el] });
        files.push({ id, label, accept: el.accept || '', isResume: RESUME_RE.test(`${label} ${el.name} ${el.id}`) });
        continue;
      }
      if (!isShown(el)) continue;
      if (tag === 'input' && SKIP_INPUT_TYPES.has(type)) continue;

      const base = {
        name: clean(el.getAttribute('name') || el.id, 80),
        autocomplete: clean(el.getAttribute('autocomplete'), 40).replace(/^(on|off)$/, ''),
        section: sectionOf(el),
        hint: hintFor(el),
        required: el.required || el.getAttribute('aria-required') === 'true',
      };

      if (tag === 'input' && (type === 'radio' || type === 'checkbox')) {
        const scope = el.form || el.getRootNode();
        const members = el.name
          ? [...scope.querySelectorAll(`input[type="${type}"][name="${CSS.escape(el.name)}"]`)].filter(isShown)
          : [el];
        const groupKey = `${type}:${el.name}`;
        if (el.name && seenGroups.has(groupKey)) continue;
        if (el.name) seenGroups.add(groupKey);
        if (type === 'radio' || members.length > 1) {
          const kind = type === 'radio' ? 'radio' : 'checkbox-group';
          push(
            { kind, label: groupLabel(members), options: members.map(optionText), hasValue: members.some((m) => m.checked), ...base },
            { kind, els: members }
          );
        } else {
          const own = optionText(el);
          const group = groupLabel([el]);
          push(
            { kind: 'checkbox', label: own || group, question: own && group !== own ? group : '', hasValue: el.checked, ...base },
            { kind: 'checkbox', els: [el] }
          );
        }
        continue;
      }

      if (tag === 'select') {
        const list = [...el.options].filter((o) => !o.disabled && o.value !== '' && clean(o.text)).map((o) => clean(o.text, 150));
        const kind = el.multiple ? 'multiselect' : 'select';
        const sel = el.selectedOptions[0];
        push(
          {
            kind,
            label: labelFor(el),
            options: list.length <= MAX_OPTIONS ? list : undefined,
            optionCount: list.length > MAX_OPTIONS ? list.length : undefined,
            hasValue: el.multiple ? el.selectedOptions.length > 0 : Boolean(sel && sel.value !== '' && sel.index > 0),
            ...base,
          },
          { kind, els: [el] }
        );
        continue;
      }

      if (tag === 'input' || tag === 'textarea') {
        let kind = 'text';
        if (tag === 'textarea') kind = 'textarea';
        else if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') kind = 'combobox';
        else kind = inputKind(type, base.autocomplete);
        push(
          {
            kind,
            label: labelFor(el),
            placeholder: clean(el.getAttribute('placeholder'), 100),
            maxLength: el.maxLength > 0 ? el.maxLength : undefined,
            hasValue: Boolean(el.value.trim()),
            ...base,
          },
          { kind, els: [el] }
        );
        continue;
      }

      if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
        push({ kind: 'contenteditable', label: labelFor(el), hasValue: Boolean(el.textContent.trim()), ...base }, { kind: 'contenteditable', els: [el] });
        continue;
      }

      // Custom dropdown widgets (div[role=combobox], button[aria-haspopup=listbox]).
      const current = clean(el.textContent, 100);
      push(
        { kind: 'dropdown', label: labelFor(el), hasValue: Boolean(current) && !/^(select|choose|--|please|none)/i.test(current), ...base },
        { kind: 'dropdown', els: [el] }
      );
    }

    globalThis.__afcEls = els;
    return {
      fields,
      files,
      skippedSensitive,
      skippedFilled,
      page: window === window.top ? pageContext() : null,
      url: location.href,
    };
  }

  globalThis.__afcScanner = { scan, readJobInfo, inputKind };
})();
