/* MagicMirror² - MMM-HomeAssistantDataProvider
 *
 * Holds the connection to Home Assistant. Connection data and readings
 * come from the server-side config only, never from a socket message:
 * MagicMirror restores SECRET_* placeholders in every socket message, so a
 * host taken from the browser would let anyone who can open the mirror
 * send the token to a server of their choice.
 *
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");
const Log = require("logger");
const {validateConfig} = require("./lib/config.js");

const MODULE_NAME = "MMM-HomeAssistantDataProvider";

module.exports = NodeHelper.create({
	start() {
		// Stays null while the module is idle.
		this.config = null;

		// Never fall back to the config from the browser: it is the one a
		// socket message can forge.
		if (typeof this.getServerModuleConfig !== "function") {
			Log.error(
				`${MODULE_NAME} requires MagicMirror² 2.38 or newer, which provides getServerModuleConfig(). The module stays idle.`
			);
			return;
		}

		const {config, errors} = validateConfig(this.getServerModuleConfig());
		if (errors) {
			for (const error of errors) {
				Log.error(`${MODULE_NAME}: ${error}`);
			}
			Log.error(`${MODULE_NAME}: The config cannot work. The module stays idle.`);
			return;
		}
		this.config = config;
	}
});
