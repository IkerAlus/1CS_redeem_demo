/**
 * Merchant CLI — stands in for the gateway dashboard's "Redeem" screen AND for the merchant's wallet.
 * Every panel it prints is what the dashboard would show; the transfer step is what wallet-connect would sign.
 *
 *   npm run redeem -- --network eip155:42161 --to near-usdc --recipient seller.near   # full flow
 *   npm run redeem -- ... --dry              # balance + preview only, nothing created
 *   npm run redeem -- ... --amount 100000    # redeem part of the balance (smallest units)
 *   npm run redeem -- ... --delay 90         # wait before sending: the late-send / refund demo
 *   npm run redeem -- --list                 # redeem history
 */

import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base, polygon } from "viem/chains";
import type { Redeem } from "../src/ledger.js";
import { destinationLabel, NETWORKS, resolveDestination } from "../src/networks.js";

try {
  process.loadEnvFile();
} catch {
  /* no .env */
}

const { values: a } = parseArgs({
  options: {
    network: { type: "string", default: "eip155:42161" },
    to: { type: "string", default: "near-usdc" },
    recipient: { type: "string", default: process.env.REDEEM_RECIPIENT }, // where the redeem is delivered
    amount: { type: "string" }, // smallest units; default = the whole tallied balance
    merchant: { type: "string", default: "demo" },
    dry: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    delay: { type: "string", default: "0" },
    list: { type: "boolean", default: false },
    gateway: { type: "string", default: `http://localhost:${process.env.GATEWAY_PORT ?? 4021}` },
    module: { type: "string", default: `http://localhost:${process.env.MODULE_PORT ?? 4022}` },
  },
});

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────
const fail = (msg: string): never => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};
const panel = (title: string) => console.log(`\n━━ ${title} ${"━".repeat(Math.max(0, 56 - title.length))}`);
const usdc = (units: string | bigint) => `${formatUnits(BigInt(units), 6)} USDC`;
const when = (iso: string | number) => new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } }).catch((e: Error) =>
    fail(`cannot reach ${url}: ${e.message}`),
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) fail(`${res.status} from ${new URL(url).pathname}: ${String(body.message ?? body.error ?? JSON.stringify(body))}`);
  return body as T;
}

// ── --list: the dashboard's redeem history ───────────────────────────────────────────────────────
if (a.list) {
  const rows = await api<Redeem[]>(`${a.module}/v1/redeems?merchantId=${a.merchant}`);
  panel(`Redeems for "${a.merchant}" (${rows.length})`);
  if (rows.length === 0) console.log("  none yet");
  for (const r of rows) {
    console.log(
      `  ${when(r.createdAt)}  ${r.phase.padEnd(9)} ${(NETWORKS[r.network]?.name ?? r.network).padEnd(8)} ${usdc(r.amountIn).padStart(16)} → ${destinationLabel(r.destinationAsset)} ${r.recipient}` +
        (r.txHash ? `  tx ${r.txHash.slice(0, 10)}…` : "") +
        `  [${r.redeemId.slice(0, 8)}]`,
    );
  }
  process.exit(0);
}

// ── inputs ──────────────────────────────────────────────────────────────────────────────────────
const net = NETWORKS[a.network!] ?? fail(`unsupported --network ${a.network}; one of ${Object.keys(NETWORKS).join(", ")}`);
if (!a.recipient) fail("--recipient is required (or set REDEEM_RECIPIENT in .env): the address that receives the redeem");
const destinationAsset = resolveDestination(a.to!);
const label = destinationLabel(destinationAsset);
const out = (units: string) => (label !== destinationAsset ? `${formatUnits(BigInt(units), 6)} ${label}` : `${units} units of ${destinationAsset}`);
const merchantWallet = (process.env.MERCHANT_WALLET ?? fail("MERCHANT_WALLET missing in .env")) as `0x${string}`;

// ── 1. balance: what the gateway has tallied for this merchant ──────────────────────────────────
panel("Balance");
let balance: string | undefined;
try {
  const all = (await (await fetch(`${a.gateway}/balances`)).json()) as Record<string, string>;
  balance = all[net.caip2] ?? "0";
  console.log(`  ${net.name.padEnd(9)} ${usdc(balance)}  settled into ${merchantWallet}`);
} catch {
  console.log(`  gateway not reachable at ${a.gateway} — using --amount`);
}
const amount: string = a.amount ?? balance ?? fail("no balance available and no --amount given");
if (amount === "0") fail("nothing to redeem: the balance is 0 and no --amount was given (run `npm run buy` first)");
if (balance && BigInt(amount) > BigInt(balance)) console.log(`  note: --amount is above the tallied balance (${usdc(balance)}); the on-chain check decides`);

// ── 2. preview: dry 1Click quote ────────────────────────────────────────────────────────────────
panel("Preview");
const query = new URLSearchParams({
  merchantId: a.merchant!,
  network: net.caip2,
  fromWallet: merchantWallet,
  amount,
  destinationAsset,
  recipient: a.recipient!,
});
const p = await api<{ amountOut: string; minAmountOut: string; timeEstimateSec: number }>(
  `${a.module}/v1/redeem/preview?${query}`,
);
console.log(`  Redeem    ${usdc(amount)} on ${net.name}`);
console.log(`  Receive   ≈ ${out(p.amountOut)} → ${a.recipient}   (min ${out(p.minAmountOut)}, ~${p.timeEstimateSec}s)`);
if (a.dry) {
  console.log("\n(dry run — nothing created)");
  process.exit(0);
}

