import { DurableObject } from "cloudflare:workers";

type Player = "p1" | "p2";
type ActionId = "secret" | "tradeOff" | "gift" | "competition";
type Status = "action" | "choice" | "roundComplete" | "gameOver";

type Card = { id: string; geishaId: string; copy: number };
type Geisha = { id: string; name: string; value: number; color: string; item: string; monogram: string };
type PlayerState = {
	hand: string[];
	tableau: string[];
	secret: string[];
	tradeOff: string[];
	usedActions: Record<ActionId, boolean>;
};
type Offer =
	| { type: "gift"; from: Player; to: Player; cards: string[] }
	| { type: "competition"; from: Player; to: Player; sets: [string[], string[]] };
type GameState = {
	id: string;
	revision: number;
	status: Status;
	round: number;
	startingPlayer: Player;
	activePlayer: Player | null;
	removedCard: string | null;
	deck: string[];
	markers: Record<string, Player | null>;
	players: Record<Player, PlayerState>;
	offer: Offer | null;
	roundSummary: unknown;
	winner: Player | null;
	winReason: string | null;
	log: { at: string; message: string }[];
	createdAt: string;
	updatedAt: string;
	tokens: Record<Player, string>;
	displayNames?: Record<Player, string>;
};

const PLAYERS: Player[] = ["p1", "p2"];
const GEISHAS: Geisha[] = [
	{ id: "violet", name: "Violet", value: 2, color: "#8b5cf6", item: "Fan", monogram: "FN" },
	{ id: "red", name: "Red", value: 2, color: "#ef4444", item: "Drum", monogram: "DR" },
	{ id: "lime", name: "Lime", value: 2, color: "#84cc16", item: "Poem", monogram: "PM" },
	{ id: "blue", name: "Blue", value: 3, color: "#3b82f6", item: "Parasol", monogram: "PS" },
	{ id: "amber", name: "Amber", value: 3, color: "#f59e0b", item: "Strings", monogram: "ST" },
	{ id: "green", name: "Green", value: 4, color: "#10b981", item: "Tea", monogram: "TE" },
	{ id: "pink", name: "Pink", value: 5, color: "#ec4899", item: "Lantern", monogram: "LN" },
];
const ACTIONS = [
	{
		id: "secret" as const,
		name: "Secret",
		cardCount: 1,
		help: "Hide 1 card. It is revealed and scored at the end of the round.",
	},
	{
		id: "tradeOff" as const,
		name: "Trade-off",
		cardCount: 2,
		help: "Remove 2 cards from this round. They will not score.",
	},
	{
		id: "gift" as const,
		name: "Gift",
		cardCount: 3,
		help: "Offer 3 cards. Your opponent takes 1, and you score the other 2.",
	},
	{
		id: "competition" as const,
		name: "Competition",
		cardCount: 4,
		help: "Split 4 cards into two pairs. Your opponent chooses one pair to score.",
	},
];
const CARD_BY_ID = Object.fromEntries(createItemDeck().map((card) => [card.id, card]));

