const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {applyDiff, toReading, toUnavailableReading, toUnknownEntityReading} = require("../lib/reading.js");

// A state as the initial `a` message of `subscribe_entities` delivers it.
function co2State(overrides = {}) {
	return {
		s: "612",
		a: {
			friendly_name: "Living room CO2",
			unit_of_measurement: "ppm",
			device_class: "carbon_dioxide",
			state_class: "measurement"
		},
		c: "01JBXYZ",
		lc: 1761912000.123456,
		...overrides
	};
}

describe("toReading", () => {
	it("maps a numeric state to every field of the contract", () => {
		assert.deepEqual(toReading("co2", co2State()), {
			name: "co2",
			label: "Living room CO2",
			value: 612,
			unit: "ppm",
			quantity: "carbon_dioxide",
			stateClass: "measurement",
			changedAt: 1761912000123,
			available: true
		});
	});

	it("reads a numeric string with decimals as a number", () => {
		assert.equal(toReading("humidity", co2State({s: "48.23"})).value, 48.23);
		assert.equal(toReading("temperature", co2State({s: "-3.5"})).value, -3.5);
	});

	for (const state of ["unavailable", "unknown"]) {
		it(`marks the state ${state} as unavailable without a value`, () => {
			const reading = toReading("co2", co2State({s: state}));
			assert.equal(reading.value, null);
			assert.equal(reading.available, false);
			assert.equal(reading.label, "Living room CO2");
		});
	}

	for (const state of ["on", "off", "Sunny", "", " ", "0x1A", "Infinity", "NaN", "1,5"]) {
		it(`publishes the non-numeric state ${JSON.stringify(state)} as available without a value`, () => {
			const reading = toReading("window", co2State({s: state}));
			assert.equal(reading.value, null);
			assert.equal(reading.available, true);
		});
	}

	it("sets missing device class, state class, unit and friendly name to null", () => {
		const reading = toReading("template", {s: "7", a: {}, c: "01JBXYZ", lc: 1761912000});
		assert.equal(reading.label, null);
		assert.equal(reading.unit, null);
		assert.equal(reading.quantity, null);
		assert.equal(reading.stateClass, null);
		assert.equal(reading.value, 7);
	});

	it("sets changedAt to null without a last change", () => {
		assert.equal(toReading("co2", co2State({lc: undefined})).changedAt, null);
	});

	it("carries no entity ID and no other attributes", () => {
		const state = co2State();
		state.a.icon = "mdi:molecule-co2";
		state.a.entity_id = "sensor.living_room_co2";
		const reading = toReading("co2", state);
		assert.deepEqual(Object.keys(reading).sort(), [
			"available",
			"changedAt",
			"label",
			"name",
			"quantity",
			"stateClass",
			"unit",
			"value"
		]);
		assert.ok(!JSON.stringify(reading).includes("sensor."));
		assert.ok(!JSON.stringify(reading).includes("mdi:"));
	});
});

describe("applyDiff", () => {
	it("applies a diff that changes only the state", () => {
		const before = co2State();
		const after = applyDiff(before, {"+": {s: "640", lc: 1761912060.5, c: "01JBABC"}});
		assert.deepEqual(toReading("co2", after), {
			...toReading("co2", before),
			value: 640,
			changedAt: 1761912060500
		});
	});

	it("keeps the last change when only attributes change", () => {
		const before = co2State();
		const after = applyDiff(before, {"+": {a: {friendly_name: "Office CO2"}, lu: 1761912090, c: "01JBDEF"}});
		const reading = toReading("co2", after);
		assert.equal(reading.label, "Office CO2");
		assert.equal(reading.changedAt, 1761912000123);
		assert.equal(reading.value, 612);
	});

	it("applies a diff that removes an attribute", () => {
		const after = applyDiff(co2State(), {"-": {a: ["unit_of_measurement"]}});
		const reading = toReading("co2", after);
		assert.equal(reading.unit, null);
		assert.equal(reading.quantity, "carbon_dioxide");
	});

	it("leaves the last known state unchanged", () => {
		const before = co2State();
		const copy = structuredClone(before);
		applyDiff(before, {"+": {s: "700", a: {friendly_name: "x"}}, "-": {a: ["device_class"]}});
		assert.deepEqual(before, copy);
	});
});

describe("toUnavailableReading", () => {
	it("drops the value and keeps every other field of the last reading", () => {
		const last = toReading("co2", co2State());
		assert.deepEqual(toUnavailableReading(last), {...last, value: null, available: false});
	});

	it("leaves the last reading unchanged", () => {
		const last = toReading("co2", co2State());
		toUnavailableReading(last);
		assert.equal(last.value, 612);
		assert.equal(last.available, true);
	});
});

describe("lib/reading.js", () => {
	it("needs neither the MagicMirror host nor a network", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "lib", "reading.js"), "utf8");
		const module = {exports: {}};
		const require = (id) => assert.fail(`lib/reading.js requires ${id}`);
		vm.runInNewContext(source, {module, exports: module.exports, require}, {filename: "reading.js"});
		assert.equal(module.exports.toReading("co2", co2State()).value, 612);
	});
});

describe("toUnknownEntityReading", () => {
	it("sets only the name, marks it unavailable and every other field null", () => {
		assert.deepEqual(toUnknownEntityReading("co2"), {
			name: "co2",
			label: null,
			value: null,
			unit: null,
			quantity: null,
			stateClass: null,
			changedAt: null,
			available: false
		});
	});
});
