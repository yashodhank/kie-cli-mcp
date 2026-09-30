import { priceToolCall } from "../generation-plan.js";
import { withSpendGuard } from "../spend-guard.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

const PAID_CATEGORIES = new Set(["image", "video", "audio"]);

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
  let credits: number | undefined;
  try {
    const price = priceToolCall(tool, args);
    credits = price.status === "exact" ? price.credits : undefined;
  } catch {
    // Invalid arguments: the tool's own validation reports them, nothing is spent.
    return tool.run(args, ctx);
  }
  try {
    return await withSpendGuard(
      ctx,
      credits,
      `direct:${tool.name}`,
      async (commit) => {
        await commit();
        return tool.run(args, ctx);
      },
    );
  } catch (error) {
    return ctx.formatError(tool.name, error, {});
  }
}
