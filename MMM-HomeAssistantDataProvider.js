/* MagicMirror² - MMM-HomeAssistantDataProvider
 *
 * Publishes Home Assistant entity states as notifications for display
 * modules. Has no display of its own.
 *
 * MIT Licensed.
 */

Module.register("MMM-HomeAssistantDataProvider", {
	// No display: MagicMirror² still calls getDom() for every module.
	getDom() {
		return document.createElement("div");
	}
});
