/* かごしま ことばさんぽ — 録音（無圧縮のWAV・16ビット・モノラル） */
(function () {
  'use strict';
  var KS = window.KS = window.KS || {};
  var h = KS.h;

  var MIN_SEC = 0.4;        // これより短い録音は「押しまちがい」とみなす
  var SILENT_PEAK = 0.001;  // これより小さい音は「音が入っていない」とみなして、録り直してもらう
  var QUIET_PEAK = 0.02;    // これより小さい音は「小さすぎる」と知らせる
  var LOUD_PEAK = 0.985;    // これより大きい音は「割れているかも」と知らせる

  var NOISY_SNR_DB = 20;    // 声と、まわりの音の差（dB）がこれより小さいと「まわりの音が大きい」と知らせる（設定シートで変えられる）

  var activeCapture = null;   // いま録音中のもの
  var activeWidget = null;    // いま録音中（または準備中）の録音ボタン
  var player = null;          // 再生は1つだけ
  var playerOwner = null;

  KS.rec = { QUIET_PEAK: QUIET_PEAK, NOISY_SNR_DB: NOISY_SNR_DB };
  KS.rec.supported = function () {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (window.AudioContext || window.webkitAudioContext));
  };

  /* ---------- マイクの音をそのまま受け取る小さなプログラム（AudioWorklet） ----------
   * 通信なしで読みこめるよう、文字として持っておき、その場でファイルの形にして渡す。 */
  var WORKLET_SRC = [
    'class KSCapture extends AudioWorkletProcessor {',
    '  constructor() {',
    '    super();',
    '    this.buf = new Float32Array(2048);',
    '    this.n = 0;',
    '    this.port.onmessage = (e) => {',
    '      if (e.data === "flush") { this.flush(); this.port.postMessage({ done: true }); }',
    '    };',
    '  }',
    '  flush() {',
    '    if (this.n > 0) { this.port.postMessage({ samples: this.buf.slice(0, this.n) }); this.n = 0; }',
    '  }',
    '  process(inputs) {',
    '    const input = inputs[0];',
    '    if (input && input.length > 0) {',
    '      const a = input[0];',
    '      const b = input.length > 1 ? input[1] : null;',
    '      for (let i = 0; i < a.length; i++) {',
    '        this.buf[this.n++] = b ? (a[i] + b[i]) * 0.5 : a[i];',
    '        if (this.n === this.buf.length) this.flush();',
    '      }',
    '    }',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("ks-capture", KSCapture);'
  ].join('\n');
  var workletUrl = null;
  var workletBroken = false;    // 一度だめだった端末では、もう試さない
  function getWorkletUrl() {
    if (!workletUrl) workletUrl = window.URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    return workletUrl;
  }

  /* ---------- 音 → WAV ---------- */
  function encodeWav(chunks, total, sampleRate) {
    var buffer = new ArrayBuffer(44 + total * 2);
    var view = new DataView(buffer);
    function str(off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); view.setUint32(4, 36 + total * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, total * 2, true);
    var off = 44;
    for (var c = 0; c < chunks.length; c++) {
      var chunk = chunks[c];
      for (var i = 0; i < chunk.length; i++) {
        var s = chunk[i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        view.setInt16(off, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF), true);
        off += 2;
      }
    }
    return buffer;
  }

  /* ---------- 声と、まわりの音の大きさの差を見積もる ----------
   * 録音を 0.02 秒ずつに区切り、区切りごとの音の大きさをはかって、
   *   ・いちばん静かなあたり（静かなほうから3番目の区切り）… まわりの音（話していないあいだの音）
   *   ・大きいほうの区切りの大きさ                           … 声
   * とみなす。返すのは { noiseDb: まわりの音, speechDb: 声, snrDb: その差 }（dB）。
   * 差が小さいほど、声がまわりの音にうもれている。
   * 見積もれるのは、鳴りつづけている音（換気扇・エアコン・車など）。とつぜんの物音や、
   * ほかの人の話し声（テレビの声をふくむ）は、本人の声と区別できないので、ここでは拾えない。
   * 「まわりの音」を静かなほうの数区切りだけで決めるのは、話す前後の間がほとんどない録音でも、
   * 声を「まわりの音」と取りちがえないようにするため（静かな部屋なのに注意が出るのを防ぐ）。
   * まったくの無音（数字の上でゼロ）の区切りは、まわりの音ではなく、音がとぎれたところなので数えない。
   * そういう区切りが多い録音は、端末が話していないあいだの音を消しているので、まわりの音は見積もらない
   * （noiseDb と snrDb を返さない）。
   */
  function analyzeNoise(chunks, total, sampleRate) {
    var frame = Math.max(1, Math.round(sampleRate * 0.02));
    var all = [];
    var sum = 0, n = 0;
    for (var c = 0; c < chunks.length; c++) {
      var chunk = chunks[c];
      for (var i = 0; i < chunk.length; i++) {
        sum += chunk[i] * chunk[i];
        if (++n === frame) { all.push(sum / frame); sum = 0; n = 0; }
      }
    }
    var ZERO = 1e-9;                             // これより小さい区切りは「まったくの無音」（本物のマイクなら、静かな部屋でもこれより大きい）
    // 録りはじめ：まったくの無音（マイクが動き出す前）と、そのあとの 0.06 秒は、音が乱れることがあるので使わない
    var start = 0;
    while (start < all.length && all[start] < ZERO) start++;
    if (all.length - start >= 25) start += 3;
    var powers = [], dropped = 0;
    for (var j = start; j < all.length; j++) {
      if (all[j] < ZERO) dropped++; else powers.push(all[j]);
    }
    var len = powers.length;
    if (len < 15) return null;                   // 0.3 秒より短いと見積もれない
    powers.sort(function (a, b) { return a - b; });
    function db(p) { return 10 * Math.log(Math.max(p, 1e-10)) / Math.LN10; }
    function round1(v) { return Math.round(v * 10) / 10; }
    var noise = db(powers[Math.min(2, Math.floor(len * 0.1))]);
    // 声：いちばん大きい2区切りは、ボタンにふれる音などのことがあるので使わず、その次から最大10区切り（0.2秒ぶん）の平均をとる
    var top = len - 3;
    var ref = powers[top];
    var acc = 0, used = 0;
    for (var k = top; k >= 0 && used < 10; k--) {
      if (powers[k] < ref * 0.01) break;         // 3番目より 20dB 以上小さい区切りは、声の中心ではない
      acc += powers[k]; used++;
    }
    var speech = db(acc / used);
    var out = { speechDb: round1(speech) };
    if (dropped > (len + dropped) * 0.1) return out;          // 無音の区切りが1割をこえる：まわりの音は見積もれない
    out.noiseDb = round1(noise);
    if (speech > -70) out.snrDb = round1(speech - noise);     // ほとんど音のない録音では、差は出さない
    return out;
  }
  KS.rec.analyzeNoise = analyzeNoise;

  // その録音は、まわりの音が大きいか。threshold は目安の dB（0 なら、いつも「いいえ」）。指定がなければ、ふだんの目安を使う
  KS.rec.isNoisy = function (value, threshold) {
    var t = (typeof threshold === 'number' && isFinite(threshold)) ? threshold : NOISY_SNR_DB;
    return !!(value && t > 0 && typeof value.snrDb === 'number' && value.snrDb < t);
  };

  /* ---------- マイクから音を受け取る ---------- */
  // かならずボタンを押した処理の中から呼ぶこと（iPhone では、そうしないと音の処理が動き出さない）
  function startCapture() {
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC();
    function wake() {
      try {
        var r = (ctx.state !== 'running' && ctx.resume) ? ctx.resume() : null;
        if (r && r.then) r.then(null, function () { /* あとでもう一度ためす */ });
      } catch (e) { /* 何もしない */ }
    }
    wake();

    var stream = null, source = null, node = null, sink = null, track = null;
    var chunks = [], total = 0, peak = 0, stopped = false, usingWorklet = false;
    var flushDone = null, firstChunk = null, tailDone = null;
    var capture = { onlevel: null, oninterrupt: null, sampleRate: ctx.sampleRate };

    function push(samples) {
      if (stopped && !flushDone && !tailDone) return;
      var p = 0;
      for (var i = 0; i < samples.length; i++) { var a = samples[i] < 0 ? -samples[i] : samples[i]; if (a > p) p = a; }
      if (p > peak) peak = p;
      chunks.push(samples);
      total += samples.length;
      if (firstChunk) { var f = firstChunk; firstChunk = null; f(); }
      if (!stopped && capture.onlevel) capture.onlevel(p);
    }
    function cleanup() {
      try { if (track) { track.onended = null; track.onmute = null; } } catch (e) { /* 何もしない */ }
      try { if (source) source.disconnect(); } catch (e) { /* 何もしない */ }
      try { if (node) { node.disconnect(); node.onaudioprocess = null; if (node.port) node.port.onmessage = null; } } catch (e) { /* 何もしない */ }
      try { if (sink) sink.disconnect(); } catch (e) { /* 何もしない */ }
      try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 何もしない */ }
      try { if (ctx && ctx.state !== 'closed' && ctx.close) ctx.close(); } catch (e) { /* 何もしない */ }
      if (activeCapture === capture) activeCapture = null;
    }
    function useScriptProcessor() {
      usingWorklet = false;
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = function (e) {
        if (stopped && !tailDone) return;
        push(new Float32Array(e.inputBuffer.getChannelData(0)));
        if (tailDone) { var t = tailDone; tailDone = null; t(); }
      };
    }
    function setupNode() {
      if (workletBroken || !ctx.audioWorklet || !window.AudioWorkletNode) { useScriptProcessor(); return Promise.resolve(); }
      return new Promise(function (resolve) {
        var settled = false;
        // 読みこみに手間どったら待たずに、古い方式（ScriptProcessor）で録る
        var timer = window.setTimeout(function () { if (!settled) { settled = true; workletBroken = true; useScriptProcessor(); resolve(); } }, 2000);
        var p;
        try { p = ctx.audioWorklet.addModule(getWorkletUrl()); } catch (e) { p = Promise.reject(e); }
        p.then(function () {
          if (settled) return;
          settled = true; window.clearTimeout(timer);
          try {
            node = new window.AudioWorkletNode(ctx, 'ks-capture', {
              numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
              channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers'
            });
            node.port.onmessage = function (e) {
              if (e.data && e.data.samples) push(e.data.samples);
              else if (e.data && e.data.done && flushDone) flushDone();
            };
            usingWorklet = true;
          } catch (e2) { workletBroken = true; useScriptProcessor(); }
          resolve();
        }, function () {
          if (settled) return;
          settled = true; window.clearTimeout(timer);
          workletBroken = true; useScriptProcessor(); resolve();
        });
      });
    }

    capture.seconds = function () { return total / ctx.sampleRate; };
    capture.cancel = function () { stopped = true; flushDone = null; tailDone = null; firstChunk = null; cleanup(); };
    capture.stop = function () {
      if (stopped) return Promise.reject(new Error('すでに止まっています'));
      var settings = {}, label = '';
      try { settings = (track && track.getSettings) ? track.getSettings() : {}; } catch (e) { settings = {}; }
      try { label = String((track && track.label) || ''); } catch (e) { label = ''; }
      var flushed;
      if (usingWorklet) {
        // 受け取り係に残っている音を、最後まで出してもらう
        flushed = new Promise(function (resolve) {
          flushDone = resolve;
          try { node.port.postMessage('flush'); } catch (e) { resolve(); }
          window.setTimeout(resolve, 400);
        });
      } else {
        // 古い方式は音がまとめて届くので、次のひとかたまりが届くまで待つ（話しおわりが切れないように）
        flushed = new Promise(function (resolve) {
          tailDone = resolve;
          window.setTimeout(resolve, 300);
        });
      }
      stopped = true;
      return flushed.then(function () {
        flushDone = null; tailDone = null;
        var rate = ctx.sampleRate;
        cleanup();
        var levels = analyzeNoise(chunks, total, rate) || {};
        return {
          buffer: encodeWav(chunks, total, rate),
          sampleRate: rate,
          durationSec: Math.round((total / rate) * 100) / 100,
          peak: Math.round(peak * 10000) / 10000,
          snrDb: levels.snrDb,            // 声と、まわりの音の差（見積もり）。小さいほど、まわりがうるさい
          noiseDb: levels.noiseDb,        // まわりの音の大きさ（見積もり）
          echoCancellation: settings.echoCancellation === true,
          noiseSuppression: settings.noiseSuppression === true,
          autoGainControl: settings.autoGainControl === true,
          trackHz: (typeof settings.sampleRate === 'number' && settings.sampleRate !== rate) ? settings.sampleRate : undefined,
          // 機器の名前そのものは残さない（持ち主の名前が入っていることがあるため）。無線イヤホンらしいかどうかだけ残す
          input: /bluetooth|airpods|hands-?free|headset|ヘッドセット|ハンズフリー/i.test(label) ? 'bluetooth' : undefined
        };
      });
    };

    // 方言の音をそのまま残したいので、端末の自動補正（雑音除去・音量の自動調整など）は切るよう求める
    var want = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } };
    return navigator.mediaDevices.getUserMedia(want).then(function (s) {
      stream = s;
      track = s.getAudioTracks()[0] || null;
      wake();
      source = ctx.createMediaStreamSource(stream);
      sink = ctx.createGain();
      sink.gain.value = 0;                 // スピーカーからは出さない
      return setupNode();
    }).then(function () {
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      activeCapture = capture;
      if (track) {
        // 電話がかかってきた・マイクを抜いた などで録音が切れたら知らせる
        track.onended = function () { if (!stopped && capture.oninterrupt) capture.oninterrupt(); };
      }
      // 最初の音が届くまで待ってから「録音中」にする（話しはじめが切れないように）。
      // 2秒待っても音が届かなければ、音の処理を起こし直してもう2秒待ち、それでもだめなら失敗にする。
      return new Promise(function (resolve, reject) {
        firstChunk = resolve;
        window.setTimeout(function () {
          if (!firstChunk) return;
          wake();
          window.setTimeout(function () {
            if (!firstChunk) return;
            var err = new Error('音が届きません');
            err.name = 'NoAudioError';
            reject(err);
          }, 2000);
        }, 2000);
      });
    }).then(function () { firstChunk = null; return capture; }, function (err) { firstChunk = null; stopped = true; cleanup(); throw err; });
  }

  function micErrorMessage(err) {
    var name = (err && err.name) || '';
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      return 'マイクの使用が許可されませんでした。もう一度ボタンを押して、たずねられたら「許可」を選んでください。たずねられないときは、ブラウザの設定で、このサイトのマイクを「許可」にしてください。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      return 'マイクが見つかりませんでした。マイクのある端末でお試しください。';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError' || name === 'NoAudioError') {
      return 'マイクの音が届きませんでした。ほかのアプリがマイクを使っていないか確かめて、もう一度ボタンを押してください。';
    }
    return '録音をはじめられませんでした。もう一度ボタンを押してください。';
  }

  function stopPlayer() {
    if (player) { try { player.pause(); } catch (e) { /* 何もしない */ } }
    if (playerOwner) { var o = playerOwner; playerOwner = null; o._playingChanged(false); }
  }

  /* ---------- 録音ボタン（画面の部品） ---------- */
  // opt: { name: '回答' などの呼び名, maxSec, noiseWarnDb（まわりの音の注意を出す目安。0 なら出さない）, onchange(value|null), onerror(name) }
  KS.recorderWidget = function (opt) {
    opt = opt || {};
    var maxSec = opt.maxSec || 20;
    var state = 'idle';       // idle | starting | recording | finishing | done
    var value = null, url = null, capture = null, tick = null, startedAt = 0, levelRaf = null, lastLevel = 0;
    var destroyed = false;
    var attempt = 0;          // 何回目の「録音をはじめる」か（前の回の結果が、あとから届いても取りちがえないように）

    var btn = h('button', { type: 'button', class: 'rec__btn', onclick: onPress });
    var statusEl = h('p', { class: 'rec__status', 'aria-live': 'polite' });
    var timeEl = h('span', { class: 'rec__time' });
    var bars = [];
    for (var i = 0; i < 7; i++) bars.push(h('span', { class: 'rec__bar' }));
    var meter = h('div', { class: 'rec__meter', 'aria-hidden': 'true' }, bars);
    var playBtn = h('button', { type: 'button', class: 'chip chip--play', onclick: togglePlay });
    var redoBtn = h('button', { type: 'button', class: 'chip', onclick: redo }, h('span', { class: 'chip__icon', svg: KS.icons.redo }), h('span', { text: '録り直す' }));
    var playerRow = h('div', { class: 'rec__player' }, playBtn, redoBtn);
    var noteEl = h('p', { class: 'rec__note', role: 'status' });
    var el = h('div', { class: 'rec', 'data-state': 'idle' },
      btn,
      h('div', { class: 'rec__body' }, statusEl, h('div', { class: 'rec__live' }, meter, timeEl), playerRow),
      noteEl
    );

    function render() {
      el.setAttribute('data-state', state);
      var name = opt.name ? opt.name + 'の' : '';
      if (state === 'idle') {
        btn.innerHTML = KS.icons.mic; btn.disabled = false;
        btn.setAttribute('aria-label', name + '録音をはじめる');
        statusEl.textContent = 'ボタンを押して、発音してください';
      } else if (state === 'starting') {
        btn.innerHTML = KS.icons.mic; btn.disabled = true;
        btn.setAttribute('aria-label', '録音の準備中');
        statusEl.textContent = '準備しています…';
      } else if (state === 'recording') {
        btn.innerHTML = KS.icons.stop; btn.disabled = false;
        btn.setAttribute('aria-label', name + '録音を終える');
        statusEl.textContent = '録音中。終わったら、もう一度押してください';
      } else if (state === 'finishing') {
        btn.innerHTML = KS.icons.stop; btn.disabled = true;
        statusEl.textContent = '保存しています…';
      } else if (state === 'done') {
        btn.innerHTML = KS.icons.check; btn.disabled = true;
        btn.setAttribute('aria-label', name + '録音ずみ');
        statusEl.textContent = '録音できました（' + KS.fmtTime(value.durationSec) + '）';
        renderPlay(false);
      }
    }
    function renderPlay(playing) {
      playBtn.innerHTML = '';
      KS.append(playBtn, [h('span', { class: 'chip__icon', svg: playing ? KS.icons.pause : KS.icons.play }), h('span', { text: playing ? '止める' : '聞く' })]);
      playBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
    }
    function setNote(msg, kind) {
      noteEl.textContent = msg || '';
      noteEl.className = 'rec__note' + (msg ? ' rec__note--' + (kind || 'warn') : '');
    }
    function setState(s) { state = s; render(); }
    function changed() { if (opt.onchange) opt.onchange(value); }
    function clearMeter() {
      if (levelRaf) { window.cancelAnimationFrame(levelRaf); levelRaf = null; }
      lastLevel = 0;
      for (var i = 0; i < bars.length; i++) bars[i].className = 'rec__bar';
    }

    function drawLevel() {
      levelRaf = null;
      var n = Math.round(Math.min(1, Math.sqrt(lastLevel) * 1.6) * bars.length);
      for (var i = 0; i < bars.length; i++) bars[i].className = 'rec__bar' + (i < n ? ' rec__bar--on' : '');
      lastLevel *= 0.6;
    }

    function onPress() {
      if (destroyed) return;
      if (state === 'idle') start();
      else if (state === 'recording') finish(false);
    }

    // 録音の途中で画面が隠れた・マイクが切れたとき：その録音は使わず、録り直してもらう
    function interrupted() {
      if (destroyed || (state !== 'recording' && state !== 'starting')) return;
      window.clearInterval(tick); tick = null;
      if (capture) { capture.cancel(); capture = null; }
      if (activeWidget === api) activeWidget = null;
      clearMeter();
      setState('idle');
      setNote('録音がとちゅうで止まりました。もう一度ボタンを押して、録り直してください。', 'warn');
    }
    function onHidden() { if (document.hidden) interrupted(); }
    document.addEventListener('visibilitychange', onHidden);

    function start() {
      if (!KS.rec.supported()) {
        setNote('このブラウザでは録音できません。Safari か Chrome で開き直してください。LINE などのアプリの中で開いている場合は、メニューから「ブラウザで開く」を選んでください。', 'error');
        if (opt.onerror) opt.onerror('unsupported');
        return;
      }
      // マイクを2つ同時には開かない。ほかの録音ボタンが録音中なら、そちらを終えるだけにして、
      // こちらはもう一度押してもらう（押した処理の中で始めないと、iPhone では録音が動き出さないことがあるため）。
      if (activeWidget && activeWidget !== api) {
        if (activeWidget._isRecording()) {
          activeWidget._finish();
          setNote('さきほどの録音を終えました。こちらを録音するには、もう一度ボタンを押してください。', 'info');
        }
        return;
      }
      if (state !== 'idle') return;
      stopPlayer();
      setNote('');
      setState('starting');
      activeWidget = api;
      var my = ++attempt;
      var p;
      try { p = startCapture(); } catch (e) { p = Promise.reject(e); }
      p.then(function (cap) {
        if (destroyed || state !== 'starting' || my !== attempt) { cap.cancel(); return; }
        capture = cap;
        cap.onlevel = function (level) {
          if (level > lastLevel) lastLevel = level;
          if (!levelRaf) levelRaf = window.requestAnimationFrame(drawLevel);
        };
        cap.oninterrupt = interrupted;
        startedAt = Date.now();
        timeEl.textContent = '0:00';
        setState('recording');
        tick = window.setInterval(function () {
          var sec = (Date.now() - startedAt) / 1000;
          timeEl.textContent = KS.fmtTime(sec);
          if (sec >= maxSec) finish(true);
        }, 250);
      }, function (err) {
        if (destroyed || my !== attempt || state !== 'starting') return;
        if (activeWidget === api) activeWidget = null;
        setState('idle');
        setNote(micErrorMessage(err), 'error');
        if (opt.onerror) opt.onerror((err && err.name) || 'error');
      });
    }

    function finish(auto) {
      if (state !== 'recording' || !capture) return Promise.resolve();
      window.clearInterval(tick); tick = null;
      var wallSec = (Date.now() - startedAt) / 1000;
      setState('finishing');
      var cap = capture; capture = null;
      return cap.stop().then(function (result) {
        if (activeWidget === api) activeWidget = null;
        if (destroyed) return;
        clearMeter();
        if (result.durationSec < MIN_SEC) {
          setState('idle');
          setNote('録音が短すぎました。ボタンを押してから話し、話しおわってからもう一度押してください。', 'warn');
          return;
        }
        if (result.peak < SILENT_PEAK) {
          setState('idle');
          setNote('音が入っていませんでした。マイクがふさがれていないか確かめて、もう一度録音してください。', 'error');
          if (opt.onerror) opt.onerror('silent');
          return;
        }
        // 録れた長さが、ボタンを押していた時間よりずっと短いときは、とちゅうで音が切れている
        if (wallSec - result.durationSec > Math.max(0.6, wallSec * 0.15)) {
          setState('idle');
          setNote('録音がとぎれました。もう一度ボタンを押して、録り直してください。', 'warn');
          return;
        }
        value = result;
        url = window.URL.createObjectURL(new Blob([result.buffer], { type: 'audio/wav' }));
        setState('done');
        // 知らせは1つだけ出す。声が小さい → まわりがうるさい → 音が割れている の順に確かめる
        // （「割れている」は、ボタンにふれる音でもそう見えることがあるので、あとにする）
        if (result.peak < QUIET_PEAK) setNote('音がとても小さいようです。口を近づけて、録り直してみてください。', 'warn');
        else if (KS.rec.isNoisy(result, opt.noiseWarnDb)) setNote('まわりの音が大きいようです。静かな場所で、口を近づけて、録り直してみてください。', 'warn');
        else if (result.peak >= LOUD_PEAK) setNote('音が大きすぎて、割れているかもしれません。気になるときは、少しはなれて録り直してください。', 'warn');
        else if (auto) setNote(maxSec + '秒たったので、録音を終えました。', 'info');
        else setNote('');
        changed();
      }, function () {
        if (activeWidget === api) activeWidget = null;
        if (destroyed) return;
        clearMeter();
        setState('idle');
        setNote('録音を保存できませんでした。もう一度ボタンを押してください。', 'error');
      });
    }

    function togglePlay() {
      if (!url) return;
      if (playerOwner === api) { stopPlayer(); return; }
      if (activeWidget && activeWidget._isBusy()) return;     // 録音中は再生しない
      stopPlayer();
      if (!player) {
        player = new window.Audio();
        player.addEventListener('ended', stopPlayer);
        player.addEventListener('error', stopPlayer);
      }
      player.src = url;
      playerOwner = api;
      renderPlay(true);
      var p = player.play();
      if (p && p.then) p.then(null, function () { stopPlayer(); });
    }

    function redo() {
      if (playerOwner === api) stopPlayer();
      if (url) { window.URL.revokeObjectURL(url); url = null; }
      value = null;
      setNote('');
      setState('idle');
      changed();
      btn.focus();
    }

    var api = {
      el: el,
      getValue: function () { return value; },
      isBusy: function () { return state === 'starting' || state === 'recording' || state === 'finishing'; },
      focus: function () { btn.focus(); },
      markMissing: function (on) { el.classList.toggle('rec--missing', !!on); },
      destroy: function () {
        destroyed = true;
        document.removeEventListener('visibilitychange', onHidden);
        window.clearInterval(tick);
        if (levelRaf) window.cancelAnimationFrame(levelRaf);
        if (capture) { capture.cancel(); capture = null; }
        if (activeWidget === api) activeWidget = null;
        if (playerOwner === api) stopPlayer();
        if (url) { window.URL.revokeObjectURL(url); url = null; }
      },
      _isRecording: function () { return state === 'recording'; },
      _isBusy: function () { return state === 'starting' || state === 'recording' || state === 'finishing'; },
      _finish: function () { return finish(false); },
      _playingChanged: function (playing) { if (state === 'done') renderPlay(playing); }
    };
    render();
    return api;
  };

  // 画面を閉じる・切りかえるとき：録音中のものを止める
  KS.rec.stopAll = function () {
    if (activeCapture) { try { activeCapture.cancel(); } catch (e) { /* 何もしない */ } activeCapture = null; }
    activeWidget = null;
    stopPlayer();
  };
})();
