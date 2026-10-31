/* MagicMirror² - MMM-HomeAssistantDataProvider
 *
 * Publishes Home Assistant entity states as notifications for display
 * modules. Has no display of its own.
 *
 * The browser side holds no state: it forwards what the node_helper sends
 * and asks the node_helper for the current state. It sends the node_helper
 * a reading name at most, never a config: the node_helper takes nothing
 * else from the browser.
 *
 * No top-level declarations: MagicMirror² loads every module's file into
 * the same global scope.
 *
 * MIT Licensed.
 */

Module.register("MMM-HomeAssistantDataProvider", {
	// No display: without this override, a module given a position shows
	// its name.
	getDom() {
		return document.createElement("div");
	},

	notificationReceived(notification, payload) {
		switch (notification) {
			case "ALL_MODULES_STARTED":
				// Notifications are not retained: displays that started after
				// the node_helper published get everything once more.
				this.sendSocketNotification("HOME_ASSISTANT_READING_REQUEST", {});
				// Between the browser side and the node_helper only; not part
				// of the contract for displays.
				this.sendSocketNotification("HOME_ASSISTANT_CONNECTION_REQUEST", {});
				break;
			case "HOME_ASSISTANT_READING_REQUEST":
				this.sendSocketNotification("HOME_ASSISTANT_READING_REQUEST", {name: payload?.name});
				break;
			default:
				break;
		}
	},

	socketNotificationReceived(notification, payload) {
		if (notification === "HOME_ASSISTANT_READING" || notification === "HOME_ASSISTANT_CONNECTION") {
			this.sendNotification(notification, payload);
		}
	}
});
