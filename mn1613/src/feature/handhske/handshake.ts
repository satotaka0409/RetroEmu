export const HANDSHAKE_SOF = 0xa5;

export enum BusDirection {
  CpuToPanel = "cpu_to_panel",
  PanelToCpu = "panel_to_cpu",
}

export enum PanelCommand {
  Ping = 0x01,
  ReadStatus = 0x02,
  SetSevenSegment = 0x10,
  SetBulletLed = 0x11,
  Beep = 0x12,
  GetKey = 0x20,
  KeyEvent = 0x30,
  Ack = 0x7e,
  Error = 0x7f,
}

export enum FunctionKey {
  AdrSet = 0x10,
  Run = 0x11,
  Inc = 0x12,
  Dec = 0x13,
  WrtInc = 0x14,
  WrtDec = 0x15,
  Break = 0x16,
  Step = 0x17,
}

export type KeyCode = number;

export type KeyEvent = {
  code: KeyCode;
  pressedAtCycle: number;
};

export type BeepState = {
  active: boolean;
  frequencyHz: number;
  remainingCycles: number;
  volume: number;
};

export type PanelBoardState = {
  sevenSegment: Uint8Array;
  bulletLed16: boolean[];
  keyQueue: KeyEvent[];
  beep: BeepState;
  irqPending: boolean;
};

export type ControlLines = {
  req: boolean;
  ack: boolean;
  irq: boolean;
  reset: boolean;
  direction: BusDirection;
};

export type HandshakePacket = {
  seq: number;
  command: number;
  payload: number[];
  checksum: number;
};

export type HandshakeTraceEvent =
  | { type: "byte_tx"; direction: BusDirection; value: number; cycle: number }
  | {
      type: "packet_rx";
      endpoint: "cpu" | "panel";
      packet: HandshakePacket;
      cycle: number;
    }
  | {
      type: "packet_tx";
      endpoint: "cpu" | "panel";
      packet: HandshakePacket;
      cycle: number;
    }
  | {
      type: "beep";
      frequencyHz: number;
      durationCycles: number;
      volume: number;
      cycle: number;
    }
  | { type: "key_irq"; keyCode: number; cycle: number }
  | { type: "error"; message: string; cycle: number };

export type HandshakeOptions = {
  segmentDigits?: number;
  onTrace?: (event: HandshakeTraceEvent) => void;
};

const clampByte = (value: number): number => value & 0xff;

const clampWord = (value: number): number => value & 0xffff;

const crc8Xor = (bytes: number[]): number => {
  let crc = 0;
  for (const b of bytes) {
    crc ^= clampByte(b);
  }
  return clampByte(crc);
};

const buildPacketBytes = (
  seq: number,
  command: number,
  payload: number[],
): number[] => {
  const body = [
    clampByte(seq),
    clampByte(command),
    clampByte(payload.length),
    ...payload.map(clampByte),
  ];
  const checksum = crc8Xor(body);
  return [HANDSHAKE_SOF, ...body, checksum];
};

const tryDecodePacket = (buffer: number[]): HandshakePacket | null => {
  while (buffer.length > 0 && buffer[0] !== HANDSHAKE_SOF) {
    buffer.shift();
  }
  if (buffer.length < 5) {
    return null;
  }

  const len = buffer[3] ?? 0;
  const needed = 5 + len;
  if (buffer.length < needed) {
    return null;
  }

  const frame = buffer.splice(0, needed);
  const seq = frame[1] ?? 0;
  const command = frame[2] ?? 0;
  const payload = frame.slice(4, 4 + len);
  const checksum = frame[4 + len] ?? 0;
  const expected = crc8Xor([seq, command, len, ...payload]);

  if (checksum !== expected) {
    return null;
  }

  return { seq, command, payload, checksum };
};

class BidirectionalBus8 {
  private cpuDrive: number | null = null;
  private panelDrive: number | null = null;

