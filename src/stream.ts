import type { UpstreamStart } from './providers';

export interface StreamHeaders {
  creditsRemaining: number;
  resetAt: string;
}

async function pumpUpstream(start: UpstreamStart, writable: WritableStream<ArrayBuffer | ArrayBufferView>): Promise<void> {
  try {
    const writer = writable.getWriter();
    await writer.write(start.firstChunk);
    writer.releaseLock();
    start.reader.releaseLock();
    await start.body.pipeTo(writable);
  } catch {
    start.controller.abort();
  }
}

export function createPassThroughResponse(start: UpstreamStart, headers: StreamHeaders): Response {
  const { readable, writable } = new IdentityTransformStream();
  void pumpUpstream(start, writable);

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Credits-Remaining': String(headers.creditsRemaining),
      'X-Credits-Reset': headers.resetAt,
      'X-Provider': start.providerId,
    },
  });
}
