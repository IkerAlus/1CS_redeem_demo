/**
 * Destinations a merchant can be paid out to.
 *
 *  - CHAINS: the catalog — for each supported chain, its native token and the two stablecoins where 1Click
 *    lists them (asset ids from GET /v0/tokens, 2026-09-11), an address format check, a block explorer.
 *  - Destinations: the merchant's saved list `{alias, chain, token, account, assetId, decimals}`, one JSON file.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Chain = {
  tokens: Record<string, { assetId: string; decimals: number }>;
  address: RegExp;
  addressHint: string;
  explorerTx: string;
};

export const CHAINS: Record<string, Chain> = {
  near: {
    tokens: {
      NEAR: { assetId: "nep141:wrap.near", decimals: 24 }, // delivered as NEAR via wrap.near
      USDC: { assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6 },
      USDT: { assetId: "nep141:usdt.tether-token.near", decimals: 6 },
    },
    address: /^([a-z0-9]([a-z0-9._-]*[a-z0-9])?\.(near|tg)|[a-f0-9]{64})$/,
    addressHint: "a NEAR account: name.near or a 64-hex implicit account",
    explorerTx: "https://nearblocks.io/txns/",
  },
  tron: {
    tokens: {
      TRX: { assetId: "nep141:tron.omft.near", decimals: 6 },
      USDT: { assetId: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", decimals: 6 },
    },
    address: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    addressHint: "a Tron address: T + 33 base58 chars",
    explorerTx: "https://tronscan.org/#/transaction/",
  },
  ethereum: {
    tokens: {
      ETH: { assetId: "nep141:eth.omft.near", decimals: 18 },
      USDC: { assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", decimals: 6 },
      USDT: { assetId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near", decimals: 6 },
    },
    address: /^0x[0-9a-fA-F]{40}$/,
    addressHint: "an EVM address: 0x + 40 hex chars",
    explorerTx: "https://etherscan.io/tx/",
  },
  bitcoin: {
    tokens: { BTC: { assetId: "nep141:btc.omft.near", decimals: 8 } },
    address: /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
    addressHint: "a Bitcoin address: bc1…, 1… or 3…",
    explorerTx: "https://mempool.space/tx/",
  },
  zcash: {
    tokens: { ZEC: { assetId: "nep141:zec.omft.near", decimals: 8 } },
    address: /^t[13][a-km-zA-HJ-NP-Z1-9]{33}$/,
    addressHint: "a transparent Zcash address: t1… or t3…",
    explorerTx: "https://blockchair.com/zcash/transaction/",
  },
  solana: {
    tokens: {
      SOL: { assetId: "nep141:sol.omft.near", decimals: 9 },
      USDC: { assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", decimals: 6 },
      USDT: { assetId: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", decimals: 6 },
    },
    address: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    addressHint: "a Solana address: 32–44 base58 chars",
    explorerTx: "https://solscan.io/tx/",
  },
};

export type Destination = {
  alias: string;
  chain: string;
  token: string;
  account: string;
  assetId: string;
  decimals: number;
};

export class ValidationError extends Error {}

/** Validate a merchant-supplied destination against the catalog. Throws ValidationError with a helpful message. */
export function validateDestination(input: { chain?: unknown; token?: unknown; account?: unknown }) {
  const chain = String(input.chain ?? "").toLowerCase();
  const c = CHAINS[chain];
  if (!c) throw new ValidationError(`chain must be one of ${Object.keys(CHAINS).join(", ")}`);
  const token = String(input.token ?? "").toUpperCase();
  const t = c.tokens[token];
  if (!t)
    throw new ValidationError(
      `token on ${chain} must be one of ${Object.keys(c.tokens).join(", ")} (1Click lists no other USDC/USDT there)`,
    );
  const account = String(input.account ?? "").trim();
  if (!c.address.test(account)) throw new ValidationError(`account is not ${c.addressHint}`);
  return { chain, token, account, assetId: t.assetId, decimals: t.decimals };
}

/** Reverse lookup: which catalog chain/token is this 1Click asset id? */
export function describeAsset(assetId: string) {
  for (const [chain, c] of Object.entries(CHAINS)) {
    for (const [token, t] of Object.entries(c.tokens)) {
      if (t.assetId === assetId) return { chain, token, decimals: t.decimals, explorerTx: c.explorerTx };
    }
  }
  return undefined;
}

export class Destinations {
  private rows: Destination[] = [];

  constructor(private readonly file: string) {
    if (existsSync(file)) this.rows = JSON.parse(readFileSync(file, "utf8")) as Destination[];
  }

  list(): Destination[] {
    return this.rows;
  }

  get(alias: string): Destination | undefined {
    return this.rows.find((d) => d.alias === alias);
  }

  /** Validate and save. The alias is `chain-token`, suffixed `-2`, `-3`… when taken. */
  add(input: { chain?: unknown; token?: unknown; account?: unknown }): Destination {
    const v = validateDestination(input);
    const base = `${v.chain}-${v.token.toLowerCase()}`;
    let alias = base;
    for (let i = 2; this.get(alias); i++) alias = `${base}-${i}`;
    const row: Destination = { alias, ...v };
    this.rows.push(row);
    writeFileSync(this.file, JSON.stringify(this.rows, null, 2));
    return row;
  }
}
