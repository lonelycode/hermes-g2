# Even Hub store listing — Hermes G2

Copy for the developer portal. Keep the display name identical to `app.json` → `name`.

## Name

Hermes G2

## Tagline

Your self-hosted Hermes Agent, hands-free on your glasses.

## Description

Talk to the Hermes Agent you already run — from your glasses, with your phone in your pocket.

Tap to talk, tap again to send. Your words appear on the display while you speak, so you can catch a mis-hearing before it goes out. The agent's reply is typed out at a steady, readable pace, and every step it takes on the way — the commands it runs, the files it reads, the searches it makes — shows up as a short line under your question, so you always know what it is doing and why it is taking a moment.

When the agent wants permission for something sensitive, the request comes to the glasses: swipe to choose "once", "this session", "always" or "deny", and tap to answer. Change your mind mid-task? Tap, say a correction, and it is delivered to the running agent as a steer. Double-tap to interrupt.

Pick up where you left off: start a new session or reopen any previous conversation from the list, with its history.

What you need:
• A Hermes Agent gateway that you host (the open-source agent from Nous Research), reachable from your phone over your LAN or a private network such as Tailscale.
• The free Hermes G2 proxy on that machine (one command to install; it handles browser access and keeps your speech-to-text key off the phone), or a gateway you have configured for browser clients.
• A speech-to-text account: Deepgram (with live preview), ElevenLabs or any OpenAI-compatible endpoint.

Nothing is sent anywhere except your own gateway and the speech-to-text provider you choose. There are no accounts, no analytics and no servers run by the developer. Setup guide, proxy installer and source: github.com/lonelycode/hermes-g2

## Short description (if a shorter field is required)

Voice front end for your self-hosted Hermes Agent: talk, watch every step, approve actions and steer — all from the glasses.

## Category / keywords

Productivity · assistant · agent · voice · Hermes · self-hosted

## Permissions (what to enter in the review form)

- **network** — reaches the user's own Hermes gateway / proxy and their chosen speech-to-text provider. Hosts are listed in the manifest whitelist.
- **g2-microphone** — captures speech from the glasses only during a tap-to-talk turn.
- **phone-microphone** — optional alternative capture source, selectable in settings.

## Privacy policy URL

https://github.com/lonelycode/hermes-g2/blob/main/PRIVACY.md

## Support / website URL

https://github.com/lonelycode/hermes-g2

## Release notes — 0.2.0 (en)

Live transcription while you talk, replies typed out at a readable pace, one-line tool steps under each question, approvals and steering from the glasses, and double-tap to interrupt.

## First-run behaviour (for the reviewer notes field)

On first launch the glasses show "Hermes unreachable" with the instruction to enter the gateway URL and key on the phone page; settings persist across launches. Root-page double-tap opens the system exit dialog.

## Screenshots (`store/screenshots/`, 576×288 RGBA from the simulator)

| File | Caption |
|---|---|
| 01-sessions.png | Start a new session or reopen a previous conversation |
| 02-steps.png | Every step the agent takes appears under your question |
| 03-working.png | Live status while the agent works |
| 04-answer.png | Replies are typed out at a readable pace |
| 05-history.png | Reopened session with its history |
| 06-listening.png | Tap to talk, tap again to send |
| 07-approval.png | Approve or deny sensitive actions from the glasses |

`store/preview/` holds the same frames composited on black for the README and GitHub.
