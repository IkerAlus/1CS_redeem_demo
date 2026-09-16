/**
 * Gateway stand-in: a stock x402 resource server (reference middleware + Coinbase facilitator) selling
 * `GET /article`, paying into the merchant wallet on each network — what an x402 gateway does today —
 * plus the two things the redeem feature adds on the gateway side:
 *
 *   - a balance tally per network (the gateway's settlement bookkeeping), and
 *   - a merchant REST API (`/merchant/*`) that plays the dashboard: balances, saved payout destinations
 *     (add / list), preview / redeem, history. The merchant wallet is **custodied by the gateway**: on a
 *     redeem the gateway quotes through the redeem module, signs the USDC transfer itself, reports the tx, tracks.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base, polygon } from "viem/chains";
import { gatewayConfig } from "./config.js";
import { describeAsset, Destinations, ValidationError } from "./destinations.js";
import type { Redeem } from "./ledger.js";
import { NETWORKS } from "./networks.js";

const cfg = gatewayConfig();
const networks = cfg.networks as Network[];
const MERCHANT_ID = "demo"; // single merchant in the demo

// ── the merchant wallet, custodied by the gateway ─────────────────────────────────────────────────
const merchant = privateKeyToAccount(cfg.merchantPrivateKey);
if (merchant.address.toLowerCase() !== cfg.merchantWallet.toLowerCase()) {
  throw new Error(`MERCHANT_PRIVATE_KEY controls ${merchant.address}, not MERCHANT_WALLET ${cfg.merchantWallet}`);
}
const chains = { 8453: base, 137: polygon, 42161: arbitrum } as const;
const fmt = (units: string | bigint, decimals: number) => formatUnits(BigInt(units), decimals);
const usdc = (units: string | bigint) => `${fmt(units, 6)} USDC`;

// ── balance tally (the gateway's bookkeeping, stand-in) ────────────────────────────────────────────
const balances: Record<string, string> = existsSync(cfg.balancesFile)
  ? (JSON.parse(readFileSync(cfg.balancesFile, "utf8")) as Record<string, string>)
  : {};
const saveBalances = () => writeFileSync(cfg.balancesFile, JSON.stringify(balances, null, 2));

// ── the merchant's saved payout destinations ───────────────────────────────────────────────────────
const dests = new Destinations(cfg.destinationsFile);
if (dests.list().length === 0 && cfg.redeemRecipient) {
  dests.add({ chain: "near", token: "USDC", account: cfg.redeemRecipient }); // alias near-usdc
}

// ── stock x402 wiring ──────────────────────────────────────────────────────────────────────────────
const server = new x402ResourceServer(
  new HTTPFacilitatorClient(createFacilitatorConfig(cfg.cdpApiKeyId, cfg.cdpApiKeySecret)),
);
for (const n of networks) server.register(n, new ExactEvmScheme());

server.onAfterSettle(async ({ requirements, result }) => {
  if (!result.success) return;
  const n = requirements.network;
  balances[n] = (BigInt(balances[n] ?? "0") + BigInt(result.amount ?? requirements.amount)).toString();
  saveBalances();
  console.log(`settled ${requirements.amount} on ${n} | tx ${result.transaction} | balance ${balances[n]}`);
});

const app = express();
app.set("json spaces", 2); // readable curl output
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

// ── merchant API (the dashboard, as REST) ──────────────────────────────────────────────────────────
class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function module<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(cfg.moduleUrl + path, { ...init, headers: { "content-type": "application/json" } }).catch(
    (e: Error) => {
      throw new ApiError(503, `redeem module unreachable at ${cfg.moduleUrl}: ${e.message}`);
    },
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, String(body.message ?? body.error ?? res.statusText));
  return body as T;
}

/** Sign and send `amount` USDC from the custodied merchant wallet on `network`; resolves when mined. */
async function sendUsdc(network: string, to: `0x${string}`, amount: string) {
  const n = NETWORKS[network]!;
  const chain = chains[n.chainId as keyof typeof chains];
  const pub = createPublicClient({ chain, transport: http(n.rpc) });
  const wallet = createWalletClient({ account: merchant, chain, transport: http(n.rpc) });
  const [onChain, gas] = await Promise.all([
    pub.readContract({ address: n.usdc, abi: erc20Abi, functionName: "balanceOf", args: [merchant.address] }),
    pub.getBalance({ address: merchant.address }),
  ]);
  if (onChain < BigInt(amount))
    throw new ApiError(409, `merchant wallet holds ${usdc(onChain)} on ${n.name}, below ${usdc(amount)}`);
  if (gas === 0n) throw new ApiError(503, `merchant wallet has no ${chain.nativeCurrency.symbol} for gas on ${n.name}`);
  // L2 base fees move in bursts between estimate and submit; cap at 2× the current base fee so the
  // transaction is never underpriced (the wallet pays the actual base fee, not the cap).
  const fees = await pub.estimateFeesPerGas();
  const hash = await wallet.writeContract({
    address: n.usdc,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, BigInt(amount)],
    maxFeePerGas: fees.maxFeePerGas * 2n,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new ApiError(502, `transfer ${hash} reverted`);
  return { hash, explorer: `${n.explorerTx}${hash}` };
}

/** Add human-readable fields and links to a module row. */
function view(r: Redeem) {
  const d = describeAsset(r.destinationAsset);
  const saved = dests.list().find((x) => x.assetId === r.destinationAsset && x.account === r.recipient);
  return {
    ...r,
    network: `${NETWORKS[r.network]?.name ?? r.network} (${r.network})`,
    amountIn: usdc(r.amountIn),
    destination: saved?.alias,
    receives: d
      ? `≈ ${fmt(r.quote.amountOut, d.decimals)} ${d.token} on ${d.chain} → ${r.recipient}`
      : `${r.quote.amountOut} units → ${r.recipient}`,
    transferExplorer: r.txHash ? `${NETWORKS[r.network]?.explorerTx}${r.txHash}` : undefined,
    destinationLinks: r.destinationTxs?.map((t) => t.explorerUrl || (d ? `${d.explorerTx}${t.hash}` : t.hash)),
  };
}

const m = express.Router();
m.use(express.json());

m.get("/balances", (_req, res) => {
  res.json(
    Object.fromEntries(
      networks.map((n) => [
        n,
        { network: NETWORKS[n]?.name, units: balances[n] ?? "0", usdc: fmt(balances[n] ?? "0", 6) },
      ]),
    ),
  );
});

m.get("/destinations", (_req, res) => res.json(dests.list()));

/** POST /merchant/destinations { chain, token, account } — validate against the catalog and save. */
m.post("/destinations", (req, res) => {
  const d = dests.add((req.body ?? {}) as Record<string, unknown>);
  console.log(`[merchant] destination ${d.alias}: ${d.token} on ${d.chain} → ${d.account}`);
  res.status(201).json(d);
});

/**
 * POST /merchant/redeem  { originNetwork, to, amount?, dry?, delaySec? }   (`to` = alias of a saved destination)
 *   dry: true  → preview only.
 *   otherwise  → quote, sign + send the transfer from the custodied wallet, report, decrement the tally.
 *   delaySec   → demo-only: wait before sending (late-send / refund path).
 */
m.post("/redeem", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const network = String(b.originNetwork ?? "");
  const n = NETWORKS[network];
  if (!n || !networks.includes(network as Network))
    throw new ApiError(400, `originNetwork must be one of ${networks.join(", ")}`);
  const to = String(b.to ?? "");
  const dest = dests.get(to);
  if (!dest) {
    const aliases = dests.list().map((d) => d.alias);
    throw new ApiError(
      400,
      aliases.length
        ? `to must be a saved destination: ${aliases.join(", ")}`
        : "to must be a saved destination; add one with POST /merchant/destinations",
    );
  }
  const { assetId: destinationAsset, account: recipient } = dest;
  const balance = balances[network] ?? "0";
  const amount = String(b.amount ?? balance);
  if (!/^[1-9]\d*$/.test(amount))
    throw new ApiError(
      400,
      `nothing to redeem on ${n.name}: balance is ${usdc(balance)} (buyers pay first) or amount is invalid`,
    );
  if (BigInt(amount) > BigInt(balance))
    throw new ApiError(409, `${usdc(amount)} exceeds the redeemable balance ${usdc(balance)} on ${n.name}`);

  const q = new URLSearchParams({
    merchantId: MERCHANT_ID,
    network,
    fromWallet: merchant.address,
    amount,
    destinationAsset,
    recipient,
  });
  if (b.dry) {
    const p = await module<{ amountOut: string; minAmountOut: string; timeEstimateSec: number }>(
      `/v1/redeem/preview?${q}`,
    );
    return res.json({
      dry: true,
      redeem: `${usdc(amount)} on ${n.name}`,
      to: dest.alias,
      receive: `≈ ${fmt(p.amountOut, dest.decimals)} ${dest.token} on ${dest.chain} → ${recipient}`,
      minimumReceive: fmt(p.minAmountOut, dest.decimals),
      estimatedSeconds: p.timeEstimateSec,
    });
  }

  // Reuse an open REQUESTED redeem for this network (e.g. a previous attempt whose transfer failed):
  // its 1Click deposit address is still valid, so we retry the transfer instead of minting a new quote.
  const open = (await module<Redeem[]>(`/v1/redeems?merchantId=${MERCHANT_ID}`)).find(
    (x) => x.network === network && x.phase === "REQUESTED",
  );
  if (
    open &&
    (open.amountIn !== amount || open.destinationAsset !== destinationAsset || open.recipient !== recipient)
  ) {
    throw new ApiError(
      409,
      `an open redeem (${open.redeemId}) for ${usdc(open.amountIn)} → ${open.recipient} is pending on ${n.name}; retry with the same parameters or wait until ${open.quote.deadline}`,
    );
  }
  const r =
    open ?? (await module<Redeem>("/v1/redeems", { method: "POST", body: JSON.stringify(Object.fromEntries(q)) }));
  console.log(
    `[merchant] redeem ${r.redeemId.slice(0, 8)}${open ? " (retry)" : ""}: ${usdc(amount)} on ${n.name} → ${dest.alias} (${dest.token} on ${dest.chain}, ${recipient}) | deposit ${r.depositAddress}`,
  );
  if (Number(b.delaySec) > 0) {
    console.log(`[merchant] redeem ${r.redeemId.slice(0, 8)}: waiting ${String(b.delaySec)}s before sending (demo)`);
    await sleep(Number(b.delaySec) * 1000);
  }
  const tx = await sendUsdc(network, r.depositAddress as `0x${string}`, r.amountIn);
  const funded = await module<Redeem>(`/v1/redeems/${r.redeemId}/tx`, {
    method: "POST",
    body: JSON.stringify({ txHash: tx.hash }),
  });
  balances[network] = (BigInt(balances[network] ?? "0") - BigInt(amount)).toString(); // payments may have landed meanwhile
  saveBalances();
  console.log(`[merchant] redeem ${r.redeemId.slice(0, 8)}: sent ${tx.explorer} | balance left ${balances[network]}`);
  return res.status(201).json({ ...view(funded), track: `GET /merchant/redeems/${r.redeemId}` });
});

m.get("/redeems", async (_req, res) =>
  res.json((await module<Redeem[]>(`/v1/redeems?merchantId=${MERCHANT_ID}`)).map(view)),
);
m.get("/redeems/:id", async (req, res) => res.json(view(await module<Redeem>(`/v1/redeems/${req.params.id}`))));

app.use("/merchant", m);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: (err as Error).message });
});

app.listen(cfg.port, () => {
  console.log(
    `gateway on :${cfg.port} | GET /article $${cfg.priceUsd} on ${networks.join(", ")} | merchant wallet ${merchant.address} (custodied) | module ${cfg.moduleUrl} | ${dests.list().length} saved destination(s) | merchant API /merchant/{balances,destinations,redeem,redeems}`,
  );
});
