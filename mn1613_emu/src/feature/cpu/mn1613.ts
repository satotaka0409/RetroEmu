/**
 * Panasonic MN1610 / MN1613 CPU Emulator Core
 *
 * Architecture:
 *   - 16-bit word machine (word-addressed)
 *   - Registers: R0-R7 (general purpose), SP, STR (status), PC
 *   - Status bits: C (carry), Z (zero), N (negative), V (overflow),
 *                  E (extend/half-carry), IE (interrupt enable)
 *
 * Memory:
 *   - Supplied externally as ArrayBuffer (word-addressed, big-endian)
 *   - Set via setMemory()
 *
 * Execution:
 *   - run(startAddr)  : 連続実行（ブレークポイント・ステップで停止）
 *   - step()          : 1命令だけ実行
 *   - halt()          : 実行停止
 *   - addBreakpoint() / removeBreakpoint() / clearBreakpoints()
 *   - setStepMode(true) : 次のstep()まで停止
 */

// ─────────────────────────────────────────────
// グローバルメモリ (外部から setMemory() で渡す)
// ─────────────────────────────────────────────
let _memory: ArrayBuffer = new ArrayBuffer(0x10000 * 2); // 64K words = 128KB
let _memView: DataView = new DataView(_memory);

export function setMemory(buf: ArrayBuffer): void {
  _memory = buf;
  _memView = new DataView(_memory);
}

export function getMemory(): ArrayBuffer {
  return _memory;
}

// ─────────────────────────────────────────────
// Status Register ビット定義
// ─────────────────────────────────────────────
export const STR_C = 0x0001; // Carry
export const STR_Z = 0x0002; // Zero
export const STR_N = 0x0004; // Negative (Sign)
export const STR_V = 0x0008; // oVerflow
export const STR_E = 0x0010; // Extend (half-carry / digit carry)
export const STR_IE = 0x0080; // Interrupt Enable

// ─────────────────────────────────────────────
// CPU 状態
// ─────────────────────────────────────────────
export type CPUState = {
  R: Uint16Array; // R0-R7
  SP: number;
  STR: number;
  PC: number;
};

const cpu: CPUState = {
  R: new Uint16Array(8),
  SP: 0x0000,
  STR: 0x0000,
  PC: 0x0000,
};

// ─────────────────────────────────────────────
// 実行状態
// ─────────────────────────────────────────────
export type ExecStatus = "idle" | "running" | "step" | "break" | "halted";

let execStatus: ExecStatus = "idle";
const breakpoints = new Set<number>();
let stepMode = false;

// コールバック（状態変化通知）
export type OnStopCallback = (status: ExecStatus, state: CPUState) => void;
let onStopCallback: OnStopCallback | null = null;

export function setOnStopCallback(cb: OnStopCallback | null): void {
  onStopCallback = cb;
}

// ─────────────────────────────────────────────
// 公開 API
// ─────────────────────────────────────────────

/** CPU をリセットする */
export function reset(): void {
  cpu.R.fill(0);
  cpu.SP = 0x0000;
  cpu.STR = 0x0000;
  cpu.PC = 0x0000;
  execStatus = "idle";
  stepMode = false;
}

/** CPU 状態のスナップショットを返す */
export function getState(): CPUState {
  return {
    R: new Uint16Array(cpu.R),
    SP: cpu.SP,
    STR: cpu.STR,
    PC: cpu.PC,
  };
}

/** 実行状態を返す */
export function getExecStatus(): ExecStatus {
  return execStatus;
}

/** ブレークポイントを追加 */
export function addBreakpoint(addr: number): void {
  breakpoints.add(addr & 0xffff);
}

/** ブレークポイントを削除 */
export function removeBreakpoint(addr: number): void {
  breakpoints.delete(addr & 0xffff);
}

/** ブレークポイントを全消去 */
export function clearBreakpoints(): void {
  breakpoints.clear();
}

/** 現在のブレークポイント一覧 */
export function getBreakpoints(): ReadonlySet<number> {
  return breakpoints;
}

/**
 * ステップ実行モード切替
 * enable=true にすると次の step() 呼び出し後に停止
 */
export function setStepMode(enable: boolean): void {
  stepMode = enable;
  if (enable && execStatus === "running") {
    execStatus = "step";
  }
}

/**
 * 1命令だけ実行する
 * @returns 実行後の CPU 状態
 */
