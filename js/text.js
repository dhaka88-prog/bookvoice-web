/* TEXT TOOLS
   Turns raw text into clean, short sentences the voice can read.
   Think of it as kitchen prep: wash, chop and sort, so the voice gets neat bite-sized pieces. */

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'rs', 'inc', 'ltd', 'co', 'corp', 'approx',
  'dept', 'govt', 'gen', 'col', 'capt', 'lt', 'sgt', 'rev', 'hon', 'messrs', 'cf', 'al', 'mt', 'ft',
  'jan', 'feb', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'sq', 'km', 'kg', 'cm',
  'mm', 'ave', 'blvd', 'rd', 'viz', 'ibid', 'esp', 'incl', 'smt', 'shri', 'sh', 'er', 'adv', 'mme',
  'mlle', 'ph', 'lit', 'ed', 'eds', 'trans', 'misc', 'est'
]);
const NUMBER_ABBREVIATIONS = new Set(['no', 'nos', 'p', 'pp', 'vol', 'vols', 'ch', 'sec', 'fig', 'figs', 'eq', 'art', 'para', 'ex', 'pg']);

function isSentenceEnd(text, punctStart, punct, after) {
  const next = text.slice(after).trimStart().charAt(0);
  if (!next) return true;
  if (/[a-z]/.test(next)) return false;
  if (!/^\./.test(punct) || /[!?…]/.test(punct)) return true;
  if (punct.startsWith('..')) return true;
  const before = text.slice(0, punctStart);
  const word = before.slice(before.search(/\S+$/)).replace(/^[("'“‘\[]+/, '');
  const lower = word.toLowerCase();
  if (/^[A-Za-z]$/.test(word)) return false;
  if (/^([A-Za-z]\.)+[A-Za-z]$/.test(word)) return false;
  if (NUMBER_ABBREVIATIONS.has(lower)) return !/\d/.test(next);
  if (ABBREVIATIONS.has(lower)) return false;
  return true;
}

/* Very long sentences are cut at ; : or , so the voice never chokes. */
function chopLongSentence(s, max = 320) {
  if (s.length <= max) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > max) {
    const win = rest.slice(0, max);
    let cut = Math.max(win.lastIndexOf('; '), win.lastIndexOf(': '), win.lastIndexOf(', '));
    if (cut < max * 0.4) cut = win.lastIndexOf(' ');
    if (cut < 20) cut = max;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function splitSentences(text) {
  const out = [];
  const add = (s) => {
    s = s.trim();
    if (!/[\p{L}\p{N}]/u.test(s)) return;
    for (const piece of chopLongSentence(s)) out.push(piece);
  };
  const paragraphs = String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n+/);
  for (let p of paragraphs) {
    p = p.replace(/\s+/g, ' ').trim();
    if (!p) continue;
    const re = /[.!?…।]+["'”’»)\]]*(?=\s|$)/g;
    let start = 0, m;
    while ((m = re.exec(p))) {
      const end = m.index + m[0].length;
      if (end >= p.length) break;
      if (!isSentenceEnd(p, m.index, m[0], end)) continue;
      add(p.slice(start, end));
      start = end;
    }
    if (start < p.length) add(p.slice(start));
  }
  return out;
}

function countWords(s) { const m = String(s).match(/\S+/g); return m ? m.length : 0; }

function guessLanguage(text) {
  const sample = String(text).slice(0, 20000);
  const deva = (sample.match(/[ऀ-ॿ]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  return deva > latin ? 'hi' : 'en';
}

const TXT_HEADING = /^\s*(chapter|part|book|prologue|epilogue|introduction|preface|foreword|afterword|appendix|अध्याय|भाग)\b[^\n]{0,70}$/i;

function chaptersFromBlocks(blocks, fallbackTitle) {
  const counts = {};
  for (const b of blocks) if (b.type === 'h') counts[b.level] = (counts[b.level] || 0) + 1;
  const splitLevel = Object.keys(counts).map(Number).sort((a, b) => a - b).find((l) => counts[l] >= 2);
  const chapters = [];
  let cur = { title: '', parts: [] };
  const flush = () => { if (cur.parts.length) chapters.push({ title: cur.title, text: cur.parts.join('\n\n') }); };
  for (const b of blocks) {
    if (b.type === 'h' && splitLevel !== undefined && b.level <= splitLevel) {
      flush();
      cur = { title: b.text, parts: [b.text] };
    } else cur.parts.push(b.text);
  }
  flush();
  chapters.forEach((c, i) => { if (!c.title) c.title = i === 0 && chapters.length > 1 ? 'Opening' : (fallbackTitle || `Part ${i + 1}`); });
  return chapters;
}

function chaptersFromPlainText(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flushPara = () => { if (para.length) { blocks.push({ type: 'p', text: para.join('\n') }); para = []; } };
  for (const line of lines) {
    const prevBlank = para.length === 0;
    if (TXT_HEADING.test(line) && line.trim().length < 80 && prevBlank) {
      flushPara();
      blocks.push({ type: 'h', level: 1, text: line.trim() });
    } else if (!line.trim()) flushPara();
    else para.push(line);
  }
  flushPara();
  return chaptersFromBlocks(blocks);
}

/* A huge chapter is cut into parts of ~400 sentences, so the page never freezes. */
function autoSplitLong(chapter, maxSentences = 400) {
  if (chapter.sentences.length <= maxSentences) return [chapter];
  const out = [];
  for (let i = 0; i < chapter.sentences.length; i += maxSentences) {
    out.push({ title: `${chapter.title} · part ${out.length + 1}`, sentences: chapter.sentences.slice(i, i + maxSentences) });
  }
  return out;
}

function markdownToBlocks(md, opts = {}) {
  const blocks = [];
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  let para = [];
  let inCode = false, tableAnnounced = false;
  const clean = (s) => s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\^[^\]]*\]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .trim();
  const flush = () => { if (para.length) { const t = clean(para.join(' ')); if (t) blocks.push({ type: 'p', text: t }); para = []; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) { flush(); if (!inCode) blocks.push({ type: 'p', text: 'Code block skipped.' }); inCode = !inCode; continue; }
    if (inCode) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) { flush(); if (!tableAnnounced && opts.announceTables !== false) blocks.push({ type: 'p', text: 'Table skipped.' }); tableAnnounced = true; continue; }
    tableAnnounced = false;
    if (/^\[\^[^\]]+\]:/.test(line) && !opts.readFootnotes) { flush(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); const t = clean(h[2].replace(/#+\s*$/, '')); if (t) blocks.push({ type: 'h', level: h[1].length, text: t }); continue; }
    if (/^\s*([-*_]\s*){3,}$/.test(line)) { flush(); continue; }
    if (!line.trim()) { flush(); continue; }
    const li = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (li) { flush(); para.push(li[1]); flush(); continue; }
    para.push(line.replace(/^\s*>\s?/, ''));
  }
  flush();
  return blocks;
}
