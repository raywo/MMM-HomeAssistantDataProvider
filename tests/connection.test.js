const {after, afterEach, before, describe, it} = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");

const {HomeAssistantConnection, TIMINGS, backoffDelay} = require("../lib/connection.js");
const {FakeHomeAssistant, delay, waitFor} = require("./support/fake-home-assistant.js");

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.secret-token-value";

// Short enough for the tests, long enough to tell the steps apart.
const TIMINGS_FOR_TESTS = {gracePeriodMs: 300, initialBackoffMs: 20, maxBackoffMs: 40, heartbeatMs: 1000};

const STATES = {
	"sensor.living_room_co2": {
		s: "612",
		a: {
			friendly_name: "Living room CO2",
			unit_of_measurement: "ppm",
			device_class: "carbon_dioxide",
			state_class: "measurement"
		},
		c: "01J0000000000000000000000",
		lc: 1761904800.123
	},
	"sensor.living_room_humidity": {
		s: "48.23",
		a: {friendly_name: "Living room humidity", unit_of_measurement: "%", device_class: "humidity"},
		c: "01J0000000000000000000001",
		lc: 1761904700
	}
};

const READINGS = {
	co2: "sensor.living_room_co2",
	humidity: "sensor.living_room_humidity"
};

const CO2 = {
	name: "co2",
	label: "Living room CO2",
	value: 612,
	unit: "ppm",
	quantity: "carbon_dioxide",
	stateClass: "measurement",
	changedAt: 1761904800123,
	available: true
};

// Every test fails on an exception or rejection that escaped the module.
const escaped = [];
const recordEscaped = (error) => escaped.push(error);
before(() => {
	process.on("uncaughtException", recordEscaped);
	process.on("unhandledRejection", recordEscaped);
});
after(() => {
	process.off("uncaughtException", recordEscaped);
	process.off("unhandledRejection", recordEscaped);
});

const running = [];
afterEach(async () => {
	for (const item of running.splice(0)) {
		await item.stop();
	}
	assert.deepEqual(escaped, [], "an error escaped as uncaught exception or unhandled rejection");
});

async function startHomeAssistant(options = {}) {
	const homeAssistant = await new FakeHomeAssistant({token: TOKEN, states: STATES, ...options}).listen();
	running.push({stop: () => homeAssistant.close()});
	return homeAssistant;
}

/**
 * Starts a connection to `port` and records what it publishes and logs.
 */
function connect(port, {token = TOKEN, readings = READINGS, timings = TIMINGS_FOR_TESTS} = {}) {
	const published = {readings: [], connection: [], log: {info: [], warn: [], error: []}};
	const log = Object.fromEntries(Object.keys(published.log).map((level) => [level, (line) => published.log[level].push(line)]));
	const connection = new HomeAssistantConnection(
		{host: "127.0.0.1", port, useTLS: false, token, readings},
		{
			log,
			timings,
			onReading: (reading) => published.readings.push(reading),
			onConnection: (state) => published.connection.push(state)
		}
	);
	running.unshift({stop: () => connection.stop()});
	connection.start();
	return {connection, published};
}

function readingsNamed(published, name) {
	return published.readings.filter((reading) => reading.name === name);
}

function lastReading(published, name) {
	return readingsNamed(published, name).at(-1);
}

