// Fresh-flow momentum bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2).
//
// Idea: most new pump.fun coins die fast, but the ones that keep attracting
// broad, accelerating buy flow for a few minutes after launch sometimes run
// much further. This bot only buys coins whose recent tape shows that flow
// (at least 2 SOL of net inflow from at least 8 distinct buyers across at
// least 8 trades in the last 60 slots, price rising but not already
// vertical), buys once, and gets out fast on a stop loss, a take profit, a
// trailing stop, fading flow, or the creator selling. No adds and no
// re-entries: on the dev window both tested worse than a single first buy.
// A tiny probe round-trip keeps the run above the guardrail (20 distinct
// coins) when the main signal goes quiet.
//
// The bot is a pure function of the hello message and the batches it is
// fed: no clock, no randomness, no I/O, no environment. Iteration is only
// over insertion-ordered maps fed by the batch stream, so two runs of the
// same replay write identical replies.
//
// Run by the grader as `node /bot/main.ts` with this directory mounted at
// /bot. The wire shim is vendored beside it at vendor/makefun-bot.ts
// (a byte-identical copy of the kit's sdk/ts/makefun-bot.ts).

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000; // lamports per SOL, as a number
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps
const BPS = 10_000;

// ---------------------------------------------------------------- params

interface Params {
  /** Entry lookback, in slots. */
  window: number;
  /** Minimum net inflow (buys minus sells, SOL) over the window. */
  minNetSol: number;
  /** Minimum buy trades in the window. */
  minBuys: number;
  /** Minimum distinct buying wallets in the window. */
  minBuyers: number;
  /** Minimum price rise over the window (fraction). */
  minRise: number;
  /** Maximum price rise over the window (fraction): skip vertical runs. */
  maxRise: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Newer-half net inflow must be at least this multiple of the older half. */
  accel: number;
  /** Largest single buyer's share of the window's buy SOL, at most. */
  maxTopBuyer: number;
  /** Real SOL reserve window at entry. */
  minRealSol: number;
  maxRealSol: number;
  /** Slots since CreateEvent before an entry is allowed. */
  minAge: number;
  /** The one buy of a position, SOL (no adds: re-entries tested worse). */
  firstBuySol: number;
  /** Most SOL into one coin in total. */
  stakeSol: number;
  /** Smallest buy worth sending, SOL. */
  minBuySol: number;
  /** Slippage allowed on buys, bps. */
  buySlipBps: number;
  /** Exit when the position is worth this far under its cost. */
  stopLoss: number;
  /** Exit when the position is worth this far over its cost. */
  takeProfit: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** ...then exit on a fall of this share from the best value. */
  trailDrop: number;
  /** Exit after holding this many slots (doubled while up trailArm or more). */
  maxHold: number;
  /** Fade window (slots) and exit threshold (net SOL below this). */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing targets (fills / coins over paceSecs of block time). */
  targetFills: number;
  targetCoins: number;
  paceSecs: number;
  /** One probe round trip buys this much SOL. */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
}

const P: Params = {
  window: 60,
  minNetSol: 2,
  minBuys: 8,
  minBuyers: 8,
  minRise: 0.03,
  maxRise: 1.2,
  nearHigh: 0.9,
  accel: 1,
  maxTopBuyer: 0.6,
  minRealSol: 1,
  maxRealSol: 80,
  minAge: 240,
  firstBuySol: 0.2,
  stakeSol: 0.2,
  minBuySol: 0.01,
  buySlipBps: 1000,
  stopLoss: 0.12,
  takeProfit: 0.15,
  trailArm: 0.1,
  trailDrop: 0.25,
  maxHold: 600,
  fadeWindow: 20,
  fadeNetSol: -0.5,
  bigSellSol: 2,
  cooldown: 300,
  maxEntries: 1,
  maxMain: 5,
  maxExposureSol: 3,
  targetFills: 300,
  targetCoins: 30,
  paceSecs: 100_000,
  probeSol: 0.02,
  maxProbes: 1,
};

// ---------------------------------------------------------------- tape

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
  price: number; // virtual quote / virtual token at the trade
}

interface CoinTape {
  created: number | null;
  creator: Pubkey | null;
  creatorSold: boolean;
  trades: Tick[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peak: number; // best close value seen, SOL
  invested: number; // SOL sent in buys (fees included in cost, not here)
  exiting: boolean;
  filled: boolean;
}

const tapes = new Map<Pubkey, CoinTape>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint. */
const probes = new Set<Pubkey>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Pubkey): CoinTape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, creator: null, creatorSold: false, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** Net SOL (buys minus sells) over the last `w` slots, walking back. */
function flow(t: CoinTape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** Entry signal on a coin's tape at slot `now`. */
function entryOk(t: CoinTape, now: number, realSol: number): boolean {
  if (realSol < P.minRealSol || realSol > P.maxRealSol) return false;
  if (t.created === null || now - t.created < P.minAge) return false;
  if (t.creatorSold) return false;
  const from = now - P.window;
  const mid = now - P.window / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const buyers = new Map<Pubkey, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < P.minBuys || buyers.size < P.minBuyers) return false;
  if (buySol - sellSol < P.minNetSol) return false;
  if (startPrice <= 0) return false;
  const rise = last / startPrice - 1;
  if (rise < P.minRise || rise > P.maxRise) return false;
  if (last < high * P.nearHigh) return false;
  if (netNew <= 0 || netNew < P.accel * netOld) return false;
  let top = 0;
  for (const v of buyers.values()) if (v > top) top = v;
  if (top > P.maxTopBuyer * buySol) return false;
  return true;
}

