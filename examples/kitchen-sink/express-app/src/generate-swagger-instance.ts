import { writeFile } from 'node:fs/promises';
import { api } from './api.js';

// Headless: emit swagger.json with no mount() and no running server — the same
// configured instance the server uses. Handy for CI checks and client generation.
await writeFile('swagger.json', JSON.stringify(api.swagger(), null, 2));
console.log('Wrote swagger.json');
