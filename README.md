# Pump.fun Momentum Bot

[![Pump.fun Paper Sprint](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Hoppererin/pumpfun-bot/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Hoppererin/pumpfun-bot/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

[![Pump.fun Replay Sprint](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Hoppererin/pumpfun-bot/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Hoppererin/pumpfun-bot/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

[![Sharpe Sprint](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Hoppererin/pumpfun-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Hoppererin/pumpfun-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for pump.fun bonding curves, built for the
[make.fun](https://make.fun) pump.fun replay sprints. One program
(`main.ts`, Node 22, standard library only) reads the
`agent-fun/replay/v2` stream on stdin and answers each batch with orders
on stdout. No network, no randomness, no clocks — every decision is a pure
function of the replay stream, so two runs produce identical action logs.

## Strategy

Two sleeves, one book (max 5 open positions):

1. **Graduation chase (the alpha).** A coin whose real SOL reserves reach
   40 SOL is close to graduating off its bonding curve, and the curve
   completes at a fixed ~14.7x the creation price — so a coin bought near
   40 SOL that graduates pays several multiples. Entry: real reserves
   ≥ 40 SOL and price ≥ 1.5x creation, size up to 0.08 SOL. Exit on
   +100% take-profit, −20% stop-loss, a −20% trailing stop, or a
   1000-batch time exit. A graduating coin is never sold by us: the
   harness force-closes it at the completion price, which is where the
   money is.
2. **Flush recovery (the breadth).** Most coins pump, then dump as early
   holders exit. After a ≥40% flush from the peak, when the price bounces
   ≥20% off its post-flush low on a buy-dominant tape (≥4 buys in the
   last 8 trades), the weak supply is gone and the coin can run again.
   Entry: flushed, bounced, real reserves ≥ 1 SOL, size up to 0.02 SOL
   (small: this sleeve keeps the book diversified across the ≥20 distinct
   mints the guardrail requires). Exit on +35% take-profit, −12%
   stop-loss, a −12% trailing stop, or a 200-batch time exit.

At most 5 positions open at once. Each mint is traded at most once.
Worst-case drawdown stays near 3–4% of the 10 SOL paper capital — far
inside the 50% guardrail.

See [DESIGN.md](DESIGN.md) for the full reasoning and the dev-data
validation numbers.
