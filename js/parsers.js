/* PARSERS: one per file format.
   Each one is a translator: it takes a file in its own "language" (EPUB, PDF, ...)
   and hands back the same simple shape: { title, author, language, cover, chapters: [{ title, text }] } */

class BookError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

// File size limits (same as the Windows app). To change a limit, edit a number here.
const MAX_FILE_MB = { pdf: 100, epub: 100, docx: 50, default: 30 };
function checkFileSize(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const limit = MAX_FILE_MB[ext] || MAX_FILE_MB.default;
  const mb = file.size / (1024 * 1024);
  if (mb > limit) {
    throw new BookError('TOO_BIG', `This ${ext.toUpperCase()} is ${mb.toFixed(0)} MB. The limit is ${limit} MB. ` +
      (ext === 'pdf' ? 'Big PDFs are often scanned pictures. Try splitting it into parts with a free "split PDF" tool and add each part.' : 'Try splitting it into smaller files.'));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));   // lets the page breathe between big steps

function baseName(fileName) { return fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim(); }

function decodeText(bytes) {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if ((utf8.match(/�/g) || []).length > 5) return new TextDecoder('windows-1252').decode(bytes);
  return utf8.replace(/^﻿/, '');
}

async function blobToCover(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const w = 300, h = Math.round((bmp.height / bmp.width) * w);
    const c = document.createElement('canvas');
    c.width = w; c.height = Math.min(h, 600);
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.82);
  } catch { return null; }
}

/* ---------- HTML / XHTML to blocks (used by HTML and EPUB) ---------- */
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'blockquote', 'li', 'dd', 'dt', 'pre', 'header', 'footer',
  'main', 'figure', 'figcaption', 'tr', 'ul', 'ol', 'dl', 'body', 'center', 'td', 'th']);
const SKIP_TAGS = new Set(['script', 'style', 'svg', 'math', 'img', 'image', 'video', 'audio', 'object', 'iframe',
  'noscript', 'head', 'title', 'button', 'input', 'select', 'textarea', 'canvas', 'map']);
const FOOTNOTE_TYPES = /\b(footnote|endnote|rearnote|note|noteref|footnotes|endnotes|rearnotes)\b/;

function isFootnoteElement(el) {
  const t = (el.getAttribute('epub:type') || '') + ' ' + (el.getAttribute('role') || '').replace('doc-', '');
  if (FOOTNOTE_TYPES.test(t)) return true;
  const tag = el.localName.toLowerCase();
  if (tag === 'aside') return true;
  const cls = (el.getAttribute('class') || '').toLowerCase();
  if (/\b(footnotes?|endnotes?|fn|noteref)\b/.test(cls)) return true;
  if (tag === 'sup' && el.querySelector && el.querySelector('a')) return true;
  if (tag === 'sup' && /^\s*[\d*†‡]+\s*$/.test(el.textContent)) return true;
  return false;
}

function domToBlocks(root, opts = {}) {
  const blocks = [];
  let buf = '';
  const flush = () => { const t = buf.replace(/\s+/g, ' ').trim(); if (t) blocks.push({ type: 'p', text: t }); buf = ''; };
  const walk = (node) => {
    if (node.nodeType === 3) { buf += node.nodeValue; return; }
    if (node.nodeType !== 1) return;
    const tag = node.localName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (!opts.readFootnotes && isFootnoteElement(node)) return;
    if (tag === 'table') { flush(); if (opts.announceTables !== false) blocks.push({ type: 'p', text: 'Table skipped.' }); return; }
    if (tag === 'br') { buf += ' '; return; }
    const h = tag.match(/^h([1-6])$/);
    if (h) {
      flush();
      const t = node.textContent.replace(/\s+/g, ' ').trim();
      if (t) blocks.push({ type: 'h', level: Number(h[1]), text: t });
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) flush();
    for (const child of node.childNodes) walk(child);
    if (isBlock) flush();
  };
  walk(root);
  flush();
  return blocks;
}

function parseMarkup(str, preferXml) {
  const p = new DOMParser();
  if (preferXml) {
    const doc = p.parseFromString(str, 'application/xhtml+xml');
    if (!doc.getElementsByTagName('parsererror').length) return doc;
  }
  return p.parseFromString(str, 'text/html');
}

