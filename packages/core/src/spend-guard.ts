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
  planCredits?: number;
  remainingCredits?: number;
  approxPlanUsd?: number;
  maxCreditsPerPlan?: number;
  dailyCreditCap?: number;
  spentLast24hCredits?: number;
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
  db: Pick<TaskDatabase, "getSpendSince" | "recordSpend">;
}

let tail: Promise<unknown> = Promise.resolve();

/** Serializes check-and-record so concurrent submits in one process cannot both pass a cap. */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn, fn);
  tail = next.catch(() => undefined);
  return next;
}

/**
 * Runs `run` only if the spend policy and the account balance allow `credits`
 * (undefined = unpriced). `run` must call `commit()` once the spend is
 * definitely going ahead, which writes it to the local spend log.
 */
export async function withSpendGuard<T>(
  ctx: GuardContext,
  credits: number | undefined,
  source: string,
  run: (commit: () => Promise<void>) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const policy = loadSpendPolicy(env);
  return serialize(async () => {
    const capsActive =
      policy.maxCreditsPerPlan !== undefined ||
      policy.dailyCreditCap !== undefined;

    if (credits === undefined) {
      if (capsActive && !policy.allowUnpriced) {
        throw new Error(
          "Spend caps are set but this request has no verified price, so the cap cannot be enforced. Use a priced model, or set KIE_AI_ALLOW_UNPRICED=true to allow unpriced requests.",
        );
      }
    } else if (credits > 0) {
      if (
        policy.maxCreditsPerPlan !== undefined &&
        credits > policy.maxCreditsPerPlan
      ) {
        throw new Error(
          `Plan needs ${credits} credits, above KIE_AI_MAX_CREDITS_PER_PLAN=${policy.maxCreditsPerPlan}.`,
        );
      }
      if (policy.dailyCreditCap !== undefined) {
        const spent = await ctx.db.getSpendSince(
          new Date(Date.now() - DAY_MS).toISOString(),
        );
        if (spent + credits > policy.dailyCreditCap) {
          throw new Error(
            `Daily cap reached: ${spent} credits already committed in the last 24h, plan needs ${credits}, KIE_AI_DAILY_CREDIT_CAP=${policy.dailyCreditCap}.`,
          );
        }
      }
      if (!policy.skipBalanceCheck) {
        const balance = await ctx.client.getCredits();
        if (balance < credits) {
          throw new Error(
            `Insufficient Kie.ai credits: plan needs ${credits}, balance is ${balance}. Top up and resubmit; the plan was not consumed.`,
          );
        }
      }
    }

    return run(async () => {
      if (credits !== undefined && credits > 0) {
        await ctx.db.recordSpend(credits, source);
      }
    });
  });
}

/** Best-effort snapshot for approval screens; never throws. */
export async function describeBudget(
  ctx: GuardContext,
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
    budget.balanceError =
      error instanceof Error ? error.message : String(error);
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