  public driveCpu(value: number): void {
    this.cpuDrive = clampByte(value);
  }

  public drivePanel(value: number): void {
    this.panelDrive = clampByte(value);
  }

  public releaseCpu(): void {
    this.cpuDrive = null;
  }

  public releasePanel(): void {
    this.panelDrive = null;
  }

  public read(direction: BusDirection): number | null {
    if (direction === BusDirection.CpuToPanel) {
      return this.cpuDrive;
    }
    return this.panelDrive;
  }

  public hasCollision(): boolean {
    return this.cpuDrive !== null && this.panelDrive !== null;
  }
}

type EndpointState = "idle" | "req_high" | "await_ack_drop";

export class Mn1613PanelHandshake {
  private readonly bus = new BidirectionalBus8();
  private readonly segmentDigits: number;
  private readonly onTrace?: (event: HandshakeTraceEvent) => void;

  private cycle = 0;
  private seqCpu = 0;
  private seqPanel = 0;

  private readonly lines: ControlLines = {
    req: false,
    ack: false,
    irq: false,
    reset: false,
    direction: BusDirection.CpuToPanel,
  };

  private cpuTxBytes: number[] = [];
  private panelTxBytes: number[] = [];
  private cpuRxBytes: number[] = [];
  private panelRxBytes: number[] = [];
  private cpuRxPackets: HandshakePacket[] = [];
  private panelRxPackets: HandshakePacket[] = [];

  private cpuState: EndpointState = "idle";
  private panelState: EndpointState = "idle";

  private readonly panelStateData: PanelBoardState;

  public constructor(options: HandshakeOptions = {}) {
    this.segmentDigits = options.segmentDigits ?? 8;
    this.onTrace = options.onTrace;

    this.panelStateData = {
      sevenSegment: new Uint8Array(this.segmentDigits),
      bulletLed16: Array.from({ length: 16 }, () => false),
      keyQueue: [],
      beep: {
        active: false,
        frequencyHz: 0,
        remainingCycles: 0,
        volume: 0,
      },
      irqPending: false,
    };
  }

  public getControlLines(): ControlLines {
    return { ...this.lines };
  }

  public getCycle(): number {
    return this.cycle;
  }

  public getPanelState(): PanelBoardState {
    return {
      sevenSegment: new Uint8Array(this.panelStateData.sevenSegment),
      bulletLed16: [...this.panelStateData.bulletLed16],
      keyQueue: [...this.panelStateData.keyQueue],
      beep: { ...this.panelStateData.beep },
      irqPending: this.panelStateData.irqPending,
    };
  }

  public cpuSend(command: number, payload: number[] = []): void {
    const bytes = buildPacketBytes(this.seqCpu, command, payload);
    this.seqCpu = clampByte(this.seqCpu + 1);
    this.cpuTxBytes.push(...bytes);
    this.emit({
      type: "packet_tx",
      endpoint: "cpu",
      packet: {
        seq: bytes[1] ?? 0,
        command: bytes[2] ?? 0,
        payload: payload.map(clampByte),
        checksum: bytes[bytes.length - 1] ?? 0,
      },
      cycle: this.cycle,
    });
  }

  public cpuReadPacket(): HandshakePacket | null {
    return this.cpuRxPackets.shift() ?? null;
  }

  public panelReadPacket(): HandshakePacket | null {
    return this.panelRxPackets.shift() ?? null;
  }

  public injectHexKey(hex: number): void {
    const code = clampByte(hex & 0x0f);
    this.enqueueKey(code);
  }

  public injectFunctionKey(key: FunctionKey): void {
    this.enqueueKey(clampByte(key));
  }

