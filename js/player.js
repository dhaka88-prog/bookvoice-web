/* PLAYER: the narrator.
   It reads ONE sentence at a time. When a sentence ends it moves to the next and saves your place,
   like a finger following the lines of a book. If you stop, the finger stays on that sentence. */

const WORDS_PER_SECOND = 2.7;   // rough speed of a normal voice at 1.0x, used for time estimates

const P = {
  meta: null, chapters: null, chapterWords: [],
  ch: 0, s: 0, playing: false,
  token: 0,                 // goes up every start/stop, so old callbacks are ignored
  voice: null, noVoiceForLanguage: false,
  sleepAt: null, sleepEndOfChapter: false,
  errors: 0, audio: null
};

const hasSpeech = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
const sentence = (ch = P.ch, s = P.s) => P.chapters[ch].sentences[s];
const langOf = (v) => (v.lang || '').toLowerCase().replace('_', '-').slice(0, 2);

/* -------------------------------- voices -------------------------------- */
function allVoices() { return hasSpeech ? speechSynthesis.getVoices() : []; }
function usableVoices() {
  const v = allVoices();
  return Settings.get('offlineOnly') ? v.filter((x) => x.localService) : v;
}
function chooseVoice() {
  if (!P.meta) return;
  const lang = (P.meta.language || 'en').slice(0, 2);
  const list = usableVoices();
  const saved = Settings.get('voiceByLang')[lang];
  const mine = list.filter((x) => langOf(x) === lang);
  let v = list.find((x) => x.voiceURI === saved && langOf(x) === lang)
       || mine.find((x) => x.localService && x.default)
       || mine.find((x) => x.localService)
       || mine.find((x) => x.default)
       || mine[0];
  P.noVoiceForLanguage = !v && list.length > 0;
  if (!v) v = list.find((x) => x.default) || list[0] || null;
  P.voice = v || null;
}
function setVoice(voice) {
  const lang = (P.meta?.language || 'en').slice(0, 2);
  const map = { ...Settings.get('voiceByLang') };
  if (langOf(voice) === lang) { map[lang] = voice.voiceURI; Settings.set('voiceByLang', map); }
  P.voice = voice;
  P.noVoiceForLanguage = langOf(voice) !== lang && !usableVoices().some((x) => langOf(x) === lang);
  if (P.playing) speakCurrent();
  UI.updatePlayer();
}

/* -------------------------------- loading -------------------------------- */
async function loadBook(id) {
  const [meta, content, progress] = await Promise.all([DB.get('books', id), DB.get('content', id), DB.get('progress', id)]);
  if (!meta || !content) throw new Error('Book not found');
  stop();
  P.meta = meta;
  P.chapters = content.chapters;
  P.chapterWords = P.chapters.map((c) => c.sentences.reduce((n, s) => n + countWords(s), 0));
  P.ch = Math.min(progress?.ch || 0, P.chapters.length - 1);
  P.s = Math.min(progress?.s || 0, P.chapters[P.ch].sentences.length - 1);
  meta.lastOpened = Date.now();
  DB.put('books', meta).catch(() => {});
  Settings.set('lastBookId', id);
  chooseVoice();
  updateMediaMetadata();
}
function unloadBook() { stop(); P.meta = null; P.chapters = null; Settings.set('lastBookId', null); }

/* -------------------------------- speaking -------------------------------- */
function speakCurrent() {
  if (!hasSpeech || !P.chapters) return;
  const t = ++P.token;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(sentence());
  if (P.voice) { u.voice = P.voice; u.lang = P.voice.lang; } else u.lang = P.meta.language || 'en';
  u.rate = Settings.get('rate');
  u.onstart = () => { if (t === P.token) P.errors = 0; };
  u.onend = () => { if (t === P.token && P.playing) advance(); };
  u.onerror = (e) => {
    if (t !== P.token || e.error === 'interrupted' || e.error === 'canceled') return;
    P.errors++;
    if (P.errors >= 3) { pause(); UI.toast('The voice stopped working. Try another voice from the Voice button.', 'error'); }
    else if (P.playing) advance();
  };
  speechSynthesis.speak(u);
  savePosition();
  UI.updatePlayer();
}

function advance() {
  if (P.sleepAt && Date.now() >= P.sleepAt) { sleepNow(); return; }
  const len = P.chapters[P.ch].sentences.length;
  if (P.s + 1 < len) P.s++;
  else if (P.ch + 1 < P.chapters.length) {
    P.ch++; P.s = 0;
    UI.renderReader();
    updateMediaMetadata();
    if (P.sleepEndOfChapter) { sleepNow(); return; }
  } else {
    pause();
    UI.toast('You reached the end of the book.');
    return;
  }
  speakCurrent();
}

function play() {
  if (!P.chapters) return;
  if (!hasSpeech) { UI.toast('This browser cannot read aloud. Please try Chrome, Edge or Safari.', 'error'); return; }
  if (!allVoices().length) UI.toast('No voices found on this device yet. Trying the default voice.', 'error');
  P.playing = true;
  startSilentAudio();
  speakCurrent();
}
function pause() {
  P.playing = false;
  P.token++;
  if (hasSpeech) speechSynthesis.cancel();
  if (P.audio) P.audio.pause();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  savePosition();
  UI.updatePlayer();
}
function stop() { if (P.playing || (hasSpeech && speechSynthesis.speaking)) pause(); }
function togglePlay() { P.playing ? pause() : play(); }

