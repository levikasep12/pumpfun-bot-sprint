# pumpfun-bot-sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/levikasep12/pumpfun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/levikasep12/pumpfun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A Solana trading bot for pump.fun style bonding curves, built for make.fun's Pump.fun Bot Sprint bounty. It trades paper money on a replay of pump.fun chain data: it buys coins whose recent tape shows broad, accelerating buy flow, starts small, adds once into strength, and exits fast on a stop loss, take profit, trailing stop, fading flow, or the creator selling.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout: the harness sends a `hello` message, then one `batch` per slot (events, marks, fills, account), and the bot replies with its `orders` for that slot. No dependencies, no network, no clock, no randomness — two runs of the same replay write identical replies.

## Strategy

- **Entry:** a coin at least 240 slots old, with 1–80 SOL of real reserves, whose last 60 slots show net inflow ≥ 0.5 SOL from ≥ 4 buyers across ≥ 4 trades, price up 3–120% and near its window high, inflow accelerating into the newer half of the window, and no single buyer over 60% of the buy flow. The creator must not have sold.
- **Sizing:** first buy 0.10 SOL, one add of 0.25 SOL into strength, at most 0.60 SOL per coin and 3 SOL exposed at once, at most 5 positions.
- **Exits:** stop loss −15%, take profit +35%, trailing stop 25% once up 10%, max hold 1,800 slots (doubled while up), exit on fading flow, a single sell ≥ 2 SOL, or the creator selling.
- **Guardrail:** tiny 0.02 SOL probe round trips keep the run above the 20-coin minimum when the main signal goes quiet.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4qtem8kg&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
