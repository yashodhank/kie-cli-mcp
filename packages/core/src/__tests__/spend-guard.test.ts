import { jest } from "@jest/globals";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TaskDatabase } from "../database.js";
import { priceToolCall } from "../generation-plan.js";
import { MODEL_CATALOG } from "../model-catalog.js";
import {
  describeBudget,
  loadSpendPolicy,
  withSpendGuard,
} from "../spend-guard.js";
import { getBalanceTool } from "../tools/get_balance.js";
import { TOOL_REGISTRY } from "../tools/index.js";
import { nanoBananaImageTool } from "../tools/nano_banana_image.js";
import { runToolGuarded } from "../tools/run-guarded.js";
import type { ToolContext, ToolDef } from "../tools/types.js";

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

const NET = (credits: number) => ({ credits, unpriced: false });
const total = (db: TaskDatabase) => db.getSpendSince(new Date(0).toISOString());

describe("withSpendGuard", () => {
  test("reserves priced credits before run and keeps them after a normal finish", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const ctx = { db, client: { getCredits: async () => 100 } };
      let during = -1;
      const result = await withSpendGuard(
        ctx,
        NET(10),
        "t",
        async (spend) => {
          during = await total(db);
          spend.markExecuted();
          return "ran";
        },
        NO_ENV,
      );
      expect(result).toBe("ran");
      expect(during).toBe(10);
      expect(await total(db)).toBe(10);
    } finally {
      await cleanup();
    }
  });

  test("refunds the reservation when run throws before markExecuted", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const ctx = { db, client: { getCredits: async () => 100 } };
      await expect(
        withSpendGuard(
          ctx,
          NET(10),
          "t",
          async () => {
            throw new Error("claim failed");
          },
          NO_ENV,
        ),
      ).rejects.toThrow("claim failed");
      expect(await total(db)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("keeps the reservation when run throws after markExecuted, and refund() gives back only what failed", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const ctx = { db, client: { getCredits: async () => 100 } };
      await expect(
        withSpendGuard(
          ctx,
          NET(10),
          "t",
          async (spend) => {
            spend.markExecuted();
            await spend.refund(4);
            await spend.refund(100);
            throw new Error("items failed");
          },
          NO_ENV,
        ),
      ).rejects.toThrow("items failed");
      expect(await total(db)).toBe(0);

      await withSpendGuard(
        ctx,
        NET(10),
        "t2",
        async (spend) => {
          spend.markExecuted();
          await spend.refund(4);
          throw new Error("x");
        },
        NO_ENV,
      ).catch(() => undefined);
      expect(await total(db)).toBe(6);
    } finally {
      await cleanup();
    }
  });

  test("refuses when the balance is short without reserving", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const run = jest.fn(async () => "ran");
      await expect(
        withSpendGuard(
          { db, client: { getCredits: async () => 3 } },
          NET(10),
          "t",
          run,
          NO_ENV,
        ),
      ).rejects.toThrow(/plan needs 10, balance is 3/);
      expect(run).not.toHaveBeenCalled();
      expect(await total(db)).toBe(0);
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
          NET(60),
          "t",
          async () => "ran",
          {
            KIE_AI_MAX_CREDITS_PER_PLAN: "50",
          },
        ),
      ).rejects.toThrow(/above KIE_AI_MAX_CREDITS_PER_PLAN=50/);
      expect(getCredits).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("enforces the rolling daily cap across reserved spends", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const ctx = { db, client: { getCredits: async () => 1_000 } };
      const env = { KIE_AI_DAILY_CREDIT_CAP: "100" };
      const spend = (credits: number) =>
        withSpendGuard(
          ctx,
          NET(credits),
          "t",
          async (s) => s.markExecuted(),
          env,
        );
      await spend(60);
      await expect(spend(50)).rejects.toThrow(/Daily cap reached: 60 credits/);
      await spend(40);
    } finally {
      await cleanup();
    }
  });

  test("a failed call does not consume the daily cap", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const ctx = { db, client: { getCredits: async () => 1_000 } };
      const env = { KIE_AI_DAILY_CREDIT_CAP: "100" };
      await withSpendGuard(
        ctx,
        NET(90),
        "t",
        async () => {
          throw new Error("provider down");
        },
        env,
      ).catch(() => undefined);
      await expect(
        withSpendGuard(ctx, NET(90), "t", async (s) => s.markExecuted(), env),
      ).resolves.toBeUndefined();
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

  test("concurrent submits in one process cannot both slip under the cap", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const ctx = { db, client: { getCredits: async () => 1_000 } };
      const env = { KIE_AI_DAILY_CREDIT_CAP: "100" };
      const attempt = () =>
        withSpendGuard(
          ctx,
          NET(60),
          "t",
          async (s) => s.markExecuted(),
          env,
        ).then(
          () => "ok",
          () => "refused",
        );
      expect((await Promise.all([attempt(), attempt()])).sort()).toEqual([
        "ok",
        "refused",
      ]);
    } finally {
      await cleanup();
    }
  });

  test("two database connections on one file cannot both slip under the cap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kie-spend-xproc-"));
    const path = join(directory, "tasks.db");
    const a = new TaskDatabase(path);
    const b = new TaskDatabase(path);
    try {
      const env = { KIE_AI_DAILY_CREDIT_CAP: "100" };
      const attempt = (db: TaskDatabase) =>
        withSpendGuard(
          { db, client: { getCredits: async () => 1_000 } },
          NET(60),
          "t",
          async (s) => s.markExecuted(),
          env,
        ).then(
          () => "ok",
          () => "refused",
        );
      expect((await Promise.all([attempt(a), attempt(b)])).sort()).toEqual([
        "ok",
        "refused",
      ]);
    } finally {
      await a.close();
      await b.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe("mixed and unpriced requests", () => {
    const client = { getCredits: async () => 1_000 };

    test("run as before when no caps are set", async () => {
      const { db, cleanup } = testDatabase();
      try {
        await expect(
          withSpendGuard(
            { db, client },
            { credits: 0, unpriced: true },
            "t",
            async () => "ran",
            NO_ENV,
          ),
        ).resolves.toBe("ran");
      } finally {
        await cleanup();
      }
    });

    test("are refused when a cap is set, even if part of the plan is priced", async () => {
      const { db, cleanup } = testDatabase();
      try {
        await expect(
          withSpendGuard(
            { db, client },
            { credits: 30, unpriced: true },
            "t",
            async () => "ran",
            {
              KIE_AI_DAILY_CREDIT_CAP: "100",
            },
          ),
        ).rejects.toThrow(/no verified price/);
        expect(await total(db)).toBe(0);
      } finally {
        await cleanup();
      }
    });

    test("with KIE_AI_ALLOW_UNPRICED=true the priced part is still capped and recorded", async () => {
      const { db, cleanup } = testDatabase();
      try {
        const env = {
          KIE_AI_MAX_CREDITS_PER_PLAN: "50",
          KIE_AI_ALLOW_UNPRICED: "true",
        };
        await expect(
          withSpendGuard(
            { db, client },
            { credits: 60, unpriced: true },
            "t",
            async () => "ran",
            env,
          ),
        ).rejects.toThrow(/above KIE_AI_MAX_CREDITS_PER_PLAN=50/);
        await withSpendGuard(
          { db, client },
          { credits: 30, unpriced: true },
          "t",
          async (s) => s.markExecuted(),
          env,
        );
        expect(await total(db)).toBe(30);
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
    } finally {
      await cleanup();
    }
  });

  test("reports unreadable caps separately from a successful balance read", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const budget = await describeBudget(
        { db, client: { getCredits: async () => 500 } },
        200,
        { KIE_AI_DAILY_CREDIT_CAP: "abc" },
      );
      expect(budget.balanceCredits).toBe(500);
      expect(budget.policyError).toContain("KIE_AI_DAILY_CREDIT_CAP");
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
  const ok = async () => ({ code: 200, msg: "ok", data: { taskId: "t1" } });

  test("the fixture request is exactly priced", () => {
    expect(priceToolCall(nanoBananaImageTool, priced)).toMatchObject({
      status: "exact",
    });
  });

  test("refuses an under-funded direct paid call and never reaches the provider", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const generate = jest.fn(ok);
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

  test("runs a funded direct call and keeps its spend", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const generate = jest.fn(ok);
      await runToolGuarded(
        nanoBananaImageTool,
        priced,
        context(db, {
          getCredits: async () => 1_000,
          generateNanoBananaImage: generate,
        }),
      );
      expect(generate).toHaveBeenCalledTimes(1);
      expect(await total(db)).toBe(4);
    } finally {
      await cleanup();
    }
  });

  test("refunds the spend when the provider call fails", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const generate = jest.fn(async () => {
        throw new Error("HTTP 500");
      });
      const result = await runToolGuarded(
        nanoBananaImageTool,
        priced,
        context(db, {
          getCredits: async () => 1_000,
          generateNanoBananaImage: generate,
        }),
      );
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        success: false,
      });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(await total(db)).toBe(0);
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
      expect(await total(db)).toBe(0);
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

  test("a non-validation pricing failure fails closed instead of skipping the guard", async () => {
    const { db, cleanup } = testDatabase();
    try {
      const run = jest.fn();
      const broken = {
        name: "nano_banana_image",
        category: "image",
        schema: {
          parse: () => {
            throw new Error("resolver bug");
          },
        },
        run,
      } as unknown as ToolDef;
      const result = await runToolGuarded(
        broken,
        {},
        context(db, { getCredits: async () => 1_000 }),
      );
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        success: false,
        error: expect.stringContaining("resolver bug"),
      });
      expect(run).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
});

test("every model-catalog generation tool is in a guarded (non-utility) category", () => {
  const byName = new Map(TOOL_REGISTRY.map((tool) => [tool.name, tool]));
  for (const entry of MODEL_CATALOG) {
    const tool = byName.get(entry.toolName);
    if (tool)
      expect([entry.toolName, tool.category]).not.toEqual([
        entry.toolName,
        "utility",
      ]);
  }
});
