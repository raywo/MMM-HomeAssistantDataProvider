const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
 * Loads the node_helper with stubs of MagicMirror²'s `node_helper` and
 * `logger` modules; returns what it exports, the helpers it created and
 * the lines it logged, by level.
 */
function loadNodeHelper() {
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
 * Starts the node_helper the way MagicMirror² does: as an instance of
 * NodeHelper, whose `getServerModuleConfig()` returns `serverConfig`.
 * Without `serverConfig`, the instance lacks `getServerModuleConfig()`, as
 * before MagicMirror² 2.38.
 */
function startNodeHelper(serverConfig, {browserConfig} = {}) {
	const {exports, logged} = loadNodeHelper();
	const base = {name: MODULE_NAME, config: browserConfig};
	if (serverConfig !== undefined) {
		base.getServerModuleConfig = () => serverConfig;
	}
	const helper = Object.assign(Object.create(base), exports.definition);
	helper.start();
	return {helper, logged};
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
		const {helper, logged} = startNodeHelper(undefined, {browserConfig: serverConfig()});
		assert.equal(helper.config, null, "falls back to the config from the browser");
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
		const {logged} = startNodeHelper(undefined, {browserConfig: serverConfig()});
		assert.ok(allLines(logged).every((line) => !line.includes(TOKEN)));
	});

	it("does not take the connection from the config of the browser", () => {
		const {helper} = startNodeHelper(serverConfig({host: ""}), {browserConfig: serverConfig({host: "attacker.example"})});
		assert.equal(helper.config, null);
	});

	it("has no dependencies", () => {
		const pkg = JSON.parse(read("package.json"));
		assert.equal(pkg.dependencies, undefined);
		assert.equal(pkg.devDependencies, undefined);
	});
});
