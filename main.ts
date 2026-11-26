// pumpfun graduation + flush bot — paper-trades pump.fun bonding curves on
// the agent-fun/replay/v2 harness (newline-delimited JSON on stdin/stdout).
//
// Two sleeves, one book (max 5 open positions):
//
//   Sleeve A — Graduation chase (the alpha). A coin whose real SOL reserves
//   reach 40 SOL is close to graduating off its bonding curve, and the
//   curve completes at a fixed ~14.7x the creation price, so a coin bought
//   near 40 SOL that graduates pays several multiples. Entry: real reserves
//   >= 40 SOL and price >= 1.5x creation. Size up to 0.08 SOL. Exit on
//   +100% take-profit, -20% stop-loss, a -20% trailing stop from the peak
//   since entry, or a 1000-batch time exit. A graduating coin is NOT sold:
//   the harness force-closes it at the completion price, which is where
//   the money is.
//
//   Sleeve B — Flush recovery (the breadth). Most coins pump, then dump as
//   early holders exit. After a >=40% flush from the peak, when the price
//   bounces >=8% off its post-flush low on a buy-dominant tape, the weak
//   supply is gone and the coin can run again. Entry: flushed, bounced,
//   real reserves >= 1 SOL. Size up to 0.03 SOL (small: this sleeve exists
//   to keep the book diversified across the >=20 distinct mints the
//   guardrail requires). Exit on +25% take-profit, -12% stop-loss, a -12%
//   trailing stop, or a 200-batch time exit.
//
// Each mint is traded at most once. No network, no randomness, no clocks:
// every decision is a pure function of the replay stream, so two runs
// produce identical action logs.
//
// Protocol (see protocol.schema.json in the kit):
//   harness -> bot: {"type":"hello",...} then {"type":"batch",seq,slot,
//                  events,marks,fills,account} ... then {"type":"done",...}
//   bot -> harness: one {"type":"reply",seq,orders} per batch.
//   buy order:  {side:"buy", client_id, mint, quote_lamports, max_slippage_bps}
//   sell order: {side:"sell", client_id, mint, token_amount, max_slippage_bps}
//   All u64 amounts are decimal strings. Price (SOL per token) is
//   virtual_sol_reserves / virtual_token_reserves on the bonding curve.

import * as process from "node:process";

// ---- tunables (all in lamports unless noted; 1 SOL = 1_000_000_000) ----
// Sleeve A — graduation chase
const GRAD_MIN_REAL_SOL = 40_000_000_000; // 40 SOL of real reserves
const GRAD_MIN_MULT = 1.5; // price must be >= 1.5x creation
const GRAD_MAX_BUY = 80_000_000; // 0.08 SOL
const GRAD_TP_MULT = 2.0; // take profit +100%
const GRAD_SL_MULT = 0.8; // stop loss -20%
const GRAD_TRAIL_MULT = 0.8; // trailing stop -20% from peak
const GRAD_MAX_HOLD = 1000; // batches
// Sleeve B — flush recovery
const FLUSH_MIN_REAL_SOL = 1_000_000_000; // 1 SOL of real reserves
const FLUSH_DROP = 0.6; // price fell to <= 60% of its peak (a >=40% flush)
const FLUSH_PEAK_MIN_MULT = 1.5; // the peak must have been >= 1.5x creation
const FLUSH_BOUNCE = 1.20; // bounced >= 20% off the post-flush low
const FLUSH_MAX_FROM_PEAK = 0.85; // do not chase all the way back to the peak
const FLUSH_MAX_BUY = 20_000_000; // 0.02 SOL (breadth sleeve: keep it small)
const FLUSH_TP_MULT = 1.35; // take profit +35%
const FLUSH_SL_MULT = 0.88; // stop loss -12%
const FLUSH_TRAIL_MULT = 0.88; // trailing stop -12% from peak
const FLUSH_MAX_HOLD = 200; // batches
// Shared
const MIN_BUY_LAMPORTS = 12_000_000; // 0.012 SOL floor (guardrail needs 0.01)
const BUY_BPS_OF_REAL = 90; // size = 0.9% of real SOL reserves
const MAX_SLIPPAGE_BPS = 300; // 3% slippage guard on every order
const RECENT_WINDOW = 8; // last N trades used for the buy-dominance check
const MIN_RECENT_BUYS = 4; // need >= 4 buys out of the last 8 trades
const PENDING_TTL_BATCHES = 10; // forget a pending order after this long
const MAX_ORDERS_PER_BATCH = 16; // harness cap (we stay well under it)

