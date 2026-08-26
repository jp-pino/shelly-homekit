# Shelly HomeKit Setup — companion app

React Native (Expo) app that discovers factory-fresh shelly-homekit devices
over **Bluetooth LE** and configures their WiFi, replacing the
join-the-device's-AP dance. Once a device is online, everything else —
HomeKit pairing, settings, the live power chart — happens in the device's
**web interface**, which this app simply links to.

## How it works

- Firmware `2.16.1-latest8` and newer (ESP32-family devices: Plus/Mini/Gen3)
  advertises the device id (e.g. `shellyplusplug-s-a1b2c3`) over BLE and
  exposes the Mongoose OS [rpc-gatts](https://github.com/mongoose-os-libs/rpc-gatts)
  GATT service.
- The app speaks that protocol (`src/MosRpc.ts`) and calls the same RPCs the
  web UI uses: `Shelly.GetInfo` and `Shelly.SetWifiConfig`.
- By default (`bt.keep_enabled=false`) **BLE is a setup-only channel**: it
  turns off once WiFi is configured, so the unauthenticated GATT surface is
  not exposed permanently. To keep devices BLE-discoverable forever, set
  `bt.keep_enabled=true` via `Config.Set` — with that trade-off in mind.
- Gen1 (ESP8266) devices have no Bluetooth; they keep the classic AP-based
  setup flow.

## Running the app

BLE does not work in simulators — use a physical phone.

```
cd app
npm install
npx expo prebuild
npx expo run:ios --device      # or: npx expo run:android --device
```

Requires Xcode (iOS) or Android Studio (Android). The `react-native-ble-plx`
config plugin injects the Bluetooth permissions declared in `app.json`.

### Signing (iOS)

No Apple Team ID is committed — set your own at build time so this public
repo stays account-neutral. Either open `ios/ShellyHomeKitSetup.xcworkspace`
in Xcode and pick your team under Signing & Capabilities, or pass it to
xcodebuild:

```
xcodebuild -workspace ios/ShellyHomeKitSetup.xcworkspace \
  -scheme ShellyHomeKitSetup -configuration Debug \
  -destination 'id=<your-device-udid>' \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<YOUR_TEAM_ID> build
```

SSID auto-fill needs the **Access WiFi Information** entitlement, which is
only available to a paid team whose account has that capability enabled;
without it the SSID field stays manual (everything else works).

## Flow

1. **Scan** — lists BLE devices whose name starts with `shelly`.
2. **Connect** — reads `Shelly.GetInfo` (model, version, WiFi state).
3. **WiFi setup** — sends `Shelly.SetWifiConfig {sta: {enable, ssid, pass}}`,
   then polls until the device reports an IP. If BLE drops right after
   saving, that is the expected setup-channel shutdown — the app shows the
   device's `.local` address instead.
4. **Open Web Interface** — hands off to `http://<ip>/`.
