# Pump.fun Momentum Bot — design notes

## The game

The harness (`pumpfun-replay/v2`) replays real pump.fun bonding-curve
events. The bot starts with 10 SOL of paper capital, may hold at most 5
open positions, may not order more than 1% of a coin's real SOL reserves
in one order, and pays ~1.25% protocol+creator fees plus 0.000105 SOL of
transaction fees per fill. Ranking is pure net PnL on a 6-hour window the
house collects after entries close. A prize needs net PnL > 0 SOL, a round
trip of ≥0.01 SOL on each of ≥20 distinct coins, and max drawdown ≤50%.

## What the dev data says

The kit's dev window (24h, 2026-11-02 → 2026-11-03, 128,058 events,
1,222 mints) shows the classic pump.fun shape:

- Median peak vs creation price: **1.53x**; 62% of coins reach +30%,
  51% reach +50%, 31% reach +100%.
- Median end vs creation: **1.00x** — most coins give it all back. You
  must sell into strength; holding to the end earns nothing.
- The bonding curve completes at a **fixed ~14.7x the creation price**,
  and 35 coins completed in the dev window. 46% of the coins that reach
  40 SOL of real reserves go on to complete. A coin bought near 40 SOL
  that graduates pays several multiples — that is the fat right tail
  this bot fishes for.
- Plain momentum buying (buy after a rise) loses money here: the bot
  buys at the median peak, because by the time a coin has 2 SOL of real
  reserves it is already up ~1.5x and the remaining upside is small.
  A first momentum version of this bot scored **−1.64 SOL** on the dev
  window. Dip-buying and graduation-chasing alone also lose; the
  two-sleeve combination below is what got closest to breakeven.

## The two sleeves

- **Sleeve A — Graduation chase.** Entry when real reserves ≥ 40 SOL
  and price ≥ 1.5x creation; size up to 0.08 SOL. Exit +100% / −20% /
  −20% trailing / 1000-batch time exit. A graduating coin is never sold
  by us: the harness force-closes it at the completion price.
- **Sleeve B — Flush recovery.** Entry after a ≥40% flush from the peak
  (peak ≥ 1.5x creation) when the price bounces ≥20% off its post-flush
  low on a buy-dominant tape (≥4 buys in the last 8 trades) and real
  reserves ≥ 1 SOL; size up to 0.02 SOL. Exit +35% / −12% / −12%
  trailing / 200-batch time exit. This sleeve exists for breadth: it
  keeps the book across the ≥20 distinct mints the guardrail requires.

## Validation (grade-local, --driver process, dev window)

Final version (flush bounce 20%, flush size 0.02 SOL):

- **Net PnL −0.168 SOL** (return −1.68%; 90% interval −0.565 …
  +0.291 SOL). Top 3 coins made 43% of the gains.
- 184 fills over **92 coins**, 92 round trips, win rate **29.3%**,
  max drawdown **3.3%**. Guardrails met (92 ≥ 20 coins, drawdown ok).
- Fees 0.086 SOL curve + 0.020 SOL tx. Two executions reproduce the
  action log byte for byte (deterministic, no randomness or clocks).

Tuning path: momentum-only −1.64 SOL → two-sleeve (flush bounce 8%)
−0.41 SOL → bounce 15% −0.23 SOL → bounce 20% **−0.17 SOL**. A 25%
bounce gave the same PnL with fewer coins, so 20% was kept.

## Why these parameters

- **40 SOL graduation floor**: the 1%-of-real-reserves order cap means
  a smaller coin cannot take a ≥0.01 SOL order at all, and only coins
  near graduation have a realistic shot at the 14.7x completion price.
- **0.08 / 0.02 SOL size caps**: at most ~0.5 SOL (5%) of capital
  exposed at once. Even a total wipeout of the open book is a ~5%
  drawdown, far inside the 50% guardrail.
- **+100% / −20% on the graduation sleeve**: wide enough to let a
  completing coin run most of the way to 14.7x, tight enough to cut a
  coin that rolls over.
- **+35% / −12% on the flush sleeve**: the bounce after a flush is
  usually short-lived; +35% captures it, −12% cuts the dead-cat
  bounces that roll over.
- **One trade per mint**: guarantees distinct-mint breadth and stops
  the bot churning the same dead coin.

## Determinism

No `Math.random`, no `Date.now`, no network, no file reads. The bot is a
pure function of the stdin stream. The grader executes each entry twice
and requires byte-identical action logs; this bot satisfies that by
construction.