// ---- per-mint market state, built from the replay stream ----
interface MintState {
  mint: string;
  createPrice: number; // SOL per token at creation
  lastPrice: number; // SOL per token at the latest event/mark
  peakPrice: number; // highest price seen since creation
  lowAfterPeak: number; // lowest price since the peak (0 = none yet)
  realSol: number; // real SOL reserves (lamports)
  recentBuys: number; // buys among the last RECENT_WINDOW trades
  recentTrades: boolean[]; // ring of is_buy flags, newest last
  completed: boolean; // saw a CompleteEvent (graduated)
  seen: number; // trades seen for this mint
}

interface Position {
  mint: string;
  tokenAmount: string; // exact string from the account snapshot
  costLamports: number; // SOL spent (lamports)
  entryPrice: number; // costLamports / tokenAmount (SOL per token)
  peakPrice: number; // highest lastPrice seen while holding
  entryBatch: number; // batch index where the fill first appeared
  sleeve: "grad" | "flush"; // which sleeve opened this position
}

interface Pending {
  mint: string;
  side: "buy" | "sell";
  batch: number; // batch index when the order was sent
}

// ---- runtime state ----
let capitalLamports = 10_000_000_000;
let maxOpenPositions = 5;
let maxOrderBpsOfReal = 100;
let maxOrdersPerBatch = 16;
let cashLamports = 10_000_000_000;
let batchIndex = 0;
let orderCounter = 0;

const mints = new Map<string, MintState>();
const positions = new Map<string, Position>();
const traded = new Set<string>(); // mints we already bought once (never re-buy)
const pending = new Map<string, Pending>(); // client_id -> pending order
const pendingByMint = new Map<string, string>(); // mint -> client_id
let sellsRequested = new Set<string>(); // mints with a sell already in flight
// client_id -> sleeve for buys still in flight (resolved on first sighting
// of the position in the account snapshot).
const pendingSleeve = new Map<string, "grad" | "flush">();

function priceOf(virtualSol: string, virtualToken: string): number {
  const s = Number(virtualSol);
  const t = Number(virtualToken);
  if (t <= 0) return 0;
  return s / t;
}

