/* MagicMirror² - MMM-HomeAssistantDataProvider
 *
 * Maps Home Assistant states to readings as the README's contract for
 * HOME_ASSISTANT_READING defines them. Pure functions: no host, no
 * network, no mutation of their arguments.
 *
 * States are kept in the compressed format of `subscribe_entities`:
 * `s` state, `a` attributes, `lc` last changed and `lu` last updated in
 * seconds since the epoch, `c` context.
 *
 * MIT Licensed.
 */

const UNAVAILABLE_STATES = new Set(["unavailable", "unknown"]);

// Plain decimal notation only. `Number()` alone would also accept "",
// " ", "0x1A" and "Infinity" as numbers.
const NUMERIC_STATE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Applies a diff of a `c` message (`{"+": {...}, "-": {...}}`) to the last
 * known compressed state and returns the new state.
 */
function applyDiff(state, diff) {
	const next = {...state, a: {...state.a}};
	const added = diff["+"];
	if (added) {
		for (const key of ["s", "c", "lc", "lu"]) {
			if (added[key] !== undefined) {
				next[key] = added[key];
			}
		}
		if (added.a) {
			Object.assign(next.a, added.a);
		}
	}
	const removed = diff["-"];
	if (removed?.a) {
		for (const attribute of removed.a) {
			delete next.a[attribute];
		}
	}
	return next;
}

/**
 * Turns a compressed state into the reading published under `name`.
 */
function toReading(name, state) {
	const attributes = state.a ?? {};
	const available = !UNAVAILABLE_STATES.has(state.s);
	return {
		name,
		label: stringOrNull(attributes.friendly_name),
		value: available ? toNumber(state.s) : null,
		unit: stringOrNull(attributes.unit_of_measurement),
		quantity: stringOrNull(attributes.device_class),
		stateClass: stringOrNull(attributes.state_class),
		changedAt: typeof state.lc === "number" ? Math.round(state.lc * 1000) : null,
		available
	};
}

/**
 * The reading after the connection stayed lost: the last known reading
 * with no value, everything else kept so a display can still show what
 * it is.
 */
function toUnavailableReading(reading) {
	return {...reading, value: null, available: false};
}

/**
 * The reading for a configured entity that Home Assistant does not know.
 */
function toUnknownEntityReading(name) {
	return {
		name,
		label: null,
		value: null,
		unit: null,
		quantity: null,
		stateClass: null,
		changedAt: null,
		available: false
	};
}

function toNumber(state) {
	if (typeof state === "number") {
		return Number.isFinite(state) ? state : null;
	}
	if (typeof state !== "string" || !NUMERIC_STATE.test(state)) {
		return null;
	}
	const value = Number(state);
	return Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
	return typeof value === "string" ? value : null;
}

module.exports = {applyDiff, toReading, toUnavailableReading, toUnknownEntityReading};
