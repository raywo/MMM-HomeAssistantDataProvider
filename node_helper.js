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
const {HomeAssistantConnection} = require("./lib/connection.js");

const MODULE_NAME = "MMM-HomeAssistantDataProvider";

const prefixedLog = {
	info: (message) => Log.info(`${MODULE_NAME}: ${message}`),
	warn: (message) => Log.warn(`${MODULE_NAME}: ${message}`),
	error: (message) => Log.error(`${MODULE_NAME}: ${message}`)
};

module.exports = NodeHelper.create({
	start() {
		// Both stay null while the module is idle.
		this.config = null;
		this.connection = null;

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

		// Not awaited: MagicMirror² waits for start() before it starts, and
		// Home Assistant may be unreachable for a long time.
		this.connection = new HomeAssistantConnection(config, {
			log: prefixedLog,
			onReading: (reading) => this.sendSocketNotification("HOME_ASSISTANT_READING", reading),
			onConnection: (state) => this.sendSocketNotification("HOME_ASSISTANT_CONNECTION", state)
		});
		this.connection.start();
	},

	/**
	 * Every socket notification is untrusted: anyone who can open the
	 * mirror can send one. It may only ask for what the helper already
	 * publishes; the payload is read for a reading name and nothing else.
	 */
	socketNotificationReceived(notification, payload) {
		if (this.connection === null) {
			return;
		}
		switch (notification) {
			case "HOME_ASSISTANT_READING_REQUEST":
				this.answerReadingRequest(payload?.name);
				break;
			case "HOME_ASSISTANT_CONNECTION_REQUEST":
				this.sendSocketNotification("HOME_ASSISTANT_CONNECTION", this.connection.state());
				break;
			default:
				break;
		}
	},

	/**
	 * Sends the latest reading of every configured name, or only of `name`
	 * if given. A name the server-side config does not list, such as an
	 * entity ID, gets no answer: the answer only ever comes from the
	 * readings the connection already holds, which are the configured
	 * ones. Never look a name up anywhere else, e.g. in Home Assistant.
	 */
	answerReadingRequest(name) {
		const all = name === undefined || name === null;
		for (const reading of this.connection.readings()) {
			if (all || reading.name === name) {
				this.sendSocketNotification("HOME_ASSISTANT_READING", reading);
			}
		}
	},

	stop() {
		this.connection?.stop();
	}
});
