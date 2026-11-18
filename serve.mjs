#!/usr/bin/env node
/* local preview — rebuilds when posts/ or public/ change */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream, watch } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const port = Number(process.env.PORT) || 4321;

const types = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.ttf': 'font/ttf',
	'.ico': 'image/x-icon',
};

function build() {
	return new Promise((resolve) => {
		const p = spawn(process.execPath, ['build.mjs'], { stdio: 'inherit' });
		p.on('exit', (code) => resolve(code === 0));
	});
}

let timer = null;
function rebuild() {
	clearTimeout(timer);
	timer = setTimeout(() => build(), 120);
}

await build();

const server = http.createServer(async (req, res) => {
	try {
		const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
		let file = path.join(dist, url);

		if (!file.startsWith(dist)) {
			res.writeHead(403).end('forbidden');
			return;
		}

		let info = await stat(file).catch(() => null);
		if (info?.isDirectory()) {
			file = path.join(file, 'index.html');
			info = await stat(file).catch(() => null);
		}

		if (!info) {
			res.writeHead(404, { 'content-type': types['.html'] });
			res.end(await readFile(path.join(dist, '404.html')).catch(() => 'not found'));
			return;
		}

		const type = types[path.extname(file)] || 'application/octet-stream';
		const range = req.headers.range;

		if (range) {
			const m = range.match(/bytes=(\d*)-(\d*)/);
			if (!m) {
				res.writeHead(416).end();
				return;
			}

			const start = m[1] ? Number(m[1]) : 0;
			const end = m[2] ? Number(m[2]) : info.size - 1;

			if (start >= info.size || end >= info.size || start > end) {
				res.writeHead(416, { 'content-range': `bytes */${info.size}` }).end();
				return;
			}

			res.writeHead(206, {
				'content-type': type,
				'content-length': end - start + 1,
				'content-range': `bytes ${start}-${end}/${info.size}`,
				'accept-ranges': 'bytes',
				'cache-control': 'no-cache',
			});
			createReadStream(file, { start, end }).pipe(res);
			return;
		}

		res.writeHead(200, {
			'content-type': type,
			'content-length': info.size,
			'accept-ranges': 'bytes',
			'cache-control': 'no-cache',
		});
		res.end(await readFile(file));
	} catch (err) {
		res.writeHead(500).end(String(err));
	}
});

server.listen(port, '127.0.0.1', () => {
	console.log(`\n  of the flesh — http://localhost:${port}\n`);
});

for (const dir of ['posts', 'public']) {
	watch(path.join(root, dir), { recursive: true }, rebuild);
}
watch(path.join(root, 'build.mjs'), rebuild);
