/*
 * On-demand firmware update check for a converted shelly-homekit device.
 *
 * The device's web UI only checks the update feed once a day; this does it now.
 * We read the device's IP and version over its BLE RPC, compare against the
 * fork's update.json, and if newer, tell the device to pull the build via its
 * /ota?url= endpoint over the local network (esp32 builds have mbedTLS, so the
 * HTTPS feed URL is fine).
 */
const FEED = "https://jp-pino.github.io/shelly-homekit/update.json";

interface Ver {
  major: number;
  minor: number;
  patch: number;
  variant: string;
  varSeq: number;
}

// major.minor.patch-variantN, matching the firmware's own parser.
function parseVersion(v: string): Ver {
  const m = (v || "").match(/^(\d+)\.(\d+)\.(\d+)-?([a-zA-Z]*)(\d*)$/);
  if (!m) return {major: 0, minor: 0, patch: 0, variant: "", varSeq: 0};
  return {
    major: +m[1],
    minor: +m[2],
    patch: +m[3],
    variant: m[4] || "",
    varSeq: +(m[5] || 0),
  };
}

function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a), y = parseVersion(b);
  if (x.major !== y.major) return x.major > y.major;
  if (x.minor !== y.minor) return x.minor > y.minor;
  if (x.patch !== y.patch) return x.patch > y.patch;
  if (x.variant !== y.variant) return true;
  if (x.varSeq !== y.varSeq) return x.varSeq > y.varSeq;
  return false;
}

export interface UpdateAvail {
  latest: string;
  url: string;
}

// Returns the available newer build for this model, or null if up to date.
export async function checkUpdate(
    model: string, version: string): Promise<UpdateAvail | null> {
  const feed = await fetch(FEED, {cache: "no-store"} as any).then((r) => r.json());
  for (const [reStr, cfg] of feed as [string, any][]) {
    if (new RegExp(reStr).test(version)) {
      const latest = cfg.version;
      const url = cfg.urls?.[model];
      if (latest && url && isNewer(latest, version)) return {latest, url};
      return null; // matched entry but already current / no build for model
    }
  }
  return null;
}

// Tell the device to fetch and install the build. The device reboots on
// success, so the BLE link drops; we then poll its HTTP RPC until the new
// version answers.
export async function installUpdate(
    ip: string, u: UpdateAvail, onTick?: (msg: string) => void):
    Promise<boolean> {
  const r = await fetch(`http://${ip}/ota?url=${encodeURIComponent(u.url)}`);
  if (!r.ok) throw new Error(`OTA request failed (HTTP ${r.status}).`);
  onTick?.("Flashing and rebooting…");
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 4000));
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const info = await fetch(`http://${ip}/rpc/Shelly.GetInfo`,
                               {signal: ctrl.signal} as any)
                       .then((x) => x.json())
                       .finally(() => clearTimeout(t));
      if (info?.version === u.latest) return true;
    } catch {}
  }
  return false;
}
