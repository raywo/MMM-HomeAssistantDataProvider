const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {validateConfig} = require("../lib/config.js");

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.secret-token-value";

// What config.js holds when MagicMirror² finds the variable not set.
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder is the case under test
const UNSET_TOKEN = "${SECRET_HOMEASSISTANT_TOKEN}";

function validConfig(overrides = {}) {
	return {
		host: "192.168.1.10",
		token: TOKEN,
		readings: {
			co2: "sensor.living_room_co2",
			humidity: "sensor.living_room_humidity"
		},
		...overrides
	};
}

function errorsFor(config) {
	const result = validateConfig(config);
	assert.equal(result.config, undefined, "an invalid config yields no config");
	assert.ok(result.errors.length > 0);
	return result.errors;
}

describe("validateConfig", () => {
	it("accepts a valid config and applies the defaults for port and useTLS", () => {
		assert.deepEqual(validateConfig(validConfig()), {
			config: {
				host: "192.168.1.10",
				port: 8123,
				useTLS: false,
				token: TOKEN,
				readings: {
					co2: "sensor.living_room_co2",
					humidity: "sensor.living_room_humidity"
				}
			}
		});
	});

	it("keeps a configured port and useTLS", () => {
		const {config} = validateConfig(validConfig({port: 443, useTLS: true}));
		assert.equal(config.port, 443);
		assert.equal(config.useTLS, true);
	});

	it("takes string values as they are, without converting them", () => {
		const {config} = validateConfig(validConfig({port: "8123", useTLS: "false"}));
		assert.equal(config.port, "8123");
		assert.equal(config.useTLS, "false");
	});

	it("does not mutate its argument and does not share the readings with it", () => {
		const input = validConfig();
		const snapshot = structuredClone(input);
		const {config} = validateConfig(input);
		assert.deepEqual(input, snapshot);
		assert.notEqual(config.readings, input.readings);
	});

	for (const [label, host] of [
		["missing", undefined],
		["empty", ""],
		["blank", "  "],
		["not a string", 192]
	]) {
		it(`names host when it is ${label}`, () => {
			assert.deepEqual(errorsFor(validConfig({host})), ["The option host is missing, empty or not a string."]);
		});
	}

	for (const [label, token] of [
		["missing", undefined],
		["empty", ""],
		["blank", " "],
		["not a string", 42]
	]) {
		it(`names token when it is ${label}`, () => {
			assert.deepEqual(errorsFor(validConfig({token})), ["The option token is missing, empty or not a string."]);
		});
	}

	it("names the variable when a SECRET_* placeholder was not substituted", () => {
		assert.deepEqual(errorsFor(validConfig({token: UNSET_TOKEN})), [
			"The option token refers to the environment variable SECRET_HOMEASSISTANT_TOKEN, which is not set."
		]);
	});

	for (const [label, readings] of [
		["missing", undefined],
		["null", null],
		["an array", ["sensor.living_room_co2"]],
		["a string", "sensor.living_room_co2"]
	]) {
		it(`names readings when it is ${label}`, () => {
			assert.deepEqual(errorsFor(validConfig({readings})), [
				"The option readings is missing or not an object of reading names and entity IDs."
			]);
		});
	}

	it("names readings when it is empty", () => {
		assert.deepEqual(errorsFor(validConfig({readings: {}})), ["The option readings is empty."]);
	});

	it("names every reading without an entity ID", () => {
		const readings = {co2: "sensor.living_room_co2", humidity: "", pressure: 3};
		assert.deepEqual(errorsFor(validConfig({readings})), [
			"The reading humidity has no entity ID: it must be a non-empty string.",
			"The reading pressure has no entity ID: it must be a non-empty string."
		]);
	});

	it("names every problem at once", () => {
		assert.deepEqual(errorsFor(validConfig({host: "", token: undefined, readings: {}})), [
			"The option host is missing, empty or not a string.",
			"The option token is missing, empty or not a string.",
			"The option readings is empty."
		]);
	});

	for (const config of [undefined, null, {}]) {
		it(`names host, token and readings for the config ${JSON.stringify(config)}`, () => {
			assert.equal(errorsFor(config).length, 3);
		});
	}

	it("never puts the token into a message", () => {
		const invalid = [
			validConfig({host: ""}),
			validConfig({readings: {}}),
			validConfig({readings: {co2: ""}}),
			validConfig({host: undefined, readings: null})
		];
		for (const config of invalid) {
			for (const error of errorsFor(config)) {
				assert.ok(!error.includes(TOKEN), `message contains the token: ${error}`);
			}
		}
	});
});

describe("lib/config.js", () => {
	it("needs neither the MagicMirror host nor a network", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "lib", "config.js"), "utf8");
		const module = {exports: {}};
		const require = (id) => assert.fail(`lib/config.js requires ${id}`);
		vm.runInNewContext(source, {module, exports: module.exports, require}, {filename: "config.js"});
		assert.ok(module.exports.validateConfig(validConfig()).config);
	});
});
