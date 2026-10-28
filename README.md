# hex-proxy

Cloudflare Worker between the Hex Flutter app and AI providers. Two jobs: provider fallback and daily credits behind Firebase auth. Routes: `POST /chat`, `GET /credits`.

Provider endpoints used (base URL + `/chat/completions`):
- gemini: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
- groq: `https://api.groq.com/openai/v1/chat/completions`
- openrouter: `https://openrouter.ai/api/v1/chat/completions`

All tunables, including providers and models, live in `src/config.ts`. Each provider entry has one extra field, `maxTokensField`, because Groq documents `max_completion_tokens` while the others use `max_tokens`. Making an image-capable provider is one line: `supportsImages: true`.

## Setup (Windows PowerShell)

```powershell
cd hex-proxy
npm install
npx wrangler login

npx wrangler d1 create hex-credits
# copy the returned database_id, then:
(Get-Content wrangler.jsonc) -replace 'REPLACE_WITH_D1_DATABASE_ID','PASTE-ID-HERE' | Set-Content wrangler.jsonc

npx wrangler d1 migrations apply hex-credits --local
npx wrangler d1 migrations apply hex-credits --remote

npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put OPENROUTER_API_KEY

Copy-Item .dev.vars.example .dev.vars
# fill the three keys in .dev.vars for local runs

npm run typecheck
npx wrangler dev
npx wrangler deploy
npx wrangler tail
```

`wrangler secret put` before the first deploy may ask to create the Worker; answer yes. Local and remote D1 are separate databases, so both migration commands are needed.

## curl.exe tests

Body files avoid PowerShell quoting problems. Get a token first (needs your Firebase Web API key and a verified test account):

```powershell
$base = "http://127.0.0.1:8787"
@{ email = "YOUR_TEST_EMAIL"; password = "YOUR_TEST_PASSWORD"; returnSecureToken = $true } | ConvertTo-Json | Set-Content signin.json
$tok = (curl.exe -s "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=YOUR_FIREBASE_WEB_API_KEY" -H "Content-Type: application/json" --data-binary "@signin.json" | ConvertFrom-Json).idToken
```

Delete `signin.json` afterwards. Then:

```powershell
'{"messages":[{"role":"user","content":"Say hello in five words."}]}' | Set-Content text.json
curl.exe -N -i "$base/chat" -H "Authorization: Bearer $tok" -H "Content-Type: application/json" --data-binary "@text.json"

$png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
'{"messages":[{"role":"user","content":"What is this?"}],"image":{"mimeType":"image/png","data":"' + $png + '"}}' | Set-Content image.json
curl.exe -N -i "$base/chat" -H "Authorization: Bearer $tok" -H "Content-Type: application/json" --data-binary "@image.json"

curl.exe -i "$base/credits" -H "Authorization: Bearer $tok"
```

Error paths:

```powershell
curl.exe -i "$base/credits"                                                              # 401 unauthenticated
curl.exe -i "$base/chat" -X POST -H "Content-Type: application/json" --data-binary "@text.json"   # 401 unauthenticated
curl.exe -i "$base/chat" -X POST -H "Authorization: Bearer abc.def.ghi" -H "Content-Type: application/json" --data-binary "@text.json"   # 401
'{"messages":"nope"}' | Set-Content bad.json
curl.exe -i "$base/chat" -X POST -H "Authorization: Bearer $tok" -H "Content-Type: application/json" --data-binary "@bad.json"          # 400 bad_request
'{"messages":[{"role":"system","content":"x"},{"role":"user","content":"hi"}]}' | Set-Content role.json
curl.exe -i "$base/chat" -X POST -H "Authorization: Bearer $tok" -H "Content-Type: application/json" --data-binary "@role.json"         # 400 bad_request
('{"messages":[{"role":"user","content":"' + ('a' * 2600000) + '"}]}') | Set-Content big.json
curl.exe -i "$base/chat" -X POST -H "Authorization: Bearer $tok" -H "Content-Type: application/json" --data-binary "@big.json"          # 413 payload_too_large
curl.exe -i "$base/chat" -H "Authorization: Bearer $tok"                                 # 405 method_not_allowed
curl.exe -i "$base/nope"                                                                 # 404 not_found
# 403 email_not_verified: sign in with an unverified email/password account and reuse the calls above
# 403 forbidden: a token whose sign_in_provider is neither google.com nor password (for example anonymous)
# 429 credits_exhausted: put DAILY_CREDITS=0 in .dev.vars, restart wrangler dev, send the text request
# 503 providers_unavailable: run with the three provider keys empty in .dev.vars
```

