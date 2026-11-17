/**
 * A conversation with a person's own model (docs/platform.md, "Your own
 * model"), over one of the two ways models are reached:
 *
 * - "openai": OpenAI's chat completions, which most services answer
 *   (DeepSeek, OpenAI, Kimi, Qwen, OpenRouter and others). One POST with
 *   fetch; the assistant's message is sent back as it came, as OpenAI's own
 *   guide does it.
 * - "anthropic": Claude, through Anthropic's own SDK, streamed and collected
 *   with `finalMessage()`, and the assistant's content sent back unchanged,
 *   thinking included.
 *
 * Each step is one request; the chat (chat.ts) runs the tools and hands the
 * outcomes back.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ModelProtocol } from "@hearth/shared";

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; input: unknown };
export type ToolOutcome = { id: string; content: string; isError: boolean };

/** What one request to the model gave: tools to run, or an answer, or why there is none. */
export type Step =
  | { kind: "tools"; text: string; calls: ToolCall[] }
  | { kind: "done"; text: string }
  | { kind: "declined"; text: string }
  | { kind: "truncated"; text: string };

export interface Conversation {
  step(signal: AbortSignal): Promise<Step>;
  /** Hands the model what its tools gave, one outcome for every call of the last step. */
  answer(outcomes: readonly ToolOutcome[]): void;
}

/** The model could not be asked, or did not take the key. The message is for the person, in English. */
export class ModelCallError extends Error {
  readonly kind: "refused_key" | "failed";
  constructor(kind: "refused_key" | "failed", message: string) {
    super(message);
    this.name = "ModelCallError";
    this.kind = kind;
  }
}

export type ConversationOptions = {
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  system: string;
  history: readonly ChatMessage[];
  tools: readonly ToolSpec[];
  /** For tests: the fetch every request goes through. */
  fetch?: typeof fetch;
};

/** Most output a step may have: room for an app's whole page in one tool call. */
const MAX_OUTPUT_TOKENS = 16_000;

export function openConversation(options: ConversationOptions): Conversation {
  // Earlier turns as text. A message with nothing in it is left out: some models refuse one.
  const history = options.history.filter((message) => message.content.trim() !== "");
  return options.protocol === "anthropic"
    ? anthropicConversation({ ...options, history })
    : openAiConversation({ ...options, history });
}

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

function openAiConversation(options: ConversationOptions): Conversation {
  const messages: unknown[] = [
    { role: "system", content: options.system },
    ...options.history.map((message) => ({ role: message.role, content: message.content })),
  ];
  const tools = options.tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
  const send = options.fetch ?? fetch;

  return {
    async step(signal) {
      let response: Response;
      try {
        response = await send(`${options.baseUrl}/chat/completions`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({ model: options.model, messages, tools, tool_choice: "auto" }),
        });
      } catch (error) {
        if (isAbort(error)) throw error;
        throw new ModelCallError("failed", `The model could not be reached (${error instanceof Error ? error.message : String(error)}).`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new ModelCallError("refused_key", `The model did not take the key (status ${response.status}).`);
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        throw new ModelCallError("failed", `The model answered with status ${response.status}${detail ? `: ${detail}` : "."}`);
      }
      const body = (await response.json().catch(() => null)) as {
        choices?: { finish_reason?: string; message?: { content?: unknown; tool_calls?: unknown } }[];
      } | null;
      const choice = body?.choices?.[0];
      const message = choice?.message;
      if (!choice || !message) throw new ModelCallError("failed", "The model's answer held no message.");
      messages.push(message);

      const text = typeof message.content === "string" ? message.content : "";
      const calls: ToolCall[] = [];
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const { id, function: fn } = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
        if (typeof id !== "string" || typeof fn?.name !== "string") continue;
        let input: unknown = fn.arguments;
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {
            // Left as the text it was: the tool's schema refuses it, and the model is told why.
          }
        }
        calls.push({ id, name: fn.name, input });
      }
      if (calls.length > 0) return { kind: "tools", text, calls };
      if (choice.finish_reason === "content_filter") return { kind: "declined", text };
      if (choice.finish_reason === "length") return { kind: "truncated", text };
      return { kind: "done", text };
    },
    answer(outcomes) {
      for (const outcome of outcomes) messages.push({ role: "tool", tool_call_id: outcome.id, content: outcome.content });
    },
  };
}

function anthropicConversation(options: ConversationOptions): Conversation {
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    maxRetries: 2,
    timeout: 10 * 60_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const messages: Anthropic.MessageParam[] = options.history.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const tools: Anthropic.Tool[] = options.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));

  return {
    async step(signal) {
      let message: Anthropic.Message;
      try {
        message = await client.messages
          .stream({ model: options.model, max_tokens: MAX_OUTPUT_TOKENS, system: options.system, messages, tools }, { signal })
          .finalMessage();
      } catch (error) {
        if (error instanceof Anthropic.APIUserAbortError || isAbort(error)) throw error;
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
          throw new ModelCallError("refused_key", `The model did not take the key (status ${error.status}).`);
        }
        if (error instanceof Anthropic.APIError) {
          const status = error.status === undefined ? "" : ` with status ${error.status}`;
          throw new ModelCallError("failed", `The model answered${status}: ${error.message.slice(0, 300)}`);
        }
        throw new ModelCallError("failed", `The model could not be asked (${error instanceof Error ? error.message : String(error)}).`);
      }

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      // A refusal can cut a tool call off half-way: its tools are never run.
      if (message.stop_reason === "refusal") return { kind: "declined", text };
      const uses = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
      if (uses.length === 0) return message.stop_reason === "max_tokens" ? { kind: "truncated", text } : { kind: "done", text };
      // A tool call cut off at the limit can look whole: never run one.
      if (message.stop_reason === "max_tokens") return { kind: "truncated", text };
      messages.push({ role: "assistant", content: message.content });
      return { kind: "tools", text, calls: uses.map((use) => ({ id: use.id, name: use.name, input: use.input })) };
    },
    answer(outcomes) {
      messages.push({
        role: "user",
        content: outcomes.map((outcome) => ({
          type: "tool_result" as const,
          tool_use_id: outcome.id,
          content: outcome.content,
          ...(outcome.isError ? { is_error: true } : {}),
        })),
      });
    },
  };
}
