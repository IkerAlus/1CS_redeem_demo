import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiError,
  type GetExecutionStatusResponse,
  type QuoteResponse,
} from "@defuse-protocol/one-click-sdk-typescript";
import { Ledger } from "./ledger.js";
import { buildQuoteRequest, HttpError, RedeemService, type OneClick, type RedeemInput } from "./redeem.js";

const input: RedeemInput = {
  merchantId: "m1",
  network: "eip155:42161",
  fromWallet: "0x1111111111111111111111111111111111111111",
  amount: "250000",
  destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  recipient: "seller.near",
};

const quoteResponse = (dry: boolean): QuoteResponse =>
  ({
    correlationId: "corr-1",
    timestamp: new Date().toISOString(),
    signature: "sig",
    quoteRequest: {} as QuoteResponse["quoteRequest"],
    quote: {
      depositAddress: dry ? undefined : "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      amountIn: "250000",
      amountInFormatted: "0.25",
      amountInUsd: "0.25",
      minAmountIn: "250000",
      amountOut: "248500",
      amountOutFormatted: "0.2485",
      amountOutUsd: "0.2485",
      minAmountOut: "247000",
      deadline: "2099-01-01T00:00:00.000Z", // 1CS address lifetime, not our cutoff
      timeWhenInactive: "2099-01-01T00:00:00.000Z",
      timeEstimate: 25,
    },
  }) as unknown as QuoteResponse;

const statusResponse = (status: string, dest: string[] = [], origin: string[] = []): GetExecutionStatusResponse =>
  ({
    correlationId: "corr-1",
    status,
    updatedAt: new Date().toISOString(),
    swapDetails: {
      originChainTxHashes: origin.map((hash) => ({ hash, explorerUrl: "" })),
      destinationChainTxHashes: dest.map((hash) => ({ hash, explorerUrl: "" })),
    },
  }) as unknown as GetExecutionStatusResponse;

/** Programmable fake 1CS. */
function fake(overrides: Partial<OneClick> = {}) {
  const calls = { quote: [] as unknown[] };
  const oc: OneClick = {
    quote: async (req) => {
      calls.quote.push(req);
      return quoteResponse(req.dry === true);
    },
    status: async () => statusResponse("PENDING_DEPOSIT"),
    ...overrides,
  };
  return { oc, calls };
}

const freshLedger = () => new Ledger(join(mkdtempSync(join(tmpdir(), "redeem-")), "ledger.json"));
const service = (oc: OneClick, ledger = freshLedger(), windowMin = 30) =>
  new RedeemService(oc, ledger, { windowMin, referral: "test" });

test("buildQuoteRequest: EXACT_INPUT, refundTo = merchant wallet, deadline = now + window", () => {
  const before = Date.now();
  const req = buildQuoteRequest(input, false, 30, "test");
  assert.equal(req.dry, false);
  assert.equal(req.swapType, "EXACT_INPUT");
  assert.equal(req.refundTo, input.fromWallet);
  assert.equal(req.recipient, "seller.near");
  assert.equal(req.originAsset, "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near");
  assert.equal(req.referral, "test");
  const dl = Date.parse(req.deadline);
  assert.ok(dl >= before + 30 * 60_000 - 1000 && dl <= before + 30 * 60_000 + 5000);
  assert.throws(() => buildQuoteRequest({ ...input, network: "eip155:480" }, true, 30), HttpError);
});

test("preview returns the dry quote and never stores anything", async () => {
  const { oc, calls } = fake();
  const ledger = freshLedger();
  const p = await service(oc, ledger).preview(input);
  assert.equal(p.amountOut, "248500");
  assert.equal((calls.quote[0] as { dry: boolean }).dry, true);
  assert.equal(ledger.list().length, 0);
});