export function step(): CPUState {
  if (execStatus === ("halted" as ExecStatus)) return getState();

  stepMode = false;
  execStatus = "running";
  _executeOne();

  if (execStatus !== ("halted" as ExecStatus)) {
    execStatus = "step";
    onStopCallback?.(execStatus, getState());
  }
  return getState();
}

/**
 * 指定アドレスから連続実行する
 * ブレークポイントまたは HALT / setStepMode(true) で停止し
 * Promise を resolve する
 * @param startAddr 開始アドレス（word アドレス）
 * @param maxCycles 無限ループ保護：最大サイクル数（0=無制限）
 */
export async function run(
  startAddr: number,
  maxCycles = 0,
): Promise<ExecStatus> {
  cpu.PC = startAddr & 0xffff;
  execStatus = "running";
  stepMode = false;

  return new Promise<ExecStatus>((resolve) => {
    let cycles = 0;

    function tick(): void {
      // 1バッチ = 1000命令ずつ実行してUIをブロックしない
      const BATCH = 1000;
      for (let i = 0; i < BATCH; i++) {
        // ブレークポイントチェック（実行前）
        if (breakpoints.has(cpu.PC)) {
          execStatus = "break";
          onStopCallback?.(execStatus, getState());
          resolve(execStatus);
          return;
        }

        // ステップモードに切り替わっていたら停止
        if (stepMode) {
          execStatus = "step";
          onStopCallback?.(execStatus, getState());
          resolve(execStatus);
          return;
        }

        _executeOne();

        if (execStatus === ("halted" as ExecStatus)) {
          onStopCallback?.(execStatus, getState());
          resolve(execStatus);
          return;
        }

        cycles++;
        if (maxCycles > 0 && cycles >= maxCycles) {
          execStatus = "break";
          onStopCallback?.(execStatus, getState());
          resolve(execStatus);
          return;
        }
      }

      // まだ続けるなら次フレームへ
      setTimeout(tick, 0);
    }

    setTimeout(tick, 0);
  });
}

/** 実行を強制停止 */
export function halt(): void {
  execStatus = "halted";
}

// ─────────────────────────────────────────────
// 内部ユーティリティ
// ─────────────────────────────────────────────

function readWord(addr: number): number {
  const byteOfs = (addr & 0xffff) << 1;
  if (byteOfs + 1 >= _memView.byteLength) return 0xffff;
  return _memView.getUint16(byteOfs, false); // big-endian
}

function writeWord(addr: number, val: number): void {
  const byteOfs = (addr & 0xffff) << 1;
  if (byteOfs + 1 >= _memView.byteLength) return;
  _memView.setUint16(byteOfs, val & 0xffff, false);
}

function fetch(): number {
  const w = readWord(cpu.PC);
  cpu.PC = (cpu.PC + 1) & 0xffff;
  return w;
}

function setFlag(flag: number, v: boolean): void {
  if (v) cpu.STR |= flag;
  else cpu.STR &= ~flag & 0xffff;
}

function getFlag(flag: number): boolean {
  return (cpu.STR & flag) !== 0;
}

function updateNZ(result: number): void {
  setFlag(STR_Z, (result & 0xffff) === 0);
  setFlag(STR_N, (result & 0x8000) !== 0);
}

function getReg(r: number): number {
  return cpu.R[r & 0x7];
}

function setReg(r: number, val: number): void {
  cpu.R[r & 0x7] = val & 0xffff;
}

