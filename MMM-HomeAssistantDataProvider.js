/* MagicMirror² - MMM-HomeAssistantDataProvider
 *
 * Publishes Home Assistant entity states as notifications for display
 * modules. Has no display of its own.
 *
 * MIT Licensed.
 */

Module.register("MMM-HomeAssistantDataProvider", {
	// No display: without this override, a module given a position shows
	// its name.
	getDom() {
		return document.createElement("div");
	}
});
