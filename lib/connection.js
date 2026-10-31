/* MagicMirror² - MMM-HomeAssistantDataProvider
 *
 * Holds one authenticated WebSocket connection to Home Assistant, keeps
 * the latest reading of every configured name and recovers from every
 * connection failure on its own.
 *
 * Every error stays inside this file: an exception escaping an event
 * handler or a rejected promise would stop the MagicMirror server.
 *
 * The token goes into the auth message and nowhere else: never into a
 * log line, a reading or the connection state.
 *
 * MIT Licensed.
 */

const {applyDiff, toReading, toUnavailableReading, toUnknownEntityReading} = require("./reading.js");

const TIMINGS = {
	// Readings turn unavailable only after this long without connection, so
	// that a restart of Home Assistant does not make displays flicker.
	gracePeriodMs: 30_000,
	initialBackoffMs: 1_000,
	maxBackoffMs: 10_000,
	// A connection that dies without a close, e.g. when the network drops,
	// is noticed only by a ping that gets no pong.
	heartbeatMs: 30_000
};

/**
 * The delay before reconnect attempt `attempt` (0 for the first): doubles
 * with every failed attempt, up to `maxBackoffMs`.
 */
function backoffDelay(attempt, {initialBackoffMs, maxBackoffMs} = TIMINGS) {
	return Math.min(initialBackoffMs * 2 ** attempt, maxBackoffMs);
}

class HomeAssistantConnection {
	/**
	 * `config` is the validated server-side config. `onReading` receives
	 * every reading to publish, `onConnection` every change of
	 * `{connected, since}`. `log` needs `info`, `warn` and `error`.
	 */
	constructor(config, {onReading, onConnection, log, timings = {}, WebSocket = globalThis.WebSocket, now = Date.now}) {
		this.url = `${config.useTLS === true ? "wss" : "ws"}://${config.host}:${config.port}/api/websocket`;
		this.token = config.token;
		this.names = Object.keys(config.readings);
		this.namesByEntity = new Map();
		for (const [name, entityId] of Object.entries(config.readings)) {
			const names = this.namesByEntity.get(entityId) ?? [];
			names.push(name);
			this.namesByEntity.set(entityId, names);
		}

		this.onReading = onReading;
		this.onConnection = onConnection;
		this.log = log;
		this.timings = {...TIMINGS, ...timings};
		this.WebSocket = WebSocket;
		this.now = now;

		this.states = new Map();
		this.latest = new Map();
		this.connectionState = {connected: false, since: now()};

		this.socket = null;
		this.nextId = 1;
		this.subscriptionId = null;
		this.initialStatesReceived = false;
		this.awaitingPong = false;
		this.failedAttempts = 0;
		this.failureLogged = false;
		this.rejected = false;
		this.stopped = false;

		this.reconnectTimer = null;
		this.graceTimer = null;
		this.heartbeatTimer = null;
	}

	/**
	 * Opens the connection and returns at once; the connection and every
	 * retry run in the background.
	 */
	start() {
		this.log.info(`Connecting to Home Assistant at ${this.url}.`);
		// Never connected yet counts as lost: displays get unavailable
		// readings instead of nothing when Home Assistant stays unreachable.
		this.startGracePeriod();
		this.connect();
	}

	/**
	 * Closes the connection and cancels every timer; nothing is published
	 * afterwards.
	 */
	stop() {
		this.stopped = true;
		clearTimeout(this.reconnectTimer);
		clearTimeout(this.graceTimer);
		this.dropSocket();
	}

	/** The latest reading of every configured name that has one. */
	readings() {
		return [...this.latest.values()];
	}

	/** `{connected, since}` as last published. */
	state() {
		return {...this.connectionState};
	}

	connect() {
		this.reconnectTimer = null;
		if (this.stopped) {
			return;
		}
		let socket;
		try {
			socket = new this.WebSocket(this.url);
		} catch (error) {
			this.handleFailure(`Cannot connect to Home Assistant at ${this.url}: ${error.message}`);
			return;
		}
		this.socket = socket;
		this.subscriptionId = null;
		this.initialStatesReceived = false;
		this.awaitingPong = false;

		// Events of a socket this connection already dropped are ignored.
		socket.addEventListener("message", (event) => {
			if (socket === this.socket) {
				this.handleData(event.data);
			}
		});
		socket.addEventListener("error", () => {
			if (socket === this.socket) {
				this.handleClose("The connection to Home Assistant failed.");
			}
		});
		socket.addEventListener("close", () => {
			if (socket === this.socket) {
				this.handleClose("Home Assistant closed the connection.");
			}
		});
	}

	handleData(data) {
		let messages;
		try {
			messages = JSON.parse(data);
		} catch {
			this.log.warn("Home Assistant sent a message that is not JSON; it is ignored.");
			return;
		}
		// Home Assistant may coalesce several messages into an array.
		for (const message of Array.isArray(messages) ? messages : [messages]) {
			try {
				this.handleMessage(message);
			} catch (error) {
				this.log.error(`Cannot handle a message from Home Assistant: ${error.message}`);
			}
		}
	}

