/* A fake of the Home Assistant WebSocket API for the tests: enough of
 * RFC 6455 to talk to Node's built-in WebSocket, and enough of Home
 * Assistant for auth, subscribe_entities and ping.
 */

const crypto = require("node:crypto");
const http = require("node:http");

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class FakeHomeAssistant {
	/**
	 * `token` is the one token accepted; `states` the compressed states of
	 * the entities Home Assistant knows, by entity ID.
	 */
	constructor({token, states = {}}) {
		this.token = token;
		this.states = structuredClone(states);
		this.answerPings = true;
		// Answers subscribe_entities with an error, as Home Assistant does
		// for an entity ID of invalid format.
		this.refuseSubscriptions = false;
		// Every message a client sent, in order.
		this.received = [];
		// Every connection that completed the WebSocket handshake.
		this.connections = [];
		this.clients = new Set();
		this.server = null;
		this.port = 0;
	}

	/** Listens on `port`, or on a free port the first time. */
	async listen(port = this.port) {
		this.server = http.createServer((_request, response) => {
			response.writeHead(426).end();
		});
		this.server.on("upgrade", (request, socket) => this.accept(request, socket));
		await new Promise((resolve) => this.server.listen(port, "127.0.0.1", resolve));
		this.port = this.server.address().port;
		return this;
	}

	/** Stops listening and drops every client. */
	async close() {
		this.dropClients();
		if (this.server) {
			const server = this.server;
			this.server = null;
			const closed = new Promise((resolve) => server.close(resolve));
			server.closeAllConnections();
			await closed;
		}
	}

	/** Closes every client connection with a close frame. */
	dropClients() {
		for (const client of this.clients) {
			client.close();
		}
	}

	/** Changes a state and sends the diff to every subscription. */
	change(entityId, diff) {
		const state = this.states[entityId];
		Object.assign(state, diff["+"]);
		for (const client of this.clients) {
			for (const subscription of client.subscriptions) {
				if (subscription.entityIds.includes(entityId)) {
					client.send({id: subscription.id, type: "event", event: {c: {[entityId]: diff}}});
				}
			}
		}
	}

	/** Removes an entity and reports it to every subscription. */
	remove(entityId) {
		delete this.states[entityId];
		for (const client of this.clients) {
			for (const subscription of client.subscriptions) {
				if (subscription.entityIds.includes(entityId)) {
					client.send({id: subscription.id, type: "event", event: {r: [entityId]}});
				}
			}
		}
	}

	/** The `subscribe_entities` messages received, in order. */
	subscriptions() {
		return this.received.filter((message) => message.type === "subscribe_entities");
	}

	accept(request, socket) {
		const accept = crypto
			.createHash("sha1")
			.update(request.headers["sec-websocket-key"] + WEBSOCKET_GUID)
			.digest("base64");
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`
		);
		const client = new FakeClient(socket, (message) => this.handle(client, message));
		this.connections.push(client);
		this.clients.add(client);
		socket.on("close", () => this.clients.delete(client));
		client.send({type: "auth_required", ha_version: "2026.10.2"});
	}

	handle(client, message) {
		this.received.push(message);
		switch (message.type) {
			case "auth":
				if (message.access_token === this.token) {
					client.authenticated = true;
					client.send({type: "auth_ok", ha_version: "2026.10.2"});
				} else {
					client.send({type: "auth_invalid", message: "Invalid access token or password"});
					client.close();
				}
				break;
			case "subscribe_entities": {
				if (this.refuseSubscriptions) {
					client.send({
						id: message.id,
						type: "result",
						success: false,
						error: {code: "invalid_format", message: "Entity IDs are invalid"}
					});
					break;
				}
				const entityIds = message.entity_ids;
				client.subscriptions.push({id: message.id, entityIds});
				client.send({id: message.id, type: "result", success: true, result: null});
				const known = Object.fromEntries(entityIds.filter((id) => id in this.states).map((id) => [id, this.states[id]]));
				client.send({id: message.id, type: "event", event: {a: known}});
				break;
			}
			case "ping":
				if (this.answerPings) {
					client.send({id: message.id, type: "pong"});
				}
				break;
			default:
				break;
		}
	}
}

/** One WebSocket connection on the server side: text frames only. */
class FakeClient {
	constructor(socket, onMessage) {
		this.socket = socket;
		this.onMessage = onMessage;
		this.authenticated = false;
		this.subscriptions = [];
		this.buffer = Buffer.alloc(0);
		socket.on("data", (chunk) => this.read(chunk));
		socket.on("error", () => {});
	}

	send(message) {
		this.write(0x1, Buffer.from(JSON.stringify(message)));
	}

	close() {
		this.write(0x8, Buffer.from([0x03, 0xe8]));
		this.socket.end();
	}

	write(opcode, payload) {
		if (this.socket.destroyed || this.socket.writableEnded) {
			return;
		}
		let header;
		if (payload.length < 126) {
			header = Buffer.from([0x80 | opcode, payload.length]);
		} else if (payload.length < 65536) {
			header = Buffer.alloc(4);
			header.writeUInt8(0x80 | opcode, 0);
			header.writeUInt8(126, 1);
			header.writeUInt16BE(payload.length, 2);
		} else {
			header = Buffer.alloc(10);
			header.writeUInt8(0x80 | opcode, 0);
			header.writeUInt8(127, 1);
			header.writeBigUInt64BE(BigInt(payload.length), 2);
		}
		this.socket.write(Buffer.concat([header, payload]));
	}

	read(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const frame = parseFrame(this.buffer);
			if (!frame) {
				return;
			}
			this.buffer = this.buffer.subarray(frame.length);
			if (frame.opcode === 0x1) {
				this.onMessage(JSON.parse(frame.payload.toString("utf8")));
			} else if (frame.opcode === 0x8) {
				this.close();
			} else if (frame.opcode === 0x9) {
				this.write(0xa, frame.payload);
			}
		}
	}
}

// Client frames are always masked; fragmented messages do not occur here.
function parseFrame(buffer) {
	if (buffer.length < 2) {
		return null;
	}
	const opcode = buffer[0] & 0x0f;
	let length = buffer[1] & 0x7f;
	let offset = 2;
	if (length === 126) {
		if (buffer.length < 4) {
			return null;
		}
		length = buffer.readUInt16BE(2);
		offset = 4;
	} else if (length === 127) {
		if (buffer.length < 10) {
			return null;
		}
		length = Number(buffer.readBigUInt64BE(2));
		offset = 10;
	}
	if (buffer.length < offset + 4 + length) {
		return null;
	}
	const mask = buffer.subarray(offset, offset + 4);
	const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
	for (let i = 0; i < payload.length; i++) {
		payload[i] ^= mask[i % 4];
	}
	return {opcode, payload, length: offset + 4 + length};
}

/** Resolves once `predicate()` holds; fails after `timeoutMs`. */
async function waitFor(predicate, timeoutMs = 2000, what = "condition") {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {FakeHomeAssistant, delay, waitFor};
