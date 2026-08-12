# Deploy the keeper to a cloud host

The keeper uses a **low-privilege wallet** (gas only). Set its key as a secret — never commit it.

## Option A — GitHub Actions (free, zero infra)

The workflow file is `keeper.github-workflow.yml.example` (couldn't be auto-pushed to
`.github/workflows/` without the `workflow` token scope). To enable:

1. Grant the scope once, locally:  `gh auth refresh -s workflow`
2. Move the file into place and push:
   `mkdir -p .github/workflows && git mv keeper.github-workflow.yml.example .github/workflows/keeper.yml && git commit -am "enable keeper workflow" && git push`
3. The `KEEPER_KEY` repo secret is already set. Trigger from the **Actions** tab (or wait for the schedule).

Each run stays alive ~5h45m and re-triggers every 6h. Public repo ⇒ unlimited Actions minutes.

## Option B — Fly.io (always-on, most robust)

```bash
fly launch --no-deploy            # creates the app from fly.toml + Dockerfile
fly secrets set KEEPER_KEY=0x...  # the low-privilege keeper key (from your .env)
fly deploy                        # runs the worker 24/7; auto-restarts on crash
```

## Option C — Railway / Render

Point either at this repo (Dockerfile auto-detected), add env var `KEEPER_KEY`, deploy as a
**worker** (no HTTP port needed).

## Fund the keeper wallet with gas

The keeper spends native USDC for gas. Top it up when low; it needs no other funds.
