/** Provider-neutral shapes. The application owns these; each provider adapter translates to and from its own API. */
export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type AssistantBlock = TextBlock | ToolUseBlock;
export type Message =
  | { role: 'user'; content: string | (TextBlock | ToolResultBlock)[] }
  | { role: 'assistant'; content: AssistantBlock[] };

export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }

export interface LlmRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  signal: AbortSignal;
  /** Correlates this call with our logs and audit trail (also sent to the provider as metadata where supported). */
  requestId: string;
}
export interface LlmResponse {
  content: AssistantBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** A failure from the model layer, already safe to show. `transient` = worth telling the user to try again. */
export class LlmError extends Error {
  constructor(message: string, public readonly kind: 'timeout' | 'unavailable' | 'rejected' | 'cancelled', public readonly transient = true) { super(message); this.name = 'LlmError'; }
}

export interface Ref { type: string; id: string; label: string }
