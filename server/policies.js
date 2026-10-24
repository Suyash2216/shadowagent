import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const POLICY_DIR = process.env.SHADOWAGENT_POLICY_DIR ?? path.join(ROOT, 'policies');

export function loadPolicies() {
  const out = {};
  for (const side of ['red', 'blue']) {
    const file = path.join(POLICY_DIR, `${side}.json`);
    if (fs.existsSync(file)) out[side] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return out;
}

export function savePolicy(side, policy) {
  if (!['red', 'blue'].includes(side)) throw new Error(`unknown side ${side}`);
  if (!Array.isArray(policy?.weights)) throw new Error('policy.weights must be an array');
  fs.mkdirSync(POLICY_DIR, { recursive: true });
  fs.writeFileSync(path.join(POLICY_DIR, `${side}.json`), JSON.stringify(policy, null, 1));
}
