/*
 * HomeKit pairing helpers for shelly-homekit devices.
 *
 * Mirrors the firmware web UI: derive a stable setup code from the device id
 * plus its WiFi settings (so it is reproducible but not guessable from the id
 * alone), hand it to the device's HAP.Setup RPC, and let the device return the
 * canonical formatted code and the X-HM:// URL used for the QR / Apple Home.
 */
import {sha256} from "js-sha256";
import {MosRpcClient} from "./MosRpc";

export interface HapSetup {
  code: string; // "123-45-678"
  url: string;  // "X-HM://..."
}

const B36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Deterministic 8-digit code + 4-char setup id from device id and WiFi, byte
// for byte the same derivation the web UI uses.
function deriveCodeAndId(info: any): {code: string; id: string} {
  const raw =
      (info.device_id ?? "") + (info.wifi_ssid ?? "") + (info.wifi_pass_h ?? "");
  const seed = sha256(raw.replace(/[^a-z0-9]/gi, "")).toLowerCase();
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += seed.charCodeAt(i) % 10;
    if (i === 2 || i === 4) code += "-";
  }
  let id = "";
  for (let i = 0; i < 4; i++) {
    id += B36.charAt((seed.charCodeAt(10 + i) + seed.charCodeAt(20 + i)) % 36);
  }
  return {code, id};
}

// Configure HAP on the device and return the code + QR URL.
export async function setupHomeKit(
    client: MosRpcClient, info: any): Promise<HapSetup> {
  const {code, id} = deriveCodeAndId(info);
  const res = await client.call("HAP.Setup", {code, id});
  if (!res?.code || !res?.url) {
    throw new Error("Device did not return a HomeKit setup code.");
  }
  return {code: res.code, url: res.url};
}
