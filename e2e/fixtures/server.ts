// A tiny local "internet" for capture tests: an article, a thin link page, a PDF and an image.
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';

const SAMPLE = new URL('../../sample-library/', import.meta.url).pathname;

const ARTICLE = `<!doctype html><html><head>
<meta charset="utf-8"><title>Lamps that glow — Fixture Journal</title>
<meta property="og:title" content="Lamps that glow, not shine">
<meta property="og:description" content="A short essay on paper lamps and evening light.">
<meta property="og:site_name" content="Fixture Journal">
<meta property="og:image" content="/cover.png">
<meta name="author" content="A. Tester">
<meta property="article:published_time" content="2026-10-01T08:00:00Z">
</head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article>
<h1>Lamps that glow, not shine</h1>
<p>There is a difference between light that glows and light that shines. A paper lamp glows: the shade becomes the source, soft at the edges, and the room around it settles down.</p>
<p>Washi paper diffuses a bare bulb into something closer to a lantern. The warmth comes from the colour temperature — 2200 to 2700 kelvin — but also from the way the light falls off into the corners of the room.</p>
<p>Put the lamp low, below eye level, and the ceiling disappears. This is the trick of every good listening bar: the light is for the counter and the records, not for the room.</p>
<p>If you only change one thing in a reading corner, change the lamp. Read more in <a href="/notes/kelvin">our note on kelvin</a>.</p>
<p>Shadows are not a problem to be solved. They give the room depth, and they make the glowing shade feel like the centre of a small world.</p>
</article>
<footer>© Fixture Journal</footer>
</body></html>`;

const THIN = `<!doctype html><html><head><title>Bulb shop</title>
<meta property="og:title" content="Warm filament bulb, 2200 K">
<meta property="og:description" content="E27 filament bulb, dimmable, 2200 K.">
</head><body><p>Buy now.</p></body></html>`;

export function startFixtureServer(port = 0): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/article' || path === '/article-2' || path === '/article-3') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(ARTICLE.replace('Lamps that glow, not shine', path === '/article' ? 'Lamps that glow, not shine' : `Lamps that glow (${path.slice(-1)})`));
    }
    if (path === '/bulb') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(THIN);
    }
    if (path === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(ARTICLE);
      }, 4000);
      return;
    }
    if (path === '/broken') {
      res.writeHead(500);
      return res.end('boom');
    }
    if (path === '/primer.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(readFileSync(SAMPLE + 'attachments/2026/07/01j2-room-acoustics-primer.pdf'));
    }
    if (path === '/cover.png' || path === '/photo.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(readFileSync(SAMPLE + 'attachments/2026/06/01hy-paper-lamp.png'));
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, server, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 4848);
  startFixtureServer(port).then((s) => console.log(`fixtures at ${s.url}`));
}