/* ---------------------------- TXT / MD / HTML ---------------------------- */
async function parseTxt(bytes, fileName) {
  const text = decodeText(bytes);
  return { title: baseName(fileName), author: '', language: guessLanguage(text), cover: null, chapters: chaptersFromPlainText(text) };
}
async function parseMarkdown(bytes, fileName, opts) {
  const text = decodeText(bytes);
  const blocks = markdownToBlocks(text, opts);
  const firstH1 = blocks.find((b) => b.type === 'h' && b.level === 1);
  return { title: firstH1 ? firstH1.text : baseName(fileName), author: '', language: guessLanguage(text), cover: null,
    chapters: chaptersFromBlocks(blocks, baseName(fileName)) };
}
async function parseHtml(bytes, fileName, opts) {
  const doc = parseMarkup(decodeText(bytes), false);
  const title = (doc.querySelector('title')?.textContent || '').trim() || baseName(fileName);
  const author = doc.querySelector('meta[name="author"]')?.getAttribute('content') || '';
  const blocks = domToBlocks(doc.body || doc.documentElement, opts);
  return { title, author, language: (doc.documentElement.getAttribute('lang') || '').slice(0, 2) || guessLanguage(doc.body?.textContent || ''),
    cover: null, chapters: chaptersFromBlocks(blocks, title) };
}

/* ---------------------------------- DOCX ---------------------------------- */
async function openZip(bytes, kind) {
  const b = new Uint8Array(bytes.slice ? bytes.slice(0, 4) : bytes);
  if (b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) {
    throw new BookError('LOCKED', kind === 'docx'
      ? 'This Word file is password-protected, or it is an old-style .doc file. Open it in Word, remove the password (or "Save As" .docx), then add it again.'
      : 'This file is encrypted and cannot be opened.');
  }
  try { return await JSZip.loadAsync(bytes); }
  catch { throw new BookError('CORRUPT', `This ${kind.toUpperCase()} file looks damaged or is not really a ${kind.toUpperCase()} file.`); }
}

async function parseDocx(bytes, fileName, opts) {
  const zip = await openZip(bytes, 'docx');
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new BookError('CORRUPT', 'This DOCX file has no document inside it. It may be damaged.');
  const xml = new DOMParser().parseFromString(await docFile.async('string'), 'application/xml');
  const body = xml.getElementsByTagNameNS(W_NS, 'body')[0];
  if (!body) throw new BookError('CORRUPT', 'This DOCX file could not be read. It may be damaged.');
  const blocks = [];
  let lastWasTable = false;
  for (const el of body.children) {
    if (el.localName === 'tbl') {
      if (!lastWasTable && opts.announceTables !== false) blocks.push({ type: 'p', text: 'Table skipped.' });
      lastWasTable = true; continue;
    }
    lastWasTable = false;
    if (el.localName !== 'p') continue;
    let text = '';
    const walk = (n) => {
      for (const c of n.children) {
        if (c.namespaceURI !== W_NS) { if (c.localName !== 'drawing') walk(c); continue; }
        if (c.localName === 't') text += c.textContent;
        else if (c.localName === 'tab' || c.localName === 'br') text += ' ';
        else if (['pPr', 'rPr', 'drawing', 'pict'].includes(c.localName)) continue;
        else walk(c);
      }
    };
    walk(el);
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const style = el.getElementsByTagNameNS(W_NS, 'pStyle')[0]?.getAttributeNS(W_NS, 'val') || '';
    const outline = el.getElementsByTagNameNS(W_NS, 'outlineLvl')[0]?.getAttributeNS(W_NS, 'val');
    let level = null;
    const m = style.match(/heading\s?(\d)/i);
    if (m) level = Number(m[1]);
    else if (/^title$/i.test(style)) level = 0;
    else if (outline !== undefined && outline !== null && outline !== '') level = Number(outline) + 1;
    blocks.push(level !== null ? { type: 'h', level, text } : { type: 'p', text });
  }
  let title = baseName(fileName), author = '';
  const core = zip.file('docProps/core.xml');
  if (core) {
    const c = new DOMParser().parseFromString(await core.async('string'), 'application/xml');
    title = c.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]?.textContent.trim() || title;
    author = c.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'creator')[0]?.textContent.trim() || '';
  }
  const all = blocks.map((b) => b.text).join(' ');
  return { title, author, language: guessLanguage(all), cover: null, chapters: chaptersFromBlocks(blocks, title) };
}

