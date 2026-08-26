/*
 * Shelly HomeKit Setup - companion app.
 *
 * Discovers shelly-homekit devices over BLE and configures their WiFi via
 * RPC-over-GATT (see src/MosRpc.ts). Once a device is on the network, all
 * further management happens in its self-hosted web UI.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import {StatusBar} from "expo-status-bar";
import {BleManager, Device} from "react-native-ble-plx";
import {MosRpcClient, RPC_SVC} from "./src/MosRpc";
import {setupHomeKit, HapSetup} from "./src/HomeKit";
import {QrCode} from "./src/QrCode";

// The phone's current WiFi SSID, so the setup form can pre-fill it. iOS only
// reveals the SSID with the Access WiFi Information entitlement AND granted
// Location permission; everything is lazy-required and guarded so a missing
// native module or denied permission simply leaves the field manual.
async function currentWifiSsid(): Promise<string | null> {
  try {
    const Location = require("expo-location");
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return null;
    const NetInfo = require("@react-native-community/netinfo").default;
    const state = await NetInfo.fetch("wifi");
    const ssid = (state.details as any)?.ssid;
    return typeof ssid === "string" && ssid && ssid !== "<unknown ssid>" ?
        ssid :
        null;
  } catch {
    return null;
  }
}

const ACCENT = "#0071e3";

type Screen = {kind: "scan"} | {kind: "device"; device: Device};

async function ensurePermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const wanted = [
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ].filter(Boolean);
  const res = await PermissionsAndroid.requestMultiple(wanted);
  return Object.values(res).every((v) => v === "granted");
}

export default function App() {
  const dark = useColorScheme() === "dark";
  const manager = useMemo(() => new BleManager(), []);
  const [screen, setScreen] = useState<Screen>({kind: "scan"});
  const t = dark ? darkTheme : lightTheme;

  useEffect(() => () => {
    void manager.destroy();
  }, [manager]);

  return (
    <View style={[styles.root, {backgroundColor: t.page}]}>
      <StatusBar style={dark ? "light" : "dark"} />
      <Text style={[styles.wordmark, {color: t.ink}]}>
        Shelly-<Text style={styles.wordmarkBold}>HomeKit</Text>
      </Text>
      {screen.kind === "scan" ? (
        <ScanScreen
          manager={manager}
          theme={t}
          onPick={(device) => setScreen({kind: "device", device})}
        />
      ) : (
        <DeviceScreen
          device={screen.device}
          theme={t}
          onBack={() => setScreen({kind: "scan"})}
        />
      )}
    </View>
  );
}

function ScanScreen({manager, theme: t, onPick}: {
  manager: BleManager;
  theme: Theme;
  onPick: (d: Device) => void;
}) {
  const [devices, setDevices] = useState<Map<string, Device>>(new Map());
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startScan = useCallback(async () => {
    setError(null);
    if (!(await ensurePermissions())) {
      setError("Bluetooth permissions are required to scan.");
      return;
    }
    // A JS reload leaves the native manager mid-flight; make sure any prior
    // scan is stopped and Bluetooth is actually powered on before scanning,
    // otherwise startDeviceScan silently finds nothing.
    manager.stopDeviceScan();
    const state = await manager.state();
    if (state !== "PoweredOn") {
      setError(
          state === "PoweredOff" ?
              "Bluetooth is off — turn it on in Settings." :
              "Waiting for Bluetooth…");
      await new Promise<void>((resolve) => {
        const sub = manager.onStateChange((s) => {
          if (s === "PoweredOn") {
            sub.remove();
            resolve();
          }
        }, true);
      });
      setError(null);
    }
    setDevices(new Map());
    setScanning(true);
    manager.startDeviceScan(null, {allowDuplicates: false}, (err, device) => {
      if (err) {
        setError(err.message);
        setScanning(false);
        return;
      }
      // Match by name OR by advertised service UUID, so a device whose name
      // is missing in the advert (common) still shows if it exposes the RPC
      // service.
      const named = device?.name && /^shelly/i.test(device.name);
      const svc = device?.serviceUUIDs?.some(
          (u) => u.toLowerCase() === RPC_SVC);
      if (device && (named || svc)) {
        setDevices((prev) => new Map(prev).set(device.id, device));
      }
    });
    setTimeout(() => {
      manager.stopDeviceScan();
      setScanning(false);
    }, 15000);
  }, [manager]);

  useEffect(() => {
    void startScan();
    return () => {
      void manager.stopDeviceScan();
    };
  }, [manager, startScan]);

  const list = [...devices.values()];
  return (
    <View style={styles.fill}>
      <View style={[styles.card, {backgroundColor: t.card, borderColor: t.border}]}>
        <Text style={[styles.h1, {color: t.ink}]}>Nearby devices</Text>
        <Text style={[styles.hint, {color: t.muted}]}>
          Devices advertise over Bluetooth while they have no WiFi configured.
          Already-configured devices are managed from their web interface.
        </Text>
        {error && <Text style={[styles.error]}>{error}</Text>}
      </View>
      <FlatList
        data={list}
        keyExtractor={(d) => d.id}
        renderItem={({item}) => (
          <Pressable
            onPress={() => {
              manager.stopDeviceScan();
              onPick(item);
            }}
            style={({pressed}) => [
              styles.card,
              styles.row,
              {backgroundColor: t.card, borderColor: t.border, opacity: pressed ? 0.7 : 1},
            ]}>
            <View style={styles.fill}>
              <Text style={[styles.deviceName, {color: t.ink}]}>{item.name}</Text>
              <Text style={[styles.hint, {color: t.muted}]}>
                RSSI {item.rssi ?? "?"} dBm
              </Text>
            </View>
            <Text style={{color: ACCENT, fontWeight: "600"}}>Set up</Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={[styles.hint, styles.center, {color: t.muted}]}>
            {scanning ? "Scanning…" : "No devices found."}
          </Text>
        }
      />
      <Button
        title={scanning ? "Scanning…" : "Scan again"}
        disabled={scanning}
        onPress={startScan}
      />
    </View>
  );
}

function DeviceScreen({device, theme: t, onBack}: {
  device: Device;
  theme: Theme;
  onBack: () => void;
}) {
  const [client, setClient] = useState<MosRpcClient | null>(null);
  const [info, setInfo] = useState<any>(null);
  const [phase, setPhase] =
      useState<"connecting" | "form" | "saving" | "joined" | "handoff">(
          "connecting");
  const [ssid, setSsid] = useState("");
  const [pass, setPass] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [hap, setHap] = useState<HapSetup | null>(null);
  const [hapBusy, setHapBusy] = useState(false);
  const clientRef = useRef<MosRpcClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await MosRpcClient.connect(device);
        if (cancelled) {
          void c.close();
          return;
        }
        c.onDisconnect = () => {
          // Expected once WiFi comes up: BLE is a setup-only channel.
          setPhase((p) => (p === "saving" || p === "joined" ? "handoff" : p));
        };
        clientRef.current = c;
        setClient(c);
        const i = await c.call("Shelly.GetInfo");
        if (!cancelled) {
          setInfo(i);
          setPhase("form");
          // Pre-fill: prefer the network the device already knows, otherwise
          // offer the phone's current WiFi (if iOS will surface it).
          let s = i?.wifi_ssid ?? "";
          if (!s) {
            const phoneSsid = await currentWifiSsid();
            if (phoneSsid && !cancelled) s = phoneSsid;
          }
          if (!cancelled) setSsid(s);
        }
      } catch (e: any) {
        if (!cancelled) setStatus(`Connection failed: ${e.message}`);
      }
    })();
    return () => {
      cancelled = true;
      void clientRef.current?.close();
    };
  }, [device]);

  const save = useCallback(async () => {
    const c = clientRef.current;
    if (!c || !ssid) return;
    setPhase("saving");
    setStatus("Sending WiFi configuration…");
    try {
      await c.call(
          "Shelly.SetWifiConfig", {sta: {enable: true, ssid, pass}});
      setStatus("Waiting for the device to join the network…");
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const inf = await c.call("Shelly.GetInfo", undefined, 5000);
        if (inf?.wifi_conn_ip) {
          setInfo(inf);
          setPhase("joined");
          setStatus(null);
          return;
        }
      }
      setStatus("The device did not report an IP yet - check your WiFi password.");
      setPhase("form");
    } catch (e: any) {
      // A dropped BLE link right after saving usually means WiFi came up
      // and BLE shut down (bt.keep_enabled=false); onDisconnect switches
      // the phase to "handoff" in that case.
      if (clientRef.current) setStatus(e.message);
    }
  }, [ssid, pass]);

  const startHomeKit = useCallback(async () => {
    const c = clientRef.current;
    if (!c || !info) return;
    setHapBusy(true);
    setStatus(null);
    try {
      const s = await setupHomeKit(c, info);
      setHap(s);
    } catch (e: any) {
      setStatus(`HomeKit setup failed: ${e.message}`);
    } finally {
      setHapBusy(false);
    }
  }, [info]);

  const webUrl = info?.wifi_conn_ip ?
      `http://${info.wifi_conn_ip}/` :
      `http://${(info?.device_id ?? device.name ?? "").toLowerCase()}.local/`;

  return (
    <ScrollView style={styles.fill} contentContainerStyle={{paddingBottom: 24}}
                keyboardShouldPersistTaps="handled">
      <View style={[styles.card, {backgroundColor: t.card, borderColor: t.border}]}>
        <Text style={[styles.h1, {color: t.ink}]}>
          {info?.name || device.name}
        </Text>
        {info && (
          <Text style={[styles.hint, {color: t.muted}]}>
            {info.model} · {info.version} · {info.device_id}
          </Text>
        )}
        {phase === "connecting" && !status && (
          <View style={styles.row}>
            <ActivityIndicator color={ACCENT} />
            <Text style={[styles.hint, {color: t.muted}]}> Connecting…</Text>
          </View>
        )}
        {status && <Text style={[styles.hint, {color: t.muted}]}>{status}</Text>}
      </View>

      {(phase === "form" || phase === "saving") && (
        <View style={[styles.card, {backgroundColor: t.card, borderColor: t.border}]}>
          <Text style={[styles.h1, {color: t.ink}]}>WiFi Setup</Text>
          <TextInput
            style={[styles.input, {color: t.ink, borderColor: t.border, backgroundColor: t.inputBg}]}
            placeholder="Network name (SSID)"
            placeholderTextColor={t.muted}
            autoCapitalize="none"
            value={ssid}
            onChangeText={setSsid}
          />
          <TextInput
            style={[styles.input, {color: t.ink, borderColor: t.border, backgroundColor: t.inputBg}]}
            placeholder="Password"
            placeholderTextColor={t.muted}
            secureTextEntry
            value={pass}
            onChangeText={setPass}
          />
          <Button
            title={phase === "saving" ? "Saving…" : "Join WiFi"}
            disabled={phase === "saving" || !ssid}
            onPress={save}
          />
        </View>
      )}

      {(phase === "joined" || phase === "handoff") && (
        <View style={[styles.card, {backgroundColor: t.card, borderColor: t.border}]}>
          <Text style={[styles.h1, {color: t.ink}]}>
            {phase === "joined" ? "Connected" : "Setup sent"}
          </Text>
          <Text style={[styles.hint, {color: t.muted}]}>
            {phase === "joined" ?
                `The device is online at ${info?.wifi_conn_ip}.` :
                "Bluetooth disconnected - this usually means the device " +
                    "joined your WiFi and closed its setup channel."}
            {" "}Everything else - HomeKit pairing, settings, live power - is
            in the device's web interface.
          </Text>
          <Button
            title="Open Web Interface"
            onPress={() => Linking.openURL(webUrl).catch(
                () => Alert.alert("Could not open", webUrl))}
          />
        </View>
      )}

      {info && phase !== "connecting" && (
        <View style={[styles.card, {backgroundColor: t.card, borderColor: t.border}]}>
          <Text style={[styles.h1, {color: t.ink}]}>HomeKit</Text>
          {!hap ? (
            <>
              <Text style={[styles.hint, {color: t.muted}]}>
                Generate a pairing code and add this device to Apple Home.
                The device must be on your WiFi to finish pairing.
              </Text>
              <Button
                title={hapBusy ? "Preparing…" : "Set up HomeKit"}
                disabled={hapBusy}
                onPress={startHomeKit}
              />
            </>
          ) : (
            <View style={{alignItems: "center"}}>
              <QrCode value={hap.url} size={220} />
              <Text style={[styles.hapCode, {color: t.ink}]}>{hap.code}</Text>
              <Text style={[styles.hint, styles.center, {color: t.muted}]}>
                Scan in the Home app, or tap below to add it now.
              </Text>
              <View style={{alignSelf: "stretch"}}>
                <Button
                  title="Add to Apple Home"
                  onPress={() => Linking.openURL(hap.url).catch(
                      () => Alert.alert(
                          "Could not open Home",
                          "Enter this code in the Home app: " + hap.code))}
                />
              </View>
            </View>
          )}
        </View>
      )}

      <Button title="Back to scan" secondary onPress={onBack} />
    </ScrollView>
  );
}

function Button({title, onPress, disabled, secondary}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({pressed}) => [
        styles.button,
        secondary && styles.buttonSecondary,
        (disabled || pressed) && {opacity: 0.6},
      ]}>
      <Text style={[styles.buttonText, secondary && {color: ACCENT}]}>
        {title}
      </Text>
    </Pressable>
  );
}

interface Theme {
  page: string;
  card: string;
  border: string;
  ink: string;
  muted: string;
  inputBg: string;
}

const lightTheme: Theme = {
  page: "#eef0f4",
  card: "#ffffff",
  border: "rgba(16,24,38,0.12)",
  ink: "#1a2027",
  muted: "#5f6b78",
  inputBg: "#ffffff",
};

const darkTheme: Theme = {
  page: "#0e1116",
  card: "#171b21",
  border: "rgba(255,255,255,0.1)",
  ink: "#e8ecf1",
  muted: "#98a2ad",
  inputBg: "#21262e",
};

const styles = StyleSheet.create({
  root: {flex: 1, paddingTop: 64, paddingHorizontal: 14},
  fill: {flex: 1},
  wordmark: {fontSize: 26, fontWeight: "300", textAlign: "center", letterSpacing: -0.5, marginBottom: 14},
  wordmarkBold: {fontWeight: "700"},
  card: {borderRadius: 16, borderWidth: 1, padding: 16, marginBottom: 12},
  row: {flexDirection: "row", alignItems: "center"},
  h1: {fontSize: 17, fontWeight: "600", marginBottom: 6},
  hint: {fontSize: 13, lineHeight: 18},
  center: {textAlign: "center", marginTop: 24},
  error: {color: "#d7343f", marginTop: 8},
  deviceName: {fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"]},
  hapCode: {fontSize: 30, fontWeight: "700", letterSpacing: 2, marginVertical: 12, fontVariant: ["tabular-nums"]},
  input: {borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginVertical: 6, fontSize: 15},
  button: {backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 12, alignItems: "center", marginTop: 10, marginBottom: 8},
  buttonSecondary: {backgroundColor: "transparent"},
  buttonText: {color: "#fff", fontWeight: "600", fontSize: 15},
});
