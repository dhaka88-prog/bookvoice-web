/* UI: everything you see and click. */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const LANG_NAMES = { en: 'English', hi: 'Hindi', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', ja: 'Japanese',
  zh: 'Chinese', ko: 'Korean', ru: 'Russian', ar: 'Arabic', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', mr: 'Marathi', gu: 'Gujarati',
  kn: 'Kannada', ml: 'Malayalam', pa: 'Punjabi', ur: 'Urdu', nl: 'Dutch', sv: 'Swedish', pl: 'Polish', tr: 'Turkish' };
const langName = (c) => LANG_NAMES[(c || '').slice(0, 2)] || (c || 'unknown').toUpperCase();

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtLong(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function hueOf(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

function coverHtml(meta) {
  if (meta.cover) return `<img class="cover-img" src="${meta.cover}" alt="">`;
  return `<div class="gen-cover" style="--h:${hueOf(meta.id)}">
      <span class="gen-format">${esc(meta.format.toUpperCase())}</span>
      <span class="gen-title">${esc(meta.title)}</span>
      ${meta.author ? `<span class="gen-author">${esc(meta.author)}</span>` : ''}</div>`;
}

const UI = {
  toast(msg, kind = 'info', ms = 4200) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
  },
  message(title, html) {
    $('#msgTitle').textContent = title;
    $('#msgBody').innerHTML = html;
    $('#dlgMessage').showModal();
  },
  confirm(title, text, okLabel = 'Remove') {
    return new Promise((resolve) => {
      const d = $('#dlgConfirm');
      $('#confirmTitle').textContent = title;
      $('#confirmText').textContent = text;
      $('#confirmOk').textContent = okLabel;
      d.returnValue = '';
      d.onclose = () => resolve(d.returnValue === 'ok');
      d.showModal();
    });
  },

  /* ------------------------------- library ------------------------------- */
  async renderLibrary() {
    const [books, progress] = await Promise.all([DB.all('books'), DB.all('progress')]);
    const prog = Object.fromEntries(progress.map((p) => [p.id, p]));
    books.sort((a, b) => (b.lastOpened || b.addedAt) - (a.lastOpened || a.addedAt));
    $('#bookCount').textContent = books.length ? `${books.length} book${books.length > 1 ? 's' : ''}` : '';
    $('#emptyState').hidden = books.length > 0;
    $('#shelf').hidden = books.length === 0;
    $('#bookGrid').innerHTML = books.map((b) => {
      const pct = prog[b.id]?.pct || 0;
      const status = pct >= 99.5 ? 'Finished' : pct > 0 ? `${Math.round(pct)}% listened` : 'Not started';
      return `<article class="book">
        <button class="book-open" data-id="${b.id}" aria-label="Open ${esc(b.title)}">
          <div class="book-cover">${coverHtml(b)}</div>
          <div class="book-info"><h3 class="book-title">${esc(b.title)}</h3><p class="book-author">${esc(b.author || '')}</p>
            <div class="bar"><span style="width:${pct}%"></span></div><p class="book-status">${status}</p></div>
        </button>
        <button class="book-remove icon-btn" data-remove="${b.id}" aria-label="Remove ${esc(b.title)}" title="Remove">${icon('trash')}</button>
      </article>`;
    }).join('');
    UI.updateMini();
  },
  showImport(name, text, frac) {
    $('#importOverlay').hidden = false;
    $('#importName').textContent = name;
    $('#importStep').textContent = text;
    $('#importBar').style.width = `${Math.round((frac || 0) * 100)}%`;
  },
  hideImport() { $('#importOverlay').hidden = true; },

  /* ------------------------------- player ------------------------------- */
  openPlayer() {
    $('#playerView').hidden = false;
    document.body.classList.add('player-open');
    UI.renderReader();
    UI.updatePlayer();
    $('#btnPlay').focus({ preventScroll: true });
  },
  closePlayer() {
    $('#playerView').hidden = true;
    document.body.classList.remove('player-open');
    UI.renderLibrary();
  },
  renderReader() {
    if (!P.chapters) return;
    const ch = P.chapters[P.ch];
    $('#readerChapter').textContent = ch.title;
    $('#readerText').innerHTML = ch.sentences.map((s, i) => `<span class="snt" data-s="${i}">${esc(s)}</span> `).join('');
    $('#readerText').lang = P.meta.language || 'en';
    UI.markCurrent(true);
  },
  markCurrent(jump) {
    const prev = $('#readerText .snt.now');
    if (prev) prev.classList.remove('now');
    const cur = $(`#readerText .snt[data-s="${P.s}"]`);
    if (!cur) return;
    cur.classList.add('now');
    const box = $('#readerText');
    const top = cur.offsetTop - box.offsetTop;
    if (jump || top < box.scrollTop + 30 || top > box.scrollTop + box.clientHeight - 90) {
      box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3), behavior: jump ? 'auto' : 'smooth' });
    }
  },
  updatePlayer() {
    UI.updateMini();
    if (!P.meta || $('#playerView').hidden) return;
    const m = P.meta, ch = P.chapters[P.ch];
    $('#pTitle').textContent = m.title;
    $('#pAuthor').textContent = m.author || '';
    $('#pChapterNum').textContent = `Chapter ${P.ch + 1} of ${P.chapters.length}`;
    const playBtn = $('#btnPlay');
    playBtn.innerHTML = icon(P.playing ? 'pause' : 'play');
    playBtn.setAttribute('aria-label', P.playing ? 'Pause' : 'Play');
    const seek = $('#seek');
    seek.max = Math.max(0, ch.sentences.length - 1);
    seek.value = P.s;
    seek.style.setProperty('--fill', `${ch.sentences.length > 1 ? (P.s / (ch.sentences.length - 1)) * 100 : 0}%`);
    seek.setAttribute('aria-valuetext', `Sentence ${P.s + 1} of ${ch.sentences.length}`);
    const t = timeEstimates();
    $('#tElapsed').textContent = fmtTime(t.elapsed);
    $('#tLeft').textContent = `−${fmtTime(t.chapterLeft)}`;
    const pct = Math.round((overallIndex() / Math.max(1, m.totalSentences - 1)) * 100);
    $('#pBookProgress').textContent = `${pct}% · ${fmtLong(t.bookLeft)} left`;
    $('#lblSpeed').textContent = `${Settings.get('rate').toFixed(2).replace(/0$/, '').replace(/\.$/, '')}×`;
    $('#lblVoice').textContent = P.voice ? P.voice.name.replace(/^(Microsoft|Google)\s+/, '').replace(/\s+-\s+.*$/, '').replace(/\s*Online \(Natural\)/, '') : 'Default';
    UI.updateSleepLabel();

    const warn = $('#voiceWarning');
    if (!hasSpeech) {
      warn.hidden = false;
      warn.textContent = 'This browser cannot read aloud. Please open this page in Chrome, Edge or Safari.';
    } else if (P.noVoiceForLanguage) {
      warn.hidden = false;
      warn.innerHTML = `This book looks like <b>${esc(langName(m.language))}</b>, but no ${esc(langName(m.language))} voice was found on this device, so another voice is reading it. You can add a voice in your device's speech or language settings.`;
    } else warn.hidden = true;
    UI.markCurrent(false);
  },
  updateSleepLabel() {
    const lbl = $('#lblSleep');
    if (!lbl) return;
    if (P.sleepEndOfChapter) lbl.textContent = 'End of ch.';
    else if (P.sleepAt) lbl.textContent = fmtTime((P.sleepAt - Date.now()) / 1000);
    else lbl.textContent = 'Sleep';
    $('#btnSleep').classList.toggle('active', !!(P.sleepAt || P.sleepEndOfChapter));
    $('#miniSleep').textContent = lbl.textContent === 'Sleep' ? '' : `☾ ${lbl.textContent}`;
  },
  updateMini() {
    const mini = $('#miniPlayer');
    if (!P.meta || !$('#playerView').hidden) { mini.hidden = true; return; }
    mini.hidden = false;
    $('#miniCover').innerHTML = coverHtml(P.meta);
    $('#miniTitle').textContent = P.meta.title;
    $('#miniChapter').textContent = P.chapters[P.ch].title;
    $('#miniPlay').innerHTML = icon(P.playing ? 'pause' : 'play');
    $('#miniPlay').setAttribute('aria-label', P.playing ? 'Pause' : 'Play');
  },

  /* ------------------------------- dialogs ------------------------------- */
  openChapters() {
    $('#chapterList').innerHTML = P.chapters.map((c, i) => {
      const secs = P.chapterWords[i] / (WORDS_PER_SECOND * Settings.get('rate'));
      return `<li><button class="row${i === P.ch ? ' current' : ''}" data-ch="${i}"><span class="row-num">${i + 1}</span><span class="row-main">${esc(c.title)}</span><span class="row-side">${fmtLong(secs)}</span></button></li>`;
    }).join('');
    $('#dlgChapters').showModal();
    $('#chapterList .current')?.scrollIntoView({ block: 'center' });
  },
  openVoices() {
    const lang = (P.meta?.language || 'en').slice(0, 2);
    const list = usableVoices();
    const mine = list.filter((v) => langOf(v) === lang);
    const others = list.filter((v) => langOf(v) !== lang).sort((a, b) => a.lang.localeCompare(b.lang));
    const row = (v) => `<li class="voice-row${P.voice && v.voiceURI === P.voice.voiceURI ? ' current' : ''}">
        <button class="row voice-pick" data-uri="${esc(v.voiceURI)}"><span class="row-main">${esc(v.name)}</span>
          <span class="row-side">${esc(v.lang)} · ${v.localService ? 'on device' : '<b class="online">online</b>'}</span></button>
        <button class="icon-btn voice-preview" data-uri="${esc(v.voiceURI)}" aria-label="Preview ${esc(v.name)}" title="Preview">${icon('play')}</button></li>`;
    $('#voiceLangLabel').textContent = `${langName(lang)} voices (this book's language)`;
    $('#voiceListMine').innerHTML = mine.length ? mine.map(row).join('') : `<li class="empty-note">No ${esc(langName(lang))} voice found on this device.</li>`;
    $('#voiceListOther').innerHTML = others.map(row).join('') || '<li class="empty-note">None</li>';
    $('#voiceCount').textContent = list.length ? `${list.length} voice${list.length === 1 ? '' : 's'} available` : 'No voices found on this device.';
    $('#dlgVoice').showModal();
  },
  openSpeed() {
    const r = Settings.get('rate');
    $('#speedRange').value = r;
    $('#speedValue').textContent = `${r.toFixed(2)}×`;
    $$('#speedChips button').forEach((b) => b.classList.toggle('current', Number(b.dataset.rate) === r));
    $('#dlgSpeed').showModal();
  },
  openSleep() {
    $$('#sleepList button').forEach((b) => {
      const v = b.dataset.min;
      b.classList.toggle('current', (v === 'chapter' && P.sleepEndOfChapter) || (v === '0' && !P.sleepAt && !P.sleepEndOfChapter));
    });
    $('#dlgSleep').showModal();
  },
  openSettings() {
    $('#setOffline').checked = Settings.get('offlineOnly');
    $('#setFootnotes').checked = Settings.get('readFootnotes');
    $('#setTables').checked = Settings.get('announceTables');
    $('#setTheme').value = Settings.get('theme');
    $('#dlgSettings').showModal();
  },
  applyTheme() {
    const t = Settings.get('theme');
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    document.documentElement.style.setProperty('--reader-size', `${Settings.get('textSize')}px`);
  }
};

