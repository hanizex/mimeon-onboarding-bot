# Mimeon Onboarding Bot

A Telegram bot that runs the closed alpha of **Mimeon**, a mobile app I founded ([App Store](https://apps.apple.com/us/app/mim-network/id6755737164) · [Google Play](https://play.google.com/store/apps/details?id=com.nowords.mim)). I invite a tester personally and send them a link to the bot. From that point the bot handles everything: registration, getting the app, support, the end-of-test survey and the thank-you rewards. The team works only in a Google Sheet.

No servers, no hosting bill: the whole system is **Google Apps Script + Google Sheets + Telegram Bot API**, about 7,000 lines in 20 modules.

> The bot's interface, the sheet and the code comments are in Ukrainian. The alpha ran with Ukrainian testers.

## Why I built it

An MVP alpha with up to 200 volunteers produces a lot of operational noise: onboarding questions, bug reports with screenshots, reminders, "did anyone answer me?", survey follow-ups, reward tracking. I wanted the team to spend its time on **evidence that the product delivers value**, not on chat logistics. So the brief was: the founder only sends the invitation, and everything after it is automated and measurable.

## What it does

| Area | Module | What happens |
|---|---|---|
| **Onboarding** | `Participants.gs` | Consent (16+), platform (Android / iOS), role (author / viewer), capacity limit, store links and a short guide |
| **In-bot guide** | `Guide.gs` | Explains the app's features inside the chat |
| **Support** | `Support.gs`, `Attachments.gs` | Testers send problems with screenshots, video or files. Each one becomes a ticket in the sheet. Testers can mark a ticket **critical**, and the founder gets a direct Telegram alert. 72-hour response target |
| **Team replies** | `Outbox.gs` | The team writes an answer in the sheet, and the bot delivers it. Idempotent queue with retries and an "unknown delivery" state for an operator to resolve |
| **Test period** | `Scheduler.gs` | Individual test window per tester, reminders only between 10:00 and 20:00 Kyiv time, extensions, closing |
| **Final survey** | `Survey.gs` | Branching interview built on *The Mom Test*: asks about past behaviour and real value, not opinions |
| **Rewards** | `Rewards.gs` | Tracks which of three thank-you rewards each tester earned and when it was fulfilled after release |
| **Analytics** | `Analytics.gs` | "Overview" sheet with the funnel and key metrics, a next-step column per tester, `/stats` command for the owner |
| **Privacy** | `MyData.gs` | Testers can see exactly what is stored about them, stop notifications, leave the alpha or request data deletion |

## How it works

```
Telegram  ──getUpdates──▶  tick_() every minute  ──▶  INBOX sheet ──▶ Dialogs (routing)
                                 │                                         │
                                 ▼                                         ▼
                           OUTBOX queue  ◀── team replies in sheet   Participants / Support /
                                 │                                   Survey / Rewards
                                 ▼
                           Telegram sendMessage (retries, rate limits)
```

- **Polling, not webhooks.** A one-minute time trigger (`Worker.gs`) pulls updates in batches. A short "fast mode" handles live conversations, and a quota guard keeps the bot inside Google's daily trigger limits.
- **Everything is a row.** Incoming events (INBOX) and outgoing messages (OUTBOX) are journaled in sheets with watermarks, so a crashed run resumes without losing or duplicating messages.
- **Secrets stay out of the sheet.** The bot token, sheet ID and owner IDs live in Script Properties. The token never reaches logs, sheets or HTML.
- **Owner binding by one-time code.** `setup_()` issues a code that is stored only as a SHA-256 hash and expires. The owner sends it to the bot to prove who they are.
- **Safe attachment viewer.** The team opens tester files through a small web app (`viewer.html`) with signed, expiring links, so files never become public.
- **Self-checks.** `healthCheck_()` reports the system's state, `measureTickCost_()` measures quota usage, and `Tests.gs` covers the pure logic without touching Telegram or the sheet.

## Project structure

```
src/            20 Apps Script modules (shared global scope, load order in src/ORDER.txt)
build.js        joins src/ into a single Code.gs for the Apps Script editor
viewer.html     attachment viewer template (web app)
appsscript.json Apps Script manifest: scopes, V8 runtime, time zone
```

## Setup

You need a Google account, Node.js (only for the build step) and a bot token from [@BotFather](https://t.me/BotFather).

1. Build the single file:
   ```bash
   node build.js
   ```
2. Create a new Apps Script project at [script.google.com](https://script.google.com). Paste `Code.gs`, add `viewer.html`, and replace the manifest with `appsscript.json`. To see the manifest, enable *Project Settings → Show "appsscript.json"*.
3. In *Project Settings → Script Properties*, add `BOT_TOKEN`.
4. Run `bootstrap_`. It creates the Google Sheet with all tabs, headers, validation and protection. It is safe to run again.
5. Run `setup_`. It checks the bot, creates the one-minute trigger and prints a one-time code. Send that code to your bot in Telegram to bind yourself as the owner.
6. Deploy as a web app (*Deploy → New deployment → Web app*) for the attachment viewer.
7. Optional: run `run_tests` and `healthCheck_` to check that everything works.

If private functions (ending in `_`) don't appear in the editor's Run list, set `ALLOW_ADMIN_LAUNCHERS=true` in Script Properties and use the `run_*` wrappers from `Launcher.gs`. Remove the property afterwards.

**Never** share the sheet publicly. Never add team members as editors of the script, because the token lives there.

---

Built by [Mykola Kalakutskyi](https://github.com/hanizex): Senior Delivery Manager, founder of Mimeon. [LinkedIn](https://linkedin.com/in/hanizex)
