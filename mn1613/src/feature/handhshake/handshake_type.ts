/**
 * ハンドシェイク共通型定義
 *
 * レトロCPUボード・制御I/Oボードの両側で使用する
 * 信号線状態・割り込み制御・コマンド定数を定義する。
 */

// ─────────────────────────────────────────────
// ハンドシェイクバス（共有信号線の状態）
// ─────────────────────────────────────────────

/**
 * ハンドシェイク信号バス
 *
 * CPU -> I/O 方向: REQ_0, ACK_0, DR_0, DATA0
 * I/O -> CPU 方向: REQ_1, ACK_1, DR_1, DATA1
 * 割り込み制御  : INT_FLG, INT_CAUSE
 */
export interface HandshakeBus {
  // ── CPU -> I/O 方向 ──────────────────────────
  /** CPU からの転送依頼信号 */
  REQ_0: number;
  /** I/O ボードの受理確認信号 */
  ACK_0: number;
  /** CPU からのデータ準備完了（トリガー） */
  DR_0: number;
  /** CPU -> I/O 8Bit データバス */
  DATA0: number;

  // ── I/O -> CPU 方向 ──────────────────────────
  /** I/O ボードからの転送依頼信号 */
  REQ_1: number;
  /** CPU ボードの受理確認信号 */
  ACK_1: number;
  /** I/O ボードからのデータ準備完了（トリガー） */
  DR_1: number;
  /** I/O -> CPU 8Bit データバス */
  DATA1: number;

  // ── 割り込み制御 ──────────────────────────────
  /** 割り込み処理中フラグ（0: 非処理中, 1: 処理中） */
  INT_FLG: number;
  /** 割り込み要因コード */
  INT_CAUSE: number;
}

/** HandshakeBus の初期値を生成する */
export function createHandshakeBus(): HandshakeBus {
  return {
    REQ_0: 0,
    ACK_0: 0,
    DR_0: 0,
    DATA0: 0,
    REQ_1: 0,
    ACK_1: 0,
    DR_1: 0,
    DATA1: 0,
    INT_FLG: 0,
    INT_CAUSE: 0,
  };
}

// ─────────────────────────────────────────────
// 割り込み要因
// ─────────────────────────────────────────────

export const INT_CAUSE_CODE = {
  /** ハンドシェイクによる割り込み */
  HANDSHAKE: 2,
} as const;

// ─────────────────────────────────────────────
// コマンド定数
// ─────────────────────────────────────────────

/** CPU -> I/O 方向コマンド */
export const CMD_CPU_TO_IO = {
  /** CPUレジスタなどの状態を通知する */
  CPU_STATUS_NOTIFY: 0x10,
  /** モニターモード/フリーモード設定 */
  MODE_SET: 0x11,
  /** 16進キー入力状態を取得（フリーモード時） */
  HEX_KEY_GET: 0x14,
  /** PCのキー入力を中継してキー入力状態を取得 */
  PC_KEY_GET: 0x15,
  /** LED表示を指示（フリーモード時） */
  LED_DISPLAY: 0x16,
  /** BEEP音を鳴らす */
  BEEP: 0x18,
  /** タイマー割り込み設定 */
  TIMER_SET: 0x19,
} as const;

/** I/O -> CPU 方向コマンド */
export const CMD_IO_TO_CPU = {
  /** メモリ/IOブレイクを設定する */
  BREAK_MEM_IO_SET: 0x40,
  /** メモリ/IOブレイクを解除する */
  BREAK_MEM_IO_CLR: 0x41,
  /** 命令ブレイクを設定する */
  BREAK_INST_SET: 0x42,
  /** 命令ブレイクを解除する */
  BREAK_INST_CLR: 0x43,
  /** CPUレジスタなどの状態を取得する */
  CPU_STATUS_GET: 0x48,
  /** アドレスを渡してプログラムを実行する */
  EXEC: 0x49,
  /** アドレスとバイト数を渡してメモリを読み込む */
  MEM_READ: 0x50,
  /** アドレスとバイト数、データを渡してメモリを書き込む */
  MEM_WRITE: 0x51,
  /** アドレスとバイト数を渡してIOを読み込む */
  IO_READ: 0x52,
  /** アドレスとバイト数、データを渡してIOを書き込む */
  IO_WRITE: 0x53,
} as const;

/** 応答コード */
export const RESPONSE_CODE = {
  OK: 0x00,
  NG: 0x01,
  NG_MODE_ERROR: 0x01,
  NG_OTHER_ERROR: 0x02,
} as const;

/** モード設定値 */
export const MODE = {
  MONITOR: 0,
  FREE: 1,
} as const;

// ─────────────────────────────────────────────
// ブレイク設定フラグ
// ─────────────────────────────────────────────

/** ブレイク対象 */
export const BREAK_TARGET = {
  MEM: 0,
  IO: 1,
} as const;

/** ブレイク方向 */
export const BREAK_DIRECTION = {
  READ: 0,
  WRITE: 1,
} as const;

/** ブレイク条件 (Bit2-4) */
export const BREAK_CONDITION = {
  EQ: 0b000,
  NEQ: 0b001,
  GTE: 0b010,
  LTE: 0b011,
  AND_MASK: 0b100,
} as const;

// ─────────────────────────────────────────────
// チェックサム・ブロック分割ユーティリティ
// ─────────────────────────────────────────────

/**
 * ブロック単位（デフォルト256バイト）のチェックサムを計算する。
 * チェックサムは各バイトの単純加算の下位8ビット。
 */
export function calcBlockChecksum(block: Uint8Array): number {
  let sum = 0;
  for (const b of block) {
    sum = (sum + b) & 0xff;
  }
  return sum;
}

/**
 * データを blockSize バイトのブロック列に分割する。
 * 端数はパディングなしでそのまま末尾ブロックとして返す。
 */
export function splitToBlocks(data: Uint8Array, blockSize = 256): Uint8Array[] {
  const blocks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += blockSize) {
    blocks.push(data.slice(offset, offset + blockSize));
  }
  return blocks;
}

// ─────────────────────────────────────────────
// 内部ユーティリティ（両ボード共通）
// ─────────────────────────────────────────────

export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * condition が true を返すまでポーリングで待機する。
 * @throws timeoutMs を超えた場合に Error をスロー
 */
export function waitCondition(
  condition: () => boolean,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("handshake timeout"));
        return;
      }
      setTimeout(check, 0);
    };
    check();
  });
}