### Refund tests

`wrangler.jsonc` sets the `enable_request_signal` compatibility flag; the disconnect refund depends on it. These tests need a temporary patch to `src/index.ts` (do not deploy it). Inside `serveSpentRequest`, directly after the line `logEvent('spent', trace, { credits_cost: trace.creditsCost });`, add one of:

```ts
await new Promise((resolve) => setTimeout(resolve, 5000));                              // patch SLOW
throw new Error('forced');                                                              // patch FAULT
await new Promise((resolve) => setTimeout(resolve, 3000)); throw new Error('forced');   // patch SLOW-FAULT
```

Revert with `git checkout src/index.ts` (or delete the added line). Define a balance helper, restart `wrangler dev` after each patch, and watch the `wrangler dev` console for the `spent` and `outcome` lines:

```powershell
function Get-Balance { (curl.exe -s "$base/credits" -H "Authorization: Bearer $tok" | ConvertFrom-Json).credits_remaining }
```

1. Cancel before the first chunk (patch SLOW). Expect the balance unchanged and one `outcome: refunded` line:
```powershell
$before = Get-Balance
curl.exe -N --max-time 1 "$base/chat" -H "Authorization: Bearer $tok" -H "Content-Type: application/json" --data-binary "@text.json"
Start-Sleep -Seconds 7
"$before -> $(Get-Balance)"
```

2. Exception after the spend (patch FAULT). Expect HTTP 500 `internal_error`, the balance unchanged and exactly one `outcome: refunded` line:
```powershell
$before = Get-Balance
curl.exe -i "$base/chat" -H "Authorization: Bearer $tok" -H "Content-Type: application/json" --data-binary "@text.json"
"$before -> $(Get-Balance)"
```

