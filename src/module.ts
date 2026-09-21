/**
 * Redeem module: the HTTP surface a gateway's dashboard backend would call.
 *   GET  /v1/redeem/preview      dry quote
 *   POST /v1/redeems             wet quote → deposit instructions (REQUESTED); the tracker takes it from there
 *   GET  /v1/redeems/:id         one redeem
 *   GET  /v1/redeems?merchantId  all redeems of a merchant
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { ApiError } from "@defuse-protocol/one-click-sdk-typescript";
import { moduleConfig } from "./config.js";
import { Ledger } from "./ledger.js";
import { NETWORKS } from "./networks.js";
import { HttpError, RedeemService, sdkClient, type RedeemInput } from "./redeem.js";

function parseInput(q: Record<string, unknown>): RedeemInput {
  const s = (k: string) => {
    const v = q[k];
    if (typeof v !== "string" || !v) throw new HttpError(400, `missing ${k}`);
    return v;
  };
  const i: RedeemInput = {
    merchantId: s("merchantId"),
    network: s("network"),
    fromWallet: s("fromWallet"),
    amount: s("amount"),
    destinationAsset: s("destinationAsset"), // raw 1CS asset id; the caller resolves names
    recipient: s("recipient"),
  };
  if (!NETWORKS[i.network]) throw new HttpError(400, `unsupported network ${i.network}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(i.fromWallet)) throw new HttpError(400, "fromWallet must be an EVM address");
  if (!/^[1-9]\d*$/.test(i.amount)) throw new HttpError(400, "amount must be a positive integer in smallest units");
  return i;
}

function createApp(svc: RedeemService, ledger: Ledger) {
  const app = express();
  app.use(express.json());

  app.get("/v1/redeem/preview", async (req, res) => {
    res.json(await svc.preview(parseInput(req.query as Record<string, unknown>)));
  });
  app.post("/v1/redeems", async (req, res) => {
    res.status(201).json(await svc.create(parseInput(req.body ?? {})));
  });
  app.get("/v1/redeems/:id", (req, res) => {
    const row = ledger.get(req.params.id);
    if (!row) throw new HttpError(404, `unknown redeem ${req.params.id}`);
    res.json(row);
  });
  app.get("/v1/redeems", (req, res) => {
    res.json(ledger.list(typeof req.query.merchantId === "string" ? req.query.merchantId : undefined));
  });

  // Express 5 routes async errors here. 1CS 4xx bodies pass through (they carry "try at least X" hints).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof ApiError) {
      const message = (err.body as { message?: unknown })?.message ?? err.statusText;
      return res.status(err.status === 400 ? 400 : 502).json({ error: `1CS ${err.status}`, message });
    }
    console.error(err);
    return res.status(500).json({ error: (err as Error).message });
  });
  return app;
}

const cfg = moduleConfig();
const ledger = new Ledger(cfg.ledgerFile);
const svc = new RedeemService(sdkClient(cfg.oneClickJwt), ledger, {
  windowMin: cfg.redeemWindowMin,
  referral: cfg.referral,
});
setInterval(() => void svc.tick(), cfg.pollMs);
void svc.tick(); // pick up anything left open by a previous run
createApp(svc, ledger).listen(cfg.port, () => {
  console.log(
    `redeem module on :${cfg.port} | ledger ${cfg.ledgerFile} (${ledger.pending().length} pending) | poll ${cfg.pollMs} ms | window ${cfg.redeemWindowMin} min | jwt ${cfg.oneClickJwt ? "yes" : "no (+0.2% fee)"}`,
  );
});