/* ---------------------------------- EPUB ---------------------------------- */
function resolvePath(base, rel) {
  rel = decodeURIComponent(rel.split('#')[0]);
  if (rel.startsWith('/')) return rel.slice(1);
  const parts = base.split('/'); parts.pop();
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}
function zipFileCI(zip, path) {
  return zip.file(path) || zip.file(new RegExp('^' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'))[0] || null;
}

async function parseEpub(bytes, fileName, opts, onProgress) {
  const zip = await openZip(bytes, 'epub');
  const drm = 'This EPUB is protected by DRM (copy protection), so it cannot be opened here. Only DRM-free books can be read.';
  if (zip.file('META-INF/rights.xml')) throw new BookError('DRM', drm);
  const enc = zip.file('META-INF/encryption.xml');
  if (enc) {
    const encXml = await enc.async('string');
    const algos = [...encXml.matchAll(/Algorithm="([^"]+)"/g)].map((m) => m[1]);
    const fontOnly = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];
    if (algos.some((a) => !fontOnly.includes(a) && !/xmldsig|digest/i.test(a))) throw new BookError('DRM', drm);
  }
  const container = zip.file('META-INF/container.xml');
  if (!container) throw new BookError('CORRUPT', 'This EPUB is missing its contents file. It may be damaged.');
  const cXml = new DOMParser().parseFromString(await container.async('string'), 'application/xml');
  const opfPath = cXml.getElementsByTagName('rootfile')[0]?.getAttribute('full-path');
  const opfFile = opfPath && zipFileCI(zip, opfPath);
  if (!opfFile) throw new BookError('CORRUPT', 'This EPUB could not be read. It may be damaged.');
  const opf = new DOMParser().parseFromString(await opfFile.async('string'), 'application/xml');
  const dc = (name) => opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', name)[0]?.textContent.trim() || '';
  const title = dc('title') || baseName(fileName);
  const author = dc('creator');
  const language = (dc('language') || '').slice(0, 2).toLowerCase();

  const manifest = {};
  for (const it of opf.getElementsByTagName('item')) {
    manifest[it.getAttribute('id')] = { href: resolvePath(opfPath, it.getAttribute('href') || ''), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' };
  }
  const spineEl = opf.getElementsByTagName('spine')[0];
  const spine = [...opf.getElementsByTagName('itemref')].map((r) => manifest[r.getAttribute('idref')]).filter(Boolean);

  const tocTitles = {};
  const navItem = Object.values(manifest).find((m) => /\bnav\b/.test(m.props));
  try {
    if (navItem && zipFileCI(zip, navItem.href)) {
      const navDoc = parseMarkup(await zipFileCI(zip, navItem.href).async('string'), true);
      const navs = [...navDoc.getElementsByTagName('nav')];
      const toc = navs.find((n) => /toc/.test(n.getAttribute('epub:type') || '')) || navs[0];
      if (toc) for (const a of toc.getElementsByTagName('a')) {
        const href = a.getAttribute('href'); if (!href) continue;
        const key = resolvePath(navItem.href, href);
        if (!tocTitles[key]) tocTitles[key] = a.textContent.replace(/\s+/g, ' ').trim();
      }
    }
    const ncxItem = manifest[spineEl?.getAttribute('toc')] || Object.values(manifest).find((m) => /dtbncx/.test(m.type));
    if (!Object.keys(tocTitles).length && ncxItem && zipFileCI(zip, ncxItem.href)) {
      const ncx = new DOMParser().parseFromString(await zipFileCI(zip, ncxItem.href).async('string'), 'application/xml');
      for (const np of ncx.getElementsByTagName('navPoint')) {
        const label = np.getElementsByTagName('text')[0]?.textContent.trim();
        const src = np.getElementsByTagName('content')[0]?.getAttribute('src');
        if (label && src) { const key = resolvePath(ncxItem.href, src); if (!tocTitles[key]) tocTitles[key] = label; }
      }
    }
  } catch { /* a broken contents list is not fatal */ }

  let cover = null;
  try {
    let coverItem = Object.values(manifest).find((m) => /cover-image/.test(m.props));
    if (!coverItem) {
      const metaCover = [...opf.getElementsByTagName('meta')].find((m) => m.getAttribute('name') === 'cover');
      if (metaCover) coverItem = manifest[metaCover.getAttribute('content')];
    }
    if (!coverItem) coverItem = Object.entries(manifest).find(([id, m]) => /cover/i.test(id + m.href) && /^image\//.test(m.type))?.[1];
    if (coverItem && /^image\//.test(coverItem.type) && zipFileCI(zip, coverItem.href)) {
      const blob = new Blob([await zipFileCI(zip, coverItem.href).async('uint8array')], { type: coverItem.type });
      cover = await blobToCover(blob);
    }
  } catch { cover = null; }

  const chapters = [];
  for (let i = 0; i < spine.length; i++) {
    const item = spine[i];
    onProgress && onProgress(i + 1, spine.length, 'section');
    if (!/html|xml/.test(item.type) || item === navItem) continue;
    const f = zipFileCI(zip, item.href);
    if (!f) continue;
    const doc = parseMarkup(await f.async('string'), true);
    const body = doc.getElementsByTagName('body')[0] || doc.documentElement;
    const blocks = domToBlocks(body, opts);
    if (!blocks.length) continue;
    const firstHeading = blocks.find((b) => b.type === 'h')?.text;
    chapters.push({ title: tocTitles[item.href] || firstHeading || `Section ${chapters.length + 1}`, text: blocks.map((b) => b.text).join('\n\n') });
    if (i % 5 === 4) await tick();
  }
  const sample = chapters.slice(0, 3).map((c) => c.text).join(' ');
  return { title, author, language: language || guessLanguage(sample), cover, chapters };
}

/* ----------------------------------- PDF ----------------------------------- */
let pdfReady = false;
function ensurePdf() {
  if (pdfReady) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  pdfReady = true;
}

function pdfPageLines(textContent) {
  const lines = [];
  let cur = null;
  for (const it of textContent.items) {
    if (typeof it.str !== 'string') continue;
    const y = it.transform[5], h = Math.abs(it.transform[3]) || it.height || 10;
    if (!cur || Math.abs(y - cur.y) > Math.max(2, h * 0.4)) {
      if (cur && cur.text.trim()) lines.push(cur);
      cur = { y, h, text: '' };
    }
    cur.text += it.str;
    if (it.hasEOL) cur.text += ' ';
  }
  if (cur && cur.text.trim()) lines.push(cur);
  lines.forEach((l) => { l.text = l.text.replace(/\s+/g, ' ').trim(); });
  return lines;
}

const normLine = (s) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const PAGE_NUMBER = /^(page\s*)?[#ivxlc]+(\s*(of|\/)\s*#)?$|^[-–—]\s*#\s*[-–—]$/i;

/* Remove page numbers and headers/footers that repeat on many pages. */
function stripHeadersFooters(pages) {
  const counts = new Map();
  const edgeLines = (lines) => [...lines.slice(0, 2), ...lines.slice(-2)];
  for (const lines of pages) {
    const seen = new Set(edgeLines(lines).map((l) => normLine(l.text)));
    for (const n of seen) counts.set(n, (counts.get(n) || 0) + 1);
  }
  const minRepeat = Math.max(3, Math.ceil(pages.length * 0.3));
  return pages.map((lines) => {
    const edges = new Set([...lines.slice(0, 2), ...lines.slice(-2)]);
    return lines.filter((l) => {
      if (!edges.has(l)) return true;
      const n = normLine(l.text);
      if (PAGE_NUMBER.test(n)) return false;
      if (pages.length >= 4 && counts.get(n) >= minRepeat) return false;
      return true;
    });
  });
}

function pdfLinesToText(lines) {
  if (!lines.length) return '';
  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1].y - lines[i].y));
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 12;
  let out = lines[0].text;
  for (let i = 1; i < lines.length; i++) {
    const gap = gaps[i - 1], next = lines[i].text;
    if (gap > median * 1.6) out += '\n\n' + next;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(next)) out = out.slice(0, -1) + next;
    else out += ' ' + next;
  }
  return out;
}