export class MyDurableObject extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname.endsWith("/create") && request.method === "POST") {
				const existing = await this.getState();
				if (existing) return json(invitePayload(existing));
				const state = createNewGame(this.nameFromRequest(url));
				await this.putState(state);
				return json(invitePayload(state));
			}

			const state = await this.getState();
			if (!state) return json({ error: "Room not found." }, 404);

			if (url.pathname.endsWith("/state") && request.method === "GET") {
				const player = readPlayer(url);
				this.assertToken(state, player, url.searchParams.get("token"));
				return json(viewForPlayer(state, player));
			}

			if (url.pathname.endsWith("/move") && request.method === "POST") {
				const body = (await request.json()) as {
					player?: Player;
					token?: string;
					move?: Record<string, unknown>;
				};
				if (!body.player || !PLAYERS.includes(body.player)) {
					return json({ error: "Invalid player." }, 400);
				}
				this.assertToken(state, body.player, body.token || null);
				const next = applyMove(state, { ...(body.move || {}), player: body.player });
				await this.putState(next);
				return json(viewForPlayer(next, body.player));
			}

			return json({ error: "Not found." }, 404);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "Unknown error." }, 400);
		}
	}

	private async getState(): Promise<GameState | null> {
		return ((await this.ctx.storage.get("state")) as GameState | undefined) || null;
	}

	private async putState(state: GameState): Promise<void> {
		await this.ctx.storage.put("state", state);
	}

	private assertToken(state: GameState, player: Player, token: string | null): void {
		if (!token || state.tokens[player] !== token) {
			throw new Error("This player link is invalid for this room.");
		}
	}

	private nameFromRequest(url: URL): string {
		return url.pathname.split("/")[3] || crypto.randomUUID();
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/create" && request.method === "POST") {
			const room = shortId();
			const id = env.MY_DURABLE_OBJECT.idFromName(room);
			const stub = env.MY_DURABLE_OBJECT.get(id);
			const response = await stub.fetch(new Request(`${url.origin}/api/rooms/${room}/create`, { method: "POST" }));
			const payload = (await response.json()) as Record<string, unknown>;
			return json(withAbsoluteLinks(payload, url.origin));
		}

		const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(state|move)$/);
		if (roomMatch) {
			const id = env.MY_DURABLE_OBJECT.idFromName(roomMatch[1]);
			const stub = env.MY_DURABLE_OBJECT.get(id);
			return stub.fetch(request);
		}

		if (url.pathname === "/" || url.pathname === "/room") return html(INDEX_HTML);
		if (url.pathname === "/app.js") {
			return new Response(APP_JS, { headers: { "content-type": "application/javascript; charset=utf-8" } });
		}
		if (url.pathname === "/styles.css") {
			return new Response(STYLES_CSS, { headers: { "content-type": "text/css; charset=utf-8" } });
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

function createNewGame(id: string): GameState {
	const state: GameState = {
		id,
		revision: 0,
		status: "action",
		round: 0,
		startingPlayer: "p1",
		activePlayer: "p1",
		removedCard: null,
		deck: [],
		markers: Object.fromEntries(GEISHAS.map((geisha) => [geisha.id, null])),
		players: createFreshPlayers(),
		offer: null,
		roundSummary: null,
		winner: null,
		winReason: null,
		log: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		tokens: { p1: token(), p2: token() },
		displayNames: { p1: "Player 1", p2: "Player 2" },
	};
	return dealNextRound(state, "p1", true);
}

function applyMove(state: GameState, move: Record<string, unknown>): GameState {
	const next = clone(state);
	switch (move.type) {
		case "useAction":
			useAction(next, move.player as Player, move.action as ActionId, (move.cardIds as string[]) || []);
			break;
		case "chooseGift":
			chooseGift(next, move.player as Player, move.cardId as string);
			break;
		case "chooseCompetition":
			chooseCompetition(next, move.player as Player, Number(move.setIndex));
			break;
		case "startNextRound":
			if (next.status !== "roundComplete") throw new Error("The next round can only start after scoring.");
			dealNextRound(next, opponent(next.startingPlayer), false);
			break;
		case "setName":
			setPlayerName(next, move.player as Player, move.displayName);
			break;
		default:
			throw new Error("Unknown move.");
	}
	touch(next);
	return next;
}

function useAction(state: GameState, player: Player, actionId: ActionId, cardIds: string[]): void {
	assertPlayer(player);
	if (state.status !== "action") throw new Error("You cannot use an action right now.");
	if (state.activePlayer !== player) throw new Error(`It is ${playerName(state, state.activePlayer)}'s turn.`);
	const action = ACTIONS.find((item) => item.id === actionId);
	if (!action) throw new Error("Choose a valid action.");
	if (state.players[player].usedActions[actionId]) throw new Error(`${action.name} has already been used.`);
	if (cardIds.length !== action.cardCount) throw new Error(`${action.name} needs exactly ${action.cardCount} card(s).`);
	assertUnique(cardIds);
	assertCardsInHand(state, player, cardIds);
	removeCardsFromHand(state.players[player].hand, cardIds);
	state.players[player].usedActions[actionId] = true;

	if (actionId === "secret") {
		state.players[player].secret = [...cardIds];
		addLog(state, `${playerName(state, player)} used Secret.`);
		finishAction(state, player);
		return;
	}
	if (actionId === "tradeOff") {
		state.players[player].tradeOff = [...cardIds];
		addLog(state, `${playerName(state, player)} used Trade-off.`);
		finishAction(state, player);
		return;
	}
	if (actionId === "gift") {
		state.status = "choice";
		state.offer = { type: "gift", from: player, to: opponent(player), cards: [...cardIds] };
		addLog(state, `${playerName(state, player)} offered a Gift.`);
		return;
	}
	state.status = "choice";
	state.offer = { type: "competition", from: player, to: opponent(player), sets: [cardIds.slice(0, 2), cardIds.slice(2, 4)] };
	addLog(state, `${playerName(state, player)} started a Competition.`);
}

function chooseGift(state: GameState, player: Player, cardId: string): void {
	assertPendingChoice(state, player, "gift");
	const offer = state.offer as Extract<Offer, { type: "gift" }>;
	if (!offer.cards.includes(cardId)) throw new Error("Choose one of the offered cards.");
	state.players[player].tableau.push(cardId);
	state.players[offer.from].tableau.push(...offer.cards.filter((id) => id !== cardId));
	addLog(state, `${playerName(state, player)} chose 1 Gift card.`);
	finishOffer(state, offer.from);
}

function chooseCompetition(state: GameState, player: Player, setIndex: number): void {
	assertPendingChoice(state, player, "competition");
	if (![0, 1].includes(setIndex)) throw new Error("Choose one of the two offered sets.");
	const offer = state.offer as Extract<Offer, { type: "competition" }>;
	const otherIndex = setIndex === 0 ? 1 : 0;
	state.players[player].tableau.push(...offer.sets[setIndex]);
	state.players[offer.from].tableau.push(...offer.sets[otherIndex]);
	addLog(state, `${playerName(state, player)} chose a Competition set.`);
	finishOffer(state, offer.from);
}

function finishOffer(state: GameState, actingPlayer: Player): void {
	state.offer = null;
	state.status = "action";
	finishAction(state, actingPlayer);
}

function finishAction(state: GameState, actingPlayer: Player): void {
	if (allActionsUsed(state)) {
		scoreRound(state);
		return;
	}
	state.activePlayer = opponent(actingPlayer);
	drawForActivePlayer(state);
}

function scoreRound(state: GameState): void {
	for (const player of PLAYERS) {
		state.players[player].tableau.push(...state.players[player].secret);
		state.players[player].secret = [];
	}
	for (const geisha of GEISHAS) {
		const p1Count = countCardsForGeisha(state.players.p1.tableau, geisha.id);
		const p2Count = countCardsForGeisha(state.players.p2.tableau, geisha.id);
		if (p1Count > p2Count) state.markers[geisha.id] = "p1";
		if (p2Count > p1Count) state.markers[geisha.id] = "p2";
	}
	const scores = calculateScores(state.markers);
	state.roundSummary = { round: state.round, scores };
	const p1Goal = scores.p1.geishas >= 4 || scores.p1.points >= 11;
	const p2Goal = scores.p2.geishas >= 4 || scores.p2.points >= 11;
	if (p1Goal || p2Goal) {
		const winner = chooseWinner(scores);
		state.status = "gameOver";
		state.activePlayer = null;
		state.winner = winner;
		state.winReason = scores[winner].points >= 11 ? `${scores[winner].points} charm points` : `${scores[winner].geishas} Geisha`;
		addLog(state, `${playerName(state, winner)} wins with ${state.winReason}.`);
	} else {
		state.status = "roundComplete";
		state.activePlayer = null;
		addLog(state, `Round ${state.round} scored. No winner yet.`);
	}
}

function dealNextRound(state: GameState, startingPlayer: Player, resetMarkers: boolean): GameState {
	state.round += 1;
	state.startingPlayer = startingPlayer;
	state.activePlayer = startingPlayer;
	state.status = "action";
	state.offer = null;
	state.roundSummary = null;
	state.winner = null;
	state.winReason = null;
	state.players = createFreshPlayers();
	if (resetMarkers) state.markers = Object.fromEntries(GEISHAS.map((geisha) => [geisha.id, null]));
	const deck = shuffle(createItemDeck()).map((card) => card.id);
	state.removedCard = deck.pop() || null;
	state.players.p1.hand = deck.splice(0, 6);
	state.players.p2.hand = deck.splice(0, 6);
	state.deck = deck;
	addLog(state, `Round ${state.round} started. ${playerName(state, startingPlayer)} starts.`);
	drawForActivePlayer(state);
	touch(state);
	return state;
}

function viewForPlayer(state: GameState, player: Player) {
	const other = opponent(player);
	return {
		id: state.id,
		revision: state.revision,
		status: state.status,
		round: state.round,
		startingPlayer: state.startingPlayer,
		activePlayer: state.activePlayer,
		deckCount: state.deck.length,
		markers: state.markers,
		players: {
			[player]: state.players[player],
			[other]: {
				handCount: state.players[other].hand.length,
				tableau: state.players[other].tableau,
				usedActions: state.players[other].usedActions,
				secretCount: state.players[other].secret.length,
				tradeOffCount: state.players[other].tradeOff.length,
			},
		},
		offer: state.offer,
		roundSummary: state.roundSummary,
		winner: state.winner,
		winReason: state.winReason,
		log: state.log.slice(-30),
		geishas: GEISHAS,
		actions: ACTIONS,
		cards: CARD_BY_ID,
		names: displayNames(state),
		player,
	};
}

function invitePayload(state: GameState) {
	return {
		room: state.id,
		players: {
			p1: { token: state.tokens.p1, path: `/room?room=${state.id}&player=p1&token=${state.tokens.p1}` },
			p2: { token: state.tokens.p2, path: `/room?room=${state.id}&player=p2&token=${state.tokens.p2}` },
		},
	};
}

function withAbsoluteLinks(payload: Record<string, unknown>, origin: string) {
	const typed = payload as { players?: Record<Player, { path: string; url?: string }> };
	if (typed.players) {
		for (const p of PLAYERS) typed.players[p].url = `${origin}${typed.players[p].path}`;
	}
	return payload;
}

function createFreshPlayers(): Record<Player, PlayerState> {
	return { p1: createFreshPlayer(), p2: createFreshPlayer() };
}

function createFreshPlayer(): PlayerState {
	return { hand: [], tableau: [], secret: [], tradeOff: [], usedActions: { secret: false, tradeOff: false, gift: false, competition: false } };
}

function createItemDeck(): Card[] {
	return GEISHAS.flatMap((geisha) => Array.from({ length: geisha.value }, (_, index) => ({ id: `${geisha.id}-${index + 1}`, geishaId: geisha.id, copy: index + 1 })));
}

function drawForActivePlayer(state: GameState): void {
	if (!state.activePlayer) return;
	const drawn = state.deck.pop();
	if (!drawn) throw new Error("The item deck is empty.");
	state.players[state.activePlayer].hand.push(drawn);
	addLog(state, `${playerName(state, state.activePlayer)} drew a card.`);
}

function allActionsUsed(state: GameState): boolean {
	return PLAYERS.every((p) => ACTIONS.every((action) => state.players[p].usedActions[action.id]));
}

function calculateScores(markers: Record<string, Player | null>) {
	const scores = { p1: { geishas: 0, points: 0 }, p2: { geishas: 0, points: 0 } };
	for (const geisha of GEISHAS) {
		const owner = markers[geisha.id];
		if (owner) {
			scores[owner].geishas += 1;
			scores[owner].points += geisha.value;
		}
	}
	return scores;
}

function chooseWinner(scores: ReturnType<typeof calculateScores>): Player {
	if (scores.p1.points >= 11 && scores.p2.points < 11) return "p1";
	if (scores.p2.points >= 11 && scores.p1.points < 11) return "p2";
	if (scores.p1.geishas >= 4 && scores.p2.geishas < 4) return "p1";
	if (scores.p2.geishas >= 4 && scores.p1.geishas < 4) return "p2";
	return scores.p1.points >= scores.p2.points ? "p1" : "p2";
}

function countCardsForGeisha(cardIds: string[], geishaId: string): number {
	return cardIds.filter((cardId) => CARD_BY_ID[cardId]?.geishaId === geishaId).length;
}

function assertPendingChoice(state: GameState, player: Player, type: Offer["type"]): void {
	if (state.status !== "choice" || !state.offer || state.offer.type !== type) throw new Error("There is no matching choice to make.");
	if (state.offer.to !== player) throw new Error(`${playerName(state, state.offer.to)} must make this choice.`);
}

function assertCardsInHand(state: GameState, player: Player, cardIds: string[]): void {
	for (const cardId of cardIds) {
		if (!state.players[player].hand.includes(cardId)) throw new Error(`${cardId} is not in your hand.`);
	}
}

function removeCardsFromHand(hand: string[], cardIds: string[]): void {
	for (const cardId of cardIds) {
		const index = hand.indexOf(cardId);
		if (index >= 0) hand.splice(index, 1);
	}
}

function assertPlayer(player: Player): void {
	if (!PLAYERS.includes(player)) throw new Error("Choose Player 1 or Player 2.");
}

function assertUnique(items: string[]): void {
	if (new Set(items).size !== items.length) throw new Error("Choose each card only once.");
}

function opponent(player: Player): Player {
	return player === "p1" ? "p2" : "p1";
}

function setPlayerName(state: GameState, player: Player, value: unknown): void {
	const name = typeof value === "string" ? value.trim().slice(0, 24) : "";
	state.displayNames = { ...displayNames(state), [player]: name || defaultPlayerName(player) };
	addLog(state, `${defaultPlayerName(player)} is now ${playerName(state, player)}.`);
}

function displayNames(state: GameState): Record<Player, string> {
	return { p1: state.displayNames?.p1 || "Player 1", p2: state.displayNames?.p2 || "Player 2" };
}

function playerName(state: GameState, player: Player | null): string {
	if (!player) return "No player";
	return displayNames(state)[player];
}

function defaultPlayerName(player: Player): string {
	return player === "p1" ? "Player 1" : "Player 2";
}

function addLog(state: GameState, message: string): void {
	state.log.push({ at: new Date().toISOString(), message });
	state.log = state.log.slice(-80);
}

function shuffle<T>(items: T[]): T[] {
	const copy = [...items];
	for (let index = copy.length - 1; index > 0; index -= 1) {
		const swapIndex = Math.floor(Math.random() * (index + 1));
		[copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
	}
	return copy;
}

function readPlayer(url: URL): Player {
	const player = url.searchParams.get("player") as Player | null;
	if (!player || !PLAYERS.includes(player)) throw new Error("Invalid player.");
	return player;
}

function touch(state: GameState): void {
	state.revision += 1;
	state.updatedAt = new Date().toISOString();
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function shortId(): string {
	return crypto.randomUUID().slice(0, 8);
}

function token(): string {
	return crypto.randomUUID().replaceAll("-", "");
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

function html(value: string): Response {
	return new Response(value, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const INDEX_HTML = `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Hanamikoji Online</title><link rel="stylesheet" href="/styles.css" /></head><body><main id="app"></main><script type="module" src="/app.js"></script></body></html>`;

const APP_JS = String.raw`
const params = new URLSearchParams(location.search);
let room = params.get("room");
let player = params.get("player");
let token = params.get("token");
let state = null;
let selected = [];
let message = "";
let previousHand = null;
let leavingCards = new Set();
let leavingSetIndex = null;
let nameDraft = null;
const app = document.querySelector("#app");
document.addEventListener("click", async (event) => {
	const el = event.target.closest("[data-action]");
	if (!el) return;
	const action = el.dataset.action;
	if (action === "create") return createRoom();
	if (action === "copy") return navigator.clipboard?.writeText(el.dataset.url);
	if (action === "save-name") return saveName();
	if (action === "select-card") { const id = el.dataset.cardId; selected = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]; return render(); }
	if (action === "use-action") { if (el.dataset.disabled === "true") return; return move({ type: "useAction", action: el.dataset.gameAction, cardIds: selected }); }
	if (action === "choose-gift") return move({ type: "chooseGift", cardId: el.dataset.cardId });
	if (action === "choose-competition") return move({ type: "chooseCompetition", setIndex: Number(el.dataset.setIndex) });
	if (action === "start-next-round") return move({ type: "startNextRound" });
});
document.addEventListener("input", (event) => {
	if (event.target?.id === "player-name") nameDraft = event.target.value;
});
document.addEventListener("keydown", (event) => {
	if (event.target?.id === "player-name" && event.key === "Enter") saveName();
});
if (room && player && token) { await refresh(); setInterval(refresh, 1800); } else { render(); }
async function createRoom() {
	const res = await fetch("/api/create", { method: "POST" });
	const data = await res.json();
	if (!res.ok) { message = data.error || "Could not create room."; render(); return; }
	room = data.room;
	state = { invite: data };
	render();
}
async function refresh() {
	const res = await fetch(\`/api/rooms/\${room}/state?player=\${player}&token=\${token}\`);
	const data = await res.json();
	if (!res.ok) { message = data.error || "Could not load room."; render(); return; }
	state = data;
	selected = selected.filter((id) => state.players[player]?.hand?.includes(id));
	render();
}
async function move(payload) {
	const leaving = cardsLeavingFor(payload);
	if (leaving.cards.length || leaving.setIndex !== null) {
		leavingCards = new Set(leaving.cards);
		leavingSetIndex = leaving.setIndex;
		render();
		await sleep(220);
	}
	const res = await fetch(\`/api/rooms/\${room}/move\`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ player, token, move: payload }) });
	const data = await res.json();
	if (!res.ok) message = data.error || "Move failed.";
	else { state = data; if (payload.type !== "setName") selected = []; message = ""; }
	leavingCards = new Set();
	leavingSetIndex = null;
	render();
}
async function saveName() {
	const input = document.querySelector("#player-name");
	if (!input) return;
	await move({ type: "setName", displayName: input.value });
	nameDraft = null;
}
function render() {
	const handBeforeRender = state?.players?.[player]?.hand || null;
	const refocusName = document.activeElement?.id === "player-name";
	app.innerHTML = header() + (message ? \`<div class="notice">\${esc(message)}</div>\` : "") + body();
	if (refocusName) {
		const input = document.querySelector("#player-name");
		input?.focus();
		input?.setSelectionRange(input.value.length, input.value.length);
	}
	previousHand = handBeforeRender ? new Set(handBeforeRender) : null;
}
function header() { return \`<header class="topbar"><div><p class="eyebrow">Hanamikoji Online</p><h1>Play with a friend</h1></div><button class="button primary" data-action="create">Create Room</button></header>\`; }
function body() {
	if (state?.invite) {
		const p1 = state.invite.players.p1.url; const p2 = state.invite.players.p2.url;
		return \`<section class="empty-state"><h2>Room created</h2><p>Send one link to each player. Keep these links private; each one contains that player's token.</p><div class="link-box"><strong>Player 1</strong><a href="\${p1}">\${p1}</a><button class="mini-button" data-action="copy" data-url="\${p1}">Copy</button></div><div class="link-box"><strong>Player 2</strong><a href="\${p2}">\${p2}</a><button class="mini-button" data-action="copy" data-url="\${p2}">Copy</button></div></section>\`;
	}
	if (!room || !player || !token) return \`<section class="empty-state"><h2>Create an online room</h2><p>Click Create Room, then send the Player 2 link to your friend abroad.</p><button class="button primary" data-action="create">Create Room</button></section>\`;
	if (!state) return \`<section class="empty-state"><h2>Loading room...</h2></section>\`;
	const scores = calculateScores(state);
	return \`<section class="status-strip"><div><span class="label">Room</span><strong>\${esc(room)}</strong></div><div><span class="label">You</span><strong>\${name(player)}</strong></div><div><span class="label">Turn</span><strong>\${state.activePlayer ? name(state.activePlayer) : state.status}</strong></div><div><span class="label">Score</span><strong>\${name("p1")} \${scores.p1.geishas}/\${scores.p1.points} - \${name("p2")} \${scores.p2.geishas}/\${scores.p2.points}</strong></div></section><div class="game-layout"><section class="board-panel"><div class="section-title"><h2>Board</h2><span>\${state.deckCount} card(s) left in deck</span></div><div class="geisha-grid">\${state.geishas.map(renderGeisha).join("")}</div></section><aside class="side-panel">\${playerPanel()}\${logPanel()}</aside></div>\`;
}
function renderGeisha(geisha) { const owner = state.markers[geisha.id]; return \`<article class="geisha-card" style="--accent:\${geisha.color}"><div class="played-zone top">\${smallCards(cardsFor("p2", geisha.id))}</div><div class="geisha-main"><span class="card-corner top-left">\${geisha.value}</span><span class="card-corner bottom-right">\${geisha.value}</span><span class="card-pattern"></span><span class="geisha-crest">\${geisha.monogram}</span><span class="name">\${geisha.name}</span><span class="marker \${owner || "center"}">\${owner ? name(owner) : "Center"}</span></div><div class="played-zone">\${smallCards(cardsFor("p1", geisha.id))}</div></article>\`; }
function playerPanel() { const me = state.players[player]; const other = state.players[player === "p1" ? "p2" : "p1"]; return \`<section class="panel"><div class="section-title player-heading"><h2>\${name(player)}</h2><span>\${other.handCount} card(s) in opponent hand</span></div>\${nameEditor()}\${instructions()}\${actions(me)}\${hand(me)}<div class="private-grid"><div><h3>Secret</h3><p>\${me.secret.length ? me.secret.map(label).join(", ") : "Not used"}</p></div><div><h3>Trade-off</h3><p>\${me.tradeOff.length ? me.tradeOff.map(label).join(", ") : "Not used"}</p></div></div></section>\`; }
function nameEditor() { const value = nameDraft ?? name(player); return \`<div class="name-editor"><label for="player-name"><span>Your name</span><input id="player-name" maxlength="24" value="\${esc(value)}" /></label><button class="mini-button" data-action="save-name">Save</button></div>\`; }
function instructions() {
	if (state.status === "gameOver") return \`<div class="result-box"><strong>\${name(state.winner)} wins</strong><span>\${esc(state.winReason)}</span></div>\`;
	if (state.status === "roundComplete") return \`<div class="action-callout"><strong>Round scored.</strong><span>Tied markers stay where they are.</span><button class="button primary" data-action="start-next-round">Start Next Round</button></div>\`;
	if (state.status === "choice" && state.offer.to === player) {
		if (state.offer.type === "gift") return \`<div class="action-callout"><strong>\${name(state.offer.from)} offered a Gift.</strong><span>Choose 1 card for yourself.</span><div class="offer-row">\${state.offer.cards.map((id) => \`<button class="card offered \${leavingCards.has(id) ? "leaving" : ""}" style="\${cardStyle(id)}" data-action="choose-gift" data-card-id="\${id}">\${cardFace(id, true)}</button>\`).join("")}</div></div>\`;
		return \`<div class="action-callout"><strong>\${name(state.offer.from)} started a Competition.</strong><span>Choose 1 set for yourself.</span><div class="set-row">\${state.offer.sets.map((set, index) => \`<button class="set-choice \${leavingSetIndex === index ? "leaving" : ""}" data-action="choose-competition" data-set-index="\${index}"><span>Set \${index + 1}</span><span>\${set.map(label).join(" + ")}</span></button>\`).join("")}</div></div>\`;
	}
	if (state.status === "choice") return \`<p class="muted">Waiting for \${name(state.offer.to)} to choose.</p>\`;
	if (state.activePlayer === player) return \`<div class="action-callout"><strong>Your turn.</strong><span>You already drew. Select cards, then choose an unused action.</span></div>\`;
	return \`<p class="muted">Waiting for \${name(state.activePlayer)}.</p>\`;
}
function actions(me) { const usable = state.status === "action" && state.activePlayer === player; return \`<div class="actions-grid">\${state.actions.map((action) => { const used = me.usedActions[action.id]; const disabled = !usable || used || selected.length !== action.cardCount; return \`<button class="action-card \${used ? "used" : ""}" data-help="\${esc(action.help)}" data-action="use-action" data-game-action="\${action.id}" data-disabled="\${disabled ? "true" : "false"}" aria-disabled="\${disabled ? "true" : "false"}"><span>\${action.name}</span><small>\${action.cardCount} card\${action.cardCount === 1 ? "" : "s"}\${used ? " used" : ""}</small></button>\`; }).join("")}</div><p class="selection-help">Selected: \${selected.length ? selected.map((id) => \`\${selectionMark(id)}. \${handLabel(id)}\`).join(", ") : "none"}. For Competition, A/B are Set 1 and C/D are Set 2.</p>\`; }
function hand(me) { const canSelect = state.status === "action" && state.activePlayer === player; return \`<div class="hand"><h3>Your hand</h3><div class="card-row">\${me.hand.map((id) => { const isNew = previousHand && !previousHand.has(id); const motion = leavingCards.has(id) ? "leaving" : isNew ? "drawn" : ""; return \`<button class="card \${selected.includes(id) ? "selected" : ""} \${motion}" style="\${cardStyle(id)}" data-action="select-card" data-card-id="\${id}" \${canSelect ? "" : "disabled"}>\${cardFace(id, false)}\${selected.includes(id) ? \`<strong>\${selectionMark(id)}</strong>\` : ""}</button>\`; }).join("")}</div></div>\`; }
function logPanel() { return \`<section class="panel compact"><h2>Log</h2><ol class="log-list">\${state.log.slice(-10).reverse().map((entry) => \`<li>\${esc(entry.message)}</li>\`).join("")}</ol></section>\`; }
function cardsFor(target, geishaId) { const p = state.players[target]; const tableau = Array.isArray(p.tableau) ? p.tableau : []; return tableau.filter((id) => state.cards[id]?.geishaId === geishaId); }
function smallCards(ids) { return ids.length ? ids.map((id) => \`<span class="small-card" style="\${cardStyle(id)}">\${geishaFor(id).monogram}</span>\`).join("") : \`<span class="empty-slot">none</span>\`; }
function calculateScores(s) { const scores = { p1: { geishas: 0, points: 0 }, p2: { geishas: 0, points: 0 } }; for (const geisha of s.geishas) { const owner = s.markers[geisha.id]; if (owner) { scores[owner].geishas += 1; scores[owner].points += geisha.value; } } return scores; }
function cardsLeavingFor(payload) {
	if (payload.type === "useAction") return { cards: selected, setIndex: null };
	if (payload.type === "chooseGift") return { cards: [payload.cardId], setIndex: null };
	if (payload.type === "chooseCompetition" && state?.offer?.type === "competition") return { cards: state.offer.sets[payload.setIndex] || [], setIndex: payload.setIndex };
	return { cards: [], setIndex: null };
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function cardFace(id, showValue) { const geisha = geishaFor(id); const corner = showValue ? geisha.value : geisha.monogram; return \`<span class="card-corner top-left">\${corner}</span><span class="card-corner bottom-right">\${corner}</span><span class="card-pattern"></span><span class="card-center"><b>\${geisha.name}</b></span>\`; }
function selectionMark(id) { return "ABCD".charAt(selected.indexOf(id)) || ""; }
function geishaFor(id) { const card = state.cards[id]; return state.geishas.find((g) => g.id === card.geishaId); }
function handLabel(id) { return geishaFor(id).name; }
function label(id) { const geisha = geishaFor(id); return \`\${geisha.name} \${geisha.value}\`; }
function cardStyle(id) { const geisha = geishaFor(id); return \`--card-color:\${geisha.color}\`; }
function name(p) { if (!p) return "No player"; return state?.names?.[p] || (p === "p1" ? "Player 1" : "Player 2"); }
function esc(v) { return String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
`.replaceAll("\\`", "`").replaceAll("\\${", "${");

const STYLES_CSS = `
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f3efe7;color:#1f2933}
*{box-sizing:border-box}
body{margin:0;min-width:320px;background:linear-gradient(135deg,rgba(31,92,74,.1),transparent 34%),linear-gradient(315deg,rgba(155,43,43,.08),transparent 30%),#f3efe7}
button,a{font:inherit}
#app{min-height:100vh;padding:20px}
.topbar,.status-strip,.panel,.board-panel,.empty-state{border:1px solid rgba(105,84,60,.22);background:rgba(255,252,247,.94);box-shadow:0 16px 42px rgba(55,40,25,.1)}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:18px;max-width:1406px;margin:0 auto;padding:18px 20px;border-radius:8px;background:linear-gradient(90deg,rgba(30,79,69,.95),rgba(88,54,42,.94));color:#fffaf2}
.topbar .eyebrow{color:#d8eadf}
.eyebrow,.label{margin:0 0 4px;color:#6f6254;font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
h1,h2,h3,p{margin-top:0}
h1{margin-bottom:0;font-size:clamp(1.55rem,2vw,2.2rem)}
h2{margin-bottom:10px;font-size:1.1rem}
h3{margin-bottom:8px;font-size:.9rem}
.button,.mini-button{display:inline-flex;align-items:center;justify-content:center;min-height:38px;border:1px solid #b9aa96;border-radius:6px;padding:8px 12px;background:#fffaf2;color:#2f261d;text-decoration:none;cursor:pointer;box-shadow:0 2px 0 rgba(47,38,29,.1)}
.button.primary{border-color:#0f5b4b;background:#146c5c;color:#fff}
.mini-button{min-height:30px;padding:5px 9px;font-size:.82rem}
.notice{max-width:1406px;margin:14px auto;border:1px solid #d9a441;border-radius:6px;padding:10px 12px;background:#fff7df}
.empty-state{max-width:820px;margin:40px auto 0;border-radius:8px;padding:24px}
.link-box{display:grid;grid-template-columns:80px 1fr auto;gap:10px;align-items:center;margin-top:12px;padding:10px;border:1px solid #eadfce;border-radius:8px}
.link-box a{overflow-wrap:anywhere}
.status-strip{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:12px;max-width:1406px;margin:14px auto 0;padding:14px;border-radius:8px}
.status-strip strong{display:block;font-size:1rem}
.game-layout{display:grid;grid-template-columns:minmax(0,980px) minmax(320px,410px);justify-content:center;align-items:start;gap:16px;max-width:1406px;margin:16px auto 0}
.side-panel{width:100%;min-width:0}
.board-panel,.panel{border-radius:8px;padding:16px}
.board-panel{width:980px;max-width:100%;overflow-x:auto;background:linear-gradient(180deg,rgba(255,252,247,.96),rgba(248,239,224,.96))}
.section-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}
.section-title h2{margin-bottom:0}
.section-title span,.muted,.selection-help{color:#756858;font-size:.9rem}
.name-editor{display:flex;align-items:end;gap:8px;margin:-2px 0 14px}
.name-editor label{display:grid;gap:4px;min-width:220px;color:#6f6254;font-size:.76rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase}
.name-editor input{height:36px;border:1px solid #c8bba7;border-radius:6px;padding:7px 9px;background:#fffdf8;color:#1f2933;font:inherit;font-weight:700;letter-spacing:0;text-transform:none}
.geisha-grid{display:grid;grid-template-columns:repeat(7,124px);gap:10px;width:max-content;padding-bottom:4px}
.geisha-card{width:124px;border:1px solid color-mix(in srgb,var(--accent) 38%,#d6ccbd);border-radius:8px;background:#fffaf2;box-shadow:0 8px 18px rgba(47,38,29,.08);overflow:hidden}
.played-zone{display:flex;align-items:center;justify-content:center;min-height:58px;padding:6px;gap:4px;flex-wrap:wrap;background:rgba(255,255,255,.48)}
.played-zone.top{border-bottom:1px solid #eadfce}
.geisha-main{position:relative;display:grid;justify-items:center;align-content:center;gap:6px;min-height:180px;padding:28px 10px 14px;border-bottom:1px solid #eadfce;background:linear-gradient(160deg,color-mix(in srgb,var(--accent) 18%,#fffaf2),#fffaf2 68%);overflow:hidden}
.geisha-main .name{position:relative;z-index:1;font-weight:900}
.geisha-crest{position:relative;z-index:1;display:grid;place-items:center;width:58px;height:58px;border-radius:50%;background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 64%,#111827));color:#fff;font-weight:900;letter-spacing:.06em;box-shadow:inset 0 0 0 4px rgba(255,255,255,.28),0 8px 14px rgba(42,31,21,.12)}
.marker{display:inline-flex;min-height:24px;align-items:center;border-radius:999px;padding:3px 8px;background:#2f261d;color:#fff;font-size:.76rem;font-weight:800}
.marker.center{background:#d8cbbb;color:#4c4035}
.small-card{display:inline-grid;place-items:center;min-width:29px;height:34px;border:1px solid color-mix(in srgb,var(--card-color) 52%,#554437);border-radius:5px;background:linear-gradient(160deg,#fffaf2,color-mix(in srgb,var(--card-color) 18%,#fff));box-shadow:0 2px 5px rgba(47,38,29,.1);font-size:.66rem;font-weight:900;color:#2f261d}
.empty-slot{color:#9a8b7d;font-size:.74rem}
.action-callout,.result-box{display:grid;gap:8px;margin-bottom:14px;border:1px solid #bdd3df;border-radius:8px;padding:12px;background:linear-gradient(180deg,#f0fbff,#eaf6f2)}
.result-box{border-color:#b7d1b2;background:#eef9eb}
.actions-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:12px 0}
.action-card{position:relative;display:grid;gap:4px;min-height:66px;border:1px solid #b9aa96;border-radius:8px;padding:10px;background:linear-gradient(180deg,#fffdf8,#fbf1e2);text-align:left;cursor:pointer;box-shadow:0 3px 0 rgba(64,49,33,.08);transition:transform .15s ease,box-shadow .15s ease,opacity .15s ease}
.action-card:hover:not([data-disabled="true"]){transform:translateY(-1px);box-shadow:0 8px 16px rgba(64,49,33,.12)}
.action-card span{font-weight:800}
.action-card[data-disabled="true"]{cursor:not-allowed;color:#82776a;background:linear-gradient(180deg,#fffaf1,#f4eadb)}
.action-card.used{color:#82776a;background:#f1e8d9}
.action-card::after{content:attr(data-help);position:absolute;left:8px;right:8px;bottom:calc(100% + 8px);z-index:10;border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:8px 10px;background:#1f1711;color:#fff;font-size:.78rem;font-weight:700;line-height:1.25;box-shadow:0 10px 22px rgba(31,24,18,.3);opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .15s ease,transform .15s ease}
.action-card:hover::after,.action-card:focus-visible::after{opacity:1;transform:translateY(0)}
.card:disabled{cursor:not-allowed;opacity:.78}
.selection-help{min-height:38px;margin-bottom:14px}
.hand{margin-top:12px}
.card-row,.offer-row,.set-row{display:flex;flex-wrap:wrap;gap:8px}
.card{position:relative;display:grid;place-items:center;width:92px;height:132px;border:1px solid color-mix(in srgb,var(--card-color) 58%,#554437);border-radius:10px;padding:12px;background:linear-gradient(155deg,#fffdf8,color-mix(in srgb,var(--card-color) 12%,#fffaf2));color:#1f2933;font-weight:800;cursor:pointer;box-shadow:0 6px 14px rgba(47,38,29,.12);overflow:hidden;transition:transform .16s ease,box-shadow .16s ease,opacity .16s ease}
.card:hover:not(:disabled){transform:translateY(-3px);box-shadow:0 12px 22px rgba(54,42,31,.18)}
.card.selected{outline:3px solid #111827;outline-offset:2px}
.card strong{position:absolute;top:7px;right:7px;z-index:3;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#111827;color:white;font-size:.8rem;box-shadow:0 2px 6px rgba(17,24,39,.26)}
.card.offered{width:104px;height:142px}
.card-corner{position:absolute;z-index:2;display:grid;place-items:center;width:30px;height:26px;background:rgba(255,253,248,.9);color:var(--card-color,var(--accent));font-size:.72rem;font-weight:900;box-shadow:0 1px 4px rgba(47,38,29,.12)}
.card-corner.top-left{top:0;left:0;border-radius:0 0 8px 0}
.card-corner.bottom-right{right:0;bottom:0;border-radius:8px 0 0 0;transform:rotate(180deg)}
.card-pattern{position:absolute;inset:10px;border:1px solid color-mix(in srgb,var(--card-color,var(--accent)) 28%,transparent);border-radius:8px;background:radial-gradient(circle at 50% 28%,color-mix(in srgb,var(--card-color,var(--accent)) 18%,transparent),transparent 34%),repeating-linear-gradient(45deg,rgba(47,38,29,.045) 0 1px,transparent 1px 8px)}
.card-center{position:relative;z-index:1;display:grid;justify-items:center;gap:5px;text-align:center}
.card-center b{font-size:.96rem;line-height:1.05}
.card.drawn{animation:card-drawn .45s ease both}
.card.leaving,.set-choice.leaving{animation:card-leaving .22s ease both}
.private-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.private-grid>div{min-height:86px;border:1px dashed #b9aa96;border-radius:8px;padding:10px}
.private-grid p{margin-bottom:0;color:#5e5144}
.set-choice{display:grid;gap:5px;min-width:160px;border:1px solid #9e8d79;border-radius:8px;padding:10px;background:linear-gradient(180deg,#fffdf8,#fbf1e2);text-align:left;cursor:pointer;transition:transform .16s ease,opacity .16s ease}
.set-choice:hover{transform:translateY(-2px)}
.set-choice span:first-child{font-weight:800}
.panel.compact{margin-top:12px}
.log-list{margin:0;padding-left:18px}
.log-list li{margin-bottom:6px;color:#5e5144}
@keyframes card-drawn{0%{opacity:0;transform:translateY(-14px) scale(.94)}60%{opacity:1;transform:translateY(2px) scale(1.04)}100%{opacity:1;transform:translateY(0) scale(1)}}
@keyframes card-leaving{0%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(16px) scale(.86)}}
@media(max-width:1450px){.game-layout{grid-template-columns:minmax(0,980px);max-width:980px}.side-panel{width:980px;max-width:100%}}
@media(max-width:980px){#app{padding:12px}.topbar,.section-title{align-items:flex-start;flex-direction:column}.status-strip{grid-template-columns:repeat(2,minmax(120px,1fr))}.game-layout{grid-template-columns:1fr}}
@media(max-width:560px){.status-strip,.actions-grid,.private-grid{grid-template-columns:1fr}.link-box{grid-template-columns:1fr}}
`;
