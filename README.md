# pelada-bot

Technical README for the WhatsApp group bot that manages "pelada" (pickup soccer) participants and guests.

## Overview
pelada-bot is a WhatsApp bot built with @whiskeysockets/baileys that:
- Tracks mensalistas (regular participants) and convidados (guests).
- Provides interactive flows via group messages (requests, confirmations, deletions).
- Uses a local SQLite database for persistence.
- Prints a QR code in the terminal to authenticate the bot session.

Core behaviours:
- DATA_PELADA is computed as the next Friday date (always future).
- Only group messages (JIDs ending with `@g.us`) are handled.
- Several multi-step flows are protected so only the initiating user can complete them.

## Features / Commands
- `pelada` — prints a confirmation prompt with the next pelada date.
- Confirm participation: `sim`, `s`, `bora`, `dentro` — adds the sender name to mensalistas.
- Decline participation: `nao`, `não`, `n`, `fora` — removes the sender name from mensalistas.
- `convidado` / `convidade` — starts a flow where the initiator is asked to type the guest name; only the initiator's next message is accepted as the guest name.
- `apagar convidados` — starts a password-protected flow to delete all convidados (requester must enter the password).
- `apagar mensalistas` — starts a password-protected flow to delete all mensalistas (requester must enter the password).
- `apagar convidado` — starts a flow where the requester is asked to provide the guest name to delete (only the requester can complete).
- `apagar mensalista` — same as above for mensalistas (case-insensitive match).

Important: The current hardcoded deletion password is `marrada`. Change it for production.

## Architecture & Key Libraries
- @whiskeysockets/baileys — WhatsApp Web protocol client.
- qrcode-terminal — ASCII QR code printed to the terminal.
- pino — logging.
- sqlite3 (used inside database.js) — local persistence.

The bot uses baileys' multi-file auth to store credentials under an `auth` folder.

## Database Schema (expected)
Suggested SQLite schema (used by the repository's database helper):
- participantes
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - nome TEXT UNIQUE
- convidados
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - nome TEXT
  - convidado_por TEXT

Queries in code assume columns `id`, `nome`, and `convidado_por` exist and use `COLLATE NOCASE` for some name comparisons.

## Environment & Requirements
- Node.js >= 16 (recommended)
- NPM or Yarn
- If using TypeScript: ts-node or a build step with tsc

Environment variables:
- DEBUG=true — sets pino logger to debug level (otherwise info).

Authentication:
- The bot will print a QR code in the console. Scan with the WhatsApp account you want the bot to use. Credentials are stored by baileys in the `auth` directory.

## Installation & Run (examples)
1. Install dependencies:
   - npm install
2. Start (TypeScript source):
   - npx ts-node src/index.ts
   OR build and run:
   - npm run build
   - node dist/index.js

Notes:
- The project imports `database.js`. Ensure database initialization code creates required tables before starting.
- The bot reconnects automatically on non-logout disconnects.

## Development & Testing
- Use a dedicated WhatsApp account / group for testing.
- Keep the `auth` folder private; it contains session credentials.
- Replace the deletion password and any hardcoded secrets before deploying.

## Troubleshooting
- "QR printed but not connecting": ensure you scanned the QR with the intended WhatsApp account and that the auth folder is writable.
- "Database errors": verify the SQLite file exists and schema matches expectations.
- "Messages not processed": ensure messages are sent in groups (JIDs with `@g.us`) and the bot user is present in the group.

## Security & Privacy Notes
- The bot processes group messages and stores participant/guest names in a local SQLite DB.
- Do not store or expose the `auth` folder or database file.
- Change the hardcoded password `marrada` and any secrets before production.

## License
- No license specified in code. Add a LICENSE file if you plan to publish.
