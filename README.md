# MMM-HomeAssistantDataProvider

A [MagicMirror²](https://magicmirror.builders/) module without a display
of its own. It keeps one connection to Home Assistant and publishes the
states of configured entities as notifications, so that display modules
such as [MMM-RingGauge](https://github.com/raywo/MMM-RingGauge) can show
them without knowing Home Assistant.

## Why a separate module

- **One connection for many displays.** Every gauge fetching its own data
  means one connection per gauge to the same Home Assistant.
- **Displays stay generic.** A display knows readings, not Home Assistant
  or tokens. The same display can later show data from another source.
- **The token stays on the server.** Only the provider's `node_helper`
  sees it.

How it differs from other modules is under
[Other modules](#other-modules).

## How it works

### Data flow

1. The `node_helper` connects to the
   [Home Assistant WebSocket API](https://developers.home-assistant.io/docs/api/websocket/)
   with a long-lived access token and subscribes to the configured
   entities.
2. On every change of a state or its attributes, it sends the reading to
   the browser side of the module.
3. The browser side publishes it to all modules with `sendNotification`.

### Reading names

The config maps neutral names to entity IDs, e.g.
`co2: "sensor.living_room_co2"`. Readings are published under the name.
Displays subscribe to `co2`, so replacing the sensor or the whole source
only changes the provider's config.

## Requirements

- MagicMirror² 2.38 or newer. The module reads its config on the server
  with `getServerModuleConfig()`, which older versions lack.
- Node.js as required by MagicMirror² 2.38 (22.22 or newer). The module
  uses Node's built-in `WebSocket` and has no dependencies.
- A Home Assistant that the MagicMirror² server reaches over the network,
  and a long-lived access token of a Home Assistant user.

## Installation

```sh
cd ~/MagicMirror/modules
git clone https://github.com/raywo/MMM-HomeAssistantDataProvider
```

The module has no dependencies; there is nothing to install.

## Configuration

1. Create the token in Home Assistant: open your profile, tab
   Security, and create a long-lived access token. Home Assistant shows
   it only once.
2. Find the entity IDs in Home Assistant under Settings > Devices &
   services > Entities, or under Developer tools > States.
3. Choose a name for every entity. Displays subscribe to that name,
   e.g. `co2`, not to the entity ID.
4. Add the module to `config/config.js`, with the names from step 3
   under `readings` (see [Options](#options)):

```js
{
  module: "MMM-HomeAssistantDataProvider",
  config: {
    host: "192.168.1.10",
    port: 8123,
    useTLS: false,
    token: "${SECRET_HOMEASSISTANT_TOKEN}",
    readings: {
      co2: "sensor.living_room_co2",
      humidity: "sensor.living_room_humidity"
    }
  }
},
```

5. Put the token from step 1 into `config/config.env`, next to
   `config.js`. MagicMirror² reads this file at start:

   ```sh
   SECRET_HOMEASSISTANT_TOKEN=eyJhbGciOi...
   ```

   A variable set in the environment of the MagicMirror² server, e.g. by
   Docker Compose, works the same way.
6. Restart MagicMirror²: under pm2 with `pm2 restart MagicMirror` (or the
   name `pm2 list` shows), in Docker by restarting the container,
   otherwise by stopping it and starting it again the way you started it.
7. Check the log of the MagicMirror² server (see
   [Troubleshooting](#troubleshooting) for where to find it). This line
   shows that the module is connected:

   ```text
   MMM-HomeAssistantDataProvider: Connected to Home Assistant.
   ```

   If it is missing, the lines before it say what went wrong; see
   [Troubleshooting](#troubleshooting).

### Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `host` | string | required | Host name or IP address of Home Assistant, without scheme and port |
| `port` | number | `8123` | Port of Home Assistant |
| `useTLS` | boolean | `false` | `true` connects with `wss://`, `false` with `ws://` |
| `token` | string | required | Long-lived access token of Home Assistant |
| `readings` | object | required | Reading names mapped to entity IDs, at least one |

If `host`, `token` or `readings` is missing or empty, a reading has no
entity ID, or the variable of the token is not set, the module logs which
option is wrong and does not connect; MagicMirror² keeps running. It does
the same on a MagicMirror² older than 2.38. The log never contains the
token.

- `host` must be reachable from the MagicMirror² server; in Docker,
  `homeassistant.local` does not resolve, use an IP address or DNS name.
- `useTLS` must be `true` if Home Assistant is reached with `https://`,
  e.g. behind a reverse proxy; then `port` is usually `443`.
- `token` should be a `SECRET_*` variable: MagicMirror² then hands it to
  the `node_helper` only.
- `readings` may map several names to the same entity ID; each name gets
  its own notifications.
- MagicMirror² replaces `${VAR}` in `config.js` textually. Write a
  variable for `useTLS` or `port` without quotes (`port: ${HA_PORT}`): in
  quotes it becomes a string, and the module does not convert strings:
  only the boolean `true` connects with `wss://`, `"true"` connects with
  `ws://`.
- The module needs no `position`.
- Configure one instance per mirror; it serves all displays.

### Security

The `node_helper` reads the connection and the readings from the
server-side config only (`getServerModuleConfig()`). The browser can at
most ask for the current state of a configured reading. Taking the host
from the browser would be a leak: MagicMirror² restores `SECRET_*`
placeholders in every socket message, so anyone who can open the mirror
could have the token sent to their own server.

## Update

```sh
cd ~/MagicMirror/modules/MMM-HomeAssistantDataProvider
git pull
```

Restart MagicMirror² afterwards, as in step 6 of
[Configuration](#configuration).

## Troubleshooting

The module writes to the log of the MagicMirror² server, i.e. the
terminal it runs in, `pm2 logs` if it runs under pm2, or
`docker logs <container>` if it runs in Docker. Every line of the module
contains `MMM-HomeAssistantDataProvider`. The browser console shows
nothing of the connection.

### The token is rejected

Log: `Home Assistant rejected the token. The module stays disconnected;
correct the token and restart MagicMirror².`

- Create a new long-lived access token in Home Assistant and put it into
  `config/config.env`. Copy it whole; it is one long line.
- Check that `config.js` refers to the same variable name as
  `config.env`.
- Restart MagicMirror². The module does not retry with a rejected token.

If the log says instead that the option token refers to an environment
variable that is not set, `config/config.env` lacks the variable or sits
in another directory than `config.js`, or the variable is not set in the
environment of the server.

### Home Assistant is not reachable

Log: a line ending in `Reconnecting with backoff of up to 10 s.`, e.g.
`The connection to Home Assistant failed. Reconnecting …` or `Home
Assistant did not complete the authentication within 10 s.
Reconnecting …`. It is written once per outage, not per attempt. The
line `Connecting to Home Assistant at …` before it names the URL the
module uses.

- Check from the MagicMirror² server that Home Assistant answers at this
  address: `curl http://192.168.1.10:8123/api/` (`https://` with
  `useTLS: true`). An answer of `401: Unauthorized` means it is
  reachable.
- In Docker, `homeassistant.local` and other mDNS names do not resolve;
  use an IP address or a DNS name.
- Check `port` and `useTLS`: Home Assistant behind a reverse proxy with
  HTTPS needs `useTLS: true` and the port of the proxy.
- The module keeps retrying on its own and connects as soon as Home
  Assistant is reachable; there is no need to restart MagicMirror².

### MagicMirror² is older than 2.38

Log: `MMM-HomeAssistantDataProvider requires MagicMirror² 2.38 or newer,
which provides getServerModuleConfig(). The module stays idle.`

Update MagicMirror². The module does not fall back to the config from
the browser: that would let anyone who can open the mirror have the token
sent elsewhere.

### A reading stays unavailable

A display shows no value, and the reading has `available: false`.

- Log: `Home Assistant does not know the entity of the reading co2; it is
  published as unavailable.` The entity ID under `readings` is wrong, or
  the entity was removed or renamed in Home Assistant. Compare it with
  Developer tools > States.
- No such line: Home Assistant itself reports the entity as
  `unavailable` or `unknown`, e.g. when the device is offline. Check the
  state in Developer tools > States.
- Every reading is unavailable: the connection has been lost for more
  than 30 s; see the sections above.

A reading with `available: true` and `value: null` has a state that is
not a number, such as `on` or `off`; the module publishes numbers only.

A value that does not change for hours is not an error: Home Assistant
reports changes only, and a reading stays valid until the next one.

### Nothing happens at all

Look for `The config cannot work. The module stays idle.` in the log. The
lines before it name each wrong option.

## For display authors

### Contract

The provider owns this contract. Any change to a notification name or a
field is a breaking change for displays.

MagicMirror² notifications are broadcast to every module; there is no
addressing. Displays react to the names below and ignore the rest.

| Notification | Sent by | Payload |
| --- | --- | --- |
| `HOME_ASSISTANT_READING` | provider | one reading |
| `HOME_ASSISTANT_READING_REQUEST` | display | `{ name }` or nothing |
| `HOME_ASSISTANT_CONNECTION` | provider | connection state |

#### `HOME_ASSISTANT_READING`

One notification per reading. A reading holds facts about the
measurement only:

| Field | Type | Source in Home Assistant |
| --- | --- | --- |
| `name` | string | the configured reading name |
| `label` | string \| null | `attributes.friendly_name` |
| `value` | number \| null | `state` as a number; `null` if not available or not numeric |
| `unit` | string \| null | `attributes.unit_of_measurement` |
| `quantity` | string \| null | `attributes.device_class` as is |
| `stateClass` | string \| null | `attributes.state_class` |
| `changedAt` | number \| null | `last_changed` as epoch ms |
| `available` | boolean | false for `unavailable`, `unknown` and a lost connection |

- `quantity` is the physical quantity a sensor measures, as Home
  Assistant names it, e.g. `temperature`, `humidity`, `carbon_dioxide`,
  `pm25`, `pressure`, `illuminance`, `power`, `energy`, `battery`. It is
  `null` for a sensor without a device class, e.g. a template sensor.
- `stateClass` tells a momentary value (`measurement`) from a counter
  (`total`, `total_increasing`).
- A reading stays valid until the next one arrives, however long the
  value stays the same. Whether it is valid at all, `available` tells.
- `changedAt` is the time of the last change of the value.
- Non-numeric states (`on`/`off`, text) are not published as values: such
  a reading has `value: null` and `available: true`.
- An unavailable reading is sent explicitly, with `value: null`, so that
  a display shows "no value" instead of keeping the old one.
- When the connection is lost, an unavailable reading keeps `label`,
  `unit`, `quantity`, `stateClass` and `changedAt` of the last known
  reading, so that a display can still show what it is.
- A configured entity that Home Assistant does not know, or that is
  removed while the provider runs, is sent as unavailable with every
  field except `name` and `available` set to `null`.
- No level or assessment: thresholds belong to the display, otherwise the
  provider couples to it.
- No entity ID: displays know readings by name only.

#### `HOME_ASSISTANT_READING_REQUEST`

Notifications are not retained: a display that needs a reading after it
was sent sees nothing until the next report. Such a display sends
`HOME_ASSISTANT_READING_REQUEST`; the provider answers with one
`HOME_ASSISTANT_READING` per configured reading it holds, or only for
`name` if given. A name the config does not list gets no answer.

The provider holds a reading once Home Assistant has sent the initial
states of the subscription, or once the 30 s grace period has passed without connection. A
reading not held yet gets no answer, neither on request nor in the
publish after `ALL_MODULES_STARTED`; it arrives on its own as soon as
the provider holds it. The provider never sends a reading as unavailable
only because it has not arrived yet.

Displays need the request only for readings they need later, e.g. when
another module shows them again. At start the provider publishes every
reading it holds once after `ALL_MODULES_STARTED` on its own.

#### `HOME_ASSISTANT_CONNECTION`

| Field | Type | Meaning |
| --- | --- | --- |
| `connected` | boolean | whether the provider holds an authenticated connection |
| `since` | number | epoch ms of the last change of `connected`, or of the start of the provider if it never connected |

Sent on every change of the connection state, and at start after
`ALL_MODULES_STARTED`.

The state is sent without delay, also for a short drop while Home
Assistant restarts. A display does not need it: after 30 s without
connection, every reading arrives with `available: false`. A display
that reacts to `connected: false` itself should wait for its own grace
period, or it flickers on every short drop.

### Example display

A minimal display that shows one reading as text:

```js
Module.register("MMM-ReadingText", {
  defaults: {
    reading: "co2"
  },

  start() {
    this.reading = null;
  },

  notificationReceived(notification, payload) {
    if (notification === "HOME_ASSISTANT_READING" && payload.name === this.config.reading) {
      this.reading = payload;
      this.updateDom();
    }
  },

  getDom() {
    const element = document.createElement("div");
    const reading = this.reading;
    if (reading === null || reading.value === null) {
      element.textContent = "–";
    } else {
      element.textContent = `${reading.label ?? reading.name}: ${reading.value} ${reading.unit ?? ""}`;
    }
    return element;
  }
});
```

It needs no request: the provider publishes every reading as soon as it
holds it, again after `ALL_MODULES_STARTED`, and on every change. A display that needs the
current value again later, e.g. after it was hidden, sends:

```js
this.sendNotification("HOME_ASSISTANT_READING_REQUEST", { name: "co2" });
```

### Connection

- The `node_helper` connects in `start()`, from the server-side config,
  without waiting for the browser. MagicMirror² awaits `start()` before it
  reports the modules as started, so `start()` does not wait for the
  connection. A reloaded browser sends nothing the connection depends
  on; it only asks for the current readings.
- The subscription is `subscribe_entities` with `entity_ids`. It sends
  the initial states, then a compressed diff on every change of a state
  or its attributes, never a report of an unchanged value. In the
  compressed format, timestamps are seconds since the epoch; `lu` is
  missing when it equals `lc`.
- After a lost connection, the provider reconnects with exponential
  backoff (cap about 10 s), resubscribes and publishes the current
  states.
- When the connection stays lost for 30 s, the provider publishes every
  reading with `available: false` and `value: null`, so that no display
  keeps an old value as if it were current. The delay avoids flicker
  while Home Assistant restarts. All other fields keep their last known
  values. The same holds when Home Assistant is unreachable from the
  start; a reading never received then has every field except `name` and
  `available` set to `null`.
- The provider pings Home Assistant every 30 s and reconnects when a ping
  gets no answer before the next one, so that a connection that dies
  without being closed, e.g. on a network failure, is noticed too.
- A connection that Home Assistant has not authenticated within 10 s
  counts as failed and is retried with the same backoff, so that a
  connection that stalls before authentication, e.g. at a proxy without
  a backend, is not kept for good.
- A configured entity missing from the initial states, or removed while
  the provider runs, is published as unavailable, and the provider logs
  a warning naming the reading.
- A rejected token is logged once, without the token. The provider then
  stays disconnected (`connected: false`) and does not retry until
  MagicMirror² restarts: a corrected token only takes effect after a
  restart anyway.

## Other modules

No module in the MagicMirror² module list covers this:

- `Snille/MMM-homeassistant-sensors` sends notifications, but only fixed
  values when a condition matches (e.g. "home"), not readings, and polls
  every 5 minutes by default.
- `aserramonner/MMM-HASS` sends the formatted value as text while
  rendering its own display, without a report time; unmaintained since
  2018.
- `Tom-Hirschberger/MMM-MQTTbridge` turns MQTT messages into
  notifications, but needs an MQTT broker and Home Assistant's
  `mqtt_statestream`.
- `wonderslug/MMM-HomeAssistantDisplay` renders Home Assistant templates
  into its own display and publishes nothing.

## Development

The module has no build step and no dependencies. Run the checks the
workflow runs on every pull request:

```sh
git ls-files '*.js' | xargs -n1 node --check
pnpm dlx @biomejs/biome@2.6.3 ci .
node --test "tests/**/*.test.js"
```

To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Support

If the module brings your Home Assistant to your mirror, you can
[buy me a coffee](https://www.buymeacoffee.com/raywo).

## License

MIT
