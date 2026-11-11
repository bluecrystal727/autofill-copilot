// Injected after scanner.js. Applies values to the elements recorded in globalThis.__afcEls
// in a way that React/Angular/Vue notice (native setters + input/change events).
(() => {
  if (globalThis.__afcFiller) return;

  const norm = (s) =>
    String(s ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9+]+/g, ' ')
      .trim();

  const DECLINE_RE = /decline|prefer not|not to (say|answer|disclose)|don.?t wish|do not wish|choose not|rather not|not specified/;

  /** Returns the index of the option that best matches `wanted`, or -1. */
  function bestOption(options, wanted) {
    const w = norm(wanted);
    if (!w) return -1;
    const opts = options.map(norm);
    let i = opts.indexOf(w);
    if (i >= 0) return i;
    if (DECLINE_RE.test(w)) {
      i = opts.findIndex((o) => DECLINE_RE.test(o));
      if (i >= 0) return i;
    }
    if (w === 'yes' || w === 'no' || w === 'true' || w === 'false') {
      const yes = w === 'yes' || w === 'true';
      i = opts.findIndex((o) => (yes ? /^(yes|y|true)\b/ : /^(no|n|false)\b/).test(o));
      if (i >= 0) return i;
    }
    // Compare with spaces removed so "Masters" ~ "Master's Degree" and "Bachelors degree" ~ "Bachelor's Degree".
    const wc = w.replace(/ /g, '');
    const compact = opts.map((o) => o.replace(/ /g, ''));
    i = compact.indexOf(wc);
    if (i >= 0) return i;
    i = compact.findIndex((o) => o.length > 1 && (o.startsWith(wc) || wc.startsWith(o)));
    if (i >= 0) return i;
    i = compact.findIndex((o) => o.length > 2 && (o.includes(wc) || wc.includes(o)));
    if (i >= 0) return i;
    // token overlap (Jaccard)
    const wt = new Set(w.split(' '));
    let best = -1;
    let bestScore = 0.5;
    opts.forEach((o, idx) => {
      const ot = new Set(o.split(' '));
      const inter = [...wt].filter((t) => ot.has(t)).length;
      const score = inter / new Set([...wt, ...ot]).size;
      if (score > bestScore) [best, bestScore] = [idx, score];
    });
    return best;
  }

  const fire = (el, type, init = {}) => el.dispatchEvent(new Event(type, { bubbles: true, composed: true, ...init }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  /** Really leaves the field (fires blur/focusout) so nothing stays focused and drags the page back to it. */
  function release(el) {
    if (el && typeof el.blur === 'function') el.blur();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
  }

  function typeInto(el, value) {
    el.focus({ preventScroll: true }); // don't yank the page around while filling
    setNativeValue(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    fire(el, 'change');
  }

  function setChecked(el, checked) {
    if (el.checked === checked) return;
    el.click(); // runs the site's handlers and toggles the box
    if (el.checked !== checked) {
      el.checked = checked;
      fire(el, 'input');
      fire(el, 'change');
    }
  }

  function toDateInput(value, kind) {
    const s = String(value).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
    let y, mo, d;
    if (m) [, y, mo, d] = m;
    else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [, mo, d, y] = m;
    else {
      const t = Date.parse(s);
      if (Number.isNaN(t)) return null;
      const dt = new Date(t);
      [y, mo, d] = [dt.getFullYear(), dt.getMonth() + 1, dt.getDate()];
    }
    const pad = (x) => String(x || 1).padStart(2, '0');
    return kind === 'month' ? `${y}-${pad(mo)}` : `${y}-${pad(mo)}-${pad(d)}`;
  }

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const press = (el) => {
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(t, { bubbles: true }));
    el.click();
  };

  /** Finds currently visible listbox options (custom dropdown menus usually render in a portal). */
  function visibleOptions(owner) {
    const ctl = owner.getAttribute('aria-controls') || owner.getAttribute('aria-owns');
    const listbox = ctl ? owner.getRootNode().getElementById?.(ctl) || document.getElementById(ctl) : null;
    const scope = listbox || document;
    return [...scope.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"]')].filter(isVisible);
  }

  async function pickFromOpenList(owner, wanted) {
    for (let tries = 0; tries < 8; tries++) {
      const options = visibleOptions(owner);
      if (options.length) {
        const i = bestOption(options.map((o) => o.textContent), wanted);
        if (i < 0) return false;
        press(options[i]);
        return true;
      }
      await sleep(120);
    }
    return false;
  }

  /** Closes any open dropdown/menu: Escape on the focused element, then a real blur. */
  function closeOpenMenus(el) {
    const key = (type) => new KeyboardEvent(type, { bubbles: true, composed: true, cancelable: true, key: 'Escape', code: 'Escape', keyCode: 27 });
    for (const target of new Set([document.activeElement, el])) {
      if (!target || target === document.body) continue;
      target.dispatchEvent(key('keydown'));
      target.dispatchEvent(key('keyup'));
      target.blur?.();
    }
  }

  async function fillCombobox(el, value) {
    typeInto(el, String(value));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    await pickFromOpenList(el, value); // if nothing matches, the typed text is kept (free-text combobox)
    await sleep(60);
    closeOpenMenus(el);
    return true;
  }

  async function fillDropdown(el, value) {
    press(el);
    await sleep(150);
    const ok = await pickFromOpenList(el, value);
    await sleep(60);
    closeOpenMenus(el); // never leave a menu open (it can lock page scrolling)
    return ok;
  }

  function fillSelect(el, value) {
    const options = [...el.options].filter((o) => !o.disabled && o.value !== '');
    const wanted = Array.isArray(value) ? value : [value];
    if (el.multiple) {
      let any = false;
      for (const w of wanted) {
        const i = bestOption(options.map((o) => o.text), w);
        if (i >= 0) any = options[i].selected = true;
      }
      if (any) {
        fire(el, 'input');
        fire(el, 'change');
      }
      return any;
    }
    let i = bestOption(options.map((o) => o.text), wanted[0]);
    // Fall back to an exact match on the option's value attribute (fuzzy-matching codes like "ba" is unsafe).
    if (i < 0) i = options.findIndex((o) => norm(o.value) === norm(wanted[0]));
    if (i < 0) return false;
    el.focus({ preventScroll: true });
    setNativeValue(el, options[i].value);
    fire(el, 'input');
    fire(el, 'change');
    release(el);
    return true;
  }

  function fillChoice(els, value, multi) {
    const labels = els.map((e) => (e.labels?.length ? [...e.labels].map((l) => l.textContent).join(' ') : e.getAttribute('aria-label') || e.value));
    const wanted = multi ? (Array.isArray(value) ? value : [value]) : [Array.isArray(value) ? value[0] : value];
    let any = false;
    for (const w of wanted) {
      const i = bestOption(labels, w);
      if (i >= 0) {
        setChecked(els[i], true);
        any = true;
      }
    }
    return any;
  }

  function fillContentEditable(el, value) {
    el.focus({ preventScroll: true });
    getSelection().selectAllChildren(el);
    if (!document.execCommand('insertText', false, String(value))) {
      el.textContent = String(value);
      fire(el, 'input');
    }
    release(el);
    return true;
  }

  function attachFile(el, file) {
    const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], file.name, { type: file.type, lastModified: Date.now() }));
    el.files = dt.files;
    fire(el, 'input');
    fire(el, 'change');
    return el.files.length > 0;
  }

  // ---------- highlighting ----------

  const STATUSES = ['afc-filled', 'afc-skipped', 'afc-review'];

  function markTarget(entry) {
    if (entry.kind === 'radio' || entry.kind === 'checkbox-group') {
      // Smallest element that wraps every option of the group.
      let node = entry.els[0].parentElement;
      while (node && node !== document.body && !entry.els.every((e) => node.contains(e))) node = node.parentElement;
      return node;
    }
    return entry.els[0];
  }

  function mark(entry, status) {
    const target = markTarget(entry);
    if (!target) return;
    target.classList.remove(...STATUSES);
    target.classList.add(`afc-${status}`);
    target.setAttribute('data-afc', status);
  }

  function clearMarks() {
    document.querySelectorAll('[data-afc]').forEach((e) => {
      e.classList.remove(...STATUSES);
      e.removeAttribute('data-afc');
    });
  }

  async function fillOne(entry, value) {
    const el = entry.els[0];
    if (!el?.isConnected) return false;
    switch (entry.kind) {
      case 'select':
      case 'multiselect':
        return fillSelect(el, value);
      case 'radio':
        return fillChoice(entry.els, value, false);
      case 'checkbox-group':
        return fillChoice(entry.els, value, true);
      case 'checkbox':
        setChecked(el, value === true || /^(true|yes|checked|1)$/i.test(String(value)));
        return true;
      case 'date':
      case 'month': {
        const v = toDateInput(value, entry.kind);
        if (!v) return false;
        typeInto(el, v);
        release(el);
        return el.value === v;
      }
      case 'contenteditable':
        return fillContentEditable(el, value);
      case 'combobox':
        return fillCombobox(el, value);
      case 'dropdown':
        return fillDropdown(el, value);
      default: {
        let v = Array.isArray(value) ? value.join(', ') : String(value);
        if (el.maxLength > 0 && v.length > el.maxLength) v = v.slice(0, el.maxLength);
        typeInto(el, v);
        release(el);
        return true;
      }
    }
  }

  // ---------- scroll-lock safety net ----------
  // Dropdown libraries (React-Select, MUI, Radix...) lock page scrolling while a menu is open.
  // We snapshot the page's scroll state before filling and undo any lock we caused afterwards.

  const LOCK_PROPS = ['overflow', 'overflowY', 'position', 'top', 'paddingRight', 'pointerEvents', 'touchAction'];
  const LOCK_CLASS_RE = /scroll|lock|modal|overflow|noscroll|open/i;

  function snapshotScroll() {
    return {
      x: window.scrollX,
      y: window.scrollY,
      roots: [document.documentElement, document.body].map((el) => ({
        el,
        style: Object.fromEntries(LOCK_PROPS.map((p) => [p, el.style[p]])),
        classes: new Set(el.classList),
        locked: isLocked(el),
      })),
    };
  }

  function isLocked(el) {
    const cs = getComputedStyle(el);
    return cs.overflowY === 'hidden' || cs.overflowY === 'clip' || cs.pointerEvents === 'none' || (el === document.body && cs.position === 'fixed');
  }

  function restoreScroll(snap) {
    let fixed = false;
    for (const r of snap.roots) {
      if (r.locked || !isLocked(r.el)) continue; // wasn't ours, or no lock appeared
      for (const [p, v] of Object.entries(r.style)) r.el.style[p] = v;
      for (const c of [...r.el.classList]) if (!r.classes.has(c) && LOCK_CLASS_RE.test(c)) r.el.classList.remove(c);
      fixed = true;
    }
    if (fixed) window.scrollTo(snap.x, snap.y);
  }

  /** @param {{fills:Array<{id:string,value:any}>, resumeFile?:object, fileIds?:string[]}} payload */
  async function apply(payload) {
    const snap = snapshotScroll();
    try {
      return await applyFills(payload);
    } finally {
      await sleep(250); // let menus finish closing, then undo any scroll lock they left behind
      closeOpenMenus(document.activeElement);
      release(null); // nothing may stay focused after we finish
      await sleep(100);
      restoreScroll(snap);
    }
  }

  async function applyFills({ fills = [], resumeFile = null, fileIds = [] }) {
    const els = globalThis.__afcEls;
    if (!els) return { filled: [], failed: fills.map((f) => f.id), filesAttached: 0, stale: true };
    const filled = [];
    const failed = [];
    for (const f of fills) {
      const entry = els.get(f.id);
      if (!entry) continue;
      let ok = false;
      try {
        ok = await fillOne(entry, f.value);
      } catch (e) {
        console.warn('[Autofill Copilot] could not fill', f.id, e);
      }
      (ok ? filled : failed).push(f.id);
      mark(entry, ok ? 'filled' : 'skipped');
    }
    let filesAttached = 0;
    if (resumeFile) {
      for (const id of fileIds) {
        const entry = els.get(id);
        try {
          if (entry && attachFile(entry.els[0], resumeFile)) {
            filesAttached++;
            const wrap = entry.els[0].closest('label,div') || entry.els[0];
            wrap.classList.add('afc-filled');
            wrap.setAttribute('data-afc', 'filled');
          }
        } catch (e) {
          console.warn('[Autofill Copilot] could not attach resume', e);
        }
      }
    }
    return { filled, failed, filesAttached };
  }

  /** Highlights fields that were scanned but got no value. */
  function markUnfilled(ids) {
    const els = globalThis.__afcEls;
    for (const id of ids) {
      const entry = els?.get(id);
      const target = entry && markTarget(entry);
      if (target?.isConnected && !target.hasAttribute('data-afc')) mark(entry, 'skipped');
    }
  }

  globalThis.__afcFiller = { apply, clearMarks, markUnfilled, bestOption, toDateInput };
})();
