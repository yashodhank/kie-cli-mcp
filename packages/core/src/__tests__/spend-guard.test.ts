import { jest } from "@jest/globals";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TaskDatabase } from "../database.js";
import { priceToolCall } from "../generation-plan.js";
import {
  describeBudget,
  loadSpendPolicy,
  withSpendGuard,
} from "../spend-guard.js";
import { getBalanceTool } from "../tools/get_balance.js";
import { nanoBananaImageTool } from "../tools/nano_banana_image.js";
import { runToolGuarded } from "../tools/run-guarded.js";
import type { ToolContext } from "../tools/types.js";

function testDatabase(): { db: TaskDatabase; cleanup: () => Promise<void> } {
  const directory = mkdtempSync(join(tmpdir(), "kie-spend-"));
  const db = new TaskDatabase(join(directory, "tasks.db"));
  return {
    db,
    cleanup: async () => {
      await db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const NO_ENV: NodeJS.ProcessEnv = {};

describe("loadSpendPolicy", () => {
  test("caps are off unless set", () => {
    expect(loadSpendPolicy(NO_ENV)).toEqual({
      maxCreditsPerPlan: undefined,
      dailyCreditCap: undefined,
      allowUnpriced: false,
      skipBalanceCheck: false,
    });
  });

  test.each(["0", "-5", "abc", "NaN"])("rejects invalid cap %p", (value) => {
    expect(() => loadSpendPolicy({ KIE_AI_DAILY_CREDIT_CAP: value })).toThrow(
      /KIE_AI_DAILY_CREDIT_CAP must be a positive number/,
    );
  });
});

describe("withSpendGuard", () => {
  test("allows a priced spend within balance and records it on commit", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const ctx = { db, client: { getCredits: async () => 100 } };
      const result = await withSpendGuard(
        ctx,
        10,
        "t",
        async (commit) => {
          await commit();
          return "ran";
        },
        NO_ENV,
      );
      expect(result).toBe("ran");
      expect(await db.getSpendSince(new Date(0).toISOString())).toBe(10);
    } finally {
      await cleanup();
    }
  });

  test("does not record spend when run never commits", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const ctx = { db, client: { getCredits: async () => 100 } };
      await expect(
        withSpendGuard(
          ctx,
          10,
          "t",
          async () => {
            throw new Error("claim failed");
          },
          NO_ENV,
        ),
      ).rejects.toThrow("claim failed");
      expect(await db.getSpendSince(new Date(0).toISOString())).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("refuses when the balance is short", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const run = jest.fn(async () => "ran");
      await expect(
        withSpendGuard(
          { db, client: { getCredits: async () => 3 } },
          10,
          "t",
          run,
          NO_ENV,
        ),
      ).rejects.toThrow(/plan needs 10, balance is 3/);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("enforces the per-plan cap before reading the balance", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const getCredits = jest.fn(async () => 1_000);
      await expect(
        withSpendGuard(
          { db, client: { getCredits } },
          60,
          "t",
          async () => "ran",
          { KIE_AI_MAX_CREDITS_PER_PLAN: "50" },
        ),
      ).rejects.toThrow(/above KIE_AI_MAX_CREDITS_PER_PLAN=50/);
      expect(getCredits).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("enforces the rolling daily cap across committed spends", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const ctx = { db, client: { getCredits: async () => 1_000 } };
      const env = { KIE_AI_DAILY_CREDIT_CAP: "100" };
      const spend = (credits: number) =>
        withSpendGuard(ctx, credits, "t", async (commit) => commit(), env);
      await spend(60);
      await expect(spend(50)).rejects.toThrow(/Daily cap reached: 60 credits/);
      await spend(40);
    } finally {
      await cleanup();
    }
  });

  test("ignores spend older than 24 hours", async () => {
    const { db, cleanup } = testDatabase();
    try {
      await db.recordSpend(90, "old");
      const future = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
      expect(await db.getSpendSince(future)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("concurrent submits cannot both slip under the daily cap", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const ctx = { db, client: { getCredits: async () => 1_000 } };
      const env = { KIE_AI_DAILY_CREDIT_CAP: "100" };
      const attempt = () =>
        withSpendGuard(ctx, 60, "t", async (commit) => commit(), env).then(
          () => "ok",
          () => "refused",
        );
      const outcomes = await Promise.all([attempt(), attempt()]);
      expect(outcomes.sort()).toEqual(["ok", "refused"]);
    } finally {
      await cleanup();
    }
  });

  describe("unpriced requests", () => {
    const client = { getCredits: async () => 1_000 };

    test("run as before when no caps are set", async () => {
      const { db, cleanup } = testDatabase();
      try {
        await expect(
          withSpendGuard(
            { db, client },
            undefined,
            "t",
            async () => "ran",
            NO_ENV,
          ),
        ).resolves.toBe("ran");
      } finally {
        await cleanup();
      }
    });

    test("are refused when a cap is set", async () => {
      const { db, cleanup } = testDatabase();
      try {
        await expect(
          withSpendGuard({ db, client }, undefined, "t", async () => "ran", {
            KIE_AI_DAILY_CREDIT_CAP: "100",
          }),
        ).rejects.toThrow(/no verified price/);
      } finally {
        await cleanup();
      }
    });

    test("run under a cap with KIE_AI_ALLOW_UNPRICED=true", async () => {
      const { db, cleanup } = testDatabase();
      try {
        await expect(
          withSpendGuard({ db, client }, undefined, "t", async () => "ran", {
            KIE_AI_DAILY_CREDIT_CAP: "100",
            KIE_AI_ALLOW_UNPRICED: "true",
          }),
        ).resolves.toBe("ran");
      } finally {
        await cleanup();
      }
    });
  });
});

describe("describeBudget", () => {
  test("reports balance, remaining credits and approximate USD", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const budget = await describeBudget(
        { db, client: { getCredits: async () => 500 } },
        200,
        { KIE_AI_DAILY_CREDIT_CAP: "300" },
      );
      expect(budget).toMatchObject({
        balanceCredits: 500,
        planCredits: 200,
        remainingCredits: 300,
        approxPlanUsd: 1,
        dailyCreditCap: 300,
        spentLast24hCredits: 0,
      });
    } finally {
      await cleanup();
    }
  });

  test("never throws when the balance cannot be read", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const budget = await describeBudget(
        {
          db,
          client: {
            getCredits: async () => {
              throw new Error("HTTP 401");
            },
          },
        },
        200,
        NO_ENV,
      );
      expect(budget.balanceCredits).toBeUndefined();
      expect(budget.balanceError).toContain("HTTP 401");
      expect(budget.planCredits).toBe(200);
    } finally {
      await cleanup();
    }
  });
});

