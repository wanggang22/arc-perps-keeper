// Arc Perps keeper (B1: self-signed push oracle with REAL Pyth prices).
// Pyth's Aug-2026 upgrade broke on-chain VAA verification on Arc (InvalidWormholeVaa).
// So instead of pushing Pyth VAAs, we pull the REAL price from the (now authenticated)
// Hermes `parsed` field, sign it ourselves, and call PerpCore.updatePrice — which
// verifies OUR signature, not a Wormhole VAA. Then liquidate + fill orders.
import { ethers } from "ethers";
import { readFileSync } from "fs";

const d = JSON.parse(readFileSync(new URL("./deployments.json", import.meta.url)));
const RPC = process.env.ARC_RPC || d.rpc;
const CHAIN = Number(process.env.ARC_CHAIN_ID || d.chainId);
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS || 12_000);
const MAX_MIN = Number(process.env.KEEPER_MAX_MINUTES || 525600);
const HERMES = "https://pyth.dourolabs.app/hermes/v2/updates/price/latest";
if (!process.env.KEEPER_KEY) { console.error("KEEPER_KEY missing"); process.exit(1); }
if (!process.env.PYTH_API_KEY) { console.error("PYTH_API_KEY missing"); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC, CHAIN);
const w = new ethers.Wallet(process.env.KEEPER_KEY, provider); // also the oracle signer
const PERP_ABI = [
  "function updatePrice(uint256 marketId, (uint256 price,uint64 roundId,uint64 timestamp,bytes sig)) ",
  "function markets(uint256) view returns (bool listed,uint256 latestPrice,uint64 latestRound,uint64 latestTs,uint256 longOI,uint256 shortOI,int256 cumFundingWad,uint64 lastFundingTs)",
  "function latestPrice(uint256) view returns (uint256)",
  "function nextId() view returns (uint256)",
  "function nextOrderId() view returns (uint256)",
  "function orders(uint256) view returns (address trader,uint256 marketId,bool isLong,uint256 margin,uint256 leverageWad,uint256 triggerPrice,bool triggerAbove,bool reduceOnly,uint256 positionId,bool active)",
  "function isLiquidatable(uint256) view returns (bool)",
  "function liquidate(uint256)",
  "function executeOrder(uint256)",
];
const perp = new ethers.Contract(d.perp, PERP_ABI, w);
const AC = ethers.AbiCoder.defaultAbiCoder();
const log = (l, m, x = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), l, m, ...x }));

async function realPrices() {
  const qs = d.markets.map((m) => `ids[]=${m.feed}`).join("&");
  const r = await fetch(`${HERMES}?${qs}&encoding=hex`, { headers: { Authorization: `Bearer ${process.env.PYTH_API_KEY}` } });
  if (!r.ok) throw new Error("hermes " + r.status);
  const j = await r.json();
  const out = {};
  for (const p of j.parsed) {
    const expo = p.price.expo, price = BigInt(p.price.price);
    out["0x" + p.id.replace(/^0x/, "").toLowerCase()] = price * 10n ** BigInt(18 + expo); // -> WAD
  }
  return out;
}
async function sign(marketId, priceWad, roundId, ts) {
  const digest = ethers.keccak256(AC.encode(
    ["address", "uint256", "uint256", "uint256", "uint64", "uint64"],
    [d.perp, CHAIN, marketId, priceWad, roundId, ts]));
  return await w.signMessage(ethers.getBytes(digest));
}

async function tick() {
  // 1. push real, self-signed prices
  try {
    const px = await realPrices();
    const ts = BigInt((await provider.getBlock("latest")).timestamp);
    const shown = {};
    for (const m of d.markets) {
      const wad = px[m.feed.toLowerCase()];
      if (!wad) continue;
      const mk = await perp.markets(m.id);
      const round = mk[2] + 1n;
      const sig = await sign(m.id, wad, round, ts);
      await (await perp.updatePrice(m.id, [wad, round, ts, sig])).wait();
      shown[m.sym] = (+ethers.formatEther(wad)).toFixed(2);
    }
    log("INFO", "pushed", { prices: shown });
  } catch (e) { log("ERROR", "push failed", { err: e.shortMessage || e.message }); }

  // 2. liquidate under-maintenance positions
  try {
    const n = await perp.nextId();
    for (let i = 1n; i < n; i++) { try { if (await perp.isLiquidatable(i)) { await (await perp.liquidate(i)).wait(); log("INFO", "liquidated", { id: i.toString() }); } } catch {} }
  } catch {}
  // 3. fill triggered resting orders
  try {
    const n = await perp.nextOrderId();
    for (let i = 1n; i < n; i++) {
      try { const o = await perp.orders(i); if (!o.active) continue;
        const p = await perp.latestPrice(o.marketId);
        if (o.triggerAbove ? p >= o.triggerPrice : p <= o.triggerPrice) { await (await perp.executeOrder(i)).wait(); log("INFO", "order", { oid: i.toString() }); }
      } catch {} }
  } catch {}
}

log("INFO", "keeper up (B1 self-signed, real prices)", { perp: d.perp, signer: w.address, maxMin: MAX_MIN });
const deadline = Date.now() + MAX_MIN * 60_000;
await tick();
while (Date.now() < deadline) { await new Promise((r) => setTimeout(r, INTERVAL_MS)); await tick(); }
log("INFO", "max runtime reached, exiting for scheduler re-trigger");
process.exit(0);
