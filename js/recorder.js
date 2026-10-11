/* かごしま ことばさんぽ — 録音（無圧縮のWAV・16ビット・モノラル） */
(function () {
  'use strict';
  var KS = window.KS = window.KS || {};
  var h = KS.h;

  var WORKLET_URL = 'js/recorder-worklet.js?v=1';
  var MIN_SEC = 0.4;        // これより短い録音は「押しまちがい」とみなす
  var QUIET_PEAK = 0.02;    // これより小さい音は「小さすぎる」と知らせる
  var LOUD_PEAK = 0.985;    // これより大きい音は「割れているかも」と知らせる

  var activeCapture = null;   // いま録音中のもの
  var activeWidget = null;
  var player = null;          // 再生は1つだけ
  var playerOwner = null;

  KS.rec = {};
  KS.rec.supported = function () {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (window.AudioContext || window.webkitAudioContext));
  };

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

  /* ---------- マイクから音を受け取る ---------- */
  // かならずボタンを押した処理の中から呼ぶこと（iPhone では、そうしないと音の処理が動き出さない）
  function startCapture() {
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC();
    var resumed = Promise.resolve();
    try {
      var r = ctx.state === 'suspended' && ctx.resume ? ctx.resume() : null;
      if (r && r.then) resumed = r.then(null, function () { /* あとでもう一度ためす */ });
    } catch (e) { /* 何もしない */ }

    var stream = null, source = null, node = null, sink = null, track = null;
    var chunks = [], total = 0, peak = 0, stopped = false, usingWorklet = false;
    var flushDone = null, firstChunk = null;
    var capture = { onlevel: null, sampleRate: ctx.sampleRate, seconds: function () { return total / ctx.sampleRate; } };

    function push(samples) {
      if (stopped && !flushDone) return;
      var p = 0;
      for (var i = 0; i < samples.length; i++) { var a = samples[i] < 0 ? -samples[i] : samples[i]; if (a > p) p = a; }
      if (p > peak) peak = p;
      chunks.push(samples);
      total += samples.length;
      if (firstChunk) { firstChunk(); firstChunk = null; }
      if (capture.onlevel) capture.onlevel(p);
    }
    function cleanup() {
      try { if (source) source.disconnect(); } catch (e) { /* 何もしない */ }
      try { if (node) { node.disconnect(); node.onaudioprocess = null; if (node.port) node.port.onmessage = null; } } catch (e) { /* 何もしない */ }
      try { if (sink) sink.disconnect(); } catch (e) { /* 何もしない */ }
      try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 何もしない */ }
      try { if (ctx && ctx.state !== 'closed' && ctx.close) ctx.close(); } catch (e) { /* 何もしない */ }
      if (activeCapture === capture) activeCapture = null;
    }
    function useScriptProcessor() {
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = function (e) { if (!stopped) push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    }
    function setupNode() {
      if (ctx.audioWorklet && window.AudioWorkletNode && window.location.protocol !== 'file:') {
        return ctx.audioWorklet.addModule(WORKLET_URL).then(function () {
          node = new window.AudioWorkletNode(ctx, 'ks-capture', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
            channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers'
          });
          node.port.onmessage = function (e) {
            if (e.data && e.data.samples) push(e.data.samples);
            else if (e.data && e.data.done && flushDone) flushDone();
          };
          usingWorklet = true;
        }).then(null, function () { usingWorklet = false; useScriptProcessor(); });
      }
      useScriptProcessor();
      return Promise.resolve();
    }

    capture.cancel = function () { stopped = true; cleanup(); };
    capture.stop = function () {
      if (stopped) return Promise.reject(new Error('すでに止まっています'));
      stopped = true;
      var settings = {};
      try { settings = (track && track.getSettings) ? track.getSettings() : {}; } catch (e) { settings = {}; }
      var flushed = usingWorklet ? new Promise(function (resolve) {
        flushDone = resolve;
        try { node.port.postMessage('flush'); } catch (e) { resolve(); }
        window.setTimeout(resolve, 400);
      }) : Promise.resolve();
      return flushed.then(function () {
        flushDone = null;
        var rate = ctx.sampleRate;
        cleanup();
        return {
          buffer: encodeWav(chunks, total, rate),
          sampleRate: rate,
          durationSec: Math.round((total / rate) * 100) / 100,
          peak: Math.round(peak * 1000) / 1000,
          echoCancellation: settings.echoCancellation === true,
          noiseSuppression: settings.noiseSuppression === true,
          autoGainControl: settings.autoGainControl === true
        };
      });
    };

    // 方言の音をそのまま残したいので、端末の自動補正（雑音除去・音量の自動調整など）は切るよう求める
    var want = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } };
    return navigator.mediaDevices.getUserMedia(want).then(function (s) {
      stream = s;
      track = s.getAudioTracks()[0] || null;
      return resumed;
    }).then(function () {
      if (ctx.state === 'suspended' && ctx.resume) { try { ctx.resume(); } catch (e) { /* 何もしない */ } }
      source = ctx.createMediaStreamSource(stream);
      sink = ctx.createGain();
      sink.gain.value = 0;                 // スピーカーからは出さない
      return setupNode();
    }).then(function () {
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      activeCapture = capture;
      // 最初の音が届くまで待ってから「録音中」にする（話しはじめが切れないように）。
      // 2秒待っても音が届かなければ、音の処理を起こし直してもう2秒待ち、それでもだめなら失敗にする。
      return new Promise(function (resolve, reject) {
        firstChunk = resolve;
        window.setTimeout(function () {
          if (!firstChunk) return;
          try { if (ctx.resume) ctx.resume(); } catch (e) { /* 何もしない */ }
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
      return 'マイクの使用が許可されていません。ブラウザの設定で、このサイトのマイクを「許可」にしてから、もう一度ボタンを押してください。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      return 'マイクが見つかりませんでした。マイクのある端末でお試しください。';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError' || name === 'NoAudioError') {
      return 'マイクを使えませんでした。ほかのアプリがマイクを使っていないか確かめて、もう一度ボタンを押してください。';
    }
    return '録音をはじめられませんでした。もう一度ボタンを押してください。';
  }

  function stopPlayer() {
    if (player) { try { player.pause(); } catch (e) { /* 何もしない */ } }
    if (playerOwner) { var o = playerOwner; playerOwner = null; o._playingChanged(false); }
  }

  /* ---------- 録音ボタン（画面の部品） ---------- */
  // opt: { name: '回答' などの呼び名, maxSec, onchange(value|null) }
  KS.recorderWidget = function (opt) {
    opt = opt || {};
    var maxSec = opt.maxSec || 30;
    var state = 'idle';       // idle | starting | recording | finishing | done
    var value = null, url = null, capture = null, tick = null, startedAt = 0, levelRaf = null, lastLevel = 0;
    var destroyed = false;

    var btn = h('button', { type: 'button', class: 'rec__btn', onclick: onPress });
    var statusEl = h('p', { class: 'rec__status', 'aria-live': 'polite' });
    var timeEl = h('span', { class: 'rec__time' });
    var bars = [];
    for (var i = 0; i < 7; i++) bars.push(h('span', { class: 'rec__bar' }));
    var meter = h('div', { class: 'rec__meter', 'aria-hidden': 'true' }, bars);
    var playBtn = h('button', { type: 'button', class: 'chip chip--play', onclick: togglePlay });
    var redoBtn = h('button', { type: 'button', class: 'chip', onclick: redo }, h('span', { class: 'chip__icon', svg: KS.icons.redo }), '録り直す');
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
      KS.append(playBtn, [h('span', { class: 'chip__icon', svg: playing ? KS.icons.pause : KS.icons.play }), playing ? '止める' : '聞く']);
      playBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
    }
    function setNote(msg, kind) {
      noteEl.textContent = msg || '';
      noteEl.className = 'rec__note' + (msg ? ' rec__note--' + (kind || 'warn') : '');
    }
    function setState(s) { state = s; render(); }
    function changed() { if (opt.onchange) opt.onchange(value); }

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

    function start() {
      if (!KS.rec.supported()) {
        setNote('このブラウザでは録音できません。Safari か Chrome で開き直してください。LINE などのアプリの中で開いている場合は、右上のメニューから「ブラウザで開く」を選んでください。', 'error');
        if (opt.onerror) opt.onerror('unsupported');
        return;
      }
      stopPlayer();
      setNote('');
      var begin = function () {
        setState('starting');
        var p;
        try { p = startCapture(); } catch (e) { p = Promise.reject(e); }
        p.then(function (cap) {
          if (destroyed || state !== 'starting') { cap.cancel(); return; }
          capture = cap;
          activeWidget = api;
          cap.onlevel = function (level) {
            if (level > lastLevel) lastLevel = level;
            if (!levelRaf) levelRaf = window.requestAnimationFrame(drawLevel);
          };
          startedAt = Date.now();
          timeEl.textContent = '0:00';
          setState('recording');
          tick = window.setInterval(function () {
            var sec = (Date.now() - startedAt) / 1000;
            timeEl.textContent = KS.fmtTime(sec);
            if (sec >= maxSec) finish(true);
          }, 250);
        }, function (err) {
          if (destroyed) return;
          setState('idle');
          setNote(micErrorMessage(err), 'error');
          if (opt.onerror) opt.onerror((err && err.name) || 'error');
        });
      };
      // ほかの録音ボタンが録音中なら、先にそれを終える
      if (activeWidget && activeWidget !== api && activeWidget._isRecording()) activeWidget._finish().then(begin, begin);
      else begin();
    }

    function finish(auto) {
      if (state !== 'recording' || !capture) return Promise.resolve();
      window.clearInterval(tick); tick = null;
      setState('finishing');
      var cap = capture; capture = null;
      if (activeWidget === api) activeWidget = null;
      return cap.stop().then(function (result) {
        if (destroyed) return;
        for (var i = 0; i < bars.length; i++) bars[i].className = 'rec__bar';
        if (result.durationSec < MIN_SEC) {
          setState('idle');
          setNote('録音が短すぎました。ボタンを押してから話し、話しおわってからもう一度押してください。', 'warn');
          return;
        }
        value = result;
        url = window.URL.createObjectURL(new Blob([result.buffer], { type: 'audio/wav' }));
        setState('done');
        if (result.peak < QUIET_PEAK) setNote('音がとても小さいようです。「聞く」で確かめて、聞こえにくければ、口を近づけて録り直してください。', 'warn');
        else if (result.peak >= LOUD_PEAK) setNote('音が大きすぎて、割れているかもしれません。「聞く」で確かめて、気になるときは少しはなれて録り直してください。', 'warn');
        else if (auto) setNote(maxSec + '秒たったので、録音を終えました。', 'info');
        else setNote('');
        changed();
      }, function () {
        if (destroyed) return;
        setState('idle');
        setNote('録音を保存できませんでした。もう一度ボタンを押してください。', 'error');
      });
    }

    function togglePlay() {
      if (!url) return;
      if (playerOwner === api) { stopPlayer(); return; }
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
        window.clearInterval(tick);
        if (levelRaf) window.cancelAnimationFrame(levelRaf);
        if (capture) { capture.cancel(); capture = null; }
        if (activeWidget === api) activeWidget = null;
        if (playerOwner === api) stopPlayer();
        if (url) { window.URL.revokeObjectURL(url); url = null; }
      },
      _isRecording: function () { return state === 'recording'; },
      _finish: function () { return finish(false); },
      _playingChanged: function (playing) { if (state === 'done') renderPlay(playing); }
    };
    render();
    return api;
  };

  // 画面を閉じる・切りかえるとき：録音中のものを止める
  KS.rec.stopAll = function () {
    if (activeCapture) { try { activeCapture.cancel(); } catch (e) { /* 何もしない */ } activeCapture = null; }
    stopPlayer();
  };
})();
