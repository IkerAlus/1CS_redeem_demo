import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAINS, describeAsset, Destinations, validateDestination, ValidationError } from "./destinations.js";

test("validateDestination: accepts every catalog chain with a well-formed address", () => {
  const ok: Record<string, string> = {
    near: "ikerpriv.near",
    tron: "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9",
    ethereum: "0xBd295bc77B6C3D2945bE165012Db3E68605C5c25",
    bitcoin: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    zcash: "t1Rj8Y4TfgM4Z1TJLvcJK8Bz2SJVfX8uHmq",
    solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  };
  for (const [chain, account] of Object.entries(ok)) {
    for (const token of Object.keys(CHAINS[chain]!.tokens)) {
      const v = validateDestination({ chain, token: token.toLowerCase(), account });
      assert.equal(v.chain, chain);
      assert.equal(v.token, token);
      assert.ok(v.assetId.startsWith("nep141:"));
    }
  }
});

test("validateDestination: rejects unknown chain, unsupported token, malformed address", () => {
  assert.throws(() => validateDestination({ chain: "base", token: "USDC", account: "0x" }), ValidationError);
  assert.throws(
    () => validateDestination({ chain: "tron", token: "USDC", account: "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9" }),
    /USDT/,
  );
  assert.throws(() => validateDestination({ chain: "bitcoin", token: "USDT", account: "bc1q" }), /BTC/);
  assert.throws(
    () =>
      validateDestination({ chain: "solana", token: "USDC", account: "0xBd295bc77B6C3D2945bE165012Db3E68605C5c25" }),
    /Solana/,
  );
  assert.throws(() => validateDestination({ chain: "near", token: "USDC", account: "Iker.Near" }), /NEAR/);
  assert.throws(() => validateDestination({ chain: "ethereum", token: "ETH", account: "0x123" }), /EVM/);
});

test("Destinations: alias is chain-token, suffixed when taken; persists across reloads", () => {
  const file = join(mkdtempSync(join(tmpdir(), "dest-")), "destinations.json");
  const d = new Destinations(file);
  const a = d.add({ chain: "solana", token: "usdc", account: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" });
  assert.equal(a.alias, "solana-usdc");
  const b = d.add({ chain: "solana", token: "USDC", account: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" });
  assert.equal(b.alias, "solana-usdc-2");
  assert.throws(
    () => d.add({ chain: "tron", token: "USDC", account: "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9" }),
    ValidationError,
  );
  const reloaded = new Destinations(file);
  assert.equal(reloaded.list().length, 2);
  assert.equal(reloaded.get("solana-usdc-2")?.account, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
});

test("describeAsset: reverse lookup gives chain, token, decimals, explorer", () => {
  const d = describeAsset("nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near");
  assert.deepEqual(d, { chain: "solana", token: "USDC", decimals: 6, explorerTx: "https://solscan.io/tx/" });
  assert.equal(describeAsset("nep141:wrap.near")?.decimals, 24);
  assert.equal(describeAsset("nep141:unknown.near"), undefined);
});
