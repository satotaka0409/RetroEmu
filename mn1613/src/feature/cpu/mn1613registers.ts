/** MN1613 CPUレジスタ状態 */
export interface CpuRegisters {
  /** 汎用レジスタ R0 (16-bit) */
  R0: number;
  /** 汎用レジスタ R1 (16-bit) */
  R1: number;
  /** 汎用レジスタ R2 (16-bit) */
  R2: number;
  /** 汎用レジスタ R3 (16-bit) */
  R3: number;
  /** 汎用レジスタ R4 (16-bit) */
  R4: number;
  /** スタックポインタ SP (24-bit: 仕様上3バイト) */
  SP: number;
  /** ステータスレジスタ STR (24-bit: 仕様上3バイト) */
  STR: number;
  /** インストラクションカウンタ IC (16-bit) */
  IC: number;
  /** コードセグメントベースレジスタ CSBR (16-bit) */
  CSBR: number;
  /** スタックセグメントベースレジスタ SSBR (16-bit) */
  SSBR: number;
  /** タスクステータスレジスタ0 TSR0 (16-bit) */
  TSR0: number;
  /** タスクステータスレジスタ1 TSR1 (16-bit) */
  TSR1: number;
  /** オペレーティングシステムレジスタ0 OSR0 (16-bit) */
  OSR0: number;
  /** オペレーティングシステムレジスタ1 OSR1 (8-bit: 仕様上1バイト) */
  OSR1: number;
  /** オペレーティングシステムレジスタ2 OSR2 (24-bit: 仕様上3バイト) */
  OSR2: number;
  /** ノーマルプロセスポインタ NPP (8-bit: 上位バイト格納) */
  NPP: number;
  /** 割り込み識別レジスタ IISR (8-bit: 下位バイト格納) */
  IISR: number;
  /** セグメントベースレジスタバックアップ SBRB (8-bit: 下位バイト格納) */
  SBRB: number;
  /** インストラクションカウンタバックアップ ICB (16-bit) */
  ICB: number;
}