// ─────────────────────────────────────────────
// 命令デコード・実行
//
// MN1610 / MN1613 命令フォーマット（16ビット語）
//
// 1語命令:
//   [15:11] opcode (5bit)
//   [10: 8] Rd     (3bit, 宛先レジスタ)
//   [ 7: 0] operand (8bit: 即値・Rsフィールドなど)
//
// 2語命令: 第2語が 16bit アドレスや即値
// ─────────────────────────────────────────────
function _executeOne(): void {
  const ir = fetch();
  const op = (ir >>> 11) & 0x1f; // opcode[4:0]
  const rd = (ir >>> 8) & 0x07; // Rd
  const imm8 = ir & 0xff; // lower 8bit
  const rs = ir & 0x07; // Rs (下位3bit)
  const simm8 = imm8 < 0x80 ? imm8 : imm8 - 0x100; // signed 8bit

  switch (op) {
    // ────── 0x00: MISC (サブオペコードで分岐) ──────
    case 0x00: {
      const subop = (ir >>> 4) & 0x0f;
      const rsub = ir & 0x0f;
      switch (subop) {
        case 0x0: // NOP
          break;

        case 0x1: // HALT
          execStatus = "halted";
          break;

        case 0x2: {
          // RET
          cpu.PC = readWord(cpu.SP);
          cpu.SP = (cpu.SP + 1) & 0xffff;
          break;
        }

        case 0x3: {
          // RETI (割り込みから復帰)
          cpu.STR = readWord(cpu.SP);
          cpu.SP = (cpu.SP + 1) & 0xffff;
          cpu.PC = readWord(cpu.SP);
          cpu.SP = (cpu.SP + 1) & 0xffff;
          break;
        }

        case 0x4: {
          // PUSH Rs
          cpu.SP = (cpu.SP - 1) & 0xffff;
          writeWord(cpu.SP, getReg(rsub & 0x7));
          break;
        }

        case 0x5: {
          // POP Rd
          setReg(rsub & 0x7, readWord(cpu.SP));
          cpu.SP = (cpu.SP + 1) & 0xffff;
          updateNZ(getReg(rsub & 0x7));
          break;
        }

        case 0x6: {
          // PUSH STR
          cpu.SP = (cpu.SP - 1) & 0xffff;
          writeWord(cpu.SP, cpu.STR);
          break;
        }

        case 0x7: {
          // POP STR
          cpu.STR = readWord(cpu.SP) & 0xffff;
          cpu.SP = (cpu.SP + 1) & 0xffff;
          break;
        }

        case 0x8: {
          // MV Rd, Rs
          const mvRd = (ir >>> 8) & 0x7;
          const mvRs = ir & 0x7;
          setReg(mvRd, getReg(mvRs));
          updateNZ(getReg(mvRd));
          break;
        }

        case 0x9: {
          // XCH Rd, Rs
          const xRd = (ir >>> 8) & 0x7;
          const xRs = ir & 0x7;
          const tmp = getReg(xRd);
          setReg(xRd, getReg(xRs));
          setReg(xRs, tmp);
          break;
        }

        case 0xa: // EI (割り込み許可)
          setFlag(STR_IE, true);
          break;

        case 0xb: // DI (割り込み禁止)
          setFlag(STR_IE, false);
          break;

        default:
          console.warn(
            `[MN1610] Unknown MISC subop=0x${subop.toString(16)} PC=0x${(cpu.PC - 1).toString(16)}`,
          );
      }
      break;
    }

    // ────── 0x01: LI  Rd, imm8  (即値ロード 8bit) ──────
    case 0x01:
      setReg(rd, imm8);
      updateNZ(imm8);
      break;

    // ────── 0x02: LW  Rd, (addr16)  (メモリロード 直接) ──────
    case 0x02: {
      const addr = fetch();
      setReg(rd, readWord(addr));
      updateNZ(getReg(rd));
      break;
    }

    // ────── 0x03: SW  Rd, (addr16)  (メモリストア 直接) ──────
    case 0x03: {
      const addr = fetch();
      writeWord(addr, getReg(rd));
      break;
    }

    // ────── 0x04: LW  Rd, (Rs+d4)  (ベースアドレス＋4bit変位) ──────
    case 0x04: {
      const baseReg = (ir >>> 4) & 0x7;
      const disp = ir & 0xf;
      const addr = (getReg(baseReg) + disp) & 0xffff;
      setReg(rd, readWord(addr));
      updateNZ(getReg(rd));
      break;
    }

    // ────── 0x05: SW  Rd, (Rs+d4)  (ベースアドレス＋4bit変位ストア) ──────
    case 0x05: {
      const baseReg = (ir >>> 4) & 0x7;
      const disp = ir & 0xf;
      const addr = (getReg(baseReg) + disp) & 0xffff;
      writeWord(addr, getReg(rd));
      break;
    }

    // ────── 0x06: LW  Rd, (Rs)+  (ポストインクリメント) ──────
    case 0x06: {
      const addr = getReg(rs);
      setReg(rd, readWord(addr));
      setReg(rs, (addr + 1) & 0xffff);
      updateNZ(getReg(rd));
      break;
    }

    // ────── 0x07: SW  Rd, (Rs)+  (ポストインクリメントストア) ──────
    case 0x07: {
      const addr = getReg(rs);
      writeWord(addr, getReg(rd));
      setReg(rs, (addr + 1) & 0xffff);
      break;
    }

    // ────── 0x08: ADD Rd, imm8 ──────
    case 0x08: {
      const a = getReg(rd);
      const res = a + imm8;
      setFlag(STR_C, res > 0xffff);
      setFlag(STR_V, (~(a ^ imm8) & (a ^ res) & 0x8000) !== 0);
      setFlag(STR_E, (a & 0xf) + (imm8 & 0xf) > 0xf);
      setReg(rd, res);
      updateNZ(getReg(rd));
      break;
    }

    // ────── 0x09: SUB Rd, imm8 ──────
    case 0x09: {
      const a = getReg(rd);
      const res = a - imm8;
      setFlag(STR_C, res < 0);
      setFlag(STR_V, ((a ^ imm8) & (a ^ res) & 0x8000) !== 0);
      setFlag(STR_E, (a & 0xf) < (imm8 & 0xf));
      setReg(rd, res);
      updateNZ(getReg(rd));
      break;
    }

    // ────── 0x0a: AND Rd, imm8 ──────
    case 0x0a:
      setReg(rd, getReg(rd) & imm8);
      updateNZ(getReg(rd));
      break;

    // ────── 0x0b: OR  Rd, imm8 ──────
    case 0x0b:
      setReg(rd, getReg(rd) | imm8);
      updateNZ(getReg(rd));
      break;

    // ────── 0x0c: XOR Rd, imm8 ──────
    case 0x0c:
      setReg(rd, getReg(rd) ^ imm8);
      updateNZ(getReg(rd));
      break;

    // ────── 0x0d: CMP Rd, imm8 (結果は捨ててフラグのみ更新) ──────
    case 0x0d: {
      const a = getReg(rd);
      const res = a - imm8;
      setFlag(STR_C, res < 0);
      setFlag(STR_V, ((a ^ imm8) & (a ^ res) & 0x8000) !== 0);
      setFlag(STR_E, (a & 0xf) < (imm8 & 0xf));
      updateNZ(res);
      break;
    }

    // ────── 0x0e: LI  Rd, imm16  (即値ロード 16bit, 2語命令) ──────
    case 0x0e: {
      const imm16 = fetch();
      setReg(rd, imm16);
      updateNZ(imm16);
      break;
    }

    // ────── 0x0f: ADD Rd, Rs ──────
    case 0x0f: {
      const a = getReg(rd);
      const b = getReg(rs);
      const res = a + b;
      setFlag(STR_C, res > 0xffff);
      setFlag(STR_V, (~(a ^ b) & (a ^ res) & 0x8000) !== 0);
      setFlag(STR_E, (a & 0xf) + (b & 0xf) > 0xf);
      setReg(rd, res);
      updateNZ(getReg(rd));
      break;
    }

    // ────── 0x10: SUB Rd, Rs ──────
    case 0x10: {
      const a = getReg(rd);
      const b = getReg(rs);
      const res = a - b;
      setFlag(STR_C, res < 0);
      setFlag(STR_V, ((a ^ b) & (a ^ res) & 0x8000) !== 0);
      setFlag(STR_E, (a & 0xf) < (b & 0xf));
      setReg(rd, res);
      updateNZ(getReg(rd));
      break;
    }

    // ────── 0x11: AND Rd, Rs ──────
    case 0x11:
      setReg(rd, getReg(rd) & getReg(rs));
      updateNZ(getReg(rd));
      break;

    // ────── 0x12: OR  Rd, Rs ──────
    case 0x12:
      setReg(rd, getReg(rd) | getReg(rs));
      updateNZ(getReg(rd));
      break;

    // ────── 0x13: XOR Rd, Rs ──────
    case 0x13:
      setReg(rd, getReg(rd) ^ getReg(rs));
      updateNZ(getReg(rd));
      break;

    // ────── 0x14: CMP Rd, Rs ──────
    case 0x14: {
      const a = getReg(rd);
      const b = getReg(rs);
      const res = a - b;
      setFlag(STR_C, res < 0);
      setFlag(STR_V, ((a ^ b) & (a ^ res) & 0x8000) !== 0);
      setFlag(STR_E, (a & 0xf) < (b & 0xf));
      updateNZ(res);
      break;
    }

    // ────── 0x15: SHL Rd (論理左シフト) ──────
    case 0x15: {
      const a = getReg(rd);
      setFlag(STR_C, (a & 0x8000) !== 0);
      setReg(rd, (a << 1) & 0xffff);
      updateNZ(getReg(rd));
      break;
    }

    // ────── 0x16: SHR Rd (論理右シフト) ──────
    case 0x16: {
      const a = getReg(rd);
      setFlag(STR_C, (a & 0x0001) !== 0);
      setReg(rd, (a >>> 1) & 0xffff);
      updateNZ(getReg(rd));
      break;
    }

    // ────── 0x17: SAR Rd (算術右シフト, 符号ビット保持) ──────
    case 0x17: {
      const a = getReg(rd);
      setFlag(STR_C, (a & 0x0001) !== 0);
      setReg(rd, ((a >> 1) | (a & 0x8000)) & 0xffff);
      updateNZ(getReg(rd));
      break;
    }

    // ────── 0x18: ROL Rd (キャリースルー左ローテート) ──────
    case 0x18: {
      const a = getReg(rd);
      const c = getFlag(STR_C) ? 1 : 0;
      setFlag(STR_C, (a & 0x8000) !== 0);
      setReg(rd, ((a << 1) | c) & 0xffff);
      updateNZ(getReg(rd));
      break;
    }

    // ────── 0x19: ROR Rd (キャリースルー右ローテート) ──────
    case 0x19: {
      const a = getReg(rd);
      const c = getFlag(STR_C) ? 0x8000 : 0;
      setFlag(STR_C, (a & 0x0001) !== 0);
      setReg(rd, ((a >>> 1) | c) & 0xffff);
      updateNZ(getReg(rd));
      break;
    }

    // ────── 0x1a: JMP addr16 (無条件ジャンプ) ──────
    case 0x1a:
      cpu.PC = fetch();
      break;

    // ────── 0x1b: CALL addr16 (サブルーチン呼び出し) ──────
    case 0x1b: {
      const addr = fetch();
      cpu.SP = (cpu.SP - 1) & 0xffff;
      writeWord(cpu.SP, cpu.PC);
      cpu.PC = addr;
      break;
    }

    // ────── 0x1c: 条件分岐 (cond は [10:8]) ──────
    // cond encoding: 0=JZ 1=JNZ 2=JC 3=JNC 4=JN 5=JP 6=JV 7=JNV
    case 0x1c: {
      const addr = fetch();
      const cond = rd; // [10:8] を条件コードとして使用
      const taken = _evalCond(cond);
      if (taken) cpu.PC = addr;
      break;
    }

    // ────── 0x1d: BRA rel8 (相対分岐, 無条件) ──────
    case 0x1d:
      cpu.PC = (cpu.PC + simm8) & 0xffff;
      break;

    // ────── 0x1e: BRcc rel8 (条件相対分岐) [10:8]=cond ──────
    case 0x1e: {
      const cond = rd;
      if (_evalCond(cond)) {
        cpu.PC = (cpu.PC + simm8) & 0xffff;
      }
      break;
    }

    // ────── 0x1f: DJNZ Rd, rel8 (デクリメント・非ゼロ分岐) ──────
    case 0x1f: {
      const val = (getReg(rd) - 1) & 0xffff;
      setReg(rd, val);
      if (val !== 0) {
        cpu.PC = (cpu.PC + simm8) & 0xffff;
      }
      break;
    }

    default:
      console.warn(
        `[MN1610] Unknown opcode=0x${op.toString(16)} IR=0x${ir.toString(16)} PC=0x${(cpu.PC - 1).toString(16)}`,
      );
  }
}

/** 条件コードを評価して true/false を返す */
function _evalCond(cond: number): boolean {
  switch (cond & 0x7) {
    case 0:
      return getFlag(STR_Z); // Z  (JZ / BEQ)
    case 1:
      return !getFlag(STR_Z); // NZ (JNZ / BNE)
    case 2:
      return getFlag(STR_C); // C  (JC / BCS)
    case 3:
      return !getFlag(STR_C); // NC (JNC / BCC)
    case 4:
      return getFlag(STR_N); // N  (JN / BMI)
    case 5:
      return !getFlag(STR_N); // P  (JP / BPL)
    case 6:
      return getFlag(STR_V); // V  (JV / BVS)
    case 7:
      return !getFlag(STR_V); // NV (JNV / BVC)
    default:
      return false;
  }
}
