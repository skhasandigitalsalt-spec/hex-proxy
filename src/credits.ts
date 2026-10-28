const SPEND_SQL = `INSERT INTO user_credits (user_id, day, credits_used, created_at, updated_at)
SELECT ?1, ?2, ?3, ?4, ?4 WHERE ?3 <= ?5
ON CONFLICT(user_id) DO UPDATE SET
  credits_used = CASE WHEN user_credits.day = excluded.day THEN user_credits.credits_used + excluded.credits_used ELSE excluded.credits_used END,
  day = excluded.day,
  updated_at = excluded.updated_at
WHERE (CASE WHEN user_credits.day = excluded.day THEN user_credits.credits_used + excluded.credits_used ELSE excluded.credits_used END) <= ?5
RETURNING credits_used`;

const REFUND_SQL = `UPDATE user_credits
SET credits_used = MAX(credits_used - ?2, 0), updated_at = ?4
WHERE user_id = ?1 AND day = ?3`;

const READ_SQL = 'SELECT day, credits_used FROM user_credits WHERE user_id = ?1';

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function nextResetIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

export interface SpendRequest {
  userId: string;
  day: string;
  cost: number;
  limit: number;
  nowSeconds: number;
}

export async function spendCredits(db: D1Database, request: SpendRequest): Promise<number | null> {
  const row = await db
    .prepare(SPEND_SQL)
    .bind(request.userId, request.day, request.cost, request.nowSeconds, request.limit)
    .first<{ credits_used: number }>();
  return row ? row.credits_used : null;
}

export interface RefundRequest {
  userId: string;
  day: string;
  cost: number;
  nowSeconds: number;
}

export async function refundCredits(db: D1Database, request: RefundRequest): Promise<void> {
  await db
    .prepare(REFUND_SQL)
    .bind(request.userId, request.cost, request.day, request.nowSeconds)
    .run();
}

export async function readCreditsUsed(db: D1Database, userId: string, today: string): Promise<number> {
  const row = await db.prepare(READ_SQL).bind(userId).first<{ day: string; credits_used: number }>();
  return row && row.day === today ? row.credits_used : 0;
}

export type CreditOutcome = 'committed' | 'refunded' | 'refund_failed';

export class CreditLedger {
  private committed = false;
  private refunded = false;
  private pendingRefund: Promise<void> | undefined;
  private readonly db: D1Database;
  private readonly refundRequest: RefundRequest;
  private readonly onOutcome: (outcome: CreditOutcome) => void;

  constructor(db: D1Database, refundRequest: RefundRequest, onOutcome: (outcome: CreditOutcome) => void) {
    this.db = db;
    this.refundRequest = refundRequest;
    this.onOutcome = onOutcome;
  }

  commit(): boolean {
    if (this.refunded) return false;
    this.committed = true;
    this.onOutcome('committed');
    return true;
  }

  refundOnce(): Promise<void> {
    if (this.committed) return Promise.resolve();
    if (this.refunded) return this.pendingRefund ?? Promise.resolve();
    this.refunded = true;
    this.pendingRefund = this.runRefund();
    return this.pendingRefund;
  }

  private async runRefund(): Promise<void> {
    try {
      await refundCredits(this.db, this.refundRequest);
      this.onOutcome('refunded');
    } catch {
      this.onOutcome('refund_failed');
    }
  }
}