// ── 3. confirm: wet quote → payment instructions ────────────────────────────────────────────────
if (!a.yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nRedeem ${usdc(amount)} now? [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) fail("cancelled");
}
panel("Confirmed");
const r = await api<Redeem>(`${a.module}/v1/redeems`, {
  method: "POST",
  body: JSON.stringify(Object.fromEntries(query)),
});
console.log(`  Redeem id  ${r.redeemId}`);
console.log(`  Send       exactly ${usdc(r.amountIn)} (${r.amountIn} units)`);
console.log(`  To         ${r.depositAddress}   (1Click deposit address, single use)`);
console.log(`  Before     ${when(r.quote.deadline)}   (later deposits are refunded to ${merchantWallet})`);

if (Number(a.delay) > 0) {
  console.log(`\n  waiting ${a.delay}s before sending (late-send demo)…`);
  await sleep(Number(a.delay) * 1000);
}

// ── 4. transfer: what the merchant's wallet signs ───────────────────────────────────────────────
panel("Transfer");
const key = (process.env.MERCHANT_PRIVATE_KEY ?? fail("MERCHANT_PRIVATE_KEY missing in .env")) as `0x${string}`;
const account = privateKeyToAccount(key);
if (account.address.toLowerCase() !== merchantWallet.toLowerCase()) {
  fail(`MERCHANT_PRIVATE_KEY controls ${account.address}, not MERCHANT_WALLET ${merchantWallet}`);
}
const chain = { 8453: base, 137: polygon, 42161: arbitrum }[net.chainId]!;
const pub = createPublicClient({ chain, transport: http(net.rpc) });
const wallet = createWalletClient({ account, chain, transport: http(net.rpc) });
const [onChain, gas] = await Promise.all([
  pub.readContract({ address: net.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
  pub.getBalance({ address: account.address }),
]);
console.log(`  Wallet     ${account.address}: ${usdc(onChain)} on-chain, ${formatUnits(gas, 18)} ${chain.nativeCurrency.symbol} for gas`);
if (onChain < BigInt(r.amountIn)) fail(`on-chain USDC (${usdc(onChain)}) is below the redeem amount ${usdc(r.amountIn)}`);
if (gas === 0n) fail(`the merchant wallet has no ${chain.nativeCurrency.symbol} to pay gas on ${net.name}`);

const hash = await wallet.writeContract({
  address: net.usdc,
  abi: erc20Abi,
  functionName: "transfer",
  args: [r.depositAddress as `0x${string}`, BigInt(r.amountIn)],
});
console.log(`  Sent       ${net.explorerTx}${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`  Mined      block ${receipt.blockNumber}, ${receipt.status}`);
if (receipt.status !== "success") fail("the transfer reverted — nothing left the wallet");
const funded = await api<Redeem>(`${a.module}/v1/redeems/${r.redeemId}/tx`, {
  method: "POST",
  body: JSON.stringify({ txHash: hash }),
});
console.log(`  Reported   module phase ${funded.phase}`);
// Tell the gateway its redeemable balance went down (what the dashboard backend would do).
await fetch(`${a.gateway}/balances/redeemed`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ network: net.caip2, amount: r.amountIn }),
}).catch(() => console.log("  (gateway not reachable: balance tally not updated)"));

// ── 5. track: 1Click status until terminal ──────────────────────────────────────────────────────
panel("Tracking");
const t0 = Date.now();
let last = "";
for (;;) {
  const cur = await api<Redeem>(`${a.module}/v1/redeems/${r.redeemId}`);
  const line = `${cur.phase.padEnd(9)} 1Click: ${cur.oneClickStatus ?? "…"}`;
  if (line !== last) {
    console.log(`  ${new Date().toISOString().slice(11, 19)}  ${line}`);
    last = line;
  }
  if (cur.phase !== "REQUESTED" && cur.phase !== "FUNDED") {
    const secs = Math.round((Date.now() - t0) / 1000);
    if (cur.phase === "SUCCESS") {
      console.log(`\n✔ Delivered ≈ ${out(cur.quote.amountOut)} to ${cur.recipient} in ${secs}s after the transfer`);
      for (const t of cur.destinationTxs ?? []) {
        // 1Click leaves explorerUrl empty for NEAR-side settlements; nearblocks can show the hash.
        console.log(`  ${t.explorerUrl || (label.startsWith("near-") ? `https://nearblocks.io/txns/${t.hash}` : t.hash)}`);
      }
    } else if (cur.phase === "REFUNDED") {
      console.log(`\n↩ Refunded to ${merchantWallet} after ${secs}s — the deposit missed the window or the swap failed; nothing lost`);
    } else {
      console.log(`\n✖ ${cur.phase} after ${secs}s`);
    }
    console.log(`  1Click explorer: https://explorer.near-intents.org  (search ${r.depositAddress})`);
    process.exit(cur.phase === "SUCCESS" ? 0 : 2);
  }
  await sleep(5000);
}
