import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { comparePricing, fetchLivePricing } from "../pricing-drift.mjs";

const check = {
  label: "x",
  sample: {},
  units: 1,
  liveDescription: "Model A, 1k",
};
const live = (creditPrice) => [
  { modelDescription: "model a, 1K ", creditPrice, creditUnit: "per image" },
];

describe("pricing drift", () => {
  test("reports OK when the card matches the live price", () => {
    const [result] = comparePricing([check], live("4.0"), () => 4);
    assert.equal(result.status, "OK");
  });

  test("reports DRIFT with both numbers when they differ", () => {
    const [result] = comparePricing([check], live("8"), () => 16);
    assert.deepEqual(
      {
        status: result.status,
        card: result.cardCredits,
        live: result.liveCredits,
      },
      { status: "DRIFT", card: 16, live: 8 },
    );
  });

  test("reports MISSING_LIVE when no live row matches", () => {
    const [result] = comparePricing([check], [], () => 4);
    assert.equal(result.status, "MISSING_LIVE");
  });

  test("reports NO_CARD_PRICE when the card cannot price the sample", () => {
    const [result] = comparePricing([check], live("4"), () => undefined);
    assert.equal(result.status, "NO_CARD_PRICE");
  });

  test("multiplies live credits by the check's units", () => {
    const [result] = comparePricing(
      [{ ...check, units: 6 }],
      live("8"),
      () => 48,
    );
    assert.equal(result.status, "OK");
  });

  test("fetchLivePricing pages until the last page", async () => {
    const pages = [
      { code: 200, data: { records: [{ modelDescription: "a" }], pages: 2 } },
      { code: 200, data: { records: [{ modelDescription: "b" }], pages: 2 } },
    ];
    let call = 0;
    const rows = await fetchLivePricing(async () => ({
      ok: true,
      json: async () => pages[call++],
    }));
    assert.deepEqual(
      rows.map((row) => row.modelDescription),
      ["a", "b"],
    );
  });

  test("fetchLivePricing fails loudly on HTTP errors and bad bodies", async () => {
    await assert.rejects(
      fetchLivePricing(async () => ({ ok: false, status: 503 })),
      /HTTP 503/,
    );
    await assert.rejects(
      fetchLivePricing(async () => ({
        ok: true,
        json: async () => ({ code: 401, msg: "nope", data: null }),
      })),
      /code=401/,
    );
  });
});
