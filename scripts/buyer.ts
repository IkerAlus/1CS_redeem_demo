/**
 * Buyer: a standard x402 client (@x402/fetch + EVM exact scheme) paying for /article.
 *
 *   npm run buy -- --network eip155:42161 --times 5      # pay N times (needs BUYER_PRIVATE_KEY + USDC)
 *   npm run buy -- --dry                                  # just fetch the 402 and print the accepts
 */

import { parseArgs } from "node:util";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

try {
  process.loadEnvFile();
} catch {
  /* no .env */
}

const { values: a } = parseArgs({
  options: {
    network: { type: "string", default: "eip155:42161" },
    times: { type: "string", default: "1" },
    url: { type: "string", default: "http://localhost:4021/article" },
    max: { type: "string", default: "$1" }, // spend cap per payment
    dry: { type: "boolean", default: false },
  },
});

if (a.dry) {
  const res = await fetch(a.url!);
  console.log(`GET ${a.url} → ${res.status}`);
  const header = res.headers.get("payment-required");
  if (!header) {
    console.log(await res.text());
    process.exit(1);
  }
  const pr = decodePaymentRequiredHeader(header);
  for (const r of pr.accepts) {
    console.log(
      `  ${r.network.padEnd(14)} ${r.amount.padStart(8)} of ${r.asset} → payTo ${r.payTo} | ${r.maxTimeoutSeconds}s | ${String(r.extra?.name)} v${String(r.extra?.version)}`,
    );
  }
  process.exit(0);
}

const key = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!key || key.length !== 66) {
  console.error("BUYER_PRIVATE_KEY missing or malformed (0x + 64 hex)");
  process.exit(1);
}
const account = privateKeyToAccount(key);
const client = new x402Client()
  .setSpendControls({ maxAmountPerPayment: a.max! })
  .register(a.network as Network, new ExactEvmScheme(account)); // only this network → the client picks that accepts entry
const payFetch = wrapFetchWithPayment(fetch, client);

console.log(`buyer ${account.address} | ${a.network} | ${a.times}× ${a.url}`);
for (let i = 1; i <= Number(a.times); i++) {
  const t0 = performance.now();
  const res = await payFetch(a.url!);
  const ms = Math.round(performance.now() - t0);
  const settle = res.headers.get("payment-response");
  const s = settle ? decodePaymentResponseHeader(settle) : undefined;
  console.log(`#${i} ${res.status} in ${ms} ms | tx ${s?.transaction ?? "-"} on ${s?.network ?? "-"}`);
  if (!res.ok) {
    console.log(await res.text());
    process.exit(1);
  }
}
