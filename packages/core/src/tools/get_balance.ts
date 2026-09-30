import { GetBalanceSchema } from "../types.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

export const getBalanceTool: ToolDef<typeof GetBalanceSchema> = {
  name: "get_balance",
  description:
    "Get the remaining Kie.ai credit balance for the configured API key. Free and read-only. One credit is worth about $0.005.",
  category: "utility",
  schema: GetBalanceSchema,
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    try {
      GetBalanceSchema.parse(args);
      const credits = await ctx.client.getCredits();
      const payload = { success: true, credits };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    } catch (error) {
      return ctx.formatError("get_balance", error, {});
    }
  },
};
