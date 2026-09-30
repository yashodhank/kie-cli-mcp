import { z } from "zod";
import { priceToolCall } from "../generation-plan.js";
import { withSpendGuard } from "../spend-guard.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

const PAID_CATEGORIES = new Set(["image", "video", "audio"]);

function failed(result: ToolResult): boolean {
  if (result.isError) return true;
  try {
    return JSON.parse(result.content[0]?.text ?? "{}")?.success === false;
  } catch {
    return false;
  }
}

/**
 * Runs a tool directly (no prepared plan). Paid generation tools pass through
 * the same spend guard that submit_media_generation uses; utilities run as-is.
 */
export async function runToolGuarded(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!PAID_CATEGORIES.has(tool.category)) return tool.run(args, ctx);
  let request: { credits: number; unpriced: boolean };
  try {
    const price = priceToolCall(tool, args);
    request =
      price.status === "exact"
        ? { credits: price.credits ?? 0, unpriced: false }
        : { credits: 0, unpriced: true };
  } catch (error) {
    // Invalid arguments: the tool's own validation reports them and nothing is spent.
    // Any other pricing failure must not silently skip the guard.
    if (error instanceof z.ZodError) return tool.run(args, ctx);
    return ctx.formatError(tool.name, error, {});
  }
  try {
    return await withSpendGuard(
      ctx,
      request,
      `direct:${tool.name}`,
      async (spend) => {
        spend.markExecuted();
        const result = await tool.run(args, ctx);
        if (failed(result)) await spend.refund(request.credits);
        return result;
      },
    );
  } catch (error) {
    return ctx.formatError(tool.name, error, {});
  }
}