async function parsePdf(bytes, fileName, opts, onProgress) {
  ensurePdf();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') {
      throw new BookError('LOCKED', 'This PDF is password-protected, so it cannot be opened here. If it is your own file, remove the password first (for example by printing it to a new PDF), then add it again.');
    }
    throw new BookError('CORRUPT', 'This PDF looks damaged or is not a real PDF file.');
  }
  const pages = [];
  let totalChars = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    onProgress && onProgress(p, pdf.numPages, 'page');
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const lines = pdfPageLines(tc);
    totalChars += lines.reduce((n, l) => n + l.text.length, 0);
    pages.push(lines);
    page.cleanup();
  }
  if (totalChars < Math.max(40, pdf.numPages * 15)) {
    throw new BookError('SCANNED', 'This PDF seems to be scanned pictures of pages, with no real text inside, so there is nothing for the voice to read.');
  }
  const cleanPages = stripHeadersFooters(pages).map(pdfLinesToText);

  let title = baseName(fileName), author = '';
  try {
    const meta = await pdf.getMetadata();
    if (meta?.info?.Title && meta.info.Title.trim().length > 2) title = meta.info.Title.trim();
    if (meta?.info?.Author) author = meta.info.Author.trim();
  } catch { /* ignore */ }

  let starts = [];
  try {
    const outline = await pdf.getOutline();
    for (const item of outline || []) {
      let dest = item.dest;
      if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest) || dest[0] == null) continue;
      const idx = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
      starts.push({ page: idx, title: (item.title || '').trim() });
    }
  } catch { starts = []; }
  starts = starts.filter((s, i, a) => a.findIndex((x) => x.page === s.page) === i).sort((a, b) => a.page - b.page);

  const chapters = [];
  if (starts.length >= 2) {
    if (starts[0].page > 0) starts.unshift({ page: 0, title: 'Front matter' });
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1].page : cleanPages.length;
      chapters.push({ title: starts[i].title || `Section ${i + 1}`, text: cleanPages.slice(starts[i].page, end).join('\n\n') });
    }
  } else {
    for (let p = 0; p < cleanPages.length; p += 10) {
      const end = Math.min(p + 10, cleanPages.length);
      chapters.push({ title: `Pages ${p + 1}–${end}`, text: cleanPages.slice(p, end).join('\n\n') });
    }
  }

  let cover = null;
  try {
    const page = await pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 300 / vp1.width });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    cover = c.toDataURL('image/jpeg', 0.8);
  } catch { cover = null; }
  pdf.destroy();
  return { title, author, language: guessLanguage(cleanPages.slice(0, 5).join(' ')), cover, chapters };
}

