export type PriceStatus = "exact" | "estimated" | "unknown";

export interface PriceState {
  status: PriceStatus;
  credits?: number;
  sourceUrl?: string;
  sourceFingerprint?: string;
  verifiedAt?: string;
  rateCardVersion: string;
}

export interface RateCardEntry {
  toolName: string;
  /** The provider route scope that has a verified formula for specific inputs. */
  scope: string;
  name: string;
  sourceUrl: string;
  sourceFingerprint: string;
  verifiedAt: string;
  matches(args: Record<string, unknown>, model: string, mode: string): boolean;
  credits(args: Record<string, unknown>): number | undefined;
}

export const RATE_CARD_VERSION = "2026-09-30";

export const RATE_CARD: RateCardEntry[] = [
  {
    toolName: "nano_banana_image",
    scope: "text-to-image",
    name: "Nano Banana 2 Lite image",
    sourceUrl: "https://kie.ai/pricing",
    sourceFingerprint: "kie-pricing-2026-08-17:nano-banana-2-lite:4-per-image",
    verifiedAt: "2026-08-17",
    matches: (args, model, mode) =>
      mode === "text-to-image" &&
      model === "nano-banana-2-lite" &&
      Number(args.outputCount ?? 1) === 1,
    credits: () => 4,
  },
  {
    toolName: "hailuo_video",
    scope: "reference-to-video",
    name: "MiniMax H3 reference-to-video at 768p",
    sourceUrl: "https://kie.ai/pricing",
    sourceFingerprint:
      "kie-pricing-2026-09-30:minimax-h3-reference-768p:8-per-second",
    verifiedAt: "2026-09-30",
    matches: (args, _model, mode) =>
      mode === "reference-to-video" &&
      args.resolution === "768p" &&
      typeof args.duration === "number",
    credits: (args) =>
      typeof args.duration === "number" ? args.duration * 8 : undefined,
  },
  ...(
    [
      ["1K", 8],
      ["2K", 12],
      ["4K", 18],
    ] as const
  ).map(
    ([resolution, credits]): RateCardEntry => ({
      toolName: "nano_banana_image",
      scope: "text-to-image",
      name: `Nano Banana 2 ${resolution} image`,
      sourceUrl: "https://kie.ai/pricing",
      sourceFingerprint: `kie-pricing-2026-09-30:nano-banana-2-${resolution.toLowerCase()}:${credits}-per-image`,
      verifiedAt: "2026-09-30",
      matches: (args, model, mode) =>
        mode === "text-to-image" &&
        model === "nano-banana-2" &&
        args.resolution === resolution &&
        Number(args.outputCount ?? 1) === 1,
      credits: () => credits,
    }),
  ),
  ...(
    [
      ["text-to-image", "1K", 6],
      ["text-to-image", "2K", 10],
      ["text-to-image", "4K", 16],
      ["image-to-image", "1K", 6],
      ["image-to-image", "2K", 10],
      ["image-to-image", "4K", 16],
    ] as const
  ).map(
    ([routeMode, resolution, credits]): RateCardEntry => ({
      toolName: "gpt_image_2",
      scope: routeMode,
      name: `GPT Image 2 ${routeMode} ${resolution}`,
      sourceUrl: "https://kie.ai/pricing",
      sourceFingerprint: `kie-pricing-2026-09-30:gpt-image-2-${routeMode}-${resolution.toLowerCase()}:${credits}-per-image`,
      verifiedAt: "2026-09-30",
      matches: (args, _model, mode) =>
        mode === routeMode &&
        args.resolution === resolution &&
        Number(args.outputCount ?? 1) === 1,
      credits: () => credits,
    }),
  ),
  ...(
    [
      ["veo3_fast", "Fast", 60],
      ["veo3", "Quality", 250],
    ] as const
  ).flatMap(([veoModel, label, credits]) =>
    (["text-to-video", "image-to-video"] as const).map(
      (routeMode): RateCardEntry => ({
        toolName: "veo3_generate_video",
        scope: routeMode,
        name: `Veo 3.1 ${label} ${routeMode} at 720p`,
        sourceUrl: "https://kie.ai/pricing",
        sourceFingerprint: `kie-pricing-2026-09-30:veo-3-1-${label.toLowerCase()}-${routeMode}-720p:${credits}-per-video`,
        verifiedAt: "2026-09-30",
        matches: (_args, model, mode) =>
          mode === routeMode && model === veoModel,
        credits: () => credits,
      }),
    ),
  ),
];

export function priceRequest(
  toolName: string,
  args: Record<string, unknown>,
  model: string,
  mode: string,
): PriceState {
  const entry = RATE_CARD.find(
    (candidate) =>
      candidate.toolName === toolName && candidate.matches(args, model, mode),
  );
  if (!entry) return { status: "unknown", rateCardVersion: RATE_CARD_VERSION };
  const credits = entry.credits(args);
  if (credits === undefined)
    return { status: "unknown", rateCardVersion: RATE_CARD_VERSION };
  return {
    status: "exact",
    credits,
    sourceUrl: entry.sourceUrl,
    sourceFingerprint: entry.sourceFingerprint,
    verifiedAt: entry.verifiedAt,
    rateCardVersion: RATE_CARD_VERSION,
  };
}
