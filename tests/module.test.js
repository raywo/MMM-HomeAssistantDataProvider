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
 * Loads the node_helper with a stub of MagicMirror²'s `node_helper`
 * module; returns what it exports and the helpers it created.
 */
function loadNodeHelper() {
	const module = {exports: {}};
	const created = [];
	const stubs = {
		node_helper: {
			create: (definition) => {
				const helper = {definition};
				created.push(helper);
				return helper;
			}
		}
	};
	const require = (id) => {
		assert.ok(id in stubs, `node_helper requires ${id}, which the test does not stub`);
		return stubs[id];
	};
	vm.runInNewContext(read("node_helper.js"), {module, exports: module.exports, require}, {filename: "node_helper.js"});
	return {exports: module.exports, created};
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

	it("has no dependencies", () => {
		const pkg = JSON.parse(read("package.json"));
		assert.equal(pkg.dependencies, undefined);
		assert.equal(pkg.devDependencies, undefined);
	});
});
