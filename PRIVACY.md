# Privacy policy — Hermes G2

_Last updated: 2026-09-25_

Hermes G2 is a client for a **Hermes Agent gateway that you host yourself**. The app developer runs no servers for it and receives no data from it.

## What the app sends, and where

| Data | Sent to | Why |
|---|---|---|
| Your voice (audio captured while you hold a tap-to-talk turn) | The speech-to-text provider **you** configure (Deepgram, ElevenLabs or an OpenAI-compatible endpoint), either directly or through the Hermes G2 proxy you run | To turn speech into text |
| The transcribed text, your session list and the agent's replies | Your own Hermes Agent gateway (directly or through your proxy) | To run the conversation |
| With each message: the local date, time and time zone, the glasses' display size and — unless you turn **Share location** off — your phone's approximate location (latitude/longitude and its accuracy) | Your own Hermes Agent gateway, as context for that one request (it is not added to the session history) | So the agent can answer time- and place-dependent questions and fit replies to the display |
| Gateway URL, API keys and preferences you type into the settings page | Stored on your phone inside the Even Realities app's storage for this plugin | So you do not have to re-enter them |

Nothing is sent to the developer of this app or to Even Realities by this app. There are no analytics, no crash reporting and no advertising.

## Permissions

- **network** — to reach your gateway/proxy and your speech-to-text provider. The exact hosts are listed in the app manifest.
- **g2-microphone** — captures audio from the glasses only while a tap-to-talk turn is active. Capture stops when you send, cancel or leave the chat.
- **phone-microphone** — optional alternative capture source, used only if you select it in settings.
- **location** — reads the phone's location when the app starts and when you send a message (at most every five minutes), only while **Share location** is on. The fix goes only to your own gateway, as described above; the app does not store it.

## Third parties

Audio is processed by the speech-to-text provider you choose under that provider's own terms and privacy policy. Conversations are processed by your Hermes Agent installation and whichever model provider you have configured there.

## Data retention and deletion

The app keeps no data of its own beyond the settings above. Uninstalling the app removes them. Conversation history lives in your Hermes Agent's session database and is under your control.

## Contact

Questions: open an issue at https://github.com/lonelycode/hermes-g2.