describe("runToolGuarded (direct calls)", () => {
  function context(
    db: TaskDatabase,
    client: Record<string, unknown>,
  ): ToolContext {
    return {
      db,
      client: client as unknown as ToolContext["client"],
      approvalContext: "test",
      getCallbackUrl: (url?: string) =>
        url ?? "https://callback.example/complete",
      getTool: () => undefined,
      formatError: (_tool: string, error: unknown) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
      }),
    } as unknown as ToolContext;
  }

  const priced = { prompt: "p", model: "nano-banana-2-lite" };

  test("the fixture request is exactly priced", () => {
    expect(priceToolCall(nanoBananaImageTool, priced)).toMatchObject({
      status: "exact",
    });
  });

  test("refuses an under-funded direct paid call and never reaches the provider", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const generate = jest.fn(async () => ({
        code: 200,
        msg: "ok",
        data: { taskId: "t1" },
      }));
      const result = await runToolGuarded(
        nanoBananaImageTool,
        priced,
        context(db, {
          getCredits: async () => 0,
          generateNanoBananaImage: generate,
        }),
      );
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        success: false,
        error: expect.stringContaining("Insufficient Kie.ai credits"),
      });
      expect(generate).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("runs a funded direct call and records its spend", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const generate = jest.fn(async () => ({
        code: 200,
        msg: "ok",
        data: { taskId: "t1" },
      }));
      await runToolGuarded(
        nanoBananaImageTool,
        priced,
        context(db, {
          getCredits: async () => 1_000,
          generateNanoBananaImage: generate,
        }),
      );
      expect(generate).toHaveBeenCalledTimes(1);
      expect(await db.getSpendSince(new Date(0).toISOString())).toBeGreaterThan(
        0,
      );
    } finally {
      await cleanup();
    }
  });

  test("utility tools bypass the guard entirely", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const getCredits = jest.fn(async () => 5);
      const result = await runToolGuarded(
        getBalanceTool,
        {},
        context(db, { getCredits }),
      );
      expect(JSON.parse(result.content[0].text)).toMatchObject({ credits: 5 });
      expect(getCredits).toHaveBeenCalledTimes(1);
      expect(await db.getSpendSince(new Date(0).toISOString())).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("invalid arguments fall through to the tool's own validation without spending", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const getCredits = jest.fn(async () => 1_000);
      const result = await runToolGuarded(
        nanoBananaImageTool,
        {},
        context(db, { getCredits }),
      );
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        success: false,
      });
      expect(getCredits).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
});
