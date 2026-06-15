import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFromRoot } from './paths.js';

const publicDir = resolveFromRoot('public');
const port = Number(process.env.PORT ?? 4173);

const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);

http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, `http://localhost:${port}`).pathname);
  const filePath = path.normalize(path.join(publicDir, pathname === '/' ? 'index.html' : pathname));
  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'content-type': types.get(path.extname(filePath)) ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    response.end(data);
  });
}).listen(port, () => {
  console.log(`Tech Radar dev server: http://localhost:${port}`);
});
