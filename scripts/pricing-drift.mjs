#!/usr/bin/env node
// Opt-in, read-only. Fetches Kie.ai's public price list and compares it with the
// built-in rate card. Never writes the rate card or the evidence manifest.
// Exit codes: 0 no drift, 1 drift or a card entry with no live match, 2 fetch failure.
import { pathToFileURL } from "node:url";

export const PRICING_ENDPOINT =
  "https://api.kie.ai/client/v1/model-pricing/page";

/** Each check ties one rate-card formula to the live row that quotes the same route. */
export const CHECKS = [
  {
    label: "nano_banana_image text-to-image nano-banana-2-lite",
    sample: {
      tool: "nano_banana_image",
      args: { outputCount: 1 },
      model: "nano-banana-2-lite",
      mode: "text-to-image",
    },
    units: 1,
    liveDescription: "nano-banana-2-lite, 1k",
  },
  {
    label: "hailuo_video reference-to-video 768p (per second)",
    sample: {
      tool: "hailuo_video",
      args: { duration: 1, resolution: "768p" },
      model: "minimax-h3",
      mode: "reference-to-video",
    },
    units: 1,
    liveDescription: "MiniMax H3, reference to video, 768p",
  },
];

export async function fetchLivePricing(fetchImpl = fetch, pageSize = 100) {
  const rows = [];
  for (let pageNum = 1; pageNum <= 50; pageNum += 1) {
    const response = await fetchImpl(PRICING_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageNum, pageSize }),
    });
    if (!response.ok) {
      throw new Error(`Pricing endpoint returned HTTP ${response.status}.`);
    }
    const body = await response.json();
    if (body.code !== 200 || !body.data || !Array.isArray(body.data.records)) {
      throw new Error(
        `Unexpected pricing response: code=${body.code} msg=${body.msg}`,
      );
    }
    rows.push(...body.data.records);
    if (pageNum >= (body.data.pages ?? 0)) return rows;
  }
  throw new Error("Pricing endpoint returned more than 50 pages.");
}

const normalize = (text) => String(text).trim().toLowerCase();

/** priceFn(sample) -> credits for that sample, or undefined when the card has no exact formula. */
export function comparePricing(checks, liveRows, priceFn) {
  const byDescription = new Map(
    liveRows.map((row) => [normalize(row.modelDescription), row]),
  );
  return checks.map((check) => {
    const cardCredits = priceFn(check.sample);
    const live = byDescription.get(normalize(check.liveDescription));
    if (cardCredits === undefined) {
      return { label: check.label, status: "NO_CARD_PRICE" };
    }
    if (!live) {
      return { label: check.label, status: "MISSING_LIVE", cardCredits };
    }
    const liveCredits = Number(live.creditPrice) * check.units;
    return {
      label: check.label,
      status: liveCredits === cardCredits ? "OK" : "DRIFT",
      cardCredits,
      liveCredits,
      liveUnit: live.creditUnit,
    };
  });
}

async function main() {
  try {
    const { priceRequest } = await import("../packages/core/dist/index.js");
    const liveRows = await fetchLivePricing();
    const results = comparePricing(CHECKS, liveRows, (sample) => {
      const price = priceRequest(
        sample.tool,
        sample.args,
        sample.model,
        sample.mode,
      );
      return price.status === "exact" ? price.credits : undefined;
    });
    const paidRows = liveRows.filter((row) => row.interfaceType !== "chat");
    console.log(
      JSON.stringify(
        {
          fetchedAt: new Date().toISOString(),
          liveRows: liveRows.length,
          liveMediaRows: paidRows.length,
          checkedFormulas: results.length,
          results,
        },
        null,
        2,
      ),
    );
    if (results.some((result) => result.status !== "OK")) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
