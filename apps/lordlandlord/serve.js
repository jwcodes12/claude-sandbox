import express from 'express';
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

app.listen(PORT, HOST, () => {
    console.log(`\n🏰 LORD LANDLORD — LOCAL REALM`);
    console.log(`================================`);
    console.log(`Server running at: http://${HOST}:${PORT}/`);
    console.log(`Press Ctrl+C to abandon the realm.`);
});
