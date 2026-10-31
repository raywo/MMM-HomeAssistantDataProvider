const {afterEach, describe, it} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const vm = require("node:vm");

const {FakeHomeAssistant, waitFor} = require("./support/fake-home-assistant.js");

const REPO_ROOT = path.join(__dirname, "..");
const MODULE_NAME = "MMM-HomeAssistantDataProvider";

function read(file) {
	return fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
}

/**
 * Loads the browser side the way MagicMirror² loads it into the page and
 * returns the definitions passed to `Module.register`, by name.
 */
function loadModule() {
	const modules = {};
	const context = vm.createContext({
		Module: {
			register: (name, definition) => {
				modules[name] = definition;
			}
		},
		document: {
			createElement: (tagName) => ({tagName: tagName.toUpperCase(), childNodes: [], innerHTML: ""})
		}
	});
	vm.runInContext(read(`${MODULE_NAME}.js`), context, {filename: `${MODULE_NAME}.js`});
	return modules;
}

/**
 * Stands in for lib/connection.js where a test needs no network: records
 * every connection the helper creates.
 */
function recordingConnection() {
	const created = [];
	class HomeAssistantConnection {
		constructor(config, callbacks) {
			this.config = config;
			this.callbacks = callbacks;
			this.started = 0;
			this.stopped = 0;
			created.push(this);
		}
		start() {
			this.started++;
		}
		stop() {
			this.stopped++;
		}
	}
	return {created, lib: {HomeAssistantConnection}};
}

/**
 * Loads the node_helper with stubs of MagicMirror²'s `node_helper` and
 * `logger` modules, and with `lib` in place of the files under lib/ it
 * names; returns what it exports, the helpers it created and the lines it
 * logged, by level.
 */
function loadNodeHelper(lib = {}) {
	const module = {exports: {}};
	const created = [];
	const logged = {log: [], info: [], warn: [], error: [], debug: []};
	const logger = Object.fromEntries(Object.keys(logged).map((level) => [level, (...args) => logged[level].push(args.join(" "))]));
	const stubs = {
		node_helper: {
			create: (definition) => {
				const helper = {definition};
				created.push(helper);
				return helper;
			}
		},
		logger
	};
	const requireStub = (id) => {
		if (id in lib) {
			return lib[id];
		}
		if (id.startsWith("./lib/")) {
			return require(path.join(REPO_ROOT, id));
		}
		assert.ok(id in stubs, `node_helper requires ${id}, which the test does not stub`);
		return stubs[id];
	};
	vm.runInNewContext(read("node_helper.js"), {module, exports: module.exports, require: requireStub}, {
		filename: "node_helper.js"
	});
	return {exports: module.exports, created, logged};
}

const started = [];
afterEach(() => {
	for (const helper of started.splice(0)) {
		helper.stop();
	}
});

/**
 * Starts the node_helper the way MagicMirror² does: as an instance of
 * NodeHelper, whose `getServerModuleConfig()` returns `serverConfig`.
 * Without `serverConfig`, the instance lacks `getServerModuleConfig()`, as
 * before MagicMirror² 2.38. Like NodeHelper, the base ignores a socket
 * notification the helper does not handle itself, and records what the
 * helper sends to the browser.
 *
 * The helper gets a recording connection unless `realConnection` is set.
 */
function startNodeHelper(serverConfig, {realConnection = false} = {}) {
	const connections = recordingConnection();
	const {exports, logged} = loadNodeHelper(realConnection ? {} : {"./lib/connection.js": connections.lib});
	const sent = [];
	const base = {
		name: MODULE_NAME,
		socketNotificationReceived() {},
		sendSocketNotification(notification, payload) {
			sent.push({notification, payload});
		}
	};
	if (serverConfig !== undefined) {
		base.getServerModuleConfig = () => serverConfig;
	}
	const helper = Object.assign(Object.create(base), exports.definition);
	const result = helper.start();
	started.push(helper);
	return {helper, logged, sent, result, connections: connections.created};
}

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.secret-token-value";

// What config.js holds when MagicMirror² finds the variable not set.
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder is the case under test
const UNSET_TOKEN = "${SECRET_HOMEASSISTANT_TOKEN}";