test("create stores a REQUESTED row with instructions; a second pending redeem on the same network is refused", async () => {
  const { oc } = fake();
  const ledger = freshLedger();
  const svc = service(oc, ledger);
  const row = await svc.create(input);
  assert.equal(row.phase, "REQUESTED");
  assert.equal(row.depositAddress, "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  assert.equal(row.amountIn, "250000");
  assert.equal(row.asset, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
  assert.equal(row.fromWallet, input.fromWallet);
  assert.ok(
    Date.parse(row.quote.deadline) < Date.parse("2099-01-01T00:00:00Z"),
    "stores OUR cutoff, not the address lifetime",
  );
  await assert.rejects(svc.create(input), (e: HttpError) => e.status === 409);
  await svc.create({ ...input, network: "eip155:8453" }); // another network is fine
  assert.equal(ledger.pending().length, 2);
});

for (const terminal of ["SUCCESS", "REFUNDED", "FAILED"] as const) {
  test(`tick: REQUESTED → ${terminal} with origin and destination tx hashes, no report needed`, async () => {
    const { oc } = fake({ status: async () => statusResponse(terminal, ["0xdest"], ["0xorigin"]) });
    const ledger = freshLedger();
    const svc = service(oc, ledger);
    const row = await svc.create(input);
    await svc.tick();
    const done = ledger.get(row.redeemId)!;
    assert.equal(done.phase, terminal);
    assert.equal(done.oneClickStatus, terminal);
    assert.deepEqual(done.originTxs, [{ hash: "0xorigin", explorerUrl: "" }]);
    assert.deepEqual(done.destinationTxs, [{ hash: "0xdest", explorerUrl: "" }]);
    assert.equal(ledger.pending().length, 0);
    assert.equal(ledger.tracked(60_000).length, 0);
  });
}

test("tick: PROCESSING keeps the row REQUESTED and records the origin tx", async () => {
  const { oc } = fake({ status: async () => statusResponse("PROCESSING", [], ["0xorigin"]) });
  const ledger = freshLedger();
  const svc = service(oc, ledger);
  const row = await svc.create(input);
  await svc.tick();
  assert.equal(ledger.get(row.redeemId)!.phase, "REQUESTED");
  assert.equal(ledger.get(row.redeemId)!.originTxs?.[0]?.hash, "0xorigin");
});

test("tick: past the cutoff with nothing deposited → EXPIRED, still tracked; a late refund is picked up", async () => {
  const seen = { status: "PENDING_DEPOSIT" };
  const { oc } = fake({ status: async () => statusResponse(seen.status) });
  const ledger = freshLedger();
  const svc = service(oc, ledger, 0); // zero-minute window: already expired
  const row = await svc.create(input);
  await svc.tick();
  assert.equal(ledger.get(row.redeemId)!.phase, "EXPIRED");
  assert.equal(ledger.pending().length, 0, "an expired redeem no longer blocks new ones");
  assert.equal(ledger.tracked(60_000).length, 1, "but stays tracked during the grace period");
  seen.status = "REFUNDED";
  await svc.tick();
  assert.equal(ledger.get(row.redeemId)!.phase, "REFUNDED");
});

test("tick: a failing status poll leaves the row untouched and does not throw", async () => {
  const { oc } = fake({
    status: async () => {
      throw new Error("timeout");
    },
  });
  const ledger = freshLedger();
  const svc = service(oc, ledger);
  const row = await svc.create(input);
  await svc.tick();
  assert.equal(ledger.get(row.redeemId)!.phase, "REQUESTED");
  assert.equal(ledger.get(row.redeemId)!.oneClickStatus, undefined);
});

test("tick: 1CS 404 for an unfunded address counts as PENDING_DEPOSIT, then EXPIRED at the cutoff", async () => {
  const notFound = () => {
    throw new ApiError(
      { method: "GET", url: "/v0/status/x" },
      { url: "/v0/status/x", ok: false, status: 404, statusText: "Not Found", body: {} },
      "Not Found",
    );
  };
  const ledger = freshLedger();
  const svc = service(fake({ status: async () => notFound() }).oc, ledger, 30);
  const row = await svc.create(input);
  await svc.tick();
  assert.equal(ledger.get(row.redeemId)!.phase, "REQUESTED");
  assert.equal(ledger.get(row.redeemId)!.oneClickStatus, "PENDING_DEPOSIT");

  const ledger2 = freshLedger();
  const svc2 = service(fake({ status: async () => notFound() }).oc, ledger2, 0);
  const row2 = await svc2.create(input);
  await svc2.tick();
  assert.equal(ledger2.get(row2.redeemId)!.phase, "EXPIRED");
});

test("ledger reloads from disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "redeem-"));
  const file = join(dir, "ledger.json");
  const svc = service(fake().oc, new Ledger(file));
  const row = await svc.create(input);
  const reloaded = new Ledger(file);
  assert.equal(reloaded.get(row.redeemId)?.depositAddress, row.depositAddress);
  assert.equal(reloaded.pending().length, 1);
});
