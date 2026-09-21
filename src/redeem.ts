/**
 * Redeem service: quote (dry/wet) → deposit instructions → track the 1CS swap to its outcome.
 * Holds no keys and never moves funds. 1CS detects the deposit on its own; the tracker just polls status.
 * 1CS access is injected so tests run against a fake.
 */

import { randomUUID } from "node:crypto";
import {
  ApiError,
  OneClickService,
  OpenAPI,
  QuoteRequest,
  type GetExecutionStatusResponse,
  type QuoteResponse,
} from "@defuse-protocol/one-click-sdk-typescript";
import { Ledger, TERMINAL, type Phase, type Redeem } from "./ledger.js";
import { NETWORKS } from "./networks.js";

export interface OneClick {
  quote(req: QuoteRequest): Promise<QuoteResponse>;
  status(depositAddress: string): Promise<GetExecutionStatusResponse>;
}

/** Real 1CS client on top of the official SDK (module-level singleton config, fine for one process). */
export function sdkClient(jwt?: string, baseUrl = "https://1click.chaindefuser.com"): OneClick {
  OpenAPI.BASE = baseUrl;
  OpenAPI.TOKEN = jwt;
  return {
    quote: (req) => OneClickService.getQuote(req),
    status: (depositAddress) => OneClickService.getExecutionStatus(depositAddress),
  };
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type RedeemInput = {
  merchantId: string;
  network: string;
  fromWallet: string;
  amount: string;
  destinationAsset: string;
  recipient: string;
};

const TRACK_GRACE_MS = 60 * 60_000; // keep watching an expired redeem this long for a late deposit / refund

export function buildQuoteRequest(i: RedeemInput, dry: boolean, windowMin: number, referral?: string): QuoteRequest {
  const net = NETWORKS[i.network];
  if (!net) throw new HttpError(400, `unsupported network ${i.network}`);
  return {
    dry,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: 50,
    originAsset: net.oneClickAsset,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    destinationAsset: i.destinationAsset,
    amount: i.amount,
    refundTo: i.fromWallet,
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipient: i.recipient,
    recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
    deadline: new Date(Date.now() + windowMin * 60_000).toISOString(),
    referral,
  };
}

export class RedeemService {
  constructor(
    private readonly oc: OneClick,
    private readonly ledger: Ledger,
    private readonly opts: { windowMin: number; referral?: string },
  ) {}

  /** Dry quote: what the merchant would get. */
  async preview(i: RedeemInput) {
    const q = (await this.oc.quote(buildQuoteRequest(i, true, this.opts.windowMin, this.opts.referral))).quote;
    return { amountOut: q.amountOut, minAmountOut: q.minAmountOut, timeEstimateSec: q.timeEstimate };
  }

  /** Wet quote → REQUESTED row with the deposit instructions. One pending redeem per merchant+network. */
  async create(i: RedeemInput): Promise<Redeem> {
    if (this.ledger.pending().some((r) => r.merchantId === i.merchantId && r.network === i.network)) {
      throw new HttpError(409, `a redeem is already pending for ${i.merchantId} on ${i.network}`);
    }
    const req = buildQuoteRequest(i, false, this.opts.windowMin, this.opts.referral);
    const res = await this.oc.quote(req);
    const q = res.quote;
    if (!q.depositAddress) throw new HttpError(502, "1CS quote returned no depositAddress");
    const now = Date.now();
    const row = this.ledger.put({
      redeemId: randomUUID(),
      merchantId: i.merchantId,
      network: i.network,
      fromWallet: i.fromWallet,
      asset: NETWORKS[i.network]!.usdc,
      amountIn: q.amountIn,
      depositAddress: q.depositAddress,
      destinationAsset: i.destinationAsset,
      recipient: i.recipient,
      quote: {
        amountOut: q.amountOut,
        minAmountOut: q.minAmountOut,
        deadline: req.deadline, // our refund cutoff (1CS's own `quote.deadline` is the address lifetime)
        correlationId: res.correlationId,
      },
      phase: "REQUESTED",
      createdAt: now,
      updatedAt: now,
    });
    console.log(
      `[redeem ${row.redeemId.slice(0, 8)}] REQUESTED | ${row.amountIn} on ${row.network} → ${row.recipient}`,
    );
    return row;
  }

  /** One tracker pass: poll 1CS for every redeem without an outcome. Errors on a row are logged and retried. */
  async tick(): Promise<void> {
    for (const row of this.ledger.tracked(TRACK_GRACE_MS)) {
      const before = `${row.phase}/${row.oneClickStatus ?? ""}`;
      try {
        const s = await this.oc.status(row.depositAddress);
        row.oneClickStatus = s.status;
        if (s.swapDetails?.originChainTxHashes?.length) row.originTxs = s.swapDetails.originChainTxHashes;
        if (s.swapDetails?.destinationChainTxHashes?.length)
          row.destinationTxs = s.swapDetails.destinationChainTxHashes;
        if (TERMINAL.has(s.status)) row.phase = s.status as Phase;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          row.oneClickStatus = "PENDING_DEPOSIT"; // 1CS knows nothing about the address until funds arrive
        } else {
          console.warn(`[redeem ${row.redeemId.slice(0, 8)}] status poll failed: ${(e as Error).message}`);
        }
      }
      if (
        row.phase === "REQUESTED" &&
        row.oneClickStatus === "PENDING_DEPOSIT" &&
        Date.now() >= Date.parse(row.quote.deadline)
      ) {
        row.phase = "EXPIRED"; // nothing arrived before our refund cutoff; a late deposit is refunded by 1CS
      }
      const after = `${row.phase}/${row.oneClickStatus ?? ""}`;
      if (after !== before)
        console.log(`[redeem ${row.redeemId.slice(0, 8)}] ${row.phase} | 1CS ${row.oneClickStatus}`);
      this.ledger.put(row);
    }
  }
}
