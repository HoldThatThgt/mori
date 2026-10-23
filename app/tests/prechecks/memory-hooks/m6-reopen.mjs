// M6 follow-up: what a reopened session file restores (read-only SessionManager.open).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pi, PROBES } from './lib.mjs';
const dir = join(PROBES, 'sessions', 'm6-none');
const file = join(dir, readdirSync(dir)[0]);
const ctx = pi.SessionManager.open(file).buildSessionContext();
console.log(JSON.stringify({ thinkingLevel: ctx.thinkingLevel, model: ctx.model }, null, 2));