function goTo(ch, s) {
  ch = Math.max(0, Math.min(ch, P.chapters.length - 1));
  s = Math.max(0, Math.min(s, P.chapters[ch].sentences.length - 1));
  const changed = ch !== P.ch;
  P.ch = ch; P.s = s;
  if (changed) { UI.renderReader(); updateMediaMetadata(); }
  if (P.playing) speakCurrent(); else { savePosition(); UI.updatePlayer(); }
}
function skipSentence(dir) {
  if (dir > 0) {
    if (P.s + 1 < P.chapters[P.ch].sentences.length) goTo(P.ch, P.s + 1);
    else if (P.ch + 1 < P.chapters.length) goTo(P.ch + 1, 0);
  } else {
    if (P.s > 0) goTo(P.ch, P.s - 1);
    else if (P.ch > 0) goTo(P.ch - 1, P.chapters[P.ch - 1].sentences.length - 1);
  }
}
/* Skip by "seconds of listening" at the current speed. */
function skipSeconds(sec) {
  const target = Math.abs(sec) * WORDS_PER_SECOND * Settings.get('rate');
  let ch = P.ch, s = P.s, acc = 0;
  if (sec > 0) {
    while (acc < target) {
      acc += countWords(sentence(ch, s));
      if (s + 1 < P.chapters[ch].sentences.length) s++;
      else if (ch + 1 < P.chapters.length) { ch++; s = 0; }
      else break;
    }
  } else {
    while (acc < target) {
      if (s > 0) s--;
      else if (ch > 0) { ch--; s = P.chapters[ch].sentences.length - 1; }
      else break;
      acc += countWords(sentence(ch, s));
    }
  }
  goTo(ch, s);
}
function skipChapter(dir) {
  if (dir > 0) { if (P.ch + 1 < P.chapters.length) goTo(P.ch + 1, 0); }
  else if (P.s > 2 || P.ch === 0) goTo(P.ch, 0);
  else goTo(P.ch - 1, 0);
}
function setRate(rate) {
  rate = Math.round(Math.max(0.5, Math.min(3, rate)) * 100) / 100;
  Settings.set('rate', rate);
  clearTimeout(setRate.t);
  if (P.playing) setRate.t = setTimeout(speakCurrent, 250);   // restart the sentence at the new speed
  UI.updatePlayer();
}

/* ---------------------------- saving your place ---------------------------- */
function overallIndex() {
  let n = 0;
  for (let i = 0; i < P.ch; i++) n += P.chapters[i].sentences.length;
  return n + P.s;
}
function savePosition() {
  if (!P.meta) return;
  const total = P.meta.totalSentences || 1;
  const pct = Math.min(100, Math.round((overallIndex() / Math.max(1, total - 1)) * 1000) / 10);
  DB.put('progress', { id: P.meta.id, ch: P.ch, s: P.s, pct, updated: Date.now() }).catch(() => {});
}
function timeEstimates() {
  const rate = Settings.get('rate');
  const sents = P.chapters[P.ch].sentences;
  let done = 0;
  for (let i = 0; i < P.s; i++) done += countWords(sents[i]);
  const chWords = P.chapterWords[P.ch];
  let later = 0;
  for (let i = P.ch + 1; i < P.chapters.length; i++) later += P.chapterWords[i];
  const wps = WORDS_PER_SECOND * rate;
  return { elapsed: done / wps, chapterLeft: (chWords - done) / wps, bookLeft: (chWords - done + later) / wps };
}

/* ------------------------------- sleep timer ------------------------------- */
function setSleep(minutes) {
  P.sleepAt = null; P.sleepEndOfChapter = false;
  if (minutes === 'chapter') P.sleepEndOfChapter = true;
  else if (minutes > 0) P.sleepAt = Date.now() + minutes * 60000;
  UI.updatePlayer();
}
function sleepNow() {
  P.sleepAt = null; P.sleepEndOfChapter = false;
  pause();
  UI.toast('Sleep timer finished. Playback paused.');
}
setInterval(() => {
  if (P.sleepAt && Date.now() >= P.sleepAt && P.playing) sleepNow();
  if (P.sleepAt) UI.updateSleepLabel();
}, 1000);

/* ----------------------- phone / keyboard media controls ----------------------- */
/* The voice itself is not "media" to the phone, so we play a silent loop while reading.
   That lets the lock-screen / notification controls and keyboard media keys reach the app. */
function silentWavUrl(seconds = 10, rate = 8000) {
  const n = seconds * rate, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function startSilentAudio() {
  try {
    if (!P.audio) { P.audio = new Audio(silentWavUrl()); P.audio.loop = true; P.audio.volume = 0.01; }
    const pr = P.audio.play();
    if (pr && pr.catch) pr.catch(() => {});
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  } catch { /* not essential */ }
}
function updateMediaMetadata() {
  if (!('mediaSession' in navigator) || !P.meta || typeof MediaMetadata === 'undefined') return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: P.meta.title, artist: P.meta.author || 'Bookvoice', album: P.chapters[P.ch].title,
      artwork: P.meta.cover ? [{ src: P.meta.cover, sizes: '300x450', type: 'image/jpeg' }] : []
    });
  } catch { /* ignore */ }
}
if ('mediaSession' in navigator) {
  const h = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch { /* unsupported */ } };
  h('play', play); h('pause', pause); h('stop', pause);
  h('previoustrack', () => skipSentence(-1)); h('nexttrack', () => skipSentence(1));
  h('seekbackward', () => skipSeconds(-30)); h('seekforward', () => skipSeconds(30));
}