  public reset(): void {
    this.lines.req = false;
    this.lines.ack = false;
    this.lines.irq = false;
    this.lines.reset = true;
    this.lines.direction = BusDirection.CpuToPanel;

    this.cpuTxBytes = [];
    this.panelTxBytes = [];
    this.cpuRxBytes = [];
    this.panelRxBytes = [];
    this.cpuRxPackets = [];
    this.panelRxPackets = [];

    this.cpuState = "idle";
    this.panelState = "idle";

    this.bus.releaseCpu();
    this.bus.releasePanel();

    this.panelStateData.sevenSegment.fill(0);
    this.panelStateData.bulletLed16.fill(false);
    this.panelStateData.keyQueue.length = 0;
    this.panelStateData.beep = {
      active: false,
      frequencyHz: 0,
      remainingCycles: 0,
      volume: 0,
    };
    this.panelStateData.irqPending = false;
  }

  public releaseReset(): void {
    this.lines.reset = false;
  }

  public runCycles(cycles: number): void {
    for (let i = 0; i < cycles; i++) {
      this.tick();
    }
  }

  public tick(): void {
    this.cycle += 1;

    this.updateBeep();
    this.updateIrqLine();

    if (this.bus.hasCollision()) {
      this.emit({
        type: "error",
        message: "8-bit bus collision detected",
        cycle: this.cycle,
      });
      this.bus.releaseCpu();
      this.bus.releasePanel();
      this.lines.req = false;
      this.lines.ack = false;
      this.cpuState = "idle";
      this.panelState = "idle";
      return;
    }

    this.driveSideIfIdle();
    this.panelCapturePhase();
    this.cpuCapturePhase();
    this.decodeAndExecute();
  }

  private driveSideIfIdle(): void {
    if (this.lines.req || this.lines.ack) {
      return;
    }

    const panelHasPending = this.panelTxBytes.length > 0;
    const cpuHasPending = this.cpuTxBytes.length > 0;
    if (!panelHasPending && !cpuHasPending) {
      return;
    }

    // IRQ中はパネル応答を優先して、キー/BEEP通知の遅延を抑える。
    const panelPriority = panelHasPending && (this.lines.irq || !cpuHasPending);
    if (panelPriority) {
      const value = this.panelTxBytes[0] ?? 0;
      this.lines.direction = BusDirection.PanelToCpu;
      this.bus.drivePanel(value);
      this.panelState = "req_high";
      this.lines.req = true;
      this.emit({
        type: "byte_tx",
        direction: this.lines.direction,
        value,
        cycle: this.cycle,
      });
      return;
    }

    const value = this.cpuTxBytes[0] ?? 0;
    this.lines.direction = BusDirection.CpuToPanel;
    this.bus.driveCpu(value);
    this.cpuState = "req_high";
    this.lines.req = true;
    this.emit({
      type: "byte_tx",
      direction: this.lines.direction,
      value,
      cycle: this.cycle,
    });
  }

  private panelCapturePhase(): void {
    if (this.lines.direction !== BusDirection.CpuToPanel) {
      return;
    }

    if (this.lines.req && !this.lines.ack) {
      const value = this.bus.read(BusDirection.CpuToPanel);
      if (value !== null) {
        this.panelRxBytes.push(value);
        this.lines.ack = true;
      }
      return;
    }

    if (!this.lines.req && this.lines.ack) {
      this.lines.ack = false;
      this.cpuTxBytes.shift();
      this.bus.releaseCpu();
      this.cpuState = "idle";
    }
  }

  private cpuCapturePhase(): void {
    if (this.lines.direction !== BusDirection.PanelToCpu) {
      return;
    }

    if (this.lines.req && !this.lines.ack) {
      const value = this.bus.read(BusDirection.PanelToCpu);
      if (value !== null) {
        this.cpuRxBytes.push(value);
        this.lines.ack = true;
      }
      return;
    }

    if (!this.lines.req && this.lines.ack) {
      this.lines.ack = false;
      this.panelTxBytes.shift();
      this.bus.releasePanel();
      this.panelState = "idle";
    }
  }

