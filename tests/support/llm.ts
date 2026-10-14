import type { AssistantBlock, LlmProvider, LlmRequest, LlmResponse } from '../../src/ai/types.js';

export type Step = (req: LlmRequest, n: number) => LlmResponse | Promise<LlmResponse>;

/** A model whose every reply is written by the test, so hostile or broken model behaviour can be replayed exactly. */
export class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-1';
  calls: LlmRequest[] = [];
  constructor(private steps: Step[], private loopLast = false) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const n = this.calls.length - 1;
    const step = this.steps[Math.min(n, this.steps.length - 1)];
    if (!step || (n >= this.steps.length && !this.loopLast)) return say('(script finished)');
    return step(req, n);
  }
}

const usage = (i = 100, o = 50) => ({ inputTokens: i, outputTokens: o });
export const say = (text: string, u = usage()): LlmResponse => ({ content: [{ type: 'text', text }], stopReason: 'end_turn', usage: u, model: 'scripted-1' });
export const use = (calls: { name: string; input: unknown; id?: string }[] | { name: string; input: unknown; id?: string }, u = usage()): LlmResponse => ({
  content: ([] as { name: string; input: unknown; id?: string }[]).concat(calls).map((c, i): AssistantBlock => ({ type: 'tool_use', id: c.id ?? `toolu_${i}_${Math.random().toString(36).slice(2, 8)}`, name: c.name, input: c.input })),
  stopReason: 'tool_use', usage: u, model: 'scripted-1',
});
/** Text of the most recent tool results the app sent back to the model. */
export const lastToolResults = (req: LlmRequest): string[] => {
  const m = [...req.messages].reverse().find((x) => x.role === 'user' && Array.isArray(x.content));
  return m && Array.isArray(m.content) ? m.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : [])) : [];
};

/** Lets one running app use a different model per test. */
export class SwitchLlm implements LlmProvider {
  readonly name = 'switch';
  get model() { return this.delegate.model; }
  constructor(public delegate: LlmProvider) {}
  complete(req: LlmRequest) { return this.delegate.complete(req); }
}
