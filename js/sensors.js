const FTMS_SERVICE = 0x1826;
const INDOOR_BIKE_DATA = 0x2ad2;
const CYCLING_POWER_SERVICE = 0x1818;
const CYCLING_POWER_MEASUREMENT = 0x2a63;
const HEART_RATE_SERVICE = 0x180d;
const HEART_RATE_MEASUREMENT = 0x2a37;
const RECONNECT_DELAY = 2000;
const HEART_RATE_TIMEOUT = 5000;  // a strap sends about once a second
const CRANK_TIMEOUT = 3000;  // without a new pedal stroke for this long, the rider has stopped

// Decode cadence and power from an FTMS Indoor Bike Data packet.
// Each flag bit says whether a field is present; unused fields still have to be skipped.
function parseIndoorBikeData(view) {
  const flags = view.getUint16(0, true);
  let offset = 2;
  const values = {};
  if (!(flags & 0x01)) offset += 2;  // speed, the ride simulates its own (inverted bit: 0 means present)
  if (flags & 0x02) offset += 2;  // average speed
  if (flags & 0x04) { values.cadence = view.getUint16(offset, true) / 2; offset += 2; }
  if (flags & 0x08) offset += 2;  // average cadence
  if (flags & 0x10) offset += 3;  // total distance, the ride computes its own
  if (flags & 0x20) offset += 2;  // resistance level
  if (flags & 0x40) values.power = view.getInt16(offset, true);
  return values;
}

// Decode power and cadence from Cycling Power Measurement packets, for trainers without FTMS and
// for power meters. The power always comes right after the flags. The cadence isn't sent: when the
// crank data is there, it gives the number of pedal strokes so far and the time of the last one, in
// 1/1024 s, and both wrap around at 65536. The cadence comes from how they moved since the previous
// stroke. Between two strokes, packets repeat the same time and the cadence holds.
function cyclingPowerParser() {
  let last = null;  // the latest stroke: count, time, and when its packet arrived
  let cadence = 0;
  return (view) => {
    const now = Date.now();
    const flags = view.getUint16(0, true);
    const values = { power: view.getInt16(2, true) };
    if (!(flags & 0x20)) return values;  // no crank data: the ride falls back on power
    let offset = 4;
    if (flags & 0x01) offset += 1;  // pedal power balance
    if (flags & 0x04) offset += 2;  // accumulated torque
    if (flags & 0x10) offset += 6;  // wheel revolutions and time
    const count = view.getUint16(offset, true);
    const time = view.getUint16(offset + 2, true);
    if (time !== last?.time) {
      // After a stop the gap may exceed the 64 s the time can count, so the first stroke only
      // starts counting again. The same goes for the first packet after connecting.
      const recent = last && now - last.at <= CRANK_TIMEOUT;
      cadence = recent ? ((count - last.count) & 0xffff) * 60 * 1024 / ((time - last.time) & 0xffff) : 0;
      last = { count, time, at: now };
    } else if (now - last.at > CRANK_TIMEOUT) {
      cadence = 0;
    }
    values.cadence = cadence;
    return values;
  };
}

// Decode the beats per minute from a Heart Rate Measurement packet: the first flag bit says
// whether they take one byte or two. A strap taken off can keep sending packets, and the next two
// bits then say it detects skin contact but has none.
function parseHeartRate(view) {
  const flags = view.getUint8(0);
  if ((flags & 0x06) === 0x04) return { heartRate: null };
  return { heartRate: flags & 0x01 ? view.getUint16(1, true) : view.getUint8(1) };
}

// A Bluetooth device sending its readings on one characteristic. `protocols` lists the services it
// may offer, each with its characteristic and parser, the preferred one first. If the connection
// drops, it keeps trying to reconnect until disconnect() is called.
class Sensor {
  active = false;

  constructor(protocols, onData, onConnectionChange) {
    Object.assign(this, { protocols, onData, onConnectionChange });
  }

  get name() {
    return this.device.name;
  }

  async connect() {
    const services = this.protocols.map(({ service }) => service);
    this.device = await navigator.bluetooth.requestDevice({
      filters: services.map((service) => ({ services: [service] })),
      optionalServices: services,  // a device listed for one service may still be read through another
    });
    await this.#subscribe();
    this.active = true;
    this.device.addEventListener("gattserverdisconnected", () => this.#reconnect());
  }

  disconnect() {
    this.active = false;
    if (this.device.gatt.connected) this.device.gatt.disconnect();
  }

  async #subscribe() {
    const server = await this.device.gatt.connect();
    const [protocol, service] = await this.#findService(server);
    this.parse = protocol.parse;
    const characteristic = await service.getCharacteristic(protocol.characteristic);
    // Bluefy on iPhone and iPad ignores the oncharacteristicvaluechanged property, only listeners get the values
    characteristic.addEventListener("characteristicvaluechanged", this.#onValue);
    await characteristic.startNotifications();
  }

  // The first protocol of the list that the device offers, with its service. A missing service
  // throws a NotFoundError, which moves on to the next protocol, or goes up after the last one.
  async #findService(server) {
    for (const protocol of this.protocols) {
      try {
        return [protocol, await server.getPrimaryService(protocol.service)];
      } catch (error) {
        if (error.name !== "NotFoundError" || protocol === this.protocols.at(-1)) throw error;
      }
    }
  }

  // One shared function, so subscribing again after a reconnection doesn't add a second listener.
  // Once the ride is over, a packet still passed on by the browser counts for nothing.
  #onValue = (event) => {
    if (this.active) this.onData(this.parse(event.target.value));
  };

  async #reconnect() {
    if (!this.active) return;
    this.onConnectionChange(false);
    while (this.active) {
      try {
        await this.#subscribe();
        if (this.active) this.onConnectionChange(true);
        else this.device.gatt.disconnect();  // the ride was ended while this attempt was running
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY));
      }
    }
  }
}

// A smart trainer, through the Fitness Machine Service. Older trainers without it, and power meters,
// go through the Cycling Power Service. A trainer offering both is read through FTMS.
export class Trainer extends Sensor {
  constructor(onData, onConnectionChange) {
    super([
      { service: FTMS_SERVICE, characteristic: INDOOR_BIKE_DATA, parse: parseIndoorBikeData },
      { service: CYCLING_POWER_SERVICE, characteristic: CYCLING_POWER_MEASUREMENT, parse: cyclingPowerParser() },
    ], onData, onConnectionChange);
  }
}

// A heart rate strap, through the standard Heart Rate Service. Some straps taken off stay connected
// for a minute or two but stop sending, so the heart rate is lost after a few seconds of silence.
export class HeartRateMonitor extends Sensor {
  #silence;

  constructor(onData, onConnectionChange) {
    super([{ service: HEART_RATE_SERVICE, characteristic: HEART_RATE_MEASUREMENT, parse: parseHeartRate }], (values) => {
      clearTimeout(this.#silence);
      this.#silence = setTimeout(() => onData({ heartRate: null }), HEART_RATE_TIMEOUT);
      onData(values);
    }, onConnectionChange);
  }

  disconnect() {
    clearTimeout(this.#silence);
    super.disconnect();
  }
}
