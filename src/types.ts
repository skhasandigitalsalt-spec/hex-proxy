export interface Env {
  DB: D1Database;
  FIREBASE_PROJECT_ID: string;
  DAILY_CREDITS?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

export type ErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  | 'email_not_verified'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'credits_exhausted'
  | 'internal_error'
  | 'providers_unavailable';

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly extra: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatImage {
  mimeType: string;
  data: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  image?: ChatImage;
}

export interface AuthenticatedUser {
  userId: string;
}

export type MaxTokensField = 'max_tokens' | 'max_completion_tokens';

export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKeyEnvName: keyof Env & string;
  model: string;
  supportsImages: boolean;
  maxTokensField: MaxTokensField;
  extraBody?: Record<string, unknown>;
}

export interface RequestTrace {
  requestId: string;
  errorCode?: string;
  providerId?: string;
  creditsCost: number;
  attempts?: string[];
}
