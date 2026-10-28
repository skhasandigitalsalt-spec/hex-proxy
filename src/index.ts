import { authenticate } from './auth';
import { IMAGE_COST, TEXT_COST, resolveDailyCredits } from './config';
import { CreditLedger, nextResetIso, readCreditsUsed, spendCredits, utcDay, type CreditOutcome } from './credits';
import { buildMessagesJson, selectProviders, startFirstAvailable } from './providers';
import { createPassThroughResponse } from './stream';
import { HttpError, type ChatRequest, type Env, type RequestTrace } from './types';
import { assertContentLengthWithinLimit, parseChatRequest, readBodyBytes } from './validate';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function errorResponse(error: HttpError): Response {
  return jsonResponse(
    error.status,
    { error: { code: error.code, message: error.message, ...error.extra } },
    error.headers,
  );
}

function methodNotAllowed(allowed: string): HttpError {
  return new HttpError(405, 'method_not_allowed', 'Method not allowed.', {}, { Allow: allowed });
}

async function handleCredits(request: Request, env: Env): Promise<Response> {
  const user = await authenticate(request, env);
  const now = new Date();
  const limit = resolveDailyCredits(env);
  const used = await readCreditsUsed(env.DB, user.userId, utcDay(now));
  return jsonResponse(200, {
    credits_remaining: Math.max(limit - used, 0),
    daily_limit: limit,
    reset_at: nextResetIso(now),
  });
}

interface SpentRequest {
  creditsRemaining: number;
  resetAt: string;
}

function logEvent(event: string, trace: RequestTrace, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, request_id: trace.requestId, ...fields }));
}

async function serveSpentRequest(
  request: Request,
  env: Env,
  chat: ChatRequest,
  ledger: CreditLedger,
  trace: RequestTrace,
  requestStartedAt: number,
  spent: SpentRequest,
): Promise<Response> {
  const refundOnClientGone = () => {
    void ledger.refundOnce();
  };
  request.signal.addEventListener('abort', refundOnClientGone, { once: true });

  try {
    logEvent('spent', trace, { credits_cost: trace.creditsCost });

    if (request.signal.aborted) {
      trace.errorCode = 'client_disconnected';
      await ledger.refundOnce();
      throw new HttpError(503, 'providers_unavailable', 'The request was cancelled.');
    }

    const providers = selectProviders(chat.image !== undefined);
    if (providers.length === 0) {
      await ledger.refundOnce();
      throw new HttpError(503, 'providers_unavailable', 'This feature is temporarily unavailable.');
    }

    const result = await startFirstAvailable(
      env,
      providers,
      buildMessagesJson(chat),
      requestStartedAt,
      request.signal,
    );
    trace.attempts = result.attempts;

    const started = result.started;
    if (!started) {
      await ledger.refundOnce();
      throw new HttpError(503, 'providers_unavailable', 'The assistant is temporarily unavailable. Please try again.');
    }

    if (request.signal.aborted || !ledger.commit()) {
      started.controller.abort();
      trace.errorCode = 'client_disconnected';
      await ledger.refundOnce();
      throw new HttpError(503, 'providers_unavailable', 'The request was cancelled.');
    }

    trace.providerId = started.providerId;
    return createPassThroughResponse(started, spent);
  } catch (error) {
    await ledger.refundOnce();
    throw error;
  } finally {
    request.signal.removeEventListener('abort', refundOnClientGone);
  }
}

async function handleChat(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  trace: RequestTrace,
  requestStartedAt: number,
): Promise<Response> {
  assertContentLengthWithinLimit(request);
  const user = await authenticate(request, env);
  const chat = parseChatRequest(await readBodyBytes(request));

  const cost = chat.image ? IMAGE_COST : TEXT_COST;
  const now = new Date();
  const day = utcDay(now);
  const resetAt = nextResetIso(now);
  const limit = resolveDailyCredits(env);
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const usedAfterSpend = await spendCredits(env.DB, { userId: user.userId, day, cost, limit, nowSeconds });
  if (usedAfterSpend === null) {
    throw new HttpError(429, 'credits_exhausted', 'Daily credit limit reached.', {
      credits_remaining: 0,
      reset_at: resetAt,
    });
  }
  trace.creditsCost = cost;

  const ledger = new CreditLedger(env.DB, { userId: user.userId, day, cost, nowSeconds }, (outcome: CreditOutcome) => {
    if (outcome === 'refunded') trace.creditsCost = 0;
    logEvent('outcome', trace, { outcome });
  });

  const served = serveSpentRequest(request, env, chat, ledger, trace, requestStartedAt, {
    creditsRemaining: Math.max(limit - usedAfterSpend, 0),
    resetAt,
  });
  ctx.waitUntil(served.then(noop, noop));
  return served;
}

function noop(): void { }

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  trace: RequestTrace,
  requestStartedAt: number,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === '/') {
    if (request.method !== 'GET') {
      throw methodNotAllowed('GET');
    }

    return new Response('OK', { status: 200 });
  }

  if (pathname === '/chat') {
    if (request.method !== 'POST') throw methodNotAllowed('POST');
    return handleChat(request, env, ctx, trace, requestStartedAt);
  }
  if (pathname === '/credits') {
    if (request.method !== 'GET') throw methodNotAllowed('GET');
    return handleCredits(request, env);
  }
  throw new HttpError(404, 'not_found', 'Not found.');
}

function logRequest(response: Response, trace: RequestTrace, requestStartedAt: number): void {
  console.log(
    JSON.stringify({
      event: 'request',
      request_id: trace.requestId,
      status: response.status,
      error_code: trace.errorCode ?? null,
      provider: trace.providerId ?? null,
      latency_ms: Date.now() - requestStartedAt,
      credits_cost: trace.creditsCost,
      attempts: trace.attempts ?? [],
    }),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestStartedAt = Date.now();
    const trace: RequestTrace = { requestId: crypto.randomUUID(), creditsCost: 0 };

    let response: Response;
    try {
      response = await route(request, env, ctx, trace, requestStartedAt);
    } catch (error) {
      if (error instanceof HttpError) {
        trace.errorCode ??= error.code;
        response = errorResponse(error);
      } else {
        trace.errorCode = 'internal_error';
        response = errorResponse(new HttpError(500, 'internal_error', 'Something went wrong. Please try again.'));
      }
    }

    logRequest(response, trace, requestStartedAt);
    return response;
  },
} satisfies ExportedHandler<Env>;
