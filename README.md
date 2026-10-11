# Fair Line

Compares sportsbook prices with the app's own fair odds, flags bets with an edge, and keeps an honest record of how those picks do. It never places a bet.

## What's in this repository

| File | What it does |
|---|---|
| `index.html` | The app you open on your phone. |
| `icon-180.png` | The home-screen icon. |
| `update.mjs` | The updater. GitHub runs it about every two hours. |
| `.github/workflows/…yml` | The schedule that runs the updater. |
| `data/` | Created by the updater: `latest.json` (the board), `picks.json` (the record), `state.json` (its memory). |

## Launch

1. **Get a free odds key.** Go to the-odds-api.com, choose the free plan, and copy the key from the email.
2. **Optional second key.** Sign up free at parlay-api.com and copy the key. This is the feed that may add weekly golf, Fanatics and Caesars.
3. **Create the repository.** On github.com tap **+**, **New repository**, name it `fair-line`, choose **Public**, create it.
4. **Upload the files.** Tap **uploading an existing file**, choose `index.html`, `update.mjs` and `icon-180.png`, tap **Commit changes**.
5. **Add the schedule.** Open **Actions**, tap **set up a workflow yourself**, delete the sample text, paste everything from `workflow.txt`, commit.
6. **Add the keys.** **Settings → Secrets and variables → Actions → New repository secret**. Name `ODDS_API_KEY`, paste the key, save. Repeat with `PARLAY_API_KEY` if you have one.
7. **Turn on the page.** **Settings → Pages**, set Branch to **main**, save.
8. **First run.** **Actions → Fair Line update → Run workflow**. It takes 5 to 10 minutes the first time.
9. **Open it.** `https://YOUR-USERNAME.github.io/fair-line/` in Safari, then **Share → Add to Home Screen**.

## Changing settings

Open `update.mjs` on GitHub, tap the pencil, and edit the block at the top:

- `sports`: which sports to follow, most important first. Remove a line to drop a sport and save credits.
- `myBooks`: the books used for the track record.
- `oddsApi.books`: up to 10 books fetched for the price of one. On a paid plan add `fanatics` and `williamhill_us` (Caesars).
- `pick`: the edge and confidence a bet needs to be logged, and how much the stats model counts.

## If something looks wrong

Open the app's **Data** tab. Each source has a dot: green worked, amber partly worked, red failed, with the reason next to it.

- **"No key set" or "key was rejected"**: check the secret's name and value in step 6.
- **"No data yet" in the app**: the first run has not finished, or step 5 or 8 was missed. Check the **Actions** tab for a red X and open it to read the error.
- **Team ratings "still building"**: normal for the first few runs. History is fetched a few leagues at a time.
- **ParlayAPI red**: the app works without it. Send the error text to whoever maintains the app.

## Costs and limits

Everything here runs on free plans. The Odds API's free plan has 500 credits a month, which the updater spreads over the month: a few refreshes a day in total, spent on the sports with games coming soonest. ESPN, Kalshi, Open-Meteo, MLB and NHL data are free and refresh on every run.

GitHub pauses scheduled workflows in repositories with no activity for 60 days. The updater's own commits normally count as activity; if updates ever stop, open **Actions** and tap **Enable workflow**.
