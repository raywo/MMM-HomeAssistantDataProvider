# MMM-HomeAssistantDataProvider

A [MagicMirror²](https://magicmirror.builders/) module without a display
of its own. It keeps one connection to Home Assistant and publishes the
states of configured entities as notifications, so that display modules
such as [MMM-RingGauge](https://github.com/raywo/MMM-RingGauge) can show
them without knowing Home Assistant.

> **Open – not implemented.** This repository holds the design so far.

## Why a separate module

- **One connection for many displays.** Every gauge fetching its own data
  means one connection per gauge to the same Home Assistant.
- **Displays stay generic.** A display knows readings, not Home Assistant
  or tokens. The same display can later show data from another source.
- **The token stays on the server.** Only the provider's `node_helper`
  sees it.

No existing module covers this. In the MagicMirror² module list:

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

## Requirements

- MagicMirror² 2.38 or newer. The module reads its config on the server
  with `getServerModuleConfig()`, which older versions lack.
- Node.js as required by MagicMirror² 2.38 (22.22 or newer). The module
  uses Node's built-in `WebSocket` and has no dependencies.
- Home Assistant 2024.3 or newer, for `last_reported`.

## Design

### Data flow

1. The `node_helper` connects to the Home Assistant WebSocket API with a
   long-lived access token and subscribes to the configured entities.
2. On every state change, and on every report of an unchanged value, it
   sends the reading to the browser side of the module.
3. The browser side publishes it to all modules with `sendNotification`.

### Reading names

The config maps neutral names to entity IDs, e.g.
`co2: "sensor.living_room_co2"`. Readings are published under the name.
Displays subscribe to `co2`, so replacing the sensor or the whole source
only changes the provider's config.

## Contract

The provider owns this contract. Any change to a notification name or a
field is a breaking change for displays.

MagicMirror² notifications are broadcast to every module; there is no
addressing. Displays react to the names below and ignore the rest.

| Notification | Sent by | Payload |
| --- | --- | --- |
| `HOME_ASSISTANT_READING` | provider | one reading |
| `HOME_ASSISTANT_READING_REQUEST` | display | `{ name }` or nothing |
| `HOME_ASSISTANT_CONNECTION` | provider | connection state |

### `HOME_ASSISTANT_READING`

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
| `reportedAt` | number \| null | `last_reported`, falling back to `last_updated`, as epoch ms |
| `changedAt` | number \| null | `last_changed` as epoch ms |
| `available` | boolean | false for `unavailable`, `unknown` and a lost connection |

- `quantity` is the physical quantity a sensor measures, as Home
  Assistant names it, e.g. `temperature`, `humidity`, `carbon_dioxide`,
  `pm25`, `pressure`, `illuminance`, `power`, `energy`, `battery`. It is
  `null` for a sensor without a device class, e.g. a template sensor.
- `stateClass` tells a momentary value (`measurement`) from a counter
  (`total`, `total_increasing`).
- `reportedAt` changes on every report, also of an unchanged value. Use
  it to decide whether a reading is stale. `changedAt` changes only when
  the value changes.
- Non-numeric states (`on`/`off`, text) are not published as values: such
  a reading has `value: null` and `available: true`.
- An unavailable reading is sent explicitly, with `value: null`, so that
  a display shows "no value" instead of keeping the old one.
- No level or assessment: thresholds belong to the display, otherwise the
  provider couples to it.
- No entity ID: displays know readings by name only.

### `HOME_ASSISTANT_READING_REQUEST`

Notifications are not retained: a display that needs a reading after it
was sent sees nothing until the next report. Such a display sends
`HOME_ASSISTANT_READING_REQUEST`; the provider answers with one
`HOME_ASSISTANT_READING` per configured reading, or only for `name` if
given. A name the config does not list gets no answer.

Displays need the request only for readings they need later, e.g. when
another module shows them again. At start the provider publishes all
readings once after `ALL_MODULES_STARTED` on its own.

### `HOME_ASSISTANT_CONNECTION`

| Field | Type | Meaning |
| --- | --- | --- |
| `connected` | boolean | whether the provider holds an authenticated connection |
| `since` | number | epoch ms of the last change of `connected` |

Sent on every change of the connection state, and at start after
`ALL_MODULES_STARTED`.

### Connection

- Reconnect after a lost connection with exponential backoff (cap about
  10 s) and resubscribe; after reconnecting, publish the current states.
- When the connection stays lost for 30 s, publish every reading with
  `available: false` and `value: null`, so that a display without its own
  staleness check does not keep an old value. The delay avoids flicker
  while Home Assistant restarts.
- **Open:** which subscription delivers reports of unchanged values
  (`last_reported`). `subscribe_entities` with an entity filter is the
  candidate; to be verified. Without it, a steady sensor would turn
  stale in the display.

## Installation

```sh
cd ~/MagicMirror/modules
git clone https://github.com/raywo/MMM-HomeAssistantDataProvider
```

The module has no dependencies; there is nothing to install.

## Update

```sh
cd ~/MagicMirror/modules/MMM-HomeAssistantDataProvider
git pull
```

## Configuration (draft)

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

- `host` must be reachable from the MagicMirror server; in Docker,
  `homeassistant.local` does not resolve, use an IP address or DNS name.
- `token` should be a `SECRET_*` variable: MagicMirror then hands it to
  the `node_helper` only. Create it in Home Assistant under profile >
  Security.
- Set `useTLS` in `config.js`, not from `.env`: substituted values are
  strings, and `"false"` is truthy.
- The module needs no `position`.
- Configure one instance per mirror; it serves all displays.

### Security

The `node_helper` reads the connection and the readings from the
server-side config only (`getServerModuleConfig()`). The browser can at
most ask for the current state of a configured reading. Taking the host
from the browser would be a leak: MagicMirror restores `SECRET_*`
placeholders in every socket message, so anyone who can open the mirror
could have the token sent to their own server.

## License

MIT
