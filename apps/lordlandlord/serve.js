import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 18180;

app.use(express.static(path.join(__dirname, 'src')));

app.listen(PORT, '127.0.0.1', () => {
    console.log(`\n🏰 LORD LANDLORD — LOCAL REALM`);
    console.log(`================================`);
    console.log(`Server running at: http://localhost:${PORT}/`);
    console.log(`Press Ctrl+C to abandon the realm.`);
});
