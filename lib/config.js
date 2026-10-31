/* MagicMirror² - MMM-HomeAssistantDataProvider
 *
 * Validates the server-side config of the node_helper. Pure functions: no
 * host, no network, no logging, no mutation of their arguments.
 *
 * No message may contain the value of an option: the token must never
 * reach a log line, also not in an error message.
 *
 * MIT Licensed.
 */

const DEFAULTS = {
	port: 8123,
	useTLS: false
};

// What MagicMirror² leaves in config.js when the variable is not set: it
// replaces `${VAR}` textually for set variables only.
const UNSUBSTITUTED_VARIABLE = /\$\{([^}]*)\}/;

/**
 * Checks the config `getServerModuleConfig()` returns.
 *
 * Returns `{config}` with the defaults applied if the module can work with
 * it, `{errors}` with one message per problem otherwise. String values are
 * taken as they are: a quoted boolean or number is a configuration error of
 * the user, not something to convert.
 */
function validateConfig(config) {
	const options = config ?? {};
	const errors = [];

	if (isBlank(options.host)) {
		errors.push("The option host is missing, empty or not a string.");
	}

	if (isBlank(options.token)) {
		errors.push("The option token is missing, empty or not a string.");
	} else {
		const variable = UNSUBSTITUTED_VARIABLE.exec(options.token);
		if (variable) {
			errors.push(`The option token refers to the environment variable ${variable[1]}, which is not set.`);
		}
	}

	errors.push(...readingsErrors(options.readings));

	if (errors.length > 0) {
		return {errors};
	}
	return {config: {...DEFAULTS, ...options, readings: {...options.readings}}};
}

function readingsErrors(readings) {
	if (readings === null || typeof readings !== "object" || Array.isArray(readings)) {
		return ["The option readings is missing or not an object of reading names and entity IDs."];
	}
	const names = Object.keys(readings);
	if (names.length === 0) {
		return ["The option readings is empty."];
	}
	return names.filter((name) => isBlank(readings[name])).map((name) => `The reading ${name} has no entity ID: it must be a non-empty string.`);
}

function isBlank(value) {
	return typeof value !== "string" || value.trim() === "";
}

module.exports = {DEFAULTS, validateConfig};
