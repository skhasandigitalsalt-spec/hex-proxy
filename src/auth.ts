import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import {
  ALLOWED_SIGN_IN_PROVIDERS,
  CLOCK_TOLERANCE_SECONDS,
  FIREBASE_JWKS_URL,
  JWKS_CACHE_MAX_AGE_MS,
  JWKS_TIMEOUT_MS,
} from './config';
import { HttpError, type AuthenticatedUser, type Env } from './types';

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

let firebaseKeys: ReturnType<typeof createRemoteJWKSet> | undefined;

function getFirebaseKeys() {
  firebaseKeys ??= createRemoteJWKSet(new URL(FIREBASE_JWKS_URL), {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    timeoutDuration: JWKS_TIMEOUT_MS,
  });
  return firebaseKeys;
}

function unauthenticated(): HttpError {
  return new HttpError(401, 'unauthenticated', 'Please sign in again.');
}

function extractBearerToken(request: Request): string {
  const header = request.headers.get('Authorization');
  const match = header ? BEARER_PATTERN.exec(header) : null;
  if (!match?.[1]) throw unauthenticated();
  return match[1];
}

export async function authenticate(request: Request, env: Env): Promise<AuthenticatedUser> {
  const token = extractBearerToken(request);

  let payload;
  try {
    ({ payload } = await jwtVerify(token, getFirebaseKeys(), {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ['exp', 'iat', 'sub'],
    }));
  } catch (error) {
    if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)) throw error;
    throw unauthenticated();
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.iat !== 'number' || payload.iat > nowSeconds + CLOCK_TOLERANCE_SECONDS) {
    throw unauthenticated();
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw unauthenticated();

  const firebaseClaim = payload['firebase'] as { sign_in_provider?: unknown } | undefined;
  const signInProvider = firebaseClaim?.sign_in_provider;
  if (typeof signInProvider !== 'string' || !ALLOWED_SIGN_IN_PROVIDERS.includes(signInProvider)) {
    throw new HttpError(403, 'forbidden', 'This sign-in method is not allowed.');
  }
  if (signInProvider === 'password' && payload['email_verified'] !== true) {
    throw new HttpError(403, 'email_not_verified', 'Please verify your email address first.');
  }

  return { userId: payload.sub };
}
