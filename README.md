# Hanamikoji Online

A Cloudflare Worker + Durable Object version of Hanamikoji for two players.

## What It Does

- Serves the web app from the Worker
- Creates private two-player game rooms
- Generates separate Player 1 and Player 2 invite links
- Keeps the full game state inside one Durable Object per room
- Sends each browser only the state that player is allowed to see
- Validates moves server-side
- Uses polling for updates, which is enough for this turn-based MVP

## Local Development

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:8787
```

Click **Create Room**, then send the Player 2 link to your friend.

## Deploy

```bash
npm run deploy
```

If this repo is connected to Cloudflare through GitHub, pushing to the connected branch may also trigger your configured Cloudflare deployment.

## Checks

```bash
npm run check
```

## Game Rules Implemented

- Geisha values: `2, 2, 2, 3, 3, 4, 5`
- 21 item cards
- 1 hidden removed card per round
- Private hands
- Secret, Trade-off, Gift, and Competition actions
- Sticky victory markers on ties
- Win by 4 Geisha or 11+ charm points
