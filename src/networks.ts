/** Payment networks a merchant can redeem from (where x402 balances accumulate). Destinations live in destinations.ts. */

export type Network = {
  caip2: string;
  name: string;
  chainId: number;
  explorerTx: string; // block-explorer prefix for a tx hash
  usdc: `0x${string}`; // native USDC contract (what buyers pay with)
  oneClickAsset: string; // the same USDC as a 1CS asset id (origin of the redeem swap)
  rpc: string; // public RPC (gateway: redeem transfer)
};

export const NETWORKS: Record<string, Network> = {
  "eip155:8453": {
    caip2: "eip155:8453",
    name: "Base",
    chainId: 8453,
    explorerTx: "https://basescan.org/tx/",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    oneClickAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    rpc: process.env.RPC_BASE ?? "https://mainnet.base.org",
  },
  "eip155:137": {
    caip2: "eip155:137",
    name: "Polygon",
    chainId: 137,
    explorerTx: "https://polygonscan.com/tx/",
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    oneClickAsset: "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L",
    rpc: process.env.RPC_POLYGON ?? "https://polygon-bor-rpc.publicnode.com",
  },
  "eip155:42161": {
    caip2: "eip155:42161",
    name: "Arbitrum",
    chainId: 42161,
    explorerTx: "https://arbiscan.io/tx/",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    oneClickAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    rpc: process.env.RPC_ARBITRUM ?? "https://arb1.arbitrum.io/rpc",
  },
};
