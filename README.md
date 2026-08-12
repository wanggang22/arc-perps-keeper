# arc-perps-keeper

Keeper for the [Arc Perps](https://wanggang22.github.io/arc-perps-testnet/) testnet dApp.
Runs on GitHub Actions on a schedule, pulling fresh Pyth prices from Hermes and posting them
to `PerpCorePyth` on Arc testnet, then liquidating under-maintenance positions and filling
triggered orders.

Uses a **low-privilege wallet** (gas only) — `refresh`/`liquidate`/`executeOrder` are all
permissionless, so the key controls nothing but its own gas. Set it as the `KEEPER_KEY`
repository secret. Trigger manually from the Actions tab, or wait for the schedule.
