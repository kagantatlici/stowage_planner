import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const port = process.env.PORT ? Number(process.env.PORT) : 5173;

const mime = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.mjs': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=UTF-8',
  '.map': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  let filePath = path.join(root, urlPath);

  // API: save current tank config to a JSON file in project root
  if (req.method === 'POST' && urlPath === '/api/save-config') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        // simple safeguard
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const tanks = Array.isArray(data.tanks) ? data.tanks : null;
        if (!tanks) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: 'missing tanks[]' }));
          return;
        }
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth()+1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const fallback = `ships_export_${y}-${m}-${d}.json`;
        const name = (data && typeof data.name === 'string') ? data.name : null;
        let filename = (data && typeof data.filename === 'string' && /^(?:[\w.-])+\.json$/.test(data.filename)) ? data.filename : fallback;
        // enforce basename only
        filename = path.basename(filename);
        const outPath = path.join(root, filename);
        // sanitize tank entries
        const outTanks = tanks.map(t => ({
          id: t.id,
          volume_m3: t.volume_m3,
          min_pct: t.min_pct,
          max_pct: t.max_pct,
          included: t.included,
          side: t.side
        }));
        const payload = { saved_at: now.toISOString(), name, tanks: outTanks };
        fs.writeFile(outPath, JSON.stringify(payload, null, 2), (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true, filename }));
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
      }
    });
    return; // handled
  }

  // Default to index.html for root or directories
  if (urlPath === '/' || urlPath.endsWith('/')) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!path.extname(filePath)) {
    filePath += '.html';
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = mime[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(port, () => {
  console.log(`Dev server running at http://localhost:${port}`);
});
