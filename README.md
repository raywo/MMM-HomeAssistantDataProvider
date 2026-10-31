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

### Contract

A reading holds facts about the measurement only:

| Field | Source in Home Assistant |
| --- | --- |
| name | the configured reading name |
| value | `state` as a number; none if `unavailable`, `unknown` or not numeric |
| unit | `attributes.unit_of_measurement` |
| quantity | `attributes.device_class`, e.g. `carbon_dioxide`, `humidity` |
| report time | `last_reported`, falling back to `last_updated` |
| available | false for `unavailable` and `unknown` |

No level or assessment: thresholds belong to the display, otherwise the
provider couples to it.

- **Open:** name of the notification. Proposed: prefixed with the module,
  e.g. `HOME_ASSISTANT_READING`, so that no other module confuses it with
  its own.
- **Open:** exact field names and value types (e.g. report time as epoch
  ms or ISO string).
- **Open:** whether `quantity` uses Home Assistant's `device_class` as is
  or a neutral vocabulary of the contract.
- **Open:** whether non-numeric states (`on`/`off`, text) are published,
  and how.

### Late displays

MagicMirror notifications are not retained: a display that starts after
a reading was sent sees nothing until the next change.

- **Open:** proposed is a request notification, e.g.
  `HOME_ASSISTANT_READING_REQUEST`, answered with the latest reading of
  every (or the named) entity. Alternative: republish all readings when
  `ALL_MODULES_STARTED` or `DOM_OBJECTS_CREATED` arrives.

### Connection

- **Open:** WebSocket client: Node's built-in `WebSocket` (Node 22+)
  without dependencies, or the `homeassistant-ws` package that
  MMM-HomeAssistantDisplay uses.
- **Open:** which subscription delivers reports of unchanged values
  (`last_reported`). `subscribe_entities` with an entity filter is the
  candidate; to be verified. Without it, a steady sensor would turn
  stale in the display.
- Reconnect after a lost connection with exponential backoff (cap about
  10 s) and resubscribe; after reconnecting, publish the current states.
- Publish an unavailable reading when the entity becomes `unavailable`,
  so that a display shows "no value" instead of keeping the old one.
- **Open:** whether a lost connection is published, or displays rely on
  staleness.

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
}
```

- `host` must be reachable from the MagicMirror server; in Docker,
  `homeassistant.local` does not resolve, use an IP address or DNS name.
- `token` should be a `SECRET_*` variable: MagicMirror then hands it to
  the `node_helper` only. Create it in Home Assistant under profile >
  Security.
- Set `useTLS` in `config.js`, not from `.env`: substituted values are
  strings, and `"false"` is truthy.
- The module needs no `position`.

## License

MIT
