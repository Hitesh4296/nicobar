import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { notBuilt } from '../contracts/codes.ts';
import type { AppEnv } from '../contracts/types.ts';

export class RunWorkflow extends WorkflowEntrypoint<AppEnv, { run_id: string }> {
  override async run(event: WorkflowEvent<{ run_id: string }>, step: WorkflowStep): Promise<void> {
    await step.do('not-built', async () => notBuilt('RunWorkflow'));
  }
}
