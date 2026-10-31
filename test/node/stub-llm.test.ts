import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStub } from '../../scripts/stub-llm.ts';

describe('test 6: stub-llm through the real SDK', () => {
  let close: () => void;
  let client: Anthropic;
  beforeAll(async () => {
    const s = await startStub();
    close = () => s.close();
    client = new Anthropic({ apiKey: 'stub', baseURL: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, maxRetries: 0 });
  });
  afterAll(() => close());

  const req = (who: string, required: string[]) => ({ model: 'claude-sonnet-5-5', max_tokens: 100,
    messages: [{ role: 'user' as const, content: who }],
    output_config: { format: { type: 'json_schema' as const, schema: { type: 'object', required } } } });

  it('answers count_tokens', async () => {
    const r = await client.messages.countTokens({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hello' }] });
    expect(r.input_tokens).toBeGreaterThan(0);
  });
  it('answers messages for both parts', async () => {
    const m = await client.messages.create(req('fx-both', ['email', 'landing_page']));
    const b = m.content[0];
    expect(b.type === 'text' && Object.keys(JSON.parse(b.text))).toEqual(['email', 'landing_page']);
    expect(m.usage.output_tokens).toBeGreaterThan(0);
  });
  it('fx-retry differs between attempts', async () => {
    const a = await client.messages.create(req('fx-retry', ['email', 'landing_page']));
    const b = await client.messages.create(req('fx-retry', ['email', 'landing_page']));
    expect(a.content).not.toEqual(b.content);
  });
  it('fx-refuse stops with refusal', async () => {
    const m = await client.messages.create(req('fx-refuse', ['email']));
    expect(m.stop_reason).toBe('refusal');
  });
});