/* -------------------------------- registry -------------------------------- */
const PARSERS = {
  txt: parseTxt, text: parseTxt, md: parseMarkdown, markdown: parseMarkdown,
  html: parseHtml, htm: parseHtml, xhtml: parseHtml, docx: parseDocx, epub: parseEpub, pdf: parsePdf
};
const UNSUPPORTED_HINTS = {
  mobi: 'MOBI books are not supported. Convert a DRM-free MOBI to EPUB (for example with the free app Calibre) and add that.',
  azw: 'Kindle (AZW) books are usually protected and are not supported.',
  azw3: 'Kindle (AZW3) books are usually protected and are not supported.',
  kfx: 'Kindle KFX books are always protected and cannot be opened.',
  aax: 'Audible files are protected and cannot be opened.',
  aa: 'Audible files are protected and cannot be opened.',
  fb2: 'FB2 books are not supported.',
  doc: 'Old-style .doc files are not supported. Open the file in Word, use "Save As" → .docx, then add that.'
};

/* Main entry: read any supported file and return a ready-to-play book. */
async function parseBook(file, bytes, opts, onProgress) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const parser = PARSERS[ext];
  if (!parser) {
    throw new BookError('UNSUPPORTED', UNSUPPORTED_HINTS[ext] || `".${ext}" files are not supported. Supported: EPUB, PDF, TXT, DOCX, HTML and Markdown (.md).`);
  }
  if (!bytes.byteLength) throw new BookError('CORRUPT', 'This file is empty.');
  let raw;
  try { raw = await parser(bytes, file.name, opts, onProgress); }
  catch (e) {
    if (e instanceof BookError) throw e;
    console.error(e);
    throw new BookError('CORRUPT', 'Something inside this file could not be understood. It may be damaged.');
  }
  const chapters = [];
  for (const ch of raw.chapters) {
    const sentences = splitSentences(ch.text);
    if (!sentences.length) continue;
    chapters.push(...autoSplitLong({ title: (ch.title || '').slice(0, 120), sentences }));
    if (chapters.length % 8 === 0) await tick();
  }
  if (!chapters.length) throw new BookError('EMPTY', 'No readable text was found in this file.');
  return { title: raw.title, author: raw.author, language: raw.language || 'en', cover: raw.cover, format: ext, chapters };
}
