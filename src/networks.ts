/** Payment networks a merchant can redeem from, and destination aliases for the CLI. */

export type Network = {
  caip2: string;
  chainId: number;
  usdc: `0x${string}`; // native USDC contract (what buyers pay with)
  oneClickAsset: string; // the same USDC as a 1CS asset id (origin of the redeem swap)
  rpc: string; // public RPC, merchant CLI only
};

export const NETWORKS: Record<string, Network> = {
  "eip155:8453": {
    caip2: "eip155:8453",
    chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    oneClickAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    rpc: process.env.RPC_BASE ?? "https://mainnet.base.org",
  },
  "eip155:137": {
    caip2: "eip155:137",
    chainId: 137,
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    oneClickAsset: "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L",
    rpc: process.env.RPC_POLYGON ?? "https://polygon-rpc.com",
  },
  "eip155:42161": {
    caip2: "eip155:42161",
    chainId: 42161,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    oneClickAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    rpc: process.env.RPC_ARBITRUM ?? "https://arb1.arbitrum.io/rpc",
  },
};

/** Friendly names for `--to`; any raw 1CS asset id is accepted as well. */
export const DESTINATIONS: Record<string, string> = {
  "near-usdc": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "near-usdt": "nep141:usdt.tether-token.near",
  "tron-usdt": "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",
};

export const resolveDestination = (v: string): string => DESTINATIONS[v] ?? v;
