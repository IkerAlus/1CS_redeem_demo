/**
 * Gateway stand-in: a stock x402 resource server (reference middleware + Coinbase facilitator) selling
 * `GET /article`, paying into the merchant's wallet on each network — i.e. what an x402 gateway does today.
 * The only addition is a ten-line balance tally per network (`GET /balances`), standing in for the
 * gateway's own settlement bookkeeping, which the redeem flow reads.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { gatewayConfig } from "./config.js";

const cfg = gatewayConfig();
const networks = cfg.networks as Network[];

// ── balance tally (the gateway's bookkeeping, stand-in) ────────────────────────────────────────────
const balances: Record<string, string> = existsSync(cfg.balancesFile)
  ? (JSON.parse(readFileSync(cfg.balancesFile, "utf8")) as Record<string, string>)
  : {};

// ── stock x402 wiring ──────────────────────────────────────────────────────────────────────────────
const server = new x402ResourceServer(
  new HTTPFacilitatorClient(createFacilitatorConfig(cfg.cdpApiKeyId, cfg.cdpApiKeySecret)),
);
for (const n of networks) server.register(n, new ExactEvmScheme());

server.onAfterSettle(async ({ requirements, result }) => {
  if (!result.success) return;
  const n = requirements.network;
  balances[n] = (BigInt(balances[n] ?? "0") + BigInt(result.amount ?? requirements.amount)).toString();
  writeFileSync(cfg.balancesFile, JSON.stringify(balances, null, 2));
  console.log(`settled ${requirements.amount} on ${n} | tx ${result.transaction} | balance ${balances[n]}`);
});

const app = express();
app.use(
  paymentMiddleware(
    {
      "GET /article": {
        accepts: networks.map((network) => ({
          scheme: "exact",
          network,
          price: `$${cfg.priceUsd}`, // stock money price → the network's USDC, EIP-712 fields filled by the scheme
          payTo: cfg.merchantWallet,
        })),
        description: "One article",
        mimeType: "application/json",
      },
    },
    server,
  ),
);

app.get("/article", (_req, res) => {
  res.json({ title: "Paid article", body: "Thanks for paying. This is the content behind the paywall." });
});
app.get("/balances", (_req, res) => res.json(balances));

app.listen(cfg.port, () => {
  console.log(
    `gateway on :${cfg.port} | GET /article $${cfg.priceUsd} on ${networks.join(", ")} | payTo ${cfg.merchantWallet} | balances ${cfg.balancesFile}`,
  );
});
