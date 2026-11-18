#!/usr/bin/env node
/* ============================================================
   of the flesh — a very small static site generator
   ------------------------------------------------------------
   posts/*.md  ->  dist/index.html + dist/posts/<slug>/ + rss
   run:  npm run build
   ============================================================ */

import { readFile, writeFile, mkdir, readdir, cp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { marked } from 'marked';

/* ------------------------------------------------------------------
   site settings — the only things you normally need to change
   ------------------------------------------------------------------ */
const site = {
	title: 'ofTheFlesh',
	description: 'A record of things I make, as I make them.',
	author: 'Raine Eera',
	// set this to your real Cloudflare Pages / custom domain once you know it
	url: 'https://oftheflesh.pages.dev',
};

const baseUrl = (process.env.SITE_URL || site.url).replace(/\/+$/, '');

const root = process.cwd();
const postsDir = path.join(root, 'posts');
const publicDir = path.join(root, 'public');
const outDir = path.join(root, 'dist');

/* ------------------------------------------------------------------
   helpers
   ------------------------------------------------------------------ */
const esc = (s = '') =>
	String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

const unquote = (s) => s.replace(/^(['"])([\s\S]*)\1$/, '$2');

const slugify = (s) =>
	String(s)
		.toLowerCase()
		.replace(/['’]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

const isoDate = (v) => {
	if (!v) return '';
	const s = String(v).trim();
	if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

const rfc822 = (iso) => (iso ? new Date(iso + 'T00:00:00Z').toUTCString() : new Date().toUTCString());

function parseFrontMatter(raw) {
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) return { data: {}, body: raw };

	const data = {};
	let lastKey = null;

	for (const line of m[1].split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith('#')) continue;

		const item = line.match(/^\s*-\s+(.*)$/);
		if (item && lastKey) {
			if (!Array.isArray(data[lastKey])) data[lastKey] = [];
			data[lastKey].push(unquote(item[1].trim()));
			continue;
		}

		const i = line.indexOf(':');
		if (i === -1) continue;
		const key = line.slice(0, i).trim().toLowerCase();
		const val = line.slice(i + 1).trim();
		lastKey = key;

		if (val === '') {
			data[key] = null;
		} else if (key === 'tags' || key === 'tag') {
			data.tags = val
				.replace(/^\[|\]$/g, '')
				.split(',')
				.map((s) => unquote(s.trim()).toLowerCase())
				.filter(Boolean);
		} else {
			data[key] = unquote(val);
		}
	}

	return { data, body: raw.slice(m[0].length) };
}

const plain = (html) =>
	html
		.replace(/<[^>]+>/g, ' ')
		.replace(/&[a-z]+;/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();

function excerptOf(html, max = 180) {
	const text = plain(html);
	if (text.length <= max) return text;
	return text.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

const readingTime = (html) => Math.max(1, Math.round(plain(html).split(/\s+/).length / 220));

const attrOf = (tag, name) => {
	const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
	return m ? m[1] ?? m[2] ?? m[3] ?? '' : '';
};

/* the first image or video in a post — used for the timeline thumbnail */
function mediaOf(html) {
	const img = html.match(/<img\b[^>]*>/i);
	const video = html.match(/<video\b[^>]*>/i);

	const first = [
		img && { kind: 'image', index: img.index },
		video && { kind: 'video', index: video.index },
	]
		.filter(Boolean)
		.sort((a, b) => a.index - b.index)[0];

	const player = html.match(/<span class="player"[^>]*\bdata-src="([^"]*)"/i);

	if (!first && !player) return null;

	return {
		kind: first ? first.kind : '',
		image: img ? attrOf(img[0], 'src') : '',
		poster: video ? attrOf(video[0], 'poster') : '',
		audio: player ? player[1] : '',
	};
}

/* turn <audio> in a post into a play button inside the article */
function audioPlayers(html) {
	return html.replace(/<audio\b([^>]*)>([\s\S]*?)<\/audio>/gi, (match, attrs, inner) => {
		const tag = `<audio${attrs}>`;
		let src = attrOf(tag, 'src');

		if (!src) {
			const source = inner.match(/<source\b[^>]*>/i);
			if (source) src = attrOf(source[0], 'src');
		}

		if (!src) return match;

		return `<span class="player" data-src="${esc(src)}">
  <button type="button" class="player-toggle" aria-pressed="false" aria-label="play audio">${playIcon}${pauseIcon}</button>
  <span class="player-main">
    <span class="player-track" aria-hidden="true"><span class="player-fill"></span></span>
    <span class="player-time"><span class="player-current">0:00</span> / <span class="player-duration">0:00</span></span>
  </span>
</span>`;
	});
}

/* ------------------------------------------------------------------
   load posts
   ------------------------------------------------------------------ */
async function loadPosts() {
	let files = [];
	try {
		files = (await readdir(postsDir)).filter((f) => f.endsWith('.md'));
	} catch {
		return [];
	}

	const posts = [];
	for (const file of files) {
		const full = path.join(postsDir, file);
		const raw = await readFile(full, 'utf8');
		const { data, body } = parseFrontMatter(raw);

		if (String(data.draft).toLowerCase() === 'true') continue;

		const base = path.basename(file, '.md');
		const fileDate = (base.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1];
		const mtime = (await stat(full)).mtime.toISOString().slice(0, 10);

		const slug =
			(data.slug && slugify(data.slug)) ||
			slugify(base.replace(/^\d{4}-\d{2}-\d{2}-?/, '')) ||
			slugify(data.title || base);

		const html = audioPlayers(marked.parse(body));
		const date = isoDate(data.date) || isoDate(fileDate) || mtime;

		posts.push({
			slug,
			file,
			title: data.title || base,
			date,
			tags: Array.isArray(data.tags)
				? data.tags.map((t) => String(t).toLowerCase().replace(/\s+/g, '-'))
				: [],
			summary: data.summary || excerptOf(html),
			html,
			minutes: readingTime(html),
			media: mediaOf(html),
		});
	}

	posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.title.localeCompare(b.title)));

	const seen = new Set();
	for (const p of posts) {
		if (seen.has(p.slug)) console.warn(`! duplicate slug "${p.slug}" (${p.file})`);
		seen.add(p.slug);
	}

	return posts;
}

/* ------------------------------------------------------------------
   templates
   ------------------------------------------------------------------ */
const favicon =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23130104'/%3E%3Crect x='7' y='14' width='18' height='4' fill='%23d45a5e'/%3E%3C/svg%3E";

function layout({ title, description, body, canonical }) {
	const pageTitle = title ? `${esc(title)} — ${esc(site.title)}` : esc(site.title);
	const desc = esc(description || site.description);
	const url = canonical ? `${baseUrl}${canonical}` : `${baseUrl}/`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>html{background:#130104;color-scheme:dark}body{background:#130104;color:#d4be98}a{color:inherit}</style>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${pageTitle}</title>
<meta name="description" content="${desc}">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#130104">
<meta property="og:title" content="${pageTitle}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="${title ? 'article' : 'website'}">
<meta property="og:url" content="${url}">
<link rel="canonical" href="${url}">
<link rel="icon" href="${favicon}">
<link rel="alternate" type="application/rss+xml" title="${esc(site.title)}" href="/rss.xml">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main class="page">
${body}
</main>
<footer class="site-footer"><sub>of the flesh — made with raine © 2026</sub></footer>
${playerScript}
</body>
</html>
`;
}

const tagList = (tags) => tags.map((t) => esc(t)).join(', ');

const playIcon = `<svg class="i-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>`;
const pauseIcon = `<svg class="i-pause" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="2.5" width="3" height="11" fill="currentColor"/><rect x="9" y="2.5" width="3" height="11" fill="currentColor"/></svg>`;

/* every .player on a page — inside a post or in the timeline */
const playerScript = `<script>
(function () {
  var players = Array.prototype.slice.call(document.querySelectorAll('.player'));
  if (!players.length) return;

  function fmt(t) {
    if (!isFinite(t) || t < 0) return '0:00';
    var m = Math.floor(t / 60);
    var s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  players.forEach(function (p) {
    var audio = new Audio(p.getAttribute('data-src'));
    audio.preload = 'metadata';
    p._audio = audio;

    var btn = p.querySelector('.player-toggle');
    var track = p.querySelector('.player-track');
    var fill = p.querySelector('.player-fill');
    var cur = p.querySelector('.player-current');
    var dur = p.querySelector('.player-duration');

    function draw() {
      var d = audio.duration || 0;
      fill.style.width = d ? (audio.currentTime / d) * 100 + '%' : '0%';
      cur.textContent = fmt(audio.currentTime);
      if (d) dur.textContent = fmt(d);
    }

    function set(playing) {
      btn.setAttribute('aria-pressed', String(playing));
      btn.setAttribute('aria-label', playing ? 'pause audio' : 'play audio');
    }

    btn.addEventListener('click', function () {
      if (audio.paused) {
        players.forEach(function (other) {
          if (other !== p && other._audio && !other._audio.paused) other._audio.pause();
        });
        audio.play();
      } else {
        audio.pause();
      }
    });

    track.addEventListener('click', function (e) {
      var r = track.getBoundingClientRect();
      var part = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      if (audio.duration) {
        audio.currentTime = part * audio.duration;
        draw();
      }
    });

    audio.addEventListener('loadedmetadata', draw);
    audio.addEventListener('timeupdate', draw);
    audio.addEventListener('play', function () { set(true); });
    audio.addEventListener('pause', function () { set(false); });
    audio.addEventListener('ended', function () { set(false); audio.currentTime = 0; draw(); });
  });
})();
</script>`;

function indexPage(posts) {
	const counts = new Map();
	for (const p of posts) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);

	const tags = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));

	const filters = ['all', ...tags]
		.map(
			(t) =>
				`<button type="button" data-filter="${esc(t)}" aria-pressed="${t === 'all'}">${esc(t)}${
					t === 'all' ? '' : ` <span class="count">${counts.get(t)}</span>`
				}</button>`
		)
		.join('\n      ');

	const items = posts
		.map((p) => {
			const m = p.media;

			let thumb = '';
			if (m?.kind === 'image' && m.image) {
				thumb = `<img class="thumb" src="${esc(m.image)}" alt="" loading="lazy">`;
			} else if (m?.kind === 'video') {
				thumb = m.poster
					? `<span class="thumb-wrap"><img class="thumb" src="${esc(m.poster)}" alt="" loading="lazy"><span class="play-glyph">${playIcon}</span></span>`
					: `<span class="thumb thumb-empty"><span class="play-glyph">${playIcon}</span></span>`;
			}

			const media = thumb ? `<span class="post-media">${thumb}</span>` : '';

			const player = m?.audio
				? `<span class="player player-mini post-player" data-src="${esc(m.audio)}">
        <button type="button" class="player-toggle" aria-pressed="false" aria-label="play audio">${playIcon}${pauseIcon}</button>
        <span class="player-main">
          <span class="player-track" aria-hidden="true"><span class="player-fill"></span></span>
          <span class="player-time"><span class="player-current">0:00</span> / <span class="player-duration">0:00</span></span>
        </span>
      </span>`
				: '';

			return `    <li class="post${thumb ? ' has-media' : ''}" data-tags="${esc(p.tags.join(' '))}">
      <a class="post-link" href="/posts/${esc(p.slug)}/">
        ${media}
        <span class="post-body">
          <span class="post-title">${esc(p.title)}</span>
          <span class="post-excerpt">${esc(p.summary)}</span>
          ${p.tags.length ? `<span class="post-tags">${tagList(p.tags)}</span>` : ''}
        </span>
        <time datetime="${esc(p.date)}">${esc(p.date)}</time>
      </a>
      ${player}
    </li>`;
		})
		.join('\n');

	return layout({
		title: '',
		canonical: '/',
		body: `  <header class="masthead">
    <h1><a href="/">${esc(site.title)}</a></h1>
  </header>

  <div class="feed-bar">
    <button type="button" class="filter-toggle" aria-expanded="false" aria-controls="filters" aria-label="filter posts">filter</button>
  </div>

  <nav class="filters" id="filters" aria-label="filter posts by tag" hidden>
      ${filters}
  </nav>

  <ol class="timeline">
${items}
  </ol>

  <p class="empty" hidden>nothing tagged that yet.</p>

  <script>
  (function () {
    var toggle = document.querySelector('.filter-toggle');
    var panel = document.getElementById('filters');
    var buttons = Array.prototype.slice.call(panel.querySelectorAll('button'));
    var posts = Array.prototype.slice.call(document.querySelectorAll('.timeline .post'));
    var empty = document.querySelector('.empty');

    function open(show) {
      panel.hidden = !show;
      toggle.setAttribute('aria-expanded', String(show));
    }

    function apply(filter) {
      var shown = 0;
      posts.forEach(function (post) {
        var tags = (post.getAttribute('data-tags') || '').split(' ');
        var match = filter === 'all' || tags.indexOf(filter) !== -1;
        post.hidden = !match;
        if (match) shown++;
      });
      buttons.forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-filter') === filter));
      });
      toggle.textContent = filter === 'all' ? 'filter' : filter;
      toggle.setAttribute('aria-label', filter === 'all' ? 'filter posts' : 'filter posts, showing ' + filter);
      if (empty) empty.hidden = shown !== 0;
      if (window.history && history.replaceState) {
        history.replaceState(null, '', filter === 'all' ? location.pathname : location.pathname + '#tag=' + encodeURIComponent(filter));
      }
    }

    toggle.addEventListener('click', function () { open(panel.hidden); });

    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        apply(b.getAttribute('data-filter'));
        open(false);
      });
    });

    document.addEventListener('click', function (e) {
      if (!panel.hidden && !panel.contains(e.target) && !toggle.contains(e.target)) open(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) {
        open(false);
        toggle.focus();
      }
    });

    var m = location.hash.match(/^#tag=(.+)$/);
    if (m) apply(decodeURIComponent(m[1]));
  })();
  </script>`,
	});
}

function postPage(p) {
	return layout({
		title: p.title,
		description: p.summary,
		canonical: `/posts/${p.slug}/`,
		body: `  <article class="post-page">
    <header class="post-header">
      <p class="post-meta"><time datetime="${esc(p.date)}">${esc(p.date)}</time> · ${p.minutes} min read${
				p.tags.length ? ` · <span class="post-tags">${tagList(p.tags)}</span>` : ''
			}</p>
      <h1>${esc(p.title)}</h1>
    </header>

    <div class="prose">
${p.html}
    </div>

    <p class="back"><a href="/">← all posts</a></p>
  </article>`,
	});
}

function rss(posts) {
	const items = posts
		.map(
			(p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${baseUrl}/posts/${esc(p.slug)}/</link>
      <guid isPermaLink="true">${baseUrl}/posts/${esc(p.slug)}/</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <description>${esc(p.summary)}</description>
    </item>`
		)
		.join('\n');

	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(site.title)}</title>
    <link>${baseUrl}/</link>
    <description>${esc(site.description)}</description>
    <language>en</language>
    <lastBuildDate>${rfc822(posts[0]?.date)}</lastBuildDate>
    <atom:link href="${baseUrl}/rss.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

function sitemap(posts) {
	const urls = [
		`  <url><loc>${baseUrl}/</loc>${posts[0] ? `<lastmod>${posts[0].date}</lastmod>` : ''}</url>`,
		...posts.map((p) => `  <url><loc>${baseUrl}/posts/${esc(p.slug)}/</loc><lastmod>${p.date}</lastmod></url>`),
	].join('\n');

	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

function notFound() {
	return layout({
		title: 'not found',
		canonical: '/404.html',
		body: `  <header class="masthead">
    <h1><a href="/">${esc(site.title)}</a></h1>
  </header>
  <p>this page isn't here.</p>
  <p class="back"><a href="/">← back to everything</a></p>`,
	});
}

/* ------------------------------------------------------------------
   build
   ------------------------------------------------------------------ */
const posts = await loadPosts();

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

try {
	await cp(publicDir, outDir, { recursive: true });
} catch (err) {
	if (err.code !== 'ENOENT') throw err;
}

await writeFile(path.join(outDir, 'index.html'), indexPage(posts));
await writeFile(path.join(outDir, 'rss.xml'), rss(posts));
await writeFile(path.join(outDir, 'sitemap.xml'), sitemap(posts));
await writeFile(path.join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`);
await writeFile(path.join(outDir, '404.html'), notFound());

for (const p of posts) {
	const dir = path.join(outDir, 'posts', p.slug);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, 'index.html'), postPage(p));
}

console.log(`${posts.length} post${posts.length === 1 ? '' : 's'} -> dist/`);
for (const p of posts) console.log(`  ${p.date}  /posts/${p.slug}/  ${p.title}`);
