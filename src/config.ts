import type { Env, ProviderConfig } from './types';

export const DAILY_CREDITS = 50;
export const TEXT_COST = 1;
export const IMAGE_COST = 2;

export const MAX_MESSAGE_CHARS = 4000;
export const MAX_MESSAGES = 7;
export const MAX_IMAGE_BYTES = 1_500_000;
export const ALLOWED_IMAGE_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_BODY_BYTES = 2_500_000;
export const MAX_OUTPUT_TOKENS = 500;

export const FIRST_CHUNK_TIMEOUT_MS = 6000;
export const OVERALL_DEADLINE_MS = 15000;

export const SYSTEM_PROMPT =
  'Be brief and direct. Your knowledge ends in March 2026. For news, prices, releases or anything after that, say you cannot confirm it and suggest checking a current source.';

export const ALLOWED_SIGN_IN_PROVIDERS: readonly string[] = ['google.com', 'password'];
export const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
export const JWKS_CACHE_MAX_AGE_MS = 3_600_000;
export const JWKS_TIMEOUT_MS = 3000;
export const CLOCK_TOLERANCE_SECONDS = 5;

export const PROVIDERS: readonly ProviderConfig[] = [
  {
    id: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKeyEnvName: 'GEMINI_API_KEY',
    model: 'gemini-3.5-flash-lite',
    supportsImages: true,
    maxTokensField: 'max_tokens',
  },
  {
    id: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnvName: 'GROQ_API_KEY',
    model: 'openai/gpt-oss-20b',
    supportsImages: false,
    maxTokensField: 'max_completion_tokens',
    extraBody: { reasoning_effort: 'low', include_reasoning: false },
  },
  {
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvName: 'OPENROUTER_API_KEY',
    model: 'openai/gpt-oss-20b:free',
    supportsImages: false,
    maxTokensField: 'max_tokens',
    extraBody: { reasoning: { effort: 'low', exclude: true } },
  },
];

export function resolveDailyCredits(env: Env): number {
  const raw = env.DAILY_CREDITS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DAILY_CREDITS;
  return Number(raw);
}
