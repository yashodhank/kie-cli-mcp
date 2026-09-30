import type { TaskDatabase } from "./database.js";
import type { KieAiClient } from "./kie-ai-client.js";

/** From kie.ai's public price list: 120 credits = $0.60. */
export const USD_PER_CREDIT = 0.005;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SpendPolicy {
  maxCreditsPerPlan?: number;
  dailyCreditCap?: number;
  allowUnpriced: boolean;
  skipBalanceCheck: boolean;
}

export interface PlanBudget {
  balanceCredits?: number;
  balanceError?: string;
  policyError?: string;
  planCredits?: number;
  remainingCredits?: number;
  approxPlanUsd?: number;
  maxCreditsPerPlan?: number;
  dailyCreditCap?: number;
  spentLast24hCredits?: number;
}

/** What a request will cost: the verified-price part, and whether any part has no verified price. */
export interface SpendRequest {
  credits: number;
  unpriced: boolean;
}

export interface SpendControl {
  /** Give back credits that were reserved but not actually spent. */
  refund(credits: number): Promise<void>;
  /** Call once provider requests may have been sent; a later throw no longer auto-refunds. */
  markExecuted(): void;
}

function readCap(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of credits.`);
  }
  return value;
}

export function loadSpendPolicy(
  env: NodeJS.ProcessEnv = process.env,
): SpendPolicy {
  return {
    maxCreditsPerPlan: readCap(env, "KIE_AI_MAX_CREDITS_PER_PLAN"),
    dailyCreditCap: readCap(env, "KIE_AI_DAILY_CREDIT_CAP"),
    allowUnpriced: env.KIE_AI_ALLOW_UNPRICED === "true",
    skipBalanceCheck: env.KIE_AI_SKIP_BALANCE_CHECK === "true",
  };
}

interface GuardContext {
  client: Pick<KieAiClient, "getCredits">;
  db: Pick<TaskDatabase, "getSpendSince" | "recordSpend" | "reserveSpend">;
}

let tail: Promise<unknown> = Promise.resolve();

/** In-process queue for the short reserve step; cross-process safety comes from the DB transaction. */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn, fn);
  tail = next.catch(() => undefined);
  return next;
}

/**
 * Checks the spend policy and balance, reserves the priced credits, then runs
 * `run`. If `run` throws before calling `markExecuted()`, the reservation is
 * refunded; afterwards the caller settles with `refund()` for whatever failed.
 */
export async function withSpendGuard<T>(
  ctx: GuardContext,
  request: SpendRequest,
  source: string,
  run: (control: SpendControl) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const policy = loadSpendPolicy(env);
  const { credits, unpriced } = request;
  const capsActive =
    policy.maxCreditsPerPlan !== undefined ||
    policy.dailyCreditCap !== undefined;

  if (unpriced && capsActive && !policy.allowUnpriced) {
    throw new Error(
      "Spend caps are set but part of this request has no verified price, so the cap cannot be enforced. Use priced models, or set KIE_AI_ALLOW_UNPRICED=true to allow unpriced requests.",
    );
  }

  const reserved = credits > 0;
  if (reserved) {
    if (
      policy.maxCreditsPerPlan !== undefined &&
      credits > policy.maxCreditsPerPlan
    ) {
      throw new Error(
        `Plan needs ${credits} credits, above KIE_AI_MAX_CREDITS_PER_PLAN=${policy.maxCreditsPerPlan}.`,
      );
    }
    if (!policy.skipBalanceCheck) {
      const balance = await ctx.client.getCredits();
      if (balance < credits) {
        throw new Error(
          `Insufficient Kie.ai credits: plan needs ${credits}, balance is ${balance}. Top up and resubmit; the plan was not consumed.`,
        );
      }
    }
    const outcome = await serialize(() =>
      ctx.db.reserveSpend(
        credits,
        source,
        policy.dailyCreditCap,
        new Date(Date.now() - DAY_MS).toISOString(),
      ),
    );
    if (!outcome.ok) {
      throw new Error(
        `Daily cap reached: ${outcome.spent} credits already committed in the last 24h, plan needs ${credits}, KIE_AI_DAILY_CREDIT_CAP=${policy.dailyCreditCap}.`,
      );
    }
  }

  let executed = false;
  let refunded = 0;
  const control: SpendControl = {
    async refund(amount) {
      const value = Math.min(amount, credits - refunded);
      if (value <= 0) return;
      refunded += value;
      await ctx.db.recordSpend(-value, `refund:${source}`);
    },
    markExecuted() {
      executed = true;
    },
  };
  try {
    return await run(control);
  } catch (error) {
    if (reserved && !executed) await control.refund(credits);
    throw error;
  }
}

/** Best-effort snapshot for approval screens; never throws. */
export async function describeBudget(
  ctx: Pick<GuardContext, "client"> & {
    db: Pick<TaskDatabase, "getSpendSince">;
  },
  planCredits: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlanBudget> {
  const budget: PlanBudget = {};
  try {
    const policy = loadSpendPolicy(env);
    budget.maxCreditsPerPlan = policy.maxCreditsPerPlan;
    budget.dailyCreditCap = policy.dailyCreditCap;
    if (policy.dailyCreditCap !== undefined) {
      budget.spentLast24hCredits = await ctx.db.getSpendSince(
        new Date(Date.now() - DAY_MS).toISOString(),
      );
    }
  } catch (error) {
    budget.policyError = error instanceof Error ? error.message : String(error);
  }
  if (planCredits !== undefined) {
    budget.planCredits = planCredits;
    budget.approxPlanUsd = Number((planCredits * USD_PER_CREDIT).toFixed(4));
  }
  try {
    budget.balanceCredits = await ctx.client.getCredits();
    if (planCredits !== undefined) {
      budget.remainingCredits = budget.balanceCredits - planCredits;
    }
  } catch (error) {
    budget.balanceError =
      error instanceof Error ? error.message : String(error);
  }
  return budget;
}
