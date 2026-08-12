// Self-contained Pyth keeper for Arc Perps. Runs on a schedule via GitHub Actions
// (see .github/workflows/keeper.yml) using a low-privilege wallet (gas only —
// refresh/liquidate/executeOrder are permissionless, so this key controls nothing).
import { ethers } from "ethers";
import { readFileSync } from "fs";

const d = JSON.parse(readFileSync(new URL("./deployments-pyth.json", import.meta.url)));
const RPC = process.env.ARC_RPC || d.rpc;
const CHAIN = Number(process.env.ARC_CHAIN_ID || d.chainId);
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS || 12_000);
const MAX_MIN = Number(process.env.KEEPER_MAX_MINUTES || 525600); // exit cleanly before the Actions timeout
if (!process.env.KEEPER_KEY) { console.error("KEEPER_KEY missing"); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC, CHAIN);
const w = new ethers.Wallet(process.env.KEEPER_KEY, provider);
const PERP_ABI = [
  "function latestPrice(uint256) view returns (uint256)",
  "function nextId() view returns (uint256)",
  "function nextOrderId() view returns (uint256)",
  "function orders(uint256) view returns (address trader,uint256 marketId,bool isLong,uint256 margin,uint256 leverageWad,uint256 triggerPrice,bool triggerAbove,bool reduceOnly,uint256 positionId,bool active)",
  "function isLiquidatable(uint256) view returns (bool)",
  "function liquidate(uint256)",
  "function executeOrder(uint256)",
  "function refresh(bytes[] updateData) payable",
];
const perp = new ethers.Contract(d.perp, PERP_ABI, w);
const pyth = new ethers.Contract(d.pyth, ["function getUpdateFee(bytes[]) view returns (uint256)"], w);
const feeds = d.markets.map((m) => m.feed);
const log = (l, m, x = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), l, m, ...x }));

async function hermes() {
  const qs = feeds.map((i) => `ids[]=${i}`).join("&");
  const r = await fetch(`${d.hermes}?${qs}&encoding=hex`);
  if (!r.ok) throw new Error("hermes " + r.status);
  return (await r.json()).binary.data.map((x) => "0x" + x);
}

async function tick() {
  try {
    const data = await hermes();
    const fee = await pyth.getUpdateFee(data);
    await (await perp.refresh(data, { value: fee })).wait();
    const px = await Promise.all(d.markets.map((m) => perp.latestPrice(m.id)));
    log("INFO", "pushed", { prices: d.markets.map((m, i) => `${m.sym} ${(+ethers.formatEther(px[i])).toFixed(2)}`) });
  } catch (e) { log("ERROR", "push failed", { err: e.shortMessage || e.message }); }
  try { const n = await perp.nextId(); for (let i = 1n; i < n; i++) { try { if (await perp.isLiquidatable(i)) { await (await perp.liquidate(i)).wait(); log("INFO", "liquidated", { id: i.toString() }); } } catch {} } } catch {}
  try { const n = await perp.nextOrderId(); for (let i = 1n; i < n; i++) { try { const o = await perp.orders(i); if (!o.active) continue; const p = await perp.latestPrice(o.marketId); if (o.triggerAbove ? p >= o.triggerPrice : p <= o.triggerPrice) { await (await perp.executeOrder(i)).wait(); log("INFO", "order", { oid: i.toString() }); } } catch {} } } catch {}
}

log("INFO", "keeper up", { perp: d.perp, wallet: w.address, maxMin: MAX_MIN });
const deadline = Date.now() + MAX_MIN * 60_000;
await tick();
while (Date.now() < deadline) { await new Promise((r) => setTimeout(r, INTERVAL_MS)); await tick(); }
log("INFO", "max runtime reached, exiting for scheduler re-trigger");
process.exit(0);
