import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_BODY_BYTES,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGES,
} from './config';
import { HttpError, type ChatImage, type ChatMessage, type ChatRequest } from './types';

const ALLOWED_TOP_LEVEL_KEYS = new Set(['messages', 'image']);
const ALLOWED_MESSAGE_KEYS = new Set(['role', 'content']);
const ALLOWED_IMAGE_KEYS = new Set(['mimeType', 'data']);
const SIGNATURE_PROBE_CHARS = 16;
const BASE64_PREFIX_PATTERN = /^[A-Za-z0-9+/]{16}/;

const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
const payloadTooLarge = (message: string) => new HttpError(413, 'payload_too_large', message);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function assertContentLengthWithinLimit(request: Request): void {
  const header = request.headers.get('Content-Length');
  if (header === null) return;
  const declared = Number(header);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw payloadTooLarge('Request is too large.');
  }
}

export async function readBodyBytes(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw badRequest('Request body is required.');

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw payloadTooLarge('Request is too large.');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) {
    throw badRequest(`messages must contain 1 to ${MAX_MESSAGES} items.`);
  }

  const messages = value.map((entry): ChatMessage => {
    if (!isPlainObject(entry) || !hasOnlyKeys(entry, ALLOWED_MESSAGE_KEYS)) {
      throw badRequest('Each message must have only role and content.');
    }
    const { role, content } = entry;
    if (role !== 'user' && role !== 'assistant') {
      throw badRequest('Message role must be user or assistant.');
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw badRequest('Message content must be a non-empty string.');
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      throw badRequest(`Message content must be at most ${MAX_MESSAGE_CHARS} characters.`);
    }
    return { role, content };
  });

  if (messages[messages.length - 1]?.role !== 'user') {
    throw badRequest('The last message must have role user.');
  }
  return messages;
}

function matchesMimeSignature(mimeType: string, base64: string): boolean {
  if (!BASE64_PREFIX_PATTERN.test(base64)) return false;
  const head = atob(base64.slice(0, SIGNATURE_PROBE_CHARS));
  if (mimeType === 'image/jpeg') return head.startsWith('\xFF\xD8\xFF');
  if (mimeType === 'image/png') return head.startsWith('\x89PNG');
  return head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP';
}

function decodedByteLength(base64: string): number {
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return (base64.length / 4) * 3 - padding;
}

function parseImage(value: unknown): ChatImage {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ALLOWED_IMAGE_KEYS)) {
    throw badRequest('image must have only mimeType and data.');
  }
  const { mimeType, data } = value;
  if (typeof mimeType !== 'string' || !ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
    throw badRequest('Image type must be image/jpeg, image/png or image/webp.');
  }
  if (typeof data !== 'string' || data.length < SIGNATURE_PROBE_CHARS || data.length % 4 !== 0) {
    throw badRequest('Image data must be base64 without a data: prefix.');
  }
  if (decodedByteLength(data) > MAX_IMAGE_BYTES) {
    throw payloadTooLarge('Image is too large.');
  }
  if (!matchesMimeSignature(mimeType, data)) {
    throw badRequest('Image data does not match its type.');
  }
  return { mimeType, data };
}

export function parseChatRequest(bytes: Uint8Array): ChatRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw badRequest('Request body must be valid JSON.');
  }

  if (!isPlainObject(parsed) || !hasOnlyKeys(parsed, ALLOWED_TOP_LEVEL_KEYS)) {
    throw badRequest('Request body must contain only messages and image.');
  }

  const messages = parseMessages(parsed['messages']);
  if (parsed['image'] === undefined) return { messages };
  return { messages, image: parseImage(parsed['image']) };
}
