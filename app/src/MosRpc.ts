/*
 * RPC-over-GATT client for Mongoose OS (rpc-gatts service), as used by
 * shelly-homekit firmware.
 *
 * Protocol (https://github.com/mongoose-os-libs/rpc-gatts):
 *  - Service 5f6d4f53-5f52-5043-5f53-56435f49445f ("_mOS_RPC_SVC_ID_").
 *  - To send a frame: write its total length as a big-endian uint32 to
 *    tx_ctl, then write the frame bytes to the data characteristic in
 *    arbitrary chunks adding up to exactly that length.
 *  - To receive: rx_ctl notifies (or reads as) the pending frame length as
 *    a big-endian uint32; the frame is then consumed by repeatedly reading
 *    the data characteristic (up to MTU bytes per read).
 *  - Frames are Mongoose OS JSON-RPC: {"id":N,"method":"...","params":{...}}
 *    answered by {"id":N,"result":...} or {"id":N,"error":{code,message}}.
 */
import {Device, Subscription} from "react-native-ble-plx";
import {Buffer} from "buffer";

export const RPC_SVC = "5f6d4f53-5f52-5043-5f53-56435f49445f";
export const RPC_DATA = "5f6d4f53-5f52-5043-5f64-6174615f5f5f";
export const RPC_TX_CTL = "5f6d4f53-5f52-5043-5f74-785f63746c5f";
export const RPC_RX_CTL = "5f6d4f53-5f52-5043-5f72-785f63746c5f";

export interface MosRpcError {
  code: number;
  message?: string;
}

function be32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

export class MosRpcClient {
  private device: Device;
  private nextId = Math.floor(Math.random() * 1000) + 1;
  private chunkSize = 20; // ATT default MTU (23) minus 3-byte header.
  private discSub?: Subscription;
  private queue: Promise<any> = Promise.resolve();
  private alive = true;
  onDisconnect?: () => void;

  private constructor(device: Device) {
    this.device = device;
  }

  static async connect(raw: Device): Promise<MosRpcClient> {
    const device = await raw.connect({requestMTU: 247});
    await device.discoverAllServicesAndCharacteristics();
    const services = await device.services();
    if (!services.some((s) => s.uuid.toLowerCase() === RPC_SVC)) {
      await device.cancelConnection().catch(() => {});
      throw new Error(
          "This device does not expose the setup service. It is likely " +
          "running stock Shelly firmware - convert it to shelly-homekit " +
          "first (see the web flashing guide).");
    }
    const client = new MosRpcClient(device);
    const mtu = device.mtu ?? 23;
    client.chunkSize = Math.max(20, mtu - 3);
    client.discSub = device.onDisconnected(() => {
      client.alive = false;
      client.onDisconnect?.();
    });
    return client;
  }

  get name(): string {
    return this.device.name ?? this.device.id;
  }

  async close(): Promise<void> {
    this.alive = false;
    this.discSub?.remove();
    try {
      await this.device.cancelConnection();
    } catch {}
  }

  /*
   * Calls are serialized: the transport has a single half-duplex frame buffer,
   * so only one request/response is ever in flight. Rather than rely on rx_ctl
   * notifications (whose delivery is unreliable through react-native-ble-plx
   * when a characteristic advertises both notify and indicate), we send the
   * request and then poll rx_ctl by reading it until the device reports a
   * response frame - the same scheme as the reference mongoose client.
   */
  call(method: string, params?: object, timeoutMs = 15000): Promise<any> {
    const run = async () => {
      const id = this.nextId++;
      await this.sendFrame({id, method, ...(params ? {params} : {})});
      const frame = await this.receiveResponse(timeoutMs, method);
      if (frame.error) {
        const e = frame.error as MosRpcError;
        throw new Error(`RPC error ${e.code}: ${e.message ?? ""}`);
      }
      return frame.result;
    };
    const result = this.queue.then(run, run);
    // Keep the queue chained but swallow errors so one failure does not wedge
    // every later call.
    this.queue = result.catch(() => {});
    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async sendFrame(frame: object): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(frame), "utf8");
    // 1) Announce the frame length (big-endian u32) on tx_ctl.
    try {
      await this.device.writeCharacteristicWithResponseForService(
          RPC_SVC, RPC_TX_CTL, be32(bytes.length).toString("base64"));
    } catch (e: any) {
      throw new Error(this.describeWriteError(e, "announcing the request"));
    }
    // 2) Stream the frame on the data characteristic. rpc-gatts' data char is
    // Write-with-response; a few peripherals only accept write-without-response
    // over a weak link, so fall back to that before giving up.
    for (let off = 0; off < bytes.length; off += this.chunkSize) {
      // NB: Buffer.subarray() returns a plain Uint8Array under the RN buffer
      // polyfill, whose toString("base64") yields a comma-joined byte list
      // rather than base64. Re-wrap in a real Buffer so the encoding is right.
      const chunk =
          Buffer.from(bytes.subarray(off, off + this.chunkSize)).toString(
              "base64");
      try {
        await this.device.writeCharacteristicWithResponseForService(
            RPC_SVC, RPC_DATA, chunk);
      } catch (e: any) {
        try {
          await this.device.writeCharacteristicWithoutResponseForService(
              RPC_SVC, RPC_DATA, chunk);
        } catch {
          throw new Error(this.describeWriteError(e, "sending the request"));
        }
      }
    }
  }

  // Turn a raw GATT write rejection into something a person can act on. The
  // giveaway for stock Shelly firmware (or any secured GATT) is an
  // authentication/encryption status, since it requires BLE pairing that
  // shelly-homekit's setup channel does not.
  private describeWriteError(e: any, during: string): string {
    const msg = String(e?.reason || e?.message || e || "");
    if (/authenticat|encrypt|insufficient|pair|bond/i.test(msg)) {
      return "This device requires Bluetooth pairing, which usually means " +
          "it is still on stock Shelly firmware. Convert it to shelly-homekit " +
          "first, then set it up here.";
    }
    if (/disconnect|was cancelled|not connected/i.test(msg)) {
      return "Bluetooth disconnected while " + during +
          " — move closer to the device and try again.";
    }
    return `Failed while ${during}: ${msg}`;
  }

  // Poll rx_ctl until the device announces a response frame, then read the
  // data characteristic until the whole frame is collected and parse it.
  // Reading rx_ctl resets the device's send offset, so we read it exactly
  // once per response (to learn the length) and never again mid-frame.
  private async receiveResponse(timeoutMs: number, method: string):
      Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.alive) throw new Error(`${method}: disconnected`);
      const ctl = await this.device.readCharacteristicForService(
          RPC_SVC, RPC_RX_CTL);
      const len =
          ctl.value ? Buffer.from(ctl.value, "base64").readUInt32BE(0) : 0;
      if (len > 0) {
        const parts: Buffer[] = [];
        let got = 0;
        while (got < len) {
          const ch = await this.device.readCharacteristicForService(
              RPC_SVC, RPC_DATA);
          if (!ch.value) break;
          const part = Buffer.from(ch.value, "base64");
          if (part.length === 0) break;
          parts.push(part);
          got += part.length;
        }
        return JSON.parse(Buffer.concat(parts).toString("utf8"));
      }
      await this.sleep(80);
    }
    throw new Error(`${method}: timed out after ${timeoutMs}ms`);
  }
}
