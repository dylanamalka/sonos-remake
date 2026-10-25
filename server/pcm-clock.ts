import { Readable } from 'node:stream';
/** Bounded wall-clock PCM queue. Silence keeps radio alive when the browser is quiet. */
export class PcmClock extends Readable {
  private chunks: Buffer[] = [];
  private queued = 0;
  private timer?: ReturnType<typeof setInterval>;
  private next = 0;
  private stopped = false;
  private lastPcmAt: number | null = null;
  private lastSignalAt: number | null = null;
  private droppedBytes = 0;
  private partial = Buffer.alloc(0);
  static readonly packetBytes = 960 * 2 * 4; // 20 ms, Float32 48 kHz stereo
  constructor(private synthetic = false) {
    super({ highWaterMark: PcmClock.packetBytes * 3 });
  }
  _read() {}
  accept(data: Buffer) {
    if (this.stopped || !data.length) return;
    data = Buffer.concat([this.partial, data]);
    const complete = data.length - (data.length % 8);
    this.partial = Buffer.from(data.subarray(complete));
    data = data.subarray(0, complete);
    if (!data.length) return;
    this.lastPcmAt = Date.now();
    // stdout chunks need not be sample aligned; only inspect complete floats for the meter.
    for (let i = 0; i + 4 <= data.length; i += 32) {
      const value = data.readFloatLE(i);
      if (Number.isFinite(value) && Math.abs(value) > 0.0005) {
        this.lastSignalAt = Date.now();
        break;
      }
    }
    this.chunks.push(Buffer.from(data));
    this.queued += data.length;
    // At most 500 ms; prefer current audio after scheduling interruptions over accumulating delay.
    while (this.queued > (48000 * 2 * 4) / 2 && this.chunks.length) {
      const old = this.chunks.shift()!;
      this.queued -= old.length;
      this.droppedBytes += old.length;
    }
  }
  start() {
    if (this.timer || this.stopped) return;
    this.next = Date.now();
    let sample = 0;
    this.timer = setInterval(() => {
      const now = Date.now();
      if (now - this.next > 200) {
        this.chunks = [];
        this.queued = 0;
        this.next = now;
      }
      if (now < this.next) return;
      this.next += 20;
      const packet = Buffer.alloc(PcmClock.packetBytes);
      let offset = 0;
      if (this.synthetic) {
        for (let i = 0; i < 960; i++) {
          const v = Math.sin((sample++ * 2 * Math.PI * 440) / 48000) * 0.08;
          packet.writeFloatLE(v, i * 8);
          packet.writeFloatLE(v, i * 8 + 4);
        }
        this.lastPcmAt = now;
        this.lastSignalAt = now;
      } else
        while (offset < packet.length && this.chunks.length) {
          const chunk = this.chunks[0],
            size = Math.min(chunk.length, packet.length - offset);
          chunk.copy(packet, offset, 0, size);
          offset += size;
          this.queued -= size;
          if (size === chunk.length) this.chunks.shift();
          else this.chunks[0] = chunk.subarray(size);
        }
      // If the encoder is backpressured, drop this packet; never buffer unlimited PCM.
      if (this.readableLength < PcmClock.packetBytes * 3) this.push(packet);
      else this.droppedBytes += packet.length;
    }, 5);
    this.timer.unref();
  }
  stats() {
    return {
      queuedBytes: this.queued,
      readableBytes: this.readableLength,
      droppedBytes: this.droppedBytes,
      lastPcmAt: this.lastPcmAt,
      lastSignalAt: this.lastSignalAt,
      silenceKeepAlive: true,
    };
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.chunks = [];
    this.queued = 0;
    this.destroy();
  }
}