/* ------------------------------ adding books ------------------------------ */
async function importFiles(files) {
  files = [...files];
  if (!files.length) return;
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ignore */ }
  const opts = { readFootnotes: Settings.get('readFootnotes'), announceTables: Settings.get('announceTables') };
  const added = [], dupes = [], problems = [];
  let lastId = null;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const prefix = files.length > 1 ? `Book ${i + 1} of ${files.length} · ` : '';
    UI.showImport(file.name, `${prefix}Opening…`, 0);
    try {
      checkFileSize(file);
      const bytes = await file.arrayBuffer();
      const id = fingerprint(bytes);
      const existing = await DB.get('books', id);
      if (existing) { dupes.push(existing.title); lastId = id; continue; }
      const book = await parseBook(file, bytes, opts, (n, total, unit) => UI.showImport(file.name, `${prefix}Reading ${unit} ${n} of ${total}…`, n / total));
      UI.showImport(file.name, `${prefix}Saving…`, 1);
      const meta = { id, title: book.title, author: book.author, language: book.language, cover: book.cover, format: book.format,
        fileName: file.name, size: file.size, addedAt: Date.now(), lastOpened: 0, chapterCount: book.chapters.length,
        totalSentences: book.chapters.reduce((n, c) => n + c.sentences.length, 0) };
      await DB.put('content', { id, chapters: book.chapters });
      await DB.put('books', meta);
      added.push(meta.title); lastId = id;
    } catch (e) {
      let msg = e instanceof BookError ? e.message : 'An unexpected problem happened while reading this file.';
      if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) msg = 'Not enough storage space left on this device for this book.';
      if (!(e instanceof BookError)) console.error(e);
      problems.push({ name: file.name, msg, code: e.code || 'ERROR' });
    }
  }
  UI.hideImport();
  await UI.renderLibrary();
  if (added.length) UI.toast(added.length === 1 ? `Added “${added[0]}”` : `Added ${added.length} books`, 'ok');
  for (const t of dupes) UI.toast(`“${t}” is already in your library.`);
  if (problems.length) {
    const heading = { DRM: 'Protected book', LOCKED: 'Locked file', SCANNED: 'Scanned PDF, no text', CORRUPT: 'Damaged file',
      UNSUPPORTED: 'Not supported', EMPTY: 'No text found', TOO_BIG: 'File too large' };
    UI.message(problems.length === 1 ? 'This file could not be added' : `${problems.length} files could not be added`,
      problems.map((p) => `<div class="problem"><p class="problem-name">${esc(p.name)} <span class="tag">${esc(heading[p.code] || 'Problem')}</span></p><p>${esc(p.msg)}</p></div>`).join(''));
  }
  if (files.length === 1 && lastId && (added.length === 1 || dupes.length === 1)) openBook(lastId);
}