	handleMessage(message) {
		switch (message?.type) {
			case "auth_required":
				this.send({type: "auth", access_token: this.token});
				break;
			case "auth_ok":
				this.handleAuthenticated();
				break;
			case "auth_invalid":
				this.handleRejected();
				break;
			case "result":
				if (message.id === this.subscriptionId && message.success !== true) {
					const reason = message.error?.message ?? "no reason given";
					this.handleClose(`Home Assistant refused the subscription: ${reason}`);
				}
				break;
			case "event":
				if (message.id === this.subscriptionId) {
					this.handleEvent(message.event ?? {});
				}
				break;
			case "pong":
				this.awaitingPong = false;
				break;
			default:
				break;
		}
	}

	handleAuthenticated() {
		this.log.info("Connected to Home Assistant.");
		this.setConnected(true);

		// The new subscription sends every current state again; a state kept
		// from before would hide an entity removed in the meantime.
		this.states = new Map();
		this.subscriptionId = this.nextId++;
		this.send({id: this.subscriptionId, type: "subscribe_entities", entity_ids: [...this.namesByEntity.keys()]});
		this.startHeartbeat();
	}

	handleRejected() {
		this.rejected = true;
		this.log.error(
			"Home Assistant rejected the token. The module stays disconnected; correct the token and restart MagicMirror²."
		);
		this.dropSocket();
	}

	handleEvent(event) {
		if (event.a) {
			for (const [entityId, state] of Object.entries(event.a)) {
				this.states.set(entityId, state);
				this.publishEntity(entityId);
			}
			if (!this.initialStatesReceived) {
				this.initialStatesReceived = true;
				// The outage ends with the first states, not with auth_ok: a
				// subscription Home Assistant refuses on every attempt would
				// otherwise keep the readings from ever turning unavailable.
				this.failedAttempts = 0;
				this.failureLogged = false;
				clearTimeout(this.graceTimer);
				this.graceTimer = null;
				this.publishMissingEntities();
			}
		}
		if (event.c) {
			for (const [entityId, diff] of Object.entries(event.c)) {
				const state = this.states.get(entityId);
				if (state) {
					this.states.set(entityId, applyDiff(state, diff));
					this.publishEntity(entityId);
				}
			}
		}
		if (Array.isArray(event.r)) {
			for (const entityId of event.r) {
				if (this.states.delete(entityId)) {
					this.publishUnknownEntity(entityId);
				}
			}
		}
	}

	publishEntity(entityId) {
		const state = this.states.get(entityId);
		for (const name of this.namesByEntity.get(entityId) ?? []) {
			this.publish(toReading(name, state));
		}
	}

	publishMissingEntities() {
		for (const entityId of this.namesByEntity.keys()) {
			if (!this.states.has(entityId)) {
				this.publishUnknownEntity(entityId);
			}
		}
	}

	publishUnknownEntity(entityId) {
		for (const name of this.namesByEntity.get(entityId)) {
			this.log.warn(`Home Assistant does not know the entity of the reading ${name}; it is published as unavailable.`);
			this.publish(toUnknownEntityReading(name));
		}
	}

	publish(reading) {
		this.latest.set(reading.name, reading);
		this.onReading(reading);
	}

	handleClose(reason) {
		const wasConnected = this.connectionState.connected;
		this.dropSocket();
		if (this.stopped || this.rejected) {
			return;
		}
		if (wasConnected) {
			this.setConnected(false);
		}
		this.startGracePeriod();
		this.handleFailure(reason);
	}

	handleFailure(reason) {
		const delay = backoffDelay(this.failedAttempts, this.timings);
		this.failedAttempts++;
		// One line per outage, not one per attempt: Home Assistant may stay
		// away for hours.
		if (!this.failureLogged) {
			this.failureLogged = true;
			this.log.warn(`${reason} Reconnecting with backoff of up to ${this.timings.maxBackoffMs / 1000} s.`);
		}
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
	}

	startGracePeriod() {
		if (this.graceTimer !== null) {
			return;
		}
		this.graceTimer = setTimeout(() => {
			this.graceTimer = null;
			this.publishAllUnavailable();
		}, this.timings.gracePeriodMs);
	}

	publishAllUnavailable() {
		for (const name of this.names) {
			const reading = this.latest.get(name);
			this.publish(reading ? toUnavailableReading(reading) : toUnknownEntityReading(name));
		}
	}

	startHeartbeat() {
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = setInterval(() => {
			if (this.awaitingPong) {
				this.handleClose("Home Assistant did not answer a ping.");
				return;
			}
			this.awaitingPong = true;
			this.send({id: this.nextId++, type: "ping"});
		}, this.timings.heartbeatMs);
	}

	setConnected(connected) {
		this.connectionState = {connected, since: this.now()};
		this.onConnection(this.state());
	}

	send(message) {
		try {
			this.socket?.send(JSON.stringify(message));
		} catch (error) {
			this.handleClose(`Cannot send to Home Assistant: ${error.message}`);
		}
	}

	dropSocket() {
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			try {
				socket.close();
			} catch {
				// Closing a socket that already failed has nothing left to do.
			}
		}
	}
}

module.exports = {HomeAssistantConnection, TIMINGS, backoffDelay};
