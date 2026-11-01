// The one dir loader, node only: role.md, voice-card.md, email.md, landing-v2.md, task.md, retry.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PromptFiles } from '../src/contracts/types.ts';
import { lf } from '../src/lib/gen/canonical.ts';

/** The version batch, draft-one, preview and readiness build from. `config seed` activates the highest, so it must be this one or /api/runs refuses the preview. */
export const PROMPT_ID = 'v2', PROMPT_DIR = `config/prompt/${PROMPT_ID}`;

export function readPromptDir(dir: string): PromptFiles {
  const read = (f: string) => lf(readFileSync(join(dir, f), 'utf8'));
  return { role: read('role.md'), voice_card: read('voice-card.md'), email: read('email.md'), landing: read('landing-v2.md'),
    task: read('task.md'), retry: read('retry.md') };
}