function lamports(s: string | undefined): number {
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// ---- stream ingestion: fold every event into per-mint state ----
function newMint(mint: string, price: number): MintState {
  return {
    mint,
    createPrice: price,
    lastPrice: price,
    peakPrice: price,
    lowAfterPeak: 0,
    realSol: 0,
    recentBuys: 0,
    recentTrades: [],
    completed: false,
    seen: 0,
  };
}

function onCreate(ev: any): void {
  const mint = String(ev.mint);
  if (mints.has(mint)) return;
  const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
  if (p <= 0) return;
  mints.set(mint, newMint(mint, p));
}

function onTrade(ev: any): void {
  const mint = String(ev.mint);
  let st = mints.get(mint);
  if (!st) {
    // A trade for a mint whose CreateEvent we missed: seed from the trade.
    const p0 = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
    if (p0 <= 0) return;
    st = newMint(mint, p0);
    mints.set(mint, st);
  }
  const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
  if (p > 0) {
    st.lastPrice = p;
    if (p > st.peakPrice) {
      st.peakPrice = p;
      st.lowAfterPeak = 0; // a new peak resets the post-peak low
    } else if (st.lowAfterPeak === 0 || p < st.lowAfterPeak) {
      st.lowAfterPeak = p;
    }
  }
  st.realSol = lamports(ev.real_sol_reserves);
  st.seen += 1;
  const isBuy = ev.is_buy === true;
  st.recentTrades.push(isBuy);
  if (isBuy) st.recentBuys += 1;
  if (st.recentTrades.length > RECENT_WINDOW) {
    const dropped = st.recentTrades.shift();
    if (dropped) st.recentBuys -= 1;
  }
}

function onComplete(ev: any): void {
  const st = mints.get(String(ev.mint));
  if (st) st.completed = true;
}

function onMarks(marks: any[]): void {
  if (!Array.isArray(marks)) return;
  for (const m of marks) {
    const st = mints.get(String(m.mint));
    if (!st) continue;
    const p = priceOf(m.virtual_quote_reserves, m.virtual_token_reserves);
    if (p > 0) {
      st.lastPrice = p;
      if (p > st.peakPrice) {
        st.peakPrice = p;
        st.lowAfterPeak = 0;
      } else if (st.lowAfterPeak === 0 || p < st.lowAfterPeak) {
        st.lowAfterPeak = p;
      }
    }
    const r = lamports(m.real_quote_reserves);
    if (r > 0) st.realSol = r;
  }
}

// ---- fills + account: reconcile what we hold and what is still pending ----
function onFills(fills: any[]): void {
  if (!Array.isArray(fills)) return;
  for (const f of fills) {
    const cid = String(f.client_id || "");
    const p = pending.get(cid);
    if (!p) continue;
    if (f.status === "rejected" || f.status === "failed") {
      pending.delete(cid);
      pendingByMint.delete(p.mint);
      sellsRequested.delete(p.mint);
    }
    // A "filled" order stays pending until the account snapshot shows it:
    // the snapshot in this same batch may already reflect it, and the
    // sync step below clears it. A stale pending entry expires by TTL.
  }
}

function syncAccount(account: any): void {
  if (!account) return;
  cashLamports = lamports(account.cash_lamports);
  const seen = new Set<string>();
  const held = Array.isArray(account.positions) ? account.positions : [];
  for (const pos of held) {
    const mint = String(pos.mint);
    seen.add(mint);
    const tokens = String(pos.token_amount);
    const cost = lamports(pos.cost_lamports);
    const existing = positions.get(mint);
    if (existing && existing.tokenAmount === tokens && existing.costLamports === cost) {
      continue; // unchanged
    }
    const amount = Number(tokens);
    const entryPrice = amount > 0 && cost > 0 ? cost / amount : 0;
    const st = mints.get(mint);
    const cur = st ? st.lastPrice : entryPrice;
    // Resolve which sleeve opened this position: the buy still in flight
    // for this mint carries it (a brand-new position defaults to flush).
    let sleeve: "grad" | "flush" = existing ? existing.sleeve : "flush";
    const buyCid = pendingByMint.get(mint);
    if (!existing && buyCid) {
      const s = pendingSleeve.get(buyCid);
      if (s) sleeve = s;
    }
    positions.set(mint, {
      mint,
      tokenAmount: tokens,
      costLamports: cost,
      entryPrice,
      peakPrice: Math.max(existing ? existing.peakPrice : 0, entryPrice, cur),
      entryBatch: existing ? existing.entryBatch : batchIndex,
      sleeve,
    });
    // A buy we sent has now landed: clear it from pending.
    const cid = pendingByMint.get(mint);
    if (cid) {
      const p = pending.get(cid);
      if (p && p.side === "buy") {
        pending.delete(cid);
        pendingByMint.delete(mint);
      }
    }
  }
  // Positions that vanished from the snapshot are closed (sold, graduated
  // or written off): drop them and clear any sell that was in flight.
  for (const mint of Array.from(positions.keys())) {
    if (!seen.has(mint)) {
      positions.delete(mint);
      const cid = pendingByMint.get(mint);
      if (cid) {
        pending.delete(cid);
        pendingByMint.delete(mint);
      }
      sellsRequested.delete(mint);
    }
  }
  // Expire stale pending orders so a lost fill can never block a mint.
  for (const [cid, p] of Array.from(pending.entries())) {
    if (batchIndex - p.batch > PENDING_TTL_BATCHES) {
      pending.delete(cid);
      pendingByMint.delete(p.mint);
      sellsRequested.delete(p.mint);
    }
  }
}

// ---- strategy: two sleeves, one book ----
// A mint is "flushed" when it peaked >= 1.5x creation and has since fallen
// to <= 60% of that peak. It is a buy when it then bounces >= 8% off its
// post-flush low without running all the way back to the peak.
function isFlushed(st: MintState): boolean {
  if (st.peakPrice < st.createPrice * FLUSH_PEAK_MIN_MULT) return false;
  if (st.lowAfterPeak <= 0) return false;
  return st.lowAfterPeak <= st.peakPrice * FLUSH_DROP;
}

function buySizeLamports(st: MintState, cap: number): number {
  const byReserve = Math.floor((st.realSol * BUY_BPS_OF_REAL) / 10000);
  return Math.min(cap, byReserve);
}

function sleeveFor(st: MintState): "grad" | "flush" | null {
  if (traded.has(st.mint)) return null;
  if (positions.has(st.mint)) return null;
  if (pendingByMint.has(st.mint)) return null;
  if (positions.size >= maxOpenPositions) return null;
  if (st.completed) return null;
  if (st.seen < 2) return null;
  // Sleeve A first: a big coin near graduation.
  if (
    st.realSol >= GRAD_MIN_REAL_SOL &&
    st.lastPrice >= st.createPrice * GRAD_MIN_MULT &&
    buySizeLamports(st, GRAD_MAX_BUY) >= MIN_BUY_LAMPORTS &&
    cashLamports >= buySizeLamports(st, GRAD_MAX_BUY) + 200_000
  ) {
    return "grad";
  }
  // Sleeve B: a flushed coin bouncing off its low on a buy-dominant tape.
  if (
    st.realSol >= FLUSH_MIN_REAL_SOL &&
    isFlushed(st) &&
    st.lowAfterPeak > 0 &&
    st.lastPrice >= st.lowAfterPeak * FLUSH_BOUNCE &&
    st.lastPrice <= st.peakPrice * FLUSH_MAX_FROM_PEAK &&
    st.recentBuys >= MIN_RECENT_BUYS &&
    buySizeLamports(st, FLUSH_MAX_BUY) >= MIN_BUY_LAMPORTS &&
    cashLamports >= buySizeLamports(st, FLUSH_MAX_BUY) + 200_000
  ) {
    return "flush";
  }
  return null;
}

function sellReason(pos: Position, st: MintState | undefined): string | null {
  if (!st) return null;
  // A graduating coin is never sold by us: the harness force-closes it at
  // the completion price, which is where the money is.
  if (st.completed) return null;
  const cur = st.lastPrice;
  if (cur <= 0 || pos.entryPrice <= 0) return null;
  if (pos.sleeve === "grad") {
    if (cur >= pos.entryPrice * GRAD_TP_MULT) return "take-profit";
    if (cur <= pos.entryPrice * GRAD_SL_MULT) return "stop-loss";
    if (cur <= pos.peakPrice * GRAD_TRAIL_MULT) return "trailing-stop";
    if (batchIndex - pos.entryBatch >= GRAD_MAX_HOLD) return "time-exit";
  } else {
    if (cur >= pos.entryPrice * FLUSH_TP_MULT) return "take-profit";
    if (cur <= pos.entryPrice * FLUSH_SL_MULT) return "stop-loss";
    if (cur <= pos.peakPrice * FLUSH_TRAIL_MULT) return "trailing-stop";
    if (batchIndex - pos.entryBatch >= FLUSH_MAX_HOLD) return "time-exit";
  }
  return null;
}

function decideOrders(): any[] {
  const orders: any[] = [];
  // 1) Exits first: free slots before considering new entries.
  for (const pos of positions.values()) {
    if (orders.length >= maxOrdersPerBatch) break;
    if (sellsRequested.has(pos.mint)) continue;
    const st = mints.get(pos.mint);
    const reason = sellReason(pos, st);
    if (!reason) continue;
    orderCounter += 1;
    const cid = `s${batchIndex}-${orderCounter}`;
    orders.push({
      side: "sell",
      client_id: cid,
      mint: pos.mint,
      token_amount: pos.tokenAmount,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    pending.set(cid, { mint: pos.mint, side: "sell", batch: batchIndex });
    pendingByMint.set(pos.mint, cid);
    sellsRequested.add(pos.mint);
  }
  // 2) Entries: graduation chases first (they carry the upside), then
  // flush recoveries (they carry the breadth).
  const grads: MintState[] = [];
  const flushes: MintState[] = [];
  for (const st of mints.values()) {
    const sleeve = sleeveFor(st);
    if (sleeve === "grad") grads.push(st);
    else if (sleeve === "flush") flushes.push(st);
  }
  grads.sort((a, b) => b.realSol - a.realSol);
  flushes.sort((a, b) => b.lastPrice / b.createPrice - a.lastPrice / a.createPrice);
  const queue: Array<{ st: MintState; sleeve: "grad" | "flush" }> = [
    ...grads.map((st) => ({ st, sleeve: "grad" as const })),
    ...flushes.map((st) => ({ st, sleeve: "flush" as const })),
  ];
  for (const { st, sleeve } of queue) {
    if (orders.length >= maxOrdersPerBatch) break;
    const buysSent = orders.filter((o) => o.side === "buy").length;
    if (positions.size + buysSent >= maxOpenPositions) break;
    const cap = sleeve === "grad" ? GRAD_MAX_BUY : FLUSH_MAX_BUY;
    const size = buySizeLamports(st, cap);
    if (size < MIN_BUY_LAMPORTS) continue;
    if (cashLamports < size + 200_000) continue;
    orderCounter += 1;
    const cid = `b${batchIndex}-${orderCounter}`;
    orders.push({
      side: "buy",
      client_id: cid,
      mint: st.mint,
      quote_lamports: String(size),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    pending.set(cid, { mint: st.mint, side: "buy", batch: batchIndex });
    pendingByMint.set(st.mint, cid);
    traded.add(st.mint);
    // Remember which sleeve opened it, so the exit rules match.
    pendingSleeve.set(cid, sleeve);
    cashLamports -= size; // reserve the cash until the fill settles
  }
  return orders;
}

// ---- main loop: NDJSON in, one reply per batch, summary on done ----
let buffer = "";
let helloSeen = false;
let batchesSeen = 0;
let buysSent = 0;
let sellsSent = 0;
let gradBuysSent = 0;
let flushBuysSent = 0;

function sendReply(seq: number, orders: any[]): void {
  const line = JSON.stringify({ type: "reply", seq, orders });
  process.stdout.write(line + "\n");
}

function handleMessage(msg: any): void {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "hello") {
    helloSeen = true;
    if (msg.capital) capitalLamports = lamports(msg.capital.lamports);
    cashLamports = capitalLamports;
    if (msg.caps) {
      if (typeof msg.caps.max_open_positions === "number") {
        maxOpenPositions = msg.caps.max_open_positions;
      }
      if (typeof msg.caps.max_order_bps_of_real_reserve === "number") {
        maxOrderBpsOfReal = msg.caps.max_order_bps_of_real_reserve;
      }
      if (typeof msg.caps.max_orders_per_batch === "number") {
        maxOrdersPerBatch = Math.min(
          msg.caps.max_orders_per_batch,
          MAX_ORDERS_PER_BATCH,
        );
      }
    }
    return;
  }
  if (msg.type === "batch") {
    batchIndex = typeof msg.seq === "number" ? msg.seq : batchIndex + 1;
    batchesSeen += 1;
    const events = Array.isArray(msg.events) ? msg.events : [];
    for (const ev of events) {
      if (ev.event === "CreateEvent") onCreate(ev);
      else if (ev.event === "TradeEvent") onTrade(ev);
      else if (ev.event === "CompleteEvent") onComplete(ev);
    }
    onMarks(msg.marks);
    onFills(msg.fills);
    syncAccount(msg.account);
    // Refresh the trailing-stop peak for every open position.
    for (const pos of positions.values()) {
      const st = mints.get(pos.mint);
      if (st && st.lastPrice > pos.peakPrice) pos.peakPrice = st.lastPrice;
    }
    const orders = decideOrders();
    for (const o of orders) {
      if (o.side === "buy") {
        buysSent += 1;
        if (pendingSleeve.get(o.client_id) === "grad") gradBuysSent += 1;
        else flushBuysSent += 1;
      } else sellsSent += 1;
    }
    sendReply(typeof msg.seq === "number" ? msg.seq : 0, orders);
    return;
  }
  if (msg.type === "done") {
    const summary = {
      helloSeen,
      batchesSeen,
      buysSent,
      gradBuysSent,
      flushBuysSent,
      sellsSent,
      distinctMintTraded: traded.size,
      openPositions: positions.size,
      finalCashLamports: cashLamports,
    };
    process.stderr.write("BOT DONE " + JSON.stringify(summary) + "\n");
    return;
  }
}

function handleLine(line: string): void {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore a malformed line; the next batch still gets a reply
  }
  try {
    handleMessage(msg);
  } catch (err) {
    // Never die on a bad batch: report to stderr and keep the stream alive.
    process.stderr.write("BOT ERROR " + String(err) + "\n");
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let idx = buffer.indexOf("\n");
  while (idx >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    handleLine(line);
    idx = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (buffer.trim()) handleLine(buffer);
});
