/** Redeem ledger: a Map written to one JSON file on every change. Reloaded on start. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type Phase = "REQUESTED" | "FUNDED" | "SUCCESS" | "REFUNDED" | "FAILED" | "EXPIRED";
export const OPEN_PHASES: ReadonlySet<Phase> = new Set(["REQUESTED", "FUNDED"]);

export type Redeem = {
  redeemId: string;
  merchantId: string;
  network: string;
  fromWallet: string; // also the 1CS refundTo
  asset: string; // origin token contract the merchant must send
  amountIn: string;
  depositAddress: string;
  destinationAsset: string;
  recipient: string;
  quote: { amountOut: string; minAmountOut: string; deadline: string; correlationId: string };
  phase: Phase;
  txHash?: string;
  oneClickStatus?: string;
  destinationTxs?: { hash: string; explorerUrl: string }[];
  createdAt: number;
  updatedAt: number;
};

export class Ledger {
  private rows = new Map<string, Redeem>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      for (const r of JSON.parse(readFileSync(file, "utf8")) as Redeem[]) this.rows.set(r.redeemId, r);
    }
  }

  get(id: string): Redeem | undefined {
    return this.rows.get(id);
  }

  list(merchantId?: string): Redeem[] {
    return [...this.rows.values()]
      .filter((r) => !merchantId || r.merchantId === merchantId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  open(): Redeem[] {
    return this.list().filter((r) => OPEN_PHASES.has(r.phase));
  }

  put(row: Redeem): Redeem {
    row.updatedAt = Date.now();
    this.rows.set(row.redeemId, row);
    writeFileSync(this.file, JSON.stringify([...this.rows.values()], null, 2));
    return row;
  }
}
