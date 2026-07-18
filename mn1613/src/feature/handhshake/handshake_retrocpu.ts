/**
 * レトロCPUボード側ハンドシェイク実装
 *
 * HandShake.md の仕様に基づき、レトロCPUボード側の
 * 送信（CPU -> I/O）・受信（I/O -> CPU）を実装する。
 *
 * 送信フロー（initiateSend → transferBytesToIo → finalizeSend）:
 *   1. ACK_0=0 確認
 *   2. REQ_0=1 セット → I/O 側に割り込み発生
 *   3. DR_0=1 セット（初期化信号）、REQ_0=0 セット
 *   4. ACK_0=1 待機（I/O 側が依頼受理）
 *   5. DR_0=0 セット（初期化完了通知）
 *   6. ACK_0=0 待機（I/O 側の初期化完了）
 *   7. DATA0 セット → DR_0 トグル → ACK_0 トグル待機（1バイトずつ繰り返し）
 *   8. DR_0=0 セット、ACK_0=0 待機（完了）
 *
 * 受信フロー（waitForIoRequest → receiveBytesFromIo → finalizeReceive）:
 *   1. REQ_1=1 待機（I/O からの割り込み）
 *   2. INT_CAUSE=2（ハンドシェイク）確認
 *   3. ACK_1=1 セット（依頼受理）
 *   4. DR_1=1 待機、ACK_1=0 セット、ACK_1=0 待機（初期化完了）
 *   5. DR_1 トグル待機 → DATA1 読み取り → ACK_1 トグル（1バイトずつ繰り返し）
 *   6. DR_1=0 待機、ACK_1=0 セット（完了）
 */

import {
  DEFAULT_TIMEOUT_MS,
  HandshakeBus,
  INT_CAUSE_CODE,
  waitCondition,
} from "./handshake_type";

export class RetroCpuHandshake {
  constructor(
    private readonly bus: HandshakeBus,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  // ─────────────────────────────────────────────
  // 公開 API
  // ─────────────────────────────────────────────

  /**
   * CPU -> I/O 方向でバイト列を送信する。
   * @param data 送信バイト列
   */
  async send(data: Uint8Array): Promise<void> {
    await this.initiateSend();
    await this.transferBytesToIo(data);
    await this.finalizeSend();
  }

  /**
   * I/O -> CPU 方向のデータを受信する。
   * REQ_1 が 1 になるまで待機してから受信を開始する。
   * @param length 受信バイト数
   * @returns 受信バイト列
   */
  async receive(length: number): Promise<Uint8Array> {
    await this.waitForIoRequest();
    const data = await this.receiveBytesFromIo(length);
    await this.finalizeReceive();
    return data;
  }

  // ─────────────────────────────────────────────
  // 送信（CPU -> I/O）内部処理
  // ─────────────────────────────────────────────

  /** ハンドシェイク開始：初期化シーケンス */
  private async initiateSend(): Promise<void> {
    // ACK_0 が 0 であることを確認
    await waitCondition(() => this.bus.ACK_0 === 0, this.timeoutMs);

    // REQ_0=1, DR_0=1, REQ_0=0 を連続セット（I/O 側への割り込みパルス + 初期化信号）
    // ※ REQ_0 はパルスのため await を挟まず同期的に 0 に戻す
    this.bus.REQ_0 = 1;
    this.bus.DR_0 = 1;
    this.bus.REQ_0 = 0;

    // ACK_0 が 1 になるまで待機（I/O 側が依頼を受理）
    await waitCondition(() => this.bus.ACK_0 === 1, this.timeoutMs);

    // DR_0 を 0 にセット（初期化完了通知）
    this.bus.DR_0 = 0;

    // ACK_0 が 0 になるまで待機（I/O 側の初期化完了）
    await waitCondition(() => this.bus.ACK_0 === 0, this.timeoutMs);
  }

  /**
   * データ転送：DR_0/ACK_0 をトリガーとして 1 バイトずつ送信する。
   * DR_0 と ACK_0 は 0->1, 1->0 を交互に繰り返す。
   */
  private async transferBytesToIo(data: Uint8Array): Promise<void> {
    let drNext = 1; // 最初のトグルは 0->1

    for (const byte of data) {
      // データをセット
      this.bus.DATA0 = byte;

      // DR_0 をトグル
      this.bus.DR_0 = drNext;

      // ACK_0 が同じ値になるまで待機（I/O 側がデータを取り込んだ）
      const ackExpected = drNext;
      await waitCondition(() => this.bus.ACK_0 === ackExpected, this.timeoutMs);

      drNext = drNext === 1 ? 0 : 1;
    }
  }

  /** ハンドシェイク完了：完了シーケンス */
  private async finalizeSend(): Promise<void> {
    // DR_0 を 0 にセット（完了処理）
    this.bus.DR_0 = 0;

    // I/O 側が ACK_0 を 0 にセットするまで待機
    await waitCondition(() => this.bus.ACK_0 === 0, this.timeoutMs);
  }

  // ─────────────────────────────────────────────
  // 受信（I/O -> CPU）内部処理
  // ─────────────────────────────────────────────

  /** 割り込み待機：I/O からの REQ_1 を受理して初期化シーケンスを実行 */
  private async waitForIoRequest(): Promise<void> {
    // REQ_1 が 1 になるまで待機（I/O からの割り込み）
    await waitCondition(() => this.bus.REQ_1 === 1, this.timeoutMs);

    // INT_CAUSE がハンドシェイク(2) であることを確認
    if (this.bus.INT_CAUSE !== INT_CAUSE_CODE.HANDSHAKE) {
      throw new Error(
        `unexpected INT_CAUSE: ${this.bus.INT_CAUSE} (expected ${INT_CAUSE_CODE.HANDSHAKE})`,
      );
    }

    // ACK_1 を 1 にセット（依頼受理を通知）
    this.bus.ACK_1 = 1;

    // DR_1 が 1 になるまで待機
    await waitCondition(() => this.bus.DR_1 === 1, this.timeoutMs);

    // I/O 側が REQ_1 を 0 にセットするまで待機（仕様: REQ_1=0 確認 → ACK_1=0 セット の順）
    await waitCondition(() => this.bus.REQ_1 === 0, this.timeoutMs);

    // ACK_1 を 0 にセット（初期化）
    this.bus.ACK_1 = 0;
  }

  /**
   * データ受信：DR_1/ACK_1 をトリガーとして 1 バイトずつ受信する。
   * DR_1 と ACK_1 は 0->1, 1->0 を交互に繰り返す。
   */
  private async receiveBytesFromIo(length: number): Promise<Uint8Array> {
    const data = new Uint8Array(length);
    let drExpected = 1; // 最初のトグルは 0->1

    for (let i = 0; i < length; i++) {
      // DR_1 がトグルするまで待機（I/O 側がデータをセット）
      await waitCondition(() => this.bus.DR_1 === drExpected, this.timeoutMs);

      // データを取り込む
      data[i] = this.bus.DATA1;

      // ACK_1 をトグル（取り込み完了を通知）
      this.bus.ACK_1 = drExpected;

      drExpected = drExpected === 1 ? 0 : 1;
    }

    return data;
  }

  /** ハンドシェイク完了：完了シーケンス */
  private async finalizeReceive(): Promise<void> {
    // I/O 側が DR_1 を 0 にセットするまで待機
    await waitCondition(() => this.bus.DR_1 === 0, this.timeoutMs);

    // ACK_1 を 0 にセット（完了処理）
    this.bus.ACK_1 = 0;
  }
}
