/*
 * Stock Shelly -> shelly-homekit conversion over the local network (HTTP).
 *
 * This is the automated form of the manual flow: a stock Gen2/Gen3 device that
 * is already on WiFi is stepped up to the latest stock firmware (so its
 * partition table matches what the HomeKit image expects - otherwise the OTA
 * aborts with "PT update is req'd"), then pointed at the fork's HomeKit build.
 * Everything is plain fetch() against the device's HTTP RPC, so no BLE and no
 * native module is involved.
 */
const FEED_BASE = "https://jp-pino.github.io/shelly-homekit/latest";

export interface StockInfo {
  ip: string;
  gen: number;
  model: string;
  app: string; // e.g. "PlusPlugS"
  version: string;
  isHomekit: boolean;
}

async function fetchJson(url: string, opts: any = {}, timeoutMs = 6000):
    Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {...opts, signal: ctrl.signal});
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function rpc(ip: string, method: string, params?: object, timeoutMs = 8000) {
  return fetchJson(
      `http://${ip}/rpc`,
      {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({id: 1, method, ...(params ? {params} : {})}),
      },
      timeoutMs);
}

// The fork build name for a stock app id (Gen2/Gen3): "Shelly" + app.
export function forkModelFor(info: StockInfo): string {
  return "Shelly" + info.app;
}

// Probe one host. Returns its identity, or null if it is not a Shelly / not
// reachable. A shelly-homekit device answers Shelly.GetInfo; stock answers the
// legacy /shelly endpoint.
export async function probeDevice(ip: string): Promise<StockInfo | null> {
  try {
    const s = await fetchJson(`http://${ip}/shelly`, {}, 2500);
    if (!s || !s.mac) return null;
    let isHomekit = false;
    try {
      const hk = await fetchJson(`http://${ip}/rpc/Shelly.GetInfo`, {}, 2500);
      isHomekit = !!hk && !hk.code; // homekit answers; stock returns 404 body
    } catch {}
    return {
      ip,
      gen: s.gen ?? 1,
      model: s.model ?? "",
      app: s.app ?? "",
      version: s.ver ?? "",
      isHomekit,
    };
  } catch {
    return null;
  }
}

// Scan a /24 subnet for Shelly devices. `baseIp` is any address on the LAN
// (the phone's own IP); we probe x.y.z.1 .. 254 with bounded concurrency.
export async function scanSubnet(
    baseIp: string, onFound: (d: StockInfo) => void,
    onProgress?: (done: number, total: number) => void): Promise<void> {
  const prefix = baseIp.split(".").slice(0, 3).join(".");
  const hosts = Array.from({length: 254}, (_, i) => `${prefix}.${i + 1}`);
  let done = 0;
  const CONCURRENCY = 24;
  let idx = 0;
  async function worker() {
    while (idx < hosts.length) {
      const ip = hosts[idx++];
      const d = await probeDevice(ip);
      done++;
      onProgress?.(done, hosts.length);
      if (d) onFound(d);
    }
  }
  await Promise.all(
      Array.from({length: CONCURRENCY}, () => worker()));
}

export interface ConvertStep {
  msg: string;
  pct?: number;
}

// Step a stock device up to the latest stock, then convert to shelly-homekit.
// Reports progress via onStep; resolves with the HomeKit GetInfo on success.
export async function convertStockToHomeKit(
    info: StockInfo, onStep: (s: ConvertStep) => void): Promise<any> {
  const {ip} = info;

  // 1) Walk stock updates until there is no newer stable (partition table must
  // match the HomeKit image, which only the latest stock guarantees).
  for (let round = 0; round < 6; round++) {
    let upd: any = null;
    try {
      upd = await rpc(ip, "Shelly.CheckForUpdate");
    } catch {}
    const latest = upd?.result?.stable?.version;
    const cur = (await probeDevice(ip))?.version;
    if (!latest || latest === cur) break;
    onStep({msg: `Updating stock firmware ${cur} → ${latest}…`});
    await rpc(ip, "Shelly.Update", {stage: "stable"}).catch(() => {});
    await waitForVersion(ip, latest, onStep);
  }

  // 2) Trigger the HomeKit conversion.
  const zip = `${FEED_BASE}/shelly-homekit-${forkModelFor(info)}.zip`;
  onStep({msg: `Installing shelly-homekit (${forkModelFor(info)})…`});
  await rpc(ip, "Shelly.Update", {url: zip}).catch(() => {});

  // 3) Wait for the HomeKit firmware to answer.
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(4000);
    try {
      const hk = await fetchJson(`http://${ip}/rpc/Shelly.GetInfo`, {}, 3000);
      if (hk && !hk.code && hk.version) {
        onStep({msg: `Converted — now on shelly-homekit ${hk.version}.`, pct: 100});
        return hk;
      }
    } catch {}
    onStep({msg: "Flashing and rebooting…"});
  }
  throw new Error(
      "The device did not come up as shelly-homekit. If it stayed on stock, " +
      "the HomeKit image may need an HTTP (not HTTPS) source, or the stock " +
      "partition layout still differs.");
}

async function waitForVersion(
    ip: string, target: string, onStep: (s: ConvertStep) => void):
    Promise<void> {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const d = await probeDevice(ip);
    if (d?.version === target) return;
    onStep({msg: `Waiting for stock ${target}… (now ${d?.version ?? "rebooting"})`});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
