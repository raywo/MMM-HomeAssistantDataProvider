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
			// What the real connection would hold: set by a test.
			this.latest = [];
			this.connectionState = {connected: false, since: 0};
			created.push(this);
		}
		start() {
			this.started++;
		}
		stop() {
			this.stopped++;
		}
		readings() {
			return [...this.latest];
		}
		state() {
			return {...this.connectionState};
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

/**
 * Creates the browser side the way MagicMirror² does: as an instance of
 * Module. Records what it publishes to other modules and what it sends to
 * the node_helper; payloads are cloned out of the module's context.
 */
function startModule() {
	const notifications = [];
	const socketNotifications = [];
	const base = {
		name: MODULE_NAME,
		sendNotification(notification, payload) {
			notifications.push({notification, payload: structuredClone(payload)});
		},
		sendSocketNotification(notification, payload) {
			socketNotifications.push({notification, payload: structuredClone(payload)});
		}
	};
	const module = Object.assign(Object.create(base), loadModule()[MODULE_NAME]);
	return {module, notifications, socketNotifications};
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
	const SOCKET_NOTIFICATIONS = [
		"CONFIG",
		"INIT",
		"GET_STATE",
		"GET_READING",
		"SET_CONFIG",
		"HOME_ASSISTANT_READING_REQUEST",
		"HOME_ASSISTANT_CONNECTION_REQUEST"
	];

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

	describe("publishing", () => {
		const CO2 = {
			name: "co2",
			label: "Living room CO2",
			value: 612,
			unit: "ppm",
			quantity: "carbon_dioxide",
			stateClass: "measurement",
			changedAt: 1761904800000,
			available: true
		};
		const HUMIDITY = {...CO2, name: "humidity", label: "Living room humidity", value: 48.2, unit: "%", quantity: "humidity"};
		const CONNECTED = {connected: true, since: 1761904800000};
		const READINGS = {co2: "sensor.living_room_co2", humidity: "sensor.living_room_humidity"};

		/**
		 * Starts the node_helper with a recording connection that holds
		 * `latest`, and the browser side, and lets their socket
		 * notifications reach each other as MagicMirror²'s socket would.
		 */
		function startMirror({latest = [CO2, HUMIDITY], readings = READINGS} = {}) {
			const helperSide = startNodeHelper(serverConfig({readings}));
			const browserSide = startModule();
			const connection = helperSide.connections[0];
			connection.latest = latest;
			connection.connectionState = CONNECTED;

			const toHelper = browserSide.module.sendSocketNotification;
			browserSide.module.sendSocketNotification = function (notification, payload) {
				toHelper.call(this, notification, payload);
				helperSide.helper.socketNotificationReceived(notification, structuredClone(payload));
			};
			helperSide.helper.sendSocketNotification = (notification, payload) => {
				helperSide.sent.push({notification, payload});
				browserSide.module.socketNotificationReceived(notification, structuredClone(payload));
			};
			return {...helperSide, ...browserSide, connection};
		}

		function published({notifications}, notification) {
			return notifications.filter((message) => message.notification === notification).map((message) => message.payload);
		}

		it("forwards each reading and connection change from the node_helper", () => {
			const mirror = startMirror();
			mirror.connection.callbacks.onReading(CO2);
			mirror.connection.callbacks.onConnection(CONNECTED);
			assert.deepEqual(mirror.notifications, [
				{notification: "HOME_ASSISTANT_READING", payload: CO2},
				{notification: "HOME_ASSISTANT_CONNECTION", payload: CONNECTED}
			]);
		});

		it("publishes nothing else the node_helper sends", () => {
			const {module, notifications} = startModule();
			module.socketNotificationReceived("SOMETHING_ELSE", {token: "x"});
			assert.deepEqual(notifications, []);
		});

		it("publishes every known reading and the connection state once after ALL_MODULES_STARTED", () => {
			const mirror = startMirror();
			mirror.module.notificationReceived("ALL_MODULES_STARTED");
			assert.deepEqual(published(mirror, "HOME_ASSISTANT_READING"), [CO2, HUMIDITY]);
			assert.deepEqual(published(mirror, "HOME_ASSISTANT_CONNECTION"), [CONNECTED]);
			assert.equal(mirror.notifications.length, 3);
		});

		it("publishes the connection state after ALL_MODULES_STARTED before any reading is known", () => {
			const mirror = startMirror({latest: []});
			mirror.module.notificationReceived("ALL_MODULES_STARTED");
			assert.deepEqual(mirror.notifications, [{notification: "HOME_ASSISTANT_CONNECTION", payload: CONNECTED}]);
		});

		it("answers a request without name with every reading", () => {
			for (const payload of [undefined, null, {}, {name: undefined}, {name: null}]) {
				const mirror = startMirror();
				mirror.module.notificationReceived("HOME_ASSISTANT_READING_REQUEST", payload);
				assert.deepEqual(mirror.notifications, [
					{notification: "HOME_ASSISTANT_READING", payload: CO2},
					{notification: "HOME_ASSISTANT_READING", payload: HUMIDITY}
				]);
			}
		});

		it("answers a request with a configured name with that reading only", () => {
			const mirror = startMirror();
			mirror.module.notificationReceived("HOME_ASSISTANT_READING_REQUEST", {name: "humidity"});
			assert.deepEqual(mirror.notifications, [{notification: "HOME_ASSISTANT_READING", payload: HUMIDITY}]);
		});

		it("does not answer a request with a name the config does not list", () => {
			for (const name of ["temperature", "", "__proto__", "constructor", "toString"]) {
				const mirror = startMirror();
				mirror.module.notificationReceived("HOME_ASSISTANT_READING_REQUEST", {name});
				assert.deepEqual(mirror.notifications, [], `answered ${name}`);
			}
		});

		it("does not answer a request with an entity ID", () => {
			const mirror = startMirror();
			for (const name of ["sensor.living_room_co2", "sensor.outside_temperature"]) {
				mirror.module.notificationReceived("HOME_ASSISTANT_READING_REQUEST", {name});
			}
			assert.deepEqual(mirror.notifications, []);
		});

		it("does not answer a request with a name that is not a string", () => {
			const mirror = startMirror();
			for (const name of [0, true, ["co2"], {name: "co2"}, {toString: () => "co2"}]) {
				mirror.helper.socketNotificationReceived("HOME_ASSISTANT_READING_REQUEST", {name});
			}
			assert.deepEqual(mirror.sent, []);
		});

		it("does not answer for a configured reading that has none yet", () => {
			const mirror = startMirror({latest: [CO2]});
			mirror.module.notificationReceived("HOME_ASSISTANT_READING_REQUEST", {name: "humidity"});
			assert.deepEqual(mirror.notifications, []);
		});

		it("sends the node_helper the reading name of a request and nothing else", () => {
			const {module, socketNotifications} = startModule();
			module.notificationReceived("HOME_ASSISTANT_READING_REQUEST", {
				name: "co2",
				entityId: "sensor.other",
				host: "attacker.example",
				token: "forged"
			});
			assert.deepEqual(socketNotifications, [{notification: "HOME_ASSISTANT_READING_REQUEST", payload: {name: "co2"}}]);
		});

		it("ignores requests while idle", () => {
			const {helper, sent} = startNodeHelper(serverConfig({host: ""}));
			helper.socketNotificationReceived("HOME_ASSISTANT_READING_REQUEST", {});
			helper.socketNotificationReceived("HOME_ASSISTANT_CONNECTION_REQUEST", {});
			assert.deepEqual(sent, []);
		});

		it("leaves the connection as it is on a request", () => {
			const mirror = startMirror();
			const config = structuredClone(mirror.helper.config);
			mirror.module.notificationReceived("ALL_MODULES_STARTED");
			mirror.module.notificationReceived("HOME_ASSISTANT_READING_REQUEST", {name: "co2"});
			assert.deepEqual(mirror.helper.config, config);
			assert.equal(mirror.connections.length, 1);
			assert.equal(mirror.connection.started, 1);
			assert.equal(mirror.connection.stopped, 0);
		});
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

		it("answers a request with the reading from Home Assistant and reads no other entity", async (t) => {
			const fake = await homeAssistant(t);
			const {helper, sent} = startNodeHelper(serverConfig({host: "127.0.0.1", port: fake.port}), {realConnection: true});
			await waitFor(() => sent.some((message) => message.notification === "HOME_ASSISTANT_READING"));
			const before = sent.length;
			const receivedBefore = fake.received.length;

			helper.socketNotificationReceived("HOME_ASSISTANT_READING_REQUEST", {name: "sensor.living_room_co2"});
			helper.socketNotificationReceived("HOME_ASSISTANT_READING_REQUEST", {name: "co2"});
			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.deepEqual(
				sent.slice(before).map((message) => [message.notification, message.payload.name, message.payload.value]),
				[["HOME_ASSISTANT_READING", "co2", 612]]
			);
			assert.equal(fake.received.length, receivedBefore, "a request reached Home Assistant");
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
