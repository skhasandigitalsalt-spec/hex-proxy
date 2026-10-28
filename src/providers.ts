import {
  FIRST_CHUNK_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  OVERALL_DEADLINE_MS,
  PROVIDERS,
  SYSTEM_PROMPT,
} from './config';
import type { ChatRequest, Env, ProviderConfig } from './types';

export interface UpstreamStart {
  providerId: string;
  controller: AbortController;
  body: ReadableStream<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  firstChunk: Uint8Array;
}

export interface ProviderChainResult {
  started?: UpstreamStart;
  attempts: string[];
}

type AttemptOutcome = { start: UpstreamStart } | { failure: string };

export function selectProviders(hasImage: boolean): readonly ProviderConfig[] {
  return hasImage ? PROVIDERS.filter((provider) => provider.supportsImages) : PROVIDERS;
}

export function buildMessagesJson(chat: ChatRequest): string {
  const upstreamMessages: Array<{ role: string; content: unknown }> = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...chat.messages.map((message) => ({ role: message.role, content: message.content as unknown })),
  ];

  const last = upstreamMessages[upstreamMessages.length - 1];
  if (chat.image && last) {
    last.content = [
      { type: 'text', text: last.content },
      { type: 'image_url', image_url: { url: `data:${chat.image.mimeType};base64,${chat.image.data}` } },
    ];
  }
  return JSON.stringify(upstreamMessages);
}

function buildRequestBody(provider: ProviderConfig, messagesJson: string): string {
  const rest = {
    model: provider.model,
    stream: true,
    [provider.maxTokensField]: MAX_OUTPUT_TOKENS,
    ...provider.extraBody,
  };
  return `{"messages":${messagesJson},${JSON.stringify(rest).slice(1)}`;
}

function chatCompletionsUrl(provider: ProviderConfig): string {
  return `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

async function attemptProvider(
  provider: ProviderConfig,
  apiKey: string,
  messagesJson: string,
  timeoutMs: number,
  clientSignal: AbortSignal,
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  const abortOnClientGone = () => controller.abort();
  clientSignal.addEventListener('abort', abortOnClientGone, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(chatCompletionsUrl(provider), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: buildRequestBody(provider, messagesJson),
      signal: controller.signal,
    });

    if (!response.ok) {
      controller.abort();
      return { failure: `status_${response.status}` };
    }
    if (!response.body) {
      controller.abort();
      return { failure: 'empty_body' };
    }

    const reader = response.body.getReader();
    let first = await reader.read();
    while (!first.done && first.value.byteLength === 0) first = await reader.read();
    if (first.done) {
      controller.abort();
      return { failure: 'empty_body' };
    }

    return {
      start: {
        providerId: provider.id,
        controller,
        body: response.body,
        reader,
        firstChunk: first.value,
      },
    };
  } catch {
    controller.abort();
    if (timedOut) return { failure: 'timeout' };
    return { failure: clientSignal.aborted ? 'client_gone' : 'network_error' };
  } finally {
    clearTimeout(timer);
    clientSignal.removeEventListener('abort', abortOnClientGone);
  }
}

export async function startFirstAvailable(
  env: Env,
  providers: readonly ProviderConfig[],
  messagesJson: string,
  requestStartedAt: number,
  clientSignal: AbortSignal,
): Promise<ProviderChainResult> {
  const deadlineAt = requestStartedAt + OVERALL_DEADLINE_MS;
  const attempts: string[] = [];

  for (const provider of providers) {
    if (clientSignal.aborted) {
      attempts.push(`${provider.id}:client_gone`);
      break;
    }

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      attempts.push(`${provider.id}:deadline`);
      break;
    }

    const apiKey = env[provider.apiKeyEnvName];
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      attempts.push(`${provider.id}:missing_key`);
      continue;
    }

    const outcome = await attemptProvider(
      provider,
      apiKey,
      messagesJson,
      Math.min(FIRST_CHUNK_TIMEOUT_MS, remainingMs),
      clientSignal,
    );
    if ('start' in outcome) {
      attempts.push(`${provider.id}:ok`);
      return { started: outcome.start, attempts };
    }
    attempts.push(`${provider.id}:${outcome.failure}`);
  }

  return { attempts };
}