function serverConfig(overrides = {}) {
	return {
		host: "192.168.1.10",
		token: TOKEN,
		readings: {co2: "sensor.living_room_co2"},
		...overrides
	};
}

function allLines(logged) {
	return Object.values(logged).flat();
}

describe(MODULE_NAME, () => {
	it("registers under the name of its directory", () => {
		assert.deepEqual(Object.keys(loadModule()), [MODULE_NAME]);
	});

	it("shows nothing", () => {
		const dom = loadModule()[MODULE_NAME].getDom();
		assert.equal(dom.childNodes.length, 0);
		assert.equal(dom.innerHTML, "");
	});

	it("has a node_helper created through MagicMirror²'s NodeHelper", () => {
		const {exports, created} = loadNodeHelper();
		assert.equal(created.length, 1);
		assert.equal(exports, created[0]);
	});

	it("takes its config from getServerModuleConfig()", () => {
		const {helper, logged} = startNodeHelper(serverConfig());
		assert.deepEqual(helper.config, {
			host: "192.168.1.10",
			port: 8123,
			useTLS: false,
			token: TOKEN,
			readings: {co2: "sensor.living_room_co2"}
		});
		assert.deepEqual(logged.error, []);
	});

	it("stays idle and names the required version without getServerModuleConfig()", () => {
		const {helper, logged} = startNodeHelper(undefined);
		assert.equal(helper.config, null);
		assert.equal(logged.error.length, 1);
		assert.match(logged.error[0], /MagicMirror² 2\.38/);
		assert.match(logged.error[0], /getServerModuleConfig\(\)/);
	});

	for (const [label, overrides, expected] of [
		["host is missing", {host: undefined}, /option host/],
		["token is missing", {token: ""}, /option token/],
		["readings are missing", {readings: undefined}, /option readings/],
		["readings are empty", {readings: {}}, /option readings is empty/],
		["the token variable is not set", {token: UNSET_TOKEN}, /SECRET_HOMEASSISTANT_TOKEN, which is not set/]
	]) {
		it(`stays idle and logs why when ${label}`, () => {
			const {helper, logged} = startNodeHelper(serverConfig(overrides));
			assert.equal(helper.config, null);
			assert.ok(
				logged.error.some((line) => expected.test(line)),
				`no error matches ${expected}: ${logged.error}`
			);
			assert.ok(logged.error.every((line) => line.startsWith(`${MODULE_NAME}`)));
		});
	}

	it("never logs the token, also not in error messages", () => {
		const cases = [serverConfig(), serverConfig({host: ""}), serverConfig({readings: {}}), serverConfig({readings: {co2: ""}})];
		for (const config of cases) {
			const {logged} = startNodeHelper(config);
			for (const line of allLines(logged)) {
				assert.ok(!line.includes(TOKEN), `log line contains the token: ${line}`);
			}
		}
	});

	// The browser reaches the helper only through socket notifications, and
	// MagicMirror² restores SECRET_* placeholders in their payloads.
	const FORGED = {host: "attacker.example", port: 443, useTLS: true, token: "forged", readings: {co2: "sensor.other"}};
	const SOCKET_NOTIFICATIONS = ["CONFIG", "INIT", "GET_STATE", "GET_READING", "SET_CONFIG"];

	function sendForged(helper) {
		for (const notification of SOCKET_NOTIFICATIONS) {
			helper.socketNotificationReceived(notification, FORGED);
			helper.socketNotificationReceived(notification, {config: FORGED});
		}
	}

	it("does not take the connection from a socket notification", () => {
		const {helper} = startNodeHelper(serverConfig());
		const config = structuredClone(helper.config);
		sendForged(helper);
		assert.deepEqual(helper.config, config);
	});

	it("does not fall back to a socket notification without getServerModuleConfig()", () => {
		const {helper} = startNodeHelper(undefined);
		sendForged(helper);
		assert.equal(helper.config, null);
	});

	it("does not fall back to a socket notification on an invalid config", () => {
		const {helper} = startNodeHelper(serverConfig({host: ""}));
		sendForged(helper);
		assert.equal(helper.config, null);
	});

	it("connects once in start(), with the server-side config", () => {
		const {helper, connections} = startNodeHelper(serverConfig());
		assert.equal(connections.length, 1);
		assert.deepEqual(connections[0].config, helper.config);
		assert.equal(connections[0].started, 1);
	});

	it("does not connect while idle", () => {
		assert.equal(startNodeHelper(undefined).connections.length, 0);
		assert.equal(startNodeHelper(serverConfig({host: ""})).connections.length, 0);
	});

	it("sends readings and connection changes to the browser side", () => {
		const {sent, connections} = startNodeHelper(serverConfig());
		const reading = {name: "co2", value: 612, available: true};
		connections[0].callbacks.onReading(reading);
		connections[0].callbacks.onConnection({connected: true, since: 1});
		assert.deepEqual(sent, [
			{notification: "HOME_ASSISTANT_READING", payload: reading},
			{notification: "HOME_ASSISTANT_CONNECTION", payload: {connected: true, since: 1}}
		]);
	});

	it("prefixes the log lines of the connection with the module name", () => {
		const {logged, connections} = startNodeHelper(serverConfig());
		connections[0].callbacks.log.warn("Something happened.");
		assert.deepEqual(logged.warn, [`${MODULE_NAME}: Something happened.`]);
	});

	it("closes the connection in stop()", () => {
		const {helper, connections} = startNodeHelper(serverConfig());
		helper.stop();
		assert.equal(connections[0].stopped, 1);
	});

	it("opens no second connection when the browser side registers again", () => {
		const {helper, connections} = startNodeHelper(serverConfig());
		sendForged(helper);
		sendForged(helper);
		assert.equal(connections.length, 1);
		assert.equal(connections[0].started, 1);
	});

	describe("against a fake Home Assistant", () => {
		const STATES = {"sensor.living_room_co2": {s: "612", a: {friendly_name: "Living room CO2"}, c: "01J", lc: 1761904800}};

		async function homeAssistant(t) {
			const fake = await new FakeHomeAssistant({token: TOKEN, states: STATES}).listen();
			t.after(() => fake.close());
			return fake;
		}

		it("returns from start() at once while Home Assistant does not answer", async (t) => {
			// Accepts TCP connections and never completes a WebSocket handshake.
			const silent = net.createServer(() => {});
			await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
			t.after(() => {
				silent.close();
				silent.closeAllConnections?.();
			});

			const before = Date.now();
			const {result} = startNodeHelper(serverConfig({host: "127.0.0.1", port: silent.address().port}), {
				realConnection: true
			});
			assert.equal(result, undefined, "start() returns no promise MagicMirror² would wait for");
			assert.ok(Date.now() - before < 100);
		});

		it("keeps one connection when the browser side registers again", async (t) => {
			const fake = await homeAssistant(t);
			const {helper, sent} = startNodeHelper(serverConfig({host: "127.0.0.1", port: fake.port}), {realConnection: true});
			await waitFor(() => sent.some((message) => message.notification === "HOME_ASSISTANT_READING"));

			sendForged(helper);
			sendForged(helper);
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(fake.connections.length, 1);
			assert.equal(fake.subscriptions().length, 1);
		});

		it("puts the token into no log line and no message to the browser", async (t) => {
			const fake = await homeAssistant(t);
			const accepted = startNodeHelper(serverConfig({host: "127.0.0.1", port: fake.port}), {realConnection: true});
			const rejected = startNodeHelper(serverConfig({host: "127.0.0.1", port: fake.port, token: `${TOKEN}-wrong`}), {
				realConnection: true
			});
			await waitFor(() => accepted.sent.some((message) => message.notification === "HOME_ASSISTANT_READING"));
			await waitFor(() => rejected.logged.error.length === 1);

			for (const {logged, sent} of [accepted, rejected]) {
				for (const line of allLines(logged)) {
					assert.ok(!line.includes(TOKEN), `log line contains the token: ${line}`);
				}
				assert.ok(!JSON.stringify(sent).includes(TOKEN), "a message to the browser contains the token");
			}
		});
	});

	it("has no dependencies", () => {
		const pkg = JSON.parse(read("package.json"));
		assert.equal(pkg.dependencies, undefined);
		assert.equal(pkg.devDependencies, undefined);
	});
});