async function openBook(id) {
  try {
    if (!P.meta || P.meta.id !== id) await loadBook(id);
    UI.openPlayer();
  } catch (e) {
    console.error(e);
    UI.toast('Could not open this book. Try removing it and adding it again.', 'error');
  }
}

async function removeBook(id) {
  const meta = await DB.get('books', id);
  if (!meta) return;
  const ok = await UI.confirm('Remove this book?', `“${meta.title}” will be removed from this library, along with your listening position. Your original file is not touched.`);
  if (!ok) return;
  if (P.meta && P.meta.id === id) unloadBook();
  await Promise.all([DB.del('books', id), DB.del('content', id), DB.del('progress', id)]);
  UI.renderLibrary();
  UI.toast(`Removed “${meta.title}”`);
}

/* --------------------------- connecting the buttons --------------------------- */
function wire() {
  const fileInput = $('#fileInput');
  fileInput.addEventListener('change', () => { importFiles(fileInput.files); fileInput.value = ''; });
  $$('[data-act="import"]').forEach((b) => b.addEventListener('click', () => fileInput.click()));

  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { depth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; document.body.classList.remove('dragging'); if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files); });

  $('#bookGrid').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) { removeBook(rm.dataset.remove); return; }
    const open = e.target.closest('.book-open');
    if (open) openBook(open.dataset.id);
  });
  $('#miniPlay').addEventListener('click', togglePlay);
  $('#miniOpen').addEventListener('click', () => UI.openPlayer());

  $('#btnBack').addEventListener('click', () => UI.closePlayer());
  $('#btnPlay').addEventListener('click', togglePlay);
  $('#btnPrevSentence').addEventListener('click', () => skipSentence(-1));
  $('#btnNextSentence').addEventListener('click', () => skipSentence(1));
  $('#btnBack30').addEventListener('click', () => skipSeconds(-30));
  $('#btnFwd30').addEventListener('click', () => skipSeconds(30));
  $('#btnPrevChapter').addEventListener('click', () => skipChapter(-1));
  $('#btnNextChapter').addEventListener('click', () => skipChapter(1));
  $$('[data-act="chapters"]').forEach((b) => b.addEventListener('click', () => UI.openChapters()));
  $('#btnSpeed').addEventListener('click', () => UI.openSpeed());
  $('#btnVoice').addEventListener('click', () => UI.openVoices());
  $('#btnSleep').addEventListener('click', () => UI.openSleep());
  $('#seek').addEventListener('input', (e) => {
    const s = Number(e.target.value), t = $('#seekTip'), txt = P.chapters[P.ch].sentences[s];
    t.hidden = false;
    t.textContent = txt.slice(0, 90) + (txt.length > 90 ? '…' : '');
  });
  $('#seek').addEventListener('change', (e) => { $('#seekTip').hidden = true; goTo(P.ch, Number(e.target.value)); });

  $('#readerText').addEventListener('click', (e) => {
    const s = e.target.closest('.snt');
    if (s) { goTo(P.ch, Number(s.dataset.s)); if (!P.playing) play(); }
  });
  $('#btnTextSmaller').addEventListener('click', () => { Settings.set('textSize', Math.max(14, Settings.get('textSize') - 2)); UI.applyTheme(); });
  $('#btnTextBigger').addEventListener('click', () => { Settings.set('textSize', Math.min(32, Settings.get('textSize') + 2)); UI.applyTheme(); });

  $('#chapterList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ch]'); if (!b) return;
    $('#dlgChapters').close(); goTo(Number(b.dataset.ch), 0);
  });
  $('#dlgVoice').addEventListener('click', (e) => {
    const pick = e.target.closest('.voice-pick'), prev = e.target.closest('.voice-preview');
    const find = (uri) => allVoices().find((v) => v.voiceURI === uri);
    if (pick) { const v = find(pick.dataset.uri); if (v) { setVoice(v); $('#dlgVoice').close(); UI.toast(`Voice: ${v.name}`); } }
    if (prev) {
      const v = find(prev.dataset.uri); if (!v) return;
      if (P.playing) pause();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(langOf(v) === 'hi' ? 'नमस्ते! मैं आपकी किताब इस आवाज़ में पढ़ूँगी।' : 'Hello! This is how I will read your book.');
      u.voice = v; u.lang = v.lang; u.rate = Settings.get('rate');
      speechSynthesis.speak(u);
    }
  });
  $('#dlgVoice').addEventListener('close', () => { if (!P.playing && hasSpeech) speechSynthesis.cancel(); });

  $('#speedRange').addEventListener('input', (e) => {
    const r = Number(e.target.value);
    $('#speedValue').textContent = `${r.toFixed(2)}×`;
    $$('#speedChips button').forEach((b) => b.classList.toggle('current', Number(b.dataset.rate) === r));
    setRate(r);
  });
  $('#speedChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rate]'); if (!b) return;
    $('#speedRange').value = b.dataset.rate;
    $('#speedRange').dispatchEvent(new Event('input'));
  });
  $('#sleepList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-min]'); if (!b) return;
    const v = b.dataset.min;
    setSleep(v === 'chapter' ? 'chapter' : Number(v));
    $('#dlgSleep').close();
    if (v !== '0') UI.toast(v === 'chapter' ? 'Will stop at the end of this chapter.' : `Will stop in ${v} minutes.`);
  });

  $('#btnSettings').addEventListener('click', () => UI.openSettings());
  $('#setOffline').addEventListener('change', (e) => { Settings.set('offlineOnly', e.target.checked); chooseVoice(); UI.updatePlayer(); });
  $('#setFootnotes').addEventListener('change', (e) => Settings.set('readFootnotes', e.target.checked));
  $('#setTables').addEventListener('change', (e) => Settings.set('announceTables', e.target.checked));
  $('#setTheme').addEventListener('change', (e) => { Settings.set('theme', e.target.value); UI.applyTheme(); });

  $$('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    $$('[data-close]', d).forEach((b) => b.addEventListener('click', () => d.close()));
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') && e.target.type !== 'range') return;
    if ($$('dialog[open]').length || !P.meta || $('#playerView').hidden) return;
    const k = e.key;
    if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
    else if (k === 'ArrowRight' && !e.target.matches('input[type=range]')) { e.preventDefault(); e.shiftKey ? skipSeconds(30) : skipSentence(1); }
    else if (k === 'ArrowLeft' && !e.target.matches('input[type=range]')) { e.preventDefault(); e.shiftKey ? skipSeconds(-30) : skipSentence(-1); }
    else if (k === ']') { e.preventDefault(); skipChapter(1); }
    else if (k === '[') { e.preventDefault(); skipChapter(-1); }
    else if (k === '+' || k === '=') setRate(Settings.get('rate') + 0.1);
    else if (k === '-' || k === '_') setRate(Settings.get('rate') - 0.1);
    else if (k === 'Escape') UI.closePlayer();
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(); });
  window.addEventListener('pagehide', savePosition);
  if (hasSpeech) speechSynthesis.addEventListener('voiceschanged', () => { chooseVoice(); UI.updatePlayer(); });
}

