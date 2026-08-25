import { readFileSync } from 'node:fs';
import path from 'node:path';
const p = path.join(process.cwd(), 'data', 'ledger.json');
const j = JSON.parse(readFileSync(p, 'utf8'));
const entries = Array.isArray(j) ? j : (j && Array.isArray(j.entries) ? j.entries : []);
console.log('records:', entries.length);
if (entries.length) console.log('first title:', entries[0].title, '| in=', entries[0].usage?.inputTokens);