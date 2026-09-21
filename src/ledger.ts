/** Redeem ledger: a Map written to one JSON file on every change. Reloaded on start. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type Phase = "REQUESTED" | "EXPIRED" | "SUCCESS" | "REFUNDED" | "FAILED";
/** Phases 1CS itself reports; nothing changes after one of these. */
export const TERMINAL: ReadonlySet<string> = new Set<Phase>(["SUCCESS", "REFUNDED", "FAILED"]);

export type Redeem = {
  redeemId: string;
  merchantId: string;
  network: string;
  fromWallet: string; // also the 1CS refundTo
  asset: string; // origin token contract to send to depositAddress
  amountIn: string;
  depositAddress: string;
  destinationAsset: string;
  recipient: string;
  quote: { amountOut: string; minAmountOut: string; deadline: string; correlationId: string };
  phase: Phase;
  oneClickStatus?: string;
  originTxs?: { hash: string; explorerUrl: string }[];
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

  /** Rows still awaiting a deposit. */
  pending(): Redeem[] {
    return this.list().filter((r) => r.phase === "REQUESTED");
  }

  /** Rows without a 1CS outcome yet, including recently expired ones (a late deposit is refunded, worth watching). */
  tracked(graceMs: number): Redeem[] {
    const now = Date.now();
    return this.list().filter((r) => !TERMINAL.has(r.phase) && now < Date.parse(r.quote.deadline) + graceMs);
  }

  put(row: Redeem): Redeem {
    row.updatedAt = Date.now();
    this.rows.set(row.redeemId, row);
    writeFileSync(this.file, JSON.stringify([...this.rows.values()], null, 2));
    return row;
  }
}