async function start() {
  UI.applyTheme();
  wire();
  $('#sizeLimitNote').textContent = `Size limit: PDF and EPUB up to ${MAX_FILE_MB.pdf} MB, Word up to ${MAX_FILE_MB.docx} MB, other files up to ${MAX_FILE_MB.default} MB.`;
  if (!hasSpeech) {
    const b = $('#speechBanner');
    b.hidden = false;
    b.textContent = 'This browser cannot read aloud, so books cannot be played here. Please open this page in Chrome, Edge or Safari.';
  } else {
    // Some browsers load their voices a moment late. If there are none after a few seconds, say so kindly.
    setTimeout(() => {
      if (!allVoices().length) {
        const b = $('#speechBanner');
        b.hidden = false;
        b.textContent = 'No voices were found on this device. You can still add books, but you may need to install a text-to-speech voice in your device settings to hear them.';
      }
    }, 4000);
  }
  if (!(await DB.isPersistent())) $('#storageWarning').hidden = false;
  await UI.renderLibrary();
  const last = Settings.get('lastBookId');
  if (last && (await DB.get('books', last))) {
    try { await loadBook(last); UI.updateMini(); } catch { /* ignore */ }
  }
  document.body.classList.add('ready');
}

window.Bookvoice = { splitSentences, parseBook, importFiles, P, DB, Settings, goTo, openBook, BookError };
start();
