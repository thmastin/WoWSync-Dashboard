// Minimal OpenAI Chat Completions client for the "Ask My Account" POC.
// Deliberately not an SDK dependency - one fetch() call, using Node's
// built-in fetch and AbortSignal.timeout. No retries, no streaming, no
// tool calling, no conversation state.
import { ASK_MY_ACCOUNT_SYSTEM_PROMPT } from "./systemPrompt.ts";
import { buildLlmContext, type AccountContext } from "@wowsync-dashboard/core";

export const DEFAULT_MODEL = "gpt-4o-mini";
export const MAX_QUESTION_LENGTH = 2000;
const REQUEST_TIMEOUT_MS = 45_000;

// Overridable so tests can point this at a local mock server instead of
// the real OpenAI API (no live credentials, no network, no mocking
// global fetch — a real HTTP request to a real local listener). Also
// happens to be a legitimate real-world escape hatch for Azure OpenAI /
// OpenAI-compatible proxies, matching the official SDK's own convention.
function chatCompletionsUrl(): string {
  const base = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  return `${base.replace(/\/+$/, "")}/chat/completions`;
}

/** A safe-to-return-to-the-browser error: `publicMessage` never contains the raw provider response, API key, or a stack trace. */
export class AskError extends Error {
  readonly status: number;
  readonly publicMessage: string;
  constructor(publicMessage: string, status: number) {
    super(publicMessage);
    this.name = "AskError";
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

export interface AskUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AskResult {
  answer: string;
  model: string;
  contextGeneratedAt: number;
  usage?: AskUsage;
}

function buildUserMessage(context: AccountContext, question: string): string {
  // Project the canonical AccountContext down to the compact, per-character
  // atomic LlmContext immediately before serializing - the model never sees
  // the full AccountContext (redundant historical transitions, the full
  // current-inventory-by-item aggregate, full trainer detail). This is the
  // one and only place that projection happens; GET /api/account-context
  // and every other consumer keep reading the canonical document untouched.
  const llmContext = buildLlmContext(context);
  return `ACCOUNT CONTEXT:\n${JSON.stringify(llmContext)}\n\nUSER QUESTION:\n${question}`;
}

export async function askOpenAI(
  question: string,
  context: AccountContext,
  opts: { apiKey: string; model: string },
): Promise<AskResult> {
  let res: Response;
  try {
    res = await fetch(chatCompletionsUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: ASK_MY_ACCOUNT_SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(context, question) },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new AskError("The request to the LLM provider timed out. Try again.", 504);
    }
    throw new AskError("Could not reach the LLM provider. Check your network connection and try again.", 502);
  }

  if (!res.ok) {
    // Never forward the raw provider response body to the browser or logs
    // - it can echo request content back on some error paths.
    if (res.status === 401 || res.status === 403) {
      throw new AskError("The configured OPENAI_API_KEY was rejected by the provider. Check the server's environment configuration.", 500);
    }
    if (res.status === 429) {
      throw new AskError("The LLM provider is rate-limiting requests right now. Wait a moment and try again.", 429);
    }
    if (res.status >= 500) {
      throw new AskError("The LLM provider is currently unavailable. Try again shortly.", 502);
    }
    throw new AskError(`The LLM provider rejected the request (HTTP ${res.status}).`, 502);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new AskError("The LLM provider returned a response that could not be parsed.", 502);
  }

  const answer = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || answer.trim().length === 0) {
    throw new AskError("The LLM provider returned an empty or malformed answer.", 502);
  }

  const rawUsage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } })?.usage;
  const usage: AskUsage | undefined = rawUsage
    ? { promptTokens: rawUsage.prompt_tokens, completionTokens: rawUsage.completion_tokens, totalTokens: rawUsage.total_tokens }
    : undefined;

  return { answer, model: opts.model, contextGeneratedAt: context.generatedAt, usage };
}