3. Cancel mid-stream (no patch). Measure time to first byte, then cancel shortly after it, using a request that produces a longer reply:
```powershell
'{"messages":[{"role":"user","content":"Count from 1 to 300, one number per line."}]}' | Set-Content long.json
curl.exe -N -s -o NUL -w "ttfb=%{time_starttransfer}`n" "$base/chat" -H "Authorization: Bearer $tok" -H "Content-Type: application/json" --data-binary "@long.json"
$before = Get-Balance
curl.exe -N -s -o NUL --max-time 1.2 "$base/chat" -H "Authorization: Bearer $tok" -H "Content-Type: application/json" --data-binary "@long.json"
"$before -> $(Get-Balance)"
```
Set `--max-time` to a little above the measured `ttfb` and below the full duration. Expect the balance to drop by 1 and one `outcome: committed` line, with no `refunded` line. If the cancel lands before the first chunk you will see `refunded` instead; lengthen `--max-time`.

4. Two refund triggers for one request (patch SLOW-FAULT). The client disconnects at 1 s (trigger one: disconnect), the forced error fires at 3 s (trigger two: catch). Expect the balance back at its earlier value, not one higher, and exactly one `outcome: refunded` line:
```powershell
$before = Get-Balance
curl.exe -N --max-time 1 "$base/chat" -H "Authorization: Bearer $tok" -H "Content-Type: application/json" --data-binary "@text.json"
Start-Sleep -Seconds 5
"$before -> $(Get-Balance)"
```
A balance above `$before` means a double refund. (The per-day counter cannot go below 0, so use an account with some credits already spent, otherwise a double refund would be hidden by the floor.)

### Postman notes for the refund tests

Postman cannot patch the worker. After applying one of the patches above you can run requests from the collection: use the Postman request timeout (Settings, General, request timeout in ms) set to 1000 for test 1 and test 4, then run request 4 or 6 (GET /credits) and compare with the balance noted before. Tests 2 and 3 are easier with `curl.exe`. Request 15 (credits exhausted) is unrelated to refunds and still needs `DAILY_CREDITS=0`.

## API contract for the Flutter developer

`POST /chat`, headers `Authorization: Bearer <Firebase ID token>`, `Content-Type: application/json`.

```json
{
  "messages": [{ "role": "user", "content": "text" }],
  "image": { "mimeType": "image/jpeg", "data": "<base64, no data: prefix>" }
}
```

- `messages`: 1 to 7 items, roles `user` or `assistant`, last one `user`, each at most 4000 characters, text only.
- `image`: optional, one image, attached to the last user message. Types `image/jpeg`, `image/png`, `image/webp`, at most 1,500,000 bytes decoded.
- No other fields are accepted. The server picks model and limits.
- Cost: 1 credit for text, 2 for text with image. 50 credits per UTC day.

Success: `200`, `Content-Type: text/event-stream`, body is the provider's OpenAI-style SSE passed through unchanged.

| Header | Meaning |
|---|---|
| `X-Credits-Remaining` | integer balance after this request |
| `X-Credits-Reset` | ISO-8601 time of the next 00:00 UTC |
| `X-Provider` | provider that answered |

Reading the stream: read lines starting with `data: `. Each is JSON with `choices[0].delta.content` (may be missing or empty on some chunks), except the last one, which is the literal `data: [DONE]`. Ignore comment lines starting with `:` and blank lines.

Interrupted reply: if the connection closes or errors and `data: [DONE]` was never received, show "response interrupted". The credits are not refunded in this case.

`GET /credits`: same auth, no body. `200 {"credits_remaining": 47, "daily_limit": 50, "reset_at": "2026-10-28T00:00:00.000Z"}`. It spends nothing.

Errors are JSON `{"error":{"code","message"}}`:

| Status | code | Notes |
|---|---|---|
| 400 | `bad_request` | invalid JSON, schema, roles, image type, long message |
| 401 | `unauthenticated` | missing or invalid token; refresh the ID token and retry once |
| 403 | `email_not_verified` / `forbidden` | verify email / sign-in method not allowed |
| 404 | `not_found` | other paths |
| 405 | `method_not_allowed` | wrong method |
| 413 | `payload_too_large` | body or image over limit |
| 429 | `credits_exhausted` | also has `credits_remaining: 0` and `reset_at` |
| 500 | `internal_error` | unexpected |
| 503 | `providers_unavailable` | all providers failed before output; credits refunded |

## Design notes

- Credits: one upsert with `RETURNING` per request. A request whose cost is above the limit never inserts a row. Refund only touches the row if its `day` equals the debit day. Checked against SQLite 3.45 (D1 is SQLite); not run on D1 itself. Refund rules are in "Refund handling" below.
- Streaming: after the first chunk the response is the first chunk followed by `pipeTo` of the rest of the upstream body into an `IdentityTransformStream`. No parsing, no per-chunk JavaScript. If the client disconnects the pipe is cancelled and the upstream request is aborted.
- Keep-alive: returning a `Response` with a streaming body keeps the request alive while the client stays connected. After the first chunk nothing depends on `ctx.waitUntil`. Before the first chunk, the whole post-spend flow runs inside a promise passed to `ctx.waitUntil` so a refund can finish after a client disconnect.
- The spec says both "do not fall back on a 400" and "move on to the next provider". Implemented as: every non-2xx moves to the next provider, and the status is recorded in the log line (`attempts`).
- Image validation checks type, size, padding and the file signature of the first bytes. It does not scan the whole base64 string, to save CPU. A corrupt image body is rejected by the provider, which results in a refund and 503.
- Logs: no user IDs, prompts, replies or tokens. Every JSON line carries `event` and `request_id`. A `spent` line is written right after the debit and before the provider chain starts. An `outcome` line (`committed`, `refunded` or `refund_failed`) is written exactly once afterwards. The usual `request` line (status, error code, provider, latency, credit cost, attempts) is written when the handler returns. Rejected requests write only the `request` line.

## Refund handling

Each chat request that spends credits gets one `CreditLedger` with two flags, `committed` and `refunded`.

- `refundOnce()` returns immediately if `committed` is set. Otherwise it sets `refunded` before running the D1 refund, so a second trigger can never start another D1 statement; later callers just wait for the first one. A failed refund is logged as `refund_failed` and is not retried. The `day` guard in the SQL stays as a second protection.
- `commit()` is called when the provider chain has returned a started stream and the client is still connected. It refuses if a refund already happened. After `commit()` no path refunds: not the catch block, not the disconnect listener. Credits for interrupted replies stay spent.
- Refund triggers: the chain finishing with nothing started, no image-capable provider, the client disconnecting (`request.signal` abort, which also aborts every in-flight upstream request and stops the chain), and any unexpected exception after the spend (then the normal `500 internal_error` is returned).
- If the first chunk is accepted but the client has already disconnected, nothing is committed: the upstream request is aborted and the credits are refunded.
- The flow after the spend runs in a promise that is both returned to the runtime and passed to `ctx.waitUntil`, so it keeps running after a disconnect.
- Rejected or invalid requests never reach the ledger or D1. The success path adds no D1 calls.

### What if the 30-second waitUntil window ends before the chain finishes?

The runtime lets `waitUntil` work continue for up to 30 seconds after the client disconnects, then cancels it. The chain deadline `OVERALL_DEADLINE_MS` is 15000 ms and is measured from the start of the request, so authentication, body read and the debit all count against it. Each attempt's first-chunk timer is `min(FIRST_CHUNK_TIMEOUT_MS, time left)`. The chain therefore ends no later than 15 s after the request started, followed by one D1 write. A disconnect can only happen after the request started, so the work always finishes before disconnect time plus 30 s, with at least about 15 s to spare. I kept `OVERALL_DEADLINE_MS` at 15000 and did not change it. Keep it at or below about 25000 if you edit `src/config.ts`. If the window ever did end first, the refund would not run and the credits would be lost; the missing `outcome` line would show it (see below).

## Known limitations

- A hard kill after the debit (CPU limit exceeded, runtime eviction, a platform restart) cannot run any code, so those credits are lost. To find them, compare log lines: every `request_id` with a `spent` event should have exactly one `outcome` event. A `spent` with no `outcome`, or an `outcome` of `refund_failed`, is a lost debit. Nothing reconciles them automatically.
- A refund whose D1 write fails is not retried.
- If `request.signal` does not fire for a disconnect, a client that leaves before the first chunk is not detected. The chain finishes, the response cannot be delivered, and the credits stay spent (`committed`).
- `committed` means the first provider chunk was accepted, not that the reply finished. Whether a reply completed is not tracked, by design.

## Unverified

Not run in this environment (no network, no npm install possible): `npm install`, `tsc`, `wrangler dev`, deploy, any live provider call, any CPU measurement. Also not confirmed from current documentation:

1. `gemini-3.5-flash-lite`: found only on a third-party reseller page, not on Google's own OpenAI-compatibility page. Check the model list in AI Studio. Google's page names other Gemini 3.x models.
2. Gemini `max_tokens`: Google's page shows the endpoint and thinking settings but I did not see `max_tokens` documented there. The reseller page does. If Gemini thinking is on by default for your model, the 500-token limit may be consumed before visible text; add `reasoning_effort: "low"` (or per Google's mapping) to its `extraBody`.
3. Groq `include_reasoning: false` for gpt-oss: Groq documents `reasoning_effort` for gpt-oss, and I saw `include_reasoning` used in code, not in the docs excerpt.
4. OpenRouter `reasoning: { effort: "low", exclude: true }`: documented as a general parameter. Whether the free gpt-oss route accepts it was not confirmed. The free route is rate limited and may return 429.
5. Firebase JWKS URL `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`: Firebase's own page lists only the x509 URL (`.../robot/v1/metadata/x509/...`), which is not a JWKS and cannot be used with `jose`'s `createRemoteJWKSet`. The JWK URL comes from other vendors' Firebase integration docs. Confirm with a real token.
6. `IdentityTransformStream` as the optimized pass-through: written from memory of the Workers streams docs, not re-read here.
7. Package versions in `package.json` (`jose`, `wrangler`, `typescript`, `@cloudflare/workers-types`) were not checked against the registry.
8. `compatibility_date` 2026-10-27: if your installed `workerd` is older, Wrangler warns and falls back. Update `wrangler` or lower the date.
9. Disconnect behaviour on the real runtime: that `request.signal` fires for a client disconnect with the `enable_request_signal` flag (documented in a May 2025 changelog entry), that `ctx.waitUntil` keeps the post-spend flow and the D1 refund alive after that disconnect, and the 30-second grace length. Simulated in Node only.
10. D1 refund behaviour under concurrency and on the real service. The refund tests were run against SQLite in Node, not D1.
11. `tsc` was not run on the refund changes (no `npm install` possible here).
12. Reasoning models and empty replies: not tested. With `reasoning_effort: low` and 500 tokens, an empty visible reply should be rare, but a provider can send reasoning-only chunks first, which counts as "first chunk" here.

## Done checklist

Refund conditions:

| Item | Status |
|---|---|
| 1. Refund exactly once per request | Pass in a Node simulation of the real handler with real SQLite (error plus disconnect gave balance 5, not 4; removing the guard makes 5 checks fail). Unverified on Workers and D1 |
| 2. Never refund after the stream has started | Pass in simulation (mid-stream cancel keeps the debit; ledger refuses refund after commit). Unverified on Workers |
| 3. Disconnect before first chunk refunds and aborts upstream | Unverified. Passes in simulation, but depends on `request.signal` and `waitUntil` on the real runtime |
| 4. Unexpected error after spend refunds and returns normal 500 | Pass in simulation. Invalid request: zero D1 statements. Success path: one D1 statement. Unverified on Workers |
| 5. Hard-kill limit documented, lost credits detectable | Pass (README "Known limitations"; `spent` and `outcome` lines with `request_id`). Detection works only while logs are kept |
| 30 s grace window cannot end first | Pass by arithmetic (15 s deadline from request start, one D1 write); real timing unverified |

Earlier items:

| Item | Status |
|---|---|
| Credits never negative; concurrent requests cannot overspend | Pass for the SQL logic in SQLite (single atomic statement). Concurrency on D1: unverified |
| `GET /credits` no write; full balance when stored day is not today | Pass by code (single SELECT, day compare). Not run on D1 |
| Image requests never reach `supportsImages: false` providers | Pass by code (`selectProviders` filters). Not run |
| Stream pass-through and headers | Unverified (not run) |
| No secrets, prompts or replies in logs or files | Pass for files (scanned). Logs: pass by code review |
| Token rejection: wrong audience, wrong issuer, expired, unverified password account | Unverified (needs real or forged tokens against a running worker) |
| Request validation (400/413 cases) | Pass, 16 local test cases under Node |
| CPU time (short, long, image, rejected) | Unverified. Highest risk is image requests (parsing and stringifying a body of about 2 MB). Measure with `wrangler dev` |
