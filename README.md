# of the flesh

a small handmade blog. markdown in, static pages out. no framework.

## writing a post

make a file in `posts/`, e.g. `posts/2026-11-20-something.md`:

```markdown
---
title: something i made
date: 2026-11-20
tags: code, notes
summary: optional one-liner for the timeline
---

the post, in normal markdown.
```

only `title` and `date` really matter. `tags` become the filter options on the
front page. `summary` is optional — if you leave it out, the first ~180
characters of the post are used. add `draft: true` to hide a post.

the first image or video in a post becomes its timeline thumbnail; a video
thumbnail opens the post. audio gets the same play button in the timeline and
inside the post. to give a video a thumbnail, add
`poster="/media/name.jpg"` to the `<video>` tag.

if a file starts with `YYYY-MM-DD-`, that date is used when `date` is missing.

## previewing

just run:

```
./launch.sh
```

it installs anything missing, opens <http://localhost:4321> in your browser,
and rebuilds whenever you save a file. hit Ctrl+C to stop.

or, without the browser:

```
npm install
npm run dev
```

just build once with:

```
npm run build
```

output lands in `dist/`.

## deploying

on cloudflare pages:

- build command: `npm run build`
- output directory: `dist`

set `SITE_URL` in the pages environment if you want the feed and sitemap to use
your real domain, otherwise it uses the url in `build.mjs`.

## files

```
build.mjs        the whole generator
serve.mjs        local preview server
posts/*.md       your writing
public/          style.css, fonts and media, copied into dist as-is
public/media/    images and audio used by posts
dist/            generated, not committed
```

colours live at the top of `public/style.css` as variables.
