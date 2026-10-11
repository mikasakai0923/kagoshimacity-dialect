/* かごしま ことばさんぽ — 回答を端末にとっておき、うしろで保存先へ送る係 */
(function () {
  'use strict';
  var KS = window.KS = window.KS || {};

  var running = false;
  var gen = 0;              // ログアウトなどで仕切り直したら増える。古い送信の続きを止めるため
  var timer = null;
  var streak = 0;           // 続けて失敗した回数（待ち時間を決める）
  // state: idle（送るものなし） | sending（送信中） | retrying（失敗のあとの送り直し中） | waiting（次の送り直しまで待機） | blocked（ログインし直しが必要）
  var status = { pending: 0, failed: 0, volatile: 0, state: 'idle', message: '' };
  var WAITS = [3000, 8000, 20000, 60000, 120000];
  var LOCAL_KEYS = { audio: 1, failed: 1, error: 1, createdAt: 1, tries: 1, sid: 1 };
  var delivered = {};       // この画面を開いてから保存先に届いた送信ID
  var deliveredList = [];
  function markDelivered(sid) {
    if (delivered[sid]) return;
    delivered[sid] = true;
    deliveredList.push(sid);
    if (deliveredList.length > 200) delete delivered[deliveredList.shift()];
  }

  function setStatus(patch) {
    var changed = false;
    for (var k in patch) if (status[k] !== patch[k]) { status[k] = patch[k]; changed = true; }
    if (changed) KS.bus.emit('sync', KS.sync.status());
  }

  function toBase64(buffer) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || '');
        resolve(s.slice(s.indexOf(',') + 1));
      };
      fr.onerror = function () { reject(fr.error || new Error('録音を読めませんでした')); };
      fr.readAsDataURL(new Blob([buffer], { type: 'audio/wav' }));
    });
  }

  // 端末にとってある形 → 送る形（録音を文字に直す）
  function toPayload(item) {
    var out = { submissionId: item.sid };
    for (var k in item) if (Object.prototype.hasOwnProperty.call(item, k) && !LOCAL_KEYS[k]) out[k] = item[k];
    var audio = item.audio || [];
    return Promise.all(audio.map(function (a) {
      return toBase64(a.buffer).then(function (b64) {
        return {
          slot: a.slot, b64: b64, sampleRate: a.sampleRate, durationSec: a.durationSec, peak: a.peak,
          echoCancellation: a.echoCancellation, noiseSuppression: a.noiseSuppression, autoGainControl: a.autoGainControl,
          trackHz: a.trackHz, input: a.input
        };
      });
    })).then(function (list) { out.audio = list; return out; });
  }

  function mine(items) {
    var session = KS.state && KS.state.session;
    if (!session) return [];
    return items.filter(function (i) { return i.participant === session.id; });
  }

  function refreshCounts() {
    return KS.db.all().then(function (items) {
      var list = mine(items);
      var failed = list.filter(function (i) { return i.failed; }).length;
      setStatus({ pending: list.length - failed, failed: failed, volatile: KS.db.volatileCount() });
      return list;
    });
  }

  // 次に送るもの：失敗の少ないもの → 古いもの の順（1件がつまずいても、ほかの回答が待たされないように）
  function pick(list) {
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (it.failed) continue;
      if (!best || (it.tries || 0) < (best.tries || 0) || ((it.tries || 0) === (best.tries || 0) && (it.createdAt || 0) < (best.createdAt || 0))) best = it;
    }
    return best;
  }

  function step(myGen) {
    var session = KS.state && KS.state.session;
    if (myGen !== gen) return;
    if (!session) { running = false; setStatus({ state: 'idle', pending: 0, failed: 0, volatile: 0 }); return; }
    var current = null;
    refreshCounts().then(function (list) {
      if (myGen !== gen) return null;
      current = pick(list);
      if (!current) { running = false; streak = 0; setStatus({ state: 'idle', message: '' }); return null; }
      // 失敗が続いているあいだは「送信中」とは見せない（画面の表示が、送り直しのたびに切りかわらないように）
      if (streak > 0) setStatus({ state: 'retrying' });
      else setStatus({ state: 'sending', message: '' });
      return toPayload(current).then(function (payload) {
        return KS.api.save(session.token, payload).then(function (res) {
          // 送った録音の本数と、保存された本数が合っているかを確かめてから、端末の控えを消す
          if (res && res.duplicate !== true && typeof res.audio === 'number' && res.audio !== payload.audio.length) {
            throw new KS.ApiError('server_error', '録音が保存先に届きませんでした。自動的に送り直します。');
          }
          return res;
        });
      }).then(function () {
        if (myGen !== gen) return null;
        return KS.db.remove(current.sid);
      }).then(function () {
        if (myGen !== gen) return;
        streak = 0;
        markDelivered(current.sid);
        KS.bus.emit('synced', { sid: current.sid, itemId: current.itemId });
        step(myGen);
      });
    }).then(null, function (err) {
      if (myGen !== gen) return;
      running = false;
      var code = err && err.code;
      var message = (err && err.message) || '';
      if (code === 'auth' || code === 'disabled' || code === 'closed') {
        setStatus({ state: 'blocked', message: message });
        KS.bus.emit('sync-failed', { sid: current && current.sid, code: code, message: message, final: true });
        KS.bus.emit('sync-blocked', err);
        return;
      }
      if (!current) {            // 送るものを取り出す前の失敗
        setStatus({ state: 'waiting', message: message });
        window.clearTimeout(timer);
        timer = window.setTimeout(KS.sync.kick, 5000);
        return;
      }
      if (code === 'bad_request' || code === 'too_large') {
        // この回答は何度送っても通らない。「送れなかった」しるしをつけて、ほかの回答を先に送る
        current.failed = true; current.error = message;
        KS.bus.emit('sync-failed', { sid: current.sid, code: code, message: message, final: true });
        KS.db.put(current).then(function () { KS.sync.kick(); });
        return;
      }
      // 通信の失敗など：回数を記録して、少し待ってからやり直す
      current.tries = (current.tries || 0) + 1;
      streak++;
      var wait = WAITS[Math.min(streak - 1, WAITS.length - 1)];
      setStatus({ state: 'waiting', message: message });
      KS.bus.emit('sync-failed', { sid: current.sid, code: code || 'error', message: message, final: false });
      KS.db.put(current).then(function () {
        if (myGen !== gen) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(KS.sync.kick, wait);
      });
    });
  }

  KS.sync = {
    status: function () {
      return { pending: status.pending, failed: status.failed, volatile: status.volatile, state: status.state, message: status.message };
    },

    // 回答をとっておき、送信をはじめる。端末に保存できたかどうかを返す（{persisted: true|false}）
    enqueue: function (item) {
      item.createdAt = Date.now();
      var saved;
      return KS.db.put(item).then(function (res) {
        saved = res;
        return refreshCounts();
      }).then(function () {
        KS.sync.kick();
        return saved;
      });
    },

    kick: function () {
      window.clearTimeout(timer);
      if (running) return;
      if (!(KS.state && KS.state.session)) { refreshCounts(); return; }
      running = true;
      step(gen);
    },

    // その回答は、もう保存先に届いているか（この画面を開いてからの分）
    isDelivered: function (sid) { return delivered[sid] === true; },

    // その回答が保存先に届くまで待つ。
    // 通信の失敗などで「あとで自動的に送り直す」ときは、opt.onRetry を呼んで待ちつづける（onRetry がなければ reject）。
    // 何度送っても通らないとき・ログインし直しが必要なとき・取り消されたときは reject。
    waitFor: function (sid, opt) {
      opt = opt || {};
      if (delivered[sid] === true) return Promise.resolve();
      return new Promise(function (resolve, reject) {
        var offs = [], timer2 = null;
        function done(fn, arg) { offs.forEach(function (off) { off(); }); window.clearTimeout(timer2); fn(arg); }
        offs.push(KS.bus.on('synced', function (e) { if (e.sid === sid) done(resolve); }));
        offs.push(KS.bus.on('sync-failed', function (e) {
          if (e.sid !== sid) return;
          if (!e.final && opt.onRetry) { opt.onRetry(e); return; }
          done(reject, new KS.ApiError(e.code, e.message));
        }));
        offs.push(KS.bus.on('sync-dropped', function (e) {
          if (!e || !e.sid || e.sid === sid) done(reject, new KS.ApiError('stale', ''));
        }));
        if (opt.timeoutMs) timer2 = window.setTimeout(function () { done(reject, new KS.ApiError('timeout', '送信に時間がかかっています。')); }, opt.timeoutMs);
      });
    },

    // とっておいた回答を取り消す（内容を直して出し直すとき）
    discard: function (sid) {
      return KS.db.remove(sid).then(function () {
        KS.bus.emit('sync-dropped', { sid: sid });
        return refreshCounts();
      });
    },

    // 「送れなかった」しるしを外して、もう一度ためす
    retryFailed: function () {
      return KS.db.all().then(function (items) {
        return Promise.all(mine(items).filter(function (i) { return i.failed || i.tries; }).map(function (i) {
          i.failed = false; i.error = ''; i.tries = 0;
          return KS.db.put(i);
        }));
      }).then(function () { streak = 0; KS.sync.kick(); });
    },

    // まだ送っていない回答の設問ID（この端末・この参加者）
    pendingItemIds: function () {
      return KS.db.all().then(function (items) { return mine(items).map(function (i) { return i.itemId; }); });
    },

    reset: function () {
      gen++;
      window.clearTimeout(timer);
      running = false; streak = 0;
      status = { pending: 0, failed: 0, volatile: 0, state: 'idle', message: '' };
      KS.bus.emit('sync-dropped', {});          // 届くのを待っていたものがあれば、待つのをやめる
    }
  };

  window.addEventListener('online', function () { streak = 0; KS.sync.kick(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) KS.sync.kick(); });
})();