/** A port nothing listens on. */
async function closedPort() {
	const server = net.createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const {port} = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

describe("HomeAssistantConnection", () => {
	it("authenticates with the token and subscribes to the configured entities only", async () => {
		const homeAssistant = await startHomeAssistant();
		const {published} = connect(homeAssistant.port, {readings: {co2: "sensor.living_room_co2"}});

		await waitFor(() => homeAssistant.subscriptions().length === 1, 2000, "the subscription");
		assert.equal(homeAssistant.received[0].type, "auth");
		assert.equal(homeAssistant.received[0].access_token, TOKEN);
		assert.deepEqual(homeAssistant.subscriptions()[0].entity_ids, ["sensor.living_room_co2"]);
		assert.equal(published.connection.length, 1);
		assert.equal(published.connection[0].connected, true);
		assert.equal(typeof published.connection[0].since, "number");
	});

	it("subscribes to an entity once when two readings name it", async () => {
		const homeAssistant = await startHomeAssistant();
		const {published} = connect(homeAssistant.port, {readings: {co2: "sensor.living_room_co2", air: "sensor.living_room_co2"}});

		await waitFor(() => published.readings.length === 2, 2000, "both readings");
		assert.deepEqual(homeAssistant.subscriptions()[0].entity_ids, ["sensor.living_room_co2"]);
		assert.deepEqual(published.readings.map((reading) => reading.name).sort(), ["air", "co2"]);
	});

	it("publishes the initial states as readings", async () => {
		const homeAssistant = await startHomeAssistant();
		const {connection, published} = connect(homeAssistant.port);

		await waitFor(() => published.readings.length === 2, 2000, "the initial readings");
		assert.deepEqual(lastReading(published, "co2"), CO2);
		assert.equal(lastReading(published, "humidity").value, 48.23);
		assert.deepEqual(
			connection
				.readings()
				.map((reading) => reading.name)
				.sort(),
			["co2", "humidity"]
		);
	});

	it("publishes a configured entity missing from the initial states as unavailable and warns", async () => {
		const homeAssistant = await startHomeAssistant();
		const {published} = connect(homeAssistant.port, {readings: {...READINGS, pressure: "sensor.gone"}});

		await waitFor(() => published.readings.length === 3, 2000, "three readings");
		assert.deepEqual(lastReading(published, "pressure"), {
			name: "pressure",
			label: null,
			value: null,
			unit: null,
			quantity: null,
			stateClass: null,
			changedAt: null,
			available: false
		});
		assert.equal(published.log.warn.length, 1);
		assert.match(published.log.warn[0], /reading pressure/);
	});

	it("publishes an update", async () => {
		const homeAssistant = await startHomeAssistant();
		const {published} = connect(homeAssistant.port);
		await waitFor(() => published.readings.length === 2, 2000, "the initial readings");

		homeAssistant.change("sensor.living_room_co2", {"+": {s: "700", lc: 1761904900, c: "01J0000000000000000000002"}});

		await waitFor(() => readingsNamed(published, "co2").length === 2, 2000, "the update");
		assert.deepEqual(lastReading(published, "co2"), {...CO2, value: 700, changedAt: 1761904900000});
		assert.equal(readingsNamed(published, "humidity").length, 1, "an unchanged reading is not published again");
	});

	it("publishes a reading as unavailable and warns when its entity is removed", async () => {
		const homeAssistant = await startHomeAssistant();
		const {published} = connect(homeAssistant.port);
		await waitFor(() => published.readings.length === 2, 2000, "the initial readings");

		homeAssistant.remove("sensor.living_room_co2");

		await waitFor(() => readingsNamed(published, "co2").length === 2, 2000, "the removal");
		assert.equal(lastReading(published, "co2").available, false);
		assert.equal(lastReading(published, "co2").value, null);
		assert.equal(published.log.warn.length, 1);
		assert.match(published.log.warn[0], /reading co2/);
	});

	it("publishes every reading as unavailable after the grace period while Home Assistant refuses the subscription", async () => {
		const homeAssistant = await startHomeAssistant();
		homeAssistant.refuseSubscriptions = true;
		const {published} = connect(homeAssistant.port, {timings: {...TIMINGS_FOR_TESTS, gracePeriodMs: 150}});

		await waitFor(() => published.readings.length === 2, 2000, "the unavailable readings");
		assert.ok(published.readings.every((reading) => !reading.available));
		assert.ok(homeAssistant.subscriptions().length >= 2, "keeps retrying");
		assert.equal(published.log.warn.length, 1, "one line per outage, not one per attempt");
	});

	it("logs a rejected token once, without the token, and does not retry", async () => {
		const homeAssistant = await startHomeAssistant();
		const {connection, published} = connect(homeAssistant.port, {token: "wrong-token-value"});

		await waitFor(() => published.log.error.length === 1, 2000, "the error");
		await delay(10 * TIMINGS_FOR_TESTS.maxBackoffMs);
		assert.equal(homeAssistant.connections.length, 1, "no second connection after a rejected token");
		assert.equal(published.log.error.length, 1);
		assert.match(published.log.error[0], /rejected the token/);
		assert.ok(!published.log.error[0].includes("wrong-token-value"));
		assert.deepEqual(published.connection, []);
		assert.equal(connection.state().connected, false);
	});

	it("reconnects, resubscribes and publishes the current states after Home Assistant closed the connection", async () => {
		const homeAssistant = await startHomeAssistant();
		const {published} = connect(homeAssistant.port);
		await waitFor(() => published.readings.length === 2, 2000, "the initial readings");

		homeAssistant.states["sensor.living_room_co2"].s = "650";
		homeAssistant.dropClients();

		await waitFor(() => homeAssistant.subscriptions().length === 2, 2000, "the second subscription");
		await waitFor(() => readingsNamed(published, "co2").length === 2, 2000, "the current states");
		assert.equal(lastReading(published, "co2").value, 650);
		assert.equal(readingsNamed(published, "humidity").length, 2);
		assert.deepEqual(
			published.connection.map((state) => state.connected),
			[true, false, true]
		);
		assert.ok(published.readings.every((reading) => reading.available), "a short drop makes no reading unavailable");
	});

	it("keeps trying while Home Assistant is unreachable and connects once it is back", async () => {
		const port = await closedPort();
		const {published} = connect(port);

		await delay(5 * TIMINGS_FOR_TESTS.maxBackoffMs);
		assert.deepEqual(published.connection, []);
		assert.equal(published.log.warn.length, 1, "one line per outage, not one per attempt");

		const homeAssistant = await startHomeAssistant();
		await homeAssistant.close();
		await homeAssistant.listen(port);

		await waitFor(() => published.connection.at(-1)?.connected === true, 2000, "the connection");
		await waitFor(() => published.readings.some((reading) => reading.available), 2000, "the readings");
	});

	it("publishes every reading as unavailable, keeping its other fields, after the grace period", async () => {
		const homeAssistant = await startHomeAssistant();
		const {published} = connect(homeAssistant.port);
		await waitFor(() => published.readings.length === 2, 2000, "the initial readings");

		await homeAssistant.close();
		const lostAt = Date.now();

		await waitFor(() => !lastReading(published, "co2").available, 2000, "the unavailable reading");
		assert.ok(Date.now() - lostAt >= TIMINGS_FOR_TESTS.gracePeriodMs - 20, "not before the grace period");
		assert.deepEqual(lastReading(published, "co2"), {...CO2, value: null, available: false});
		assert.equal(lastReading(published, "humidity").available, false);
		assert.equal(lastReading(published, "humidity").label, "Living room humidity");
	});

	it("publishes every reading as unavailable after the grace period when Home Assistant is unreachable from the start", async () => {
		const {published} = connect(await closedPort());

		await waitFor(() => published.readings.length === 2, 2000, "the unavailable readings");
		assert.ok(published.readings.every((reading) => !reading.available && reading.value === null && reading.label === null));
	});

	it("reconnects when Home Assistant does not answer a ping", async () => {
		const homeAssistant = await startHomeAssistant();
		homeAssistant.answerPings = false;
		const {published} = connect(homeAssistant.port, {timings: {...TIMINGS_FOR_TESTS, heartbeatMs: 30}});

		await waitFor(() => homeAssistant.connections.length >= 2, 2000, "the second connection");
		assert.ok(homeAssistant.received.some((message) => message.type === "ping"));
		assert.equal(published.connection[1].connected, false);
	});

	it("stays connected while Home Assistant answers pings", async () => {
		const homeAssistant = await startHomeAssistant();
		connect(homeAssistant.port, {timings: {...TIMINGS_FOR_TESTS, heartbeatMs: 20}});

		await delay(200);
		assert.ok(homeAssistant.received.filter((message) => message.type === "ping").length >= 3);
		assert.equal(homeAssistant.connections.length, 1);
	});

	it("publishes nothing and does not reconnect after stop()", async () => {
		const homeAssistant = await startHomeAssistant();
		const {connection, published} = connect(homeAssistant.port);
		await waitFor(() => published.readings.length === 2, 2000, "the initial readings");

		connection.stop();
		const count = published.readings.length + published.connection.length;
		await delay(TIMINGS_FOR_TESTS.gracePeriodMs + 50);
		assert.equal(published.readings.length + published.connection.length, count);
		assert.equal(homeAssistant.connections.length, 1);
	});

	it("puts the token into no log line, reading or connection state", async () => {
		const homeAssistant = await startHomeAssistant();
		const {published} = connect(homeAssistant.port);
		await waitFor(() => published.readings.length === 2, 2000, "the initial readings");
		await homeAssistant.close();
		await waitFor(() => published.readings.length === 4, 2000, "the unavailable readings");

		const everything = JSON.stringify(published);
		assert.ok(!everything.includes(TOKEN));
	});
});

describe("backoffDelay", () => {
	it("doubles from the initial delay up to the cap of about 10 s", () => {
		const delays = Array.from({length: 7}, (_, attempt) => backoffDelay(attempt));
		assert.deepEqual(delays, [1000, 2000, 4000, 8000, 10000, 10000, 10000]);
	});

	it("waits 30 s before readings turn unavailable", () => {
		assert.equal(TIMINGS.gracePeriodMs, 30_000);
	});
});