  private decodeAndExecute(): void {
    if (this.cpuState === "req_high" && this.lines.ack) {
      this.cpuState = "await_ack_drop";
      this.lines.req = false;
    }
    if (this.panelState === "req_high" && this.lines.ack) {
      this.panelState = "await_ack_drop";
      this.lines.req = false;
    }

    let decoded = tryDecodePacket(this.panelRxBytes);
    while (decoded) {
      this.panelRxPackets.push(decoded);
      this.emit({
        type: "packet_rx",
        endpoint: "panel",
        packet: decoded,
        cycle: this.cycle,
      });
      this.handlePanelPacket(decoded);
      decoded = tryDecodePacket(this.panelRxBytes);
    }

    let cpuDecoded = tryDecodePacket(this.cpuRxBytes);
    while (cpuDecoded) {
      this.cpuRxPackets.push(cpuDecoded);
      this.emit({
        type: "packet_rx",
        endpoint: "cpu",
        packet: cpuDecoded,
        cycle: this.cycle,
      });
      cpuDecoded = tryDecodePacket(this.cpuRxBytes);
    }
  }

  private handlePanelPacket(packet: HandshakePacket): void {
    const command = packet.command;
    const payload = packet.payload;

    switch (command) {
      case PanelCommand.Ping:
        this.panelSend(PanelCommand.Ack, [packet.seq, 0x00]);
        return;

      case PanelCommand.ReadStatus: {
        const status = this.makeStatusByte();
        this.panelSend(PanelCommand.ReadStatus, [status]);
        return;
      }

      case PanelCommand.SetSevenSegment:
        this.execSetSevenSegment(payload, packet.seq);
        return;

      case PanelCommand.SetBulletLed:
        this.execSetBulletLed(payload, packet.seq);
        return;

      case PanelCommand.Beep:
        this.execBeep(payload, packet.seq);
        return;

      case PanelCommand.GetKey:
        this.execGetKey(packet.seq);
        return;

      default:
        this.panelSend(PanelCommand.Error, [packet.seq, 0x01]);
    }
  }

  private execSetSevenSegment(payload: number[], seq: number): void {
    if (payload.length === 2) {
      const index = payload[0] ?? 0;
      const value = payload[1] ?? 0;
      if (index < this.panelStateData.sevenSegment.length) {
        this.panelStateData.sevenSegment[index] = clampByte(value);
        this.panelSend(PanelCommand.Ack, [seq, 0x00]);
        return;
      }
      this.panelSend(PanelCommand.Error, [seq, 0x11]);
      return;
    }

    if (payload.length === this.panelStateData.sevenSegment.length) {
      this.panelStateData.sevenSegment.set(payload.map(clampByte));
      this.panelSend(PanelCommand.Ack, [seq, 0x00]);
      return;
    }

    this.panelSend(PanelCommand.Error, [seq, 0x12]);
  }

  private execSetBulletLed(payload: number[], seq: number): void {
    if (payload.length < 2) {
      this.panelSend(PanelCommand.Error, [seq, 0x13]);
      return;
    }

    const low = payload[0] ?? 0;
    const high = payload[1] ?? 0;
    const mask = clampWord(low | (high << 8));
    for (let i = 0; i < 16; i++) {
      this.panelStateData.bulletLed16[i] = ((mask >>> i) & 1) === 1;
    }
    this.panelSend(PanelCommand.Ack, [seq, 0x00]);
  }

  private execBeep(payload: number[], seq: number): void {
    if (payload.length < 5) {
      this.panelSend(PanelCommand.Error, [seq, 0x14]);
      return;
    }

    const fLo = payload[0] ?? 0;
    const fHi = payload[1] ?? 0;
    const dLo = payload[2] ?? 0;
    const dHi = payload[3] ?? 0;
    const volume = payload[4] ?? 0;

    const frequencyHz = Math.max(1, clampWord(fLo | (fHi << 8)));
    const durationCycles = Math.max(1, clampWord(dLo | (dHi << 8)));
    this.panelStateData.beep = {
      active: true,
      frequencyHz,
      remainingCycles: durationCycles,
      volume: clampByte(volume),
    };
    this.emit({
      type: "beep",
      frequencyHz,
      durationCycles,
      volume: clampByte(volume),
      cycle: this.cycle,
    });
    this.panelSend(PanelCommand.Ack, [seq, 0x00]);
  }

