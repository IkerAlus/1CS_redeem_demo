/** Env → config. Loads `.env` if present (Node built-in, no dotenv). Fails fast on missing required values. */

try {
  process.loadEnvFile();
} catch {
  /* no .env file: rely on the environment */
}

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k} (see .env.example)`);
  return v;
};
const opt = (k: string, d: string): string => process.env[k] || d;

export const moduleConfig = () => ({
  port: Number(opt("MODULE_PORT", "4022")),
  oneClickJwt: process.env.ONE_CLICK_JWT || undefined,
  referral: opt("ONE_CLICK_REFERRAL", "1cs-redeem-demo"),
  redeemWindowMin: Number(opt("REDEEM_WINDOW_MIN", "30")),
  pollMs: Number(opt("POLL_MS", "5000")),
  ledgerFile: opt("LEDGER_FILE", "./ledger.json"),
});

export const gatewayConfig = () => ({
  port: Number(opt("GATEWAY_PORT", "4021")),
  priceUsd: opt("PRICE_USD", "0.05"),
  networks: opt("NETWORKS", "eip155:8453,eip155:137,eip155:42161").split(","),
  merchantWallet: need("MERCHANT_WALLET") as `0x${string}`,
  merchantPrivateKey: need("MERCHANT_PRIVATE_KEY") as `0x${string}`, // custodied by the gateway stand-in
  redeemRecipient: process.env.REDEEM_RECIPIENT || undefined, // seeds the default `near-usdc` destination
  destinationsFile: opt("DESTINATIONS_FILE", "./destinations.json"),
  moduleUrl: opt("MODULE_URL", "http://localhost:4022"),
  balancesFile: opt("BALANCES_FILE", "./balances.json"),
  cdpApiKeyId: need("CDP_API_KEY_ID"),
  cdpApiKeySecret: need("CDP_API_KEY_SECRET"),
});
