import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.LL_HTTP_PORT) || 18180;
// Default loopback-only; set LL_HTTP_HOST (e.g. the box's tailscale IP) to
// serve other devices on the tailnet for real-device testing.
const HOST = process.env.LL_HTTP_HOST || '127.0.0.1';

app.use(express.static(path.join(__dirname, 'src')));

// ---- player feedback (write-only) ------------------------------------------
// Appends one JSON line per submission to var/feedback.jsonl. No reads are
// served; check it on the box: tail var/feedback.jsonl
const FEEDBACK_FILE = path.join(__dirname, 'var', 'feedback.jsonl');
const feedbackHits = new Map();   // ip -> [timestamps], naive rate limit
app.use(express.json({ limit: '4kb' }));
app.post('/feedback', (req, res) => {
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';
    const now = Date.now();
    const hits = (feedbackHits.get(ip) || []).filter(t => now - t < 60000);
    if (hits.length >= 5) return res.status(429).json({ ok: false });
    hits.push(now);
    feedbackHits.set(ip, hits);

    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 2000) : '';
    if (!text) return res.status(400).json({ ok: false });
    const entry = {
        ts: new Date().toISOString(),
        text,
        name: typeof req.body?.name === 'string' ? req.body.name.slice(0, 32) : null,
        room: typeof req.body?.room === 'string' ? req.body.room.slice(0, 16) : null,
        ua: String(req.headers['user-agent'] || '').slice(0, 160),
    };
    try {
        fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
        fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n');
        res.json({ ok: true });
    } catch (e) {
        console.error('feedback write failed:', e.message);
        res.status(500).json({ ok: false });
    }
});

app.listen(PORT, HOST, () => {
    console.log(`\n🏰 LORD LANDLORD — LOCAL REALM`);
    console.log(`================================`);
    console.log(`Server running at: http://${HOST}:${PORT}/`);
    console.log(`Press Ctrl+C to abandon the realm.`);
});
