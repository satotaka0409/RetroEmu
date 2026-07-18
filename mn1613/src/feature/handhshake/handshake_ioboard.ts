/**
 * 制御・I/O ボード側ハンドシェイク実装
 *
 * HandShake.md の仕様に基づき、制御・I/O ボード側の
 * 受信（CPU -> I/O）・送信（I/O -> CPU）を実装する。
 *
 * 受信フロー（waitForCpuRequest → receiveBytesFromCpu → finalizeReceive）:
 *   1. DR_0=1 待機（CPU の初期化信号を検出。REQ_0 はパルスのため DR_0 でポーリング）
 *   2. ACK_0=1 セット（依頼受理を通知）
 *   3. DR_0=0 待機（CPU が初期化完了を通知）
 *   4. ACK_0=0 セット（初期化完了）
 *   5. DR_0 トグル待機 → DATA0 読み取り → ACK_0 トグル（1バイトずつ繰り返し）
 *   6. DR_0=0 待機、ACK_0=0 セット（完了）
 *
 * 送信フロー（initiateSend → transferBytesToCpu → finalizeSend）:
 *   1. ACK_1=0 確認
 *   2. INT_FLG=0 確認（割り込み処理中でないこと）
 *   3. INT_CAUSE=2（ハンドシェイク）セット
 *   4. REQ_1=1 セット → CPU 側の割り込み発生
 *   5. ACK_1=1 待機（依頼受理）
 *   6. DR_1=1 セット、REQ_1=0 セット
 *   7. ACK_1=0 待機（初期化完了）
 *   8. DATA1 セット → DR_1 トグル → ACK_1 トグル待機（1バイトずつ繰り返し）
 *   9. DR_1=0 セット、ACK_1=0 待機（完了）
 */

import {
  DEFAULT_TIMEOUT_MS,
  HandshakeBus,
  INT_CAUSE_CODE,
  waitCondition,
} from "./handshake_type";

export class IoControlHandshake {
  constructor(
    private readonly bus: HandshakeBus,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  // ─────────────────────────────────────────────
  // 公開 API
  // ─────────────────────────────────────────────

  /**
   * I/O -> CPU 方向でバイト列を送信する。
   * @param data 送信バイト列
   */
  async send(data: Uint8Array): Promise<void> {
    await this.initiateSend();
    await this.transferBytesToCpu(data);
    await this.finalizeSend();
  }

  /**
   * CPU -> I/O 方向のデータを受信する。
   * REQ_0 が 1 になるまで待機してから受信を開始する。
   * @param length 受信バイト数
   * @returns 受信バイト列
   */
  async receive(length: number): Promise<Uint8Array> {
    await this.waitForCpuRequest();
    const data = await this.receiveBytesFromCpu(length);
    await this.finalizeReceive();
    return data;
  }

  // ─────────────────────────────────────────────
  // 受信（CPU -> I/O）内部処理
  // ─────────────────────────────────────────────

  /** 割り込み待機：CPU からの初期化信号を受理して初期化シーケンスを実行 */
  private async waitForCpuRequest(): Promise<void> {
    // DR_0=1 になるまで待機
    // ※ CPU は REQ_0 をパルスで送出するためポーリングでは検出できない。
    //   DR_0=1 は ACK_0=1 を受け取るまで保持されるため、こちらで割り込みを検出する。
    await waitCondition(() => this.bus.DR_0 === 1, this.timeoutMs);

    // ACK_0 を 1 にセット（依頼受理を通知）
    this.bus.ACK_0 = 1;

    // CPU 側が DR_0 を 0 にセットするまで待機（初期化完了信号）
    await waitCondition(() => this.bus.DR_0 === 0, this.timeoutMs);

    // ACK_0 を 0 にセット（初期化完了）
    this.bus.ACK_0 = 0;
  }

  /**
   * データ受信：DR_0/ACK_0 をトリガーとして 1 バイトずつ受信する。
   * DR_0 と ACK_0 は 0->1, 1->0 を交互に繰り返す。
   */
  private async receiveBytesFromCpu(length: number): Promise<Uint8Array> {
    const data = new Uint8Array(length);
    let drExpected = 1; // 最初のトグルは 0->1

    for (let i = 0; i < length; i++) {
      // DR_0 がトグルするまで待機（CPU 側がデータをセット）
      await waitCondition(() => this.bus.DR_0 === drExpected, this.timeoutMs);

      // データを取り込む
      data[i] = this.bus.DATA0;

      // ACK_0 をトグル（取り込み完了を通知）
      this.bus.ACK_0 = drExpected;

      drExpected = drExpected === 1 ? 0 : 1;
    }

    return data;
  }

  /** ハンドシェイク完了：完了シーケンス */
  private async finalizeReceive(): Promise<void> {
    // CPU 側が DR_0 を 0 にセットするまで待機
    await waitCondition(() => this.bus.DR_0 === 0, this.timeoutMs);

    // ACK_0 を 0 にセット（完了処理）
    this.bus.ACK_0 = 0;
  }

  // ─────────────────────────────────────────────
  // 送信（I/O -> CPU）内部処理
  // ─────────────────────────────────────────────

  /** ハンドシェイク開始：初期化シーケンス */
  private async initiateSend(): Promise<void> {
    // ACK_1 が 0 であることを確認
    await waitCondition(() => this.bus.ACK_1 === 0, this.timeoutMs);

    // INT_FLG が 0 であることを確認（割り込み処理中でないこと）
    await waitCondition(() => this.bus.INT_FLG === 0, this.timeoutMs);

    // 割り込み要因をハンドシェイク(2) にセット
    this.bus.INT_CAUSE = INT_CAUSE_CODE.HANDSHAKE;

    // REQ_1 を 1 にセット → CPU 側に割り込み発生
    this.bus.REQ_1 = 1;

    // ACK_1 が 1 になるまで待機（CPU 側が依頼を受理）
    await waitCondition(() => this.bus.ACK_1 === 1, this.timeoutMs);

    // DR_1 を 1 にセット（初期化通知）
    this.bus.DR_1 = 1;

    // REQ_1 を 0 にセット（初期化）
    this.bus.REQ_1 = 0;

    // ACK_1 が 0 になるまで待機（CPU 側の初期化完了）
    await waitCondition(() => this.bus.ACK_1 === 0, this.timeoutMs);
  }

  /**
   * データ転送：DR_1/ACK_1 をトリガーとして 1 バイトずつ送信する。
   * DR_1 と ACK_1 は 0->1, 1->0 を交互に繰り返す。
   */
  private async transferBytesToCpu(data: Uint8Array): Promise<void> {
    let drNext = 1; // 最初のトグルは 0->1

    for (const byte of data) {
      // データをセット
      this.bus.DATA1 = byte;

      // DR_1 をトグル
      this.bus.DR_1 = drNext;

      // ACK_1 が同じ値になるまで待機（CPU 側がデータを取り込んだ）
      const ackExpected = drNext;
      await waitCondition(() => this.bus.ACK_1 === ackExpected, this.timeoutMs);

      drNext = drNext === 1 ? 0 : 1;
    }
  }

  /** ハンドシェイク完了：完了シーケンス */
  private async finalizeSend(): Promise<void> {
    // DR_1 を 0 にセット（完了処理）
    this.bus.DR_1 = 0;

    // CPU 側が ACK_1 を 0 にセットするまで待機
    await waitCondition(() => this.bus.ACK_1 === 0, this.timeoutMs);
  }
}
