# Bookvoice

Listen to your own DRM-free e-books. Open the page, pick a book from your phone or computer, press play, and the browser reads it aloud.

- Opens EPUB, PDF, Word (.docx), TXT, HTML and Markdown files.
- Plays one sentence at a time, highlights the sentence being read, with speed, voice, chapters and a sleep timer.
- Remembers where you stopped (saved on your own device).
- Your books never leave your device. Protected files (Kindle, Audible, DRM-locked EPUBs) cannot be opened.
- Plain static HTML, CSS and JavaScript. No server, no sign-up.

Built by Nishant Dhaka as part of the AI course at IIM Lucknow. AI helped build it.

## Run it
Open `index.html` through any static web server (or deploy the folder as-is to Vercel, Netlify or GitHub Pages).

## Third-party libraries (in `vendor/`)
- pdf.js 3.11.174 (Apache-2.0) for reading PDFs
- JSZip 3.10.1 (MIT) for reading EPUB and DOCX files

The sample book in `samples/` is the opening of *Alice's Adventures in Wonderland* by Lewis Carroll (1865), which is in the public domain.
