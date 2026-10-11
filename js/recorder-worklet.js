/* かごしま ことばさんぽ — マイクの音をそのまま（無圧縮で）受け取る係。recorder.js から読みこまれます。 */
class KSCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.flush();
        this.port.postMessage({ done: true });
      }
    };
  }
  flush() {
    if (this.n > 0) {
      this.port.postMessage({ samples: this.buf.slice(0, this.n) });
      this.n = 0;
    }
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const a = input[0];
      const b = input.length > 1 ? input[1] : null;
      for (let i = 0; i < a.length; i++) {
        this.buf[this.n++] = b ? (a[i] + b[i]) * 0.5 : a[i];
        if (this.n === this.buf.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('ks-capture', KSCapture);