  private execGetKey(seq: number): void {
    const ev = this.panelStateData.keyQueue.shift();
    if (!ev) {
      this.panelSend(PanelCommand.GetKey, [seq & 0xff, 0xff]);
      return;
    }

    this.panelSend(PanelCommand.GetKey, [seq & 0xff, ev.code & 0xff]);
    if (this.panelStateData.keyQueue.length === 0) {
      this.panelStateData.irqPending = false;
    }
  }

  private panelSend(command: number, payload: number[]): void {
    const bytes = buildPacketBytes(this.seqPanel, command, payload);
    this.seqPanel = clampByte(this.seqPanel + 1);
    this.panelTxBytes.push(...bytes);
    this.emit({
      type: "packet_tx",
      endpoint: "panel",
      packet: {
        seq: bytes[1] ?? 0,
        command: bytes[2] ?? 0,
        payload: payload.map(clampByte),
        checksum: bytes[bytes.length - 1] ?? 0,
      },
      cycle: this.cycle,
    });
  }

  private enqueueKey(code: KeyCode): void {
    this.panelStateData.keyQueue.push({
      code: clampByte(code),
      pressedAtCycle: this.cycle,
    });
    this.panelStateData.irqPending = true;
    this.emit({ type: "key_irq", keyCode: clampByte(code), cycle: this.cycle });

    // キーは割り込み駆動でも取得可能なように非同期通知パケットを積む。
    this.panelSend(PanelCommand.KeyEvent, [clampByte(code)]);
  }

  private makeStatusByte(): number {
    const busy = this.lines.req || this.lines.ack;
    const keyReady = this.panelStateData.keyQueue.length > 0;
    const beepBusy = this.panelStateData.beep.active;
    const irq = this.panelStateData.irqPending;

    let status = 0;
    if (busy) status |= 1 << 0;
    if (keyReady) status |= 1 << 1;
    if (beepBusy) status |= 1 << 2;
    if (irq) status |= 1 << 3;
    return clampByte(status);
  }

  private updateBeep(): void {
    const beep = this.panelStateData.beep;
    if (!beep.active) {
      return;
    }

    beep.remainingCycles -= 1;
    if (beep.remainingCycles <= 0) {
      beep.active = false;
      beep.frequencyHz = 0;
      beep.remainingCycles = 0;
      beep.volume = 0;
    }
  }

  private updateIrqLine(): void {
    this.lines.irq = this.panelStateData.irqPending;
  }

  private emit(event: HandshakeTraceEvent): void {
    if (this.onTrace) {
      this.onTrace(event);
    }
  }
}

export const createDefaultHandshake = (): Mn1613PanelHandshake => {
  return new Mn1613PanelHandshake({ segmentDigits: 8 });
};

export const hexCharToKeyCode = (hex: string): KeyCode | null => {
  const normalized = hex.trim().toUpperCase();
  if (!/^[0-9A-F]$/.test(normalized)) {
    return null;
  }
  return parseInt(normalized, 16) & 0x0f;
};

export const functionLabelToKeyCode = (label: string): FunctionKey | null => {
  const normalized = label.trim().toUpperCase();
  switch (normalized) {
    case "ADR SET":
      return FunctionKey.AdrSet;
    case "RUN":
      return FunctionKey.Run;
    case "INC":
      return FunctionKey.Inc;
    case "DEC":
      return FunctionKey.Dec;
    case "WRT INC":
      return FunctionKey.WrtInc;
    case "WRT DEC":
      return FunctionKey.WrtDec;
    case "BREAK":
      return FunctionKey.Break;
    case "STEP":
      return FunctionKey.Step;
    default:
      return null;
  }
};