/** What selling `tokens` against (vq, vt) pays, after curve fees, in SOL. */
function sellValueSol(tokens: bigint, vq: bigint, vt: bigint): number {
  if (tokens <= 0n || vt <= 0n) return 0;
  const q = Number((tokens * vq) / (vt + tokens)) / SOL;
  return q * (1 - CURVE_FEE);
}

function pendingSide(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
  for (const po of state.pending.values()) {
    if (po.order.mint === mint && po.order.side === side) return true;
  }
  return false;
}

// ---------------------------------------------------------------- bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const bigSell = new Set<Pubkey>();
    const traded = new Set<Pubkey>();

    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }

    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const t = tapeOf(e.mint);
        t.created = e.slot;
        t.creator = e.creator;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / SOL;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
        if (!e.is_buy && t.creator !== null && e.user === t.creator) t.creatorSold = true;
        if (!e.is_buy && sol >= P.bigSellSol) bigSell.add(e.mint);
      } else {
        // CompleteEvent: the curve is done; drop its tape's entry hopes.
        const t = tapes.get(e.mint);
        if (t !== undefined) t.lastExit = now;
      }
    }

    // Prune trades older than any window we read.
    const keep = Math.max(P.window, P.fadeWindow) + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const txSol = Number(state.txFeeLamports()) / SOL;

    const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint; realSol: number } | null => {
      const mk = marks.get(mint);
      if (mk !== undefined) {
        return {
          vq: BigInt(mk.virtual_quote_reserves),
          vt: BigInt(mk.virtual_token_reserves),
          realSol: Number(mk.real_quote_reserves) / SOL,
        };
      }
      const c = state.curves.get(mint);
      if (c === undefined) return null;
      return { vq: c.virtual_quote_reserves, vt: c.virtual_token_reserves, realSol: Number(c.real_quote_reserves) / SOL };
    };

    // --- Exits first.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingSide(state, mint, 'buy') && !pendingSide(state, mint, 'sell')) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const r = reservesOf(mint);
      if (r === null) continue;
      const value = sellValueSol(pos.token_amount, r.vq, r.vt) - txSol;
      const cost = Number(pos.cost_lamports) / SOL;
      if (value > h.peak) h.peak = value;
      const t = tapeOf(mint);
      let exit = h.exiting;
      if (!exit && value < cost * (1 - P.stopLoss)) exit = true;
      if (!exit && value >= cost * (1 + P.takeProfit)) exit = true;
      if (!exit && h.peak >= cost * (1 + P.trailArm) && value < h.peak * (1 - P.trailDrop)) exit = true;
      if (!exit && flow(t, now, P.fadeWindow) < P.fadeNetSol) exit = true;
      if (!exit && bigSell.has(mint)) exit = true;
      if (!exit && t.creatorSold) exit = true;
      const holdLimit = value >= cost * (1 + P.trailArm) ? P.maxHold * 2 : P.maxHold;
      if (!exit && now - h.opened > holdLimit) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (pendingSide(state, mint, 'sell')) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
    }

    // --- Probe sells: a probe round trip closes as soon as its buy lands.
    for (const mint of [...probes]) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingSide(state, mint, 'buy') && !pendingSide(state, mint, 'sell')) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      if (pendingSide(state, mint, 'buy') || pendingSide(state, mint, 'sell')) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
    }

    // --- Entries: one buy per coin, first fire only. No adds and no
    // re-entries: on the dev window both tested worse than a single
    // first buy (they mostly averaged down into coins already fading).
    let free = Number(state.freeCashLamports()) / SOL;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let mainLeft = P.maxMain - held.size;
    let exposure = 0;
    for (const [mint, h] of held) {
      exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / SOL);
    }
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingSide(state, mint, 'buy') || pendingSide(state, mint, 'sell')) continue;
      if (probes.has(mint)) continue;
      if (held.has(mint)) continue;
      const t = tapes.get(mint)!;
      const r = reservesOf(mint);
      if (r === null) continue;
      if (slotsLeft <= 0 || mainLeft <= 0) continue;
      if (t.entries >= P.maxEntries || now - t.lastExit < P.cooldown) continue;
      if (!entryOk(t, now, r.realSol)) continue;
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / SOL;
      let amount = Math.min(capSol, P.firstBuySol, P.stakeSol, P.maxExposureSol - exposure);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < P.minBuySol) continue;
      const lamports = BigInt(Math.floor(amount * SOL));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: P.buySlipBps });
      free -= amount + txSol;
      exposure += amount;
      held.set(mint, { opened: now, peak: 0, invested: amount, exiting: false, filled: false });
      t.entries++;
      slotsLeft--;
      mainLeft--;
    }

    // --- Guardrail pacing: open a tiny probe round trip when fills or
    // coins lag the pace, so the run clears 20 distinct coins.
    if (probes.size < P.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / P.paceSecs);
      const needCoins = myCoins.size < Math.ceil(P.targetCoins * pace);
      const needFills = myFills < Math.ceil(P.targetFills * pace);
      if (needCoins || needFills) {
        const minReal = (P.probeSol * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= P.maxProbes) break;
          if (held.has(mint) || probes.has(mint)) continue;
          if (pendingSide(state, mint, 'buy') || pendingSide(state, mint, 'sell')) continue;
          if (state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / SOL < minReal * 1.5) continue;
          if (free < P.probeSol + 2 * txSol) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(P.probeSol * SOL)), max_slippage_bps: P.buySlipBps });
          probes.add(mint);
          free -= P.probeSol + txSol;
        }
      }
    }

    return orders;
  },
});
