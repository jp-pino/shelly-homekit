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
  private rxSub?: Subscription;
  private discSub?: Subscription;
  private pending = new Map<
      number, {resolve: (v: any) => void; reject: (e: Error) => void}>();
  private queue: Promise<void> = Promise.resolve();
  private receiving = false;
  onDisconnect?: () => void;

  private constructor(device: Device) {
    this.device = device;
  }

  static async connect(raw: Device): Promise<MosRpcClient> {
    const device = await raw.connect({requestMTU: 247});
    await device.discoverAllServicesAndCharacteristics();
    const client = new MosRpcClient(device);
    const mtu = device.mtu ?? 23;
    client.chunkSize = Math.max(20, mtu - 3);
    client.discSub = device.onDisconnected(() => {
      client.failAll(new Error("disconnected"));
      client.onDisconnect?.();
    });
    client.rxSub = device.monitorCharacteristicForService(
        RPC_SVC, RPC_RX_CTL, (err, ch) => {
          if (err || !ch?.value) return;
          const len = Buffer.from(ch.value, "base64").readUInt32BE(0);
          if (len > 0) void client.receiveFrame(len);
        });
    return client;
  }

  get name(): string {
    return this.device.name ?? this.device.id;
  }

  async close(): Promise<void> {
    this.rxSub?.remove();
    this.discSub?.remove();
    this.failAll(new Error("closed"));
    try {
      await this.device.cancelConnection();
    } catch {}
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /*
   * Calls are serialized: the transport has a single half-duplex frame
   * buffer, so only one frame is ever in flight.
   */
  call(method: string, params?: object, timeoutMs = 15000): Promise<any> {
    const id = this.nextId++;
    const result = new Promise<any>((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
    this.queue = this.queue
                     .then(() => this.sendFrame(
                               {id, method, ...(params ? {params} : {})}))
                     .catch((e) => {
                       const p = this.pending.get(id);
                       if (p) {
                         this.pending.delete(id);
                         p.reject(e instanceof Error ? e : new Error(String(e)));
                       }
                     });
    return result;
  }

  private async sendFrame(frame: object): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(frame), "utf8");
    await this.device.writeCharacteristicWithResponseForService(
        RPC_SVC, RPC_TX_CTL, be32(bytes.length).toString("base64"));
    for (let off = 0; off < bytes.length; off += this.chunkSize) {
      await this.device.writeCharacteristicWithResponseForService(
          RPC_SVC, RPC_DATA,
          bytes.subarray(off, off + this.chunkSize).toString("base64"));
    }
  }

  private async receiveFrame(len: number): Promise<void> {
    if (this.receiving) return;
    this.receiving = true;
    try {
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
      this.dispatch(Buffer.concat(parts).toString("utf8"));
    } catch {
      // Read failed - connection is likely gone; onDisconnected handles it.
    } finally {
      this.receiving = false;
    }
  }

  private dispatch(text: string) {
    let frame: any;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    const p = this.pending.get(frame.id);
    if (!p) return;
    this.pending.delete(frame.id);
    if (frame.error) {
      const e = frame.error as MosRpcError;
      p.reject(new Error(`RPC error ${e.code}: ${e.message ?? ""}`));
    } else {
      p.resolve(frame.result);
    }
  }
}
