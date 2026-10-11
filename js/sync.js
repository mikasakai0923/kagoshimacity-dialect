/* かごしま ことばさんぽ — 回答を端末にとっておき、うしろで保存先へ送る係 */
(function () {
  'use strict';
  var KS = window.KS = window.KS || {};

  var running = false;
  var timer = null;
  var tries = 0;
  var status = { pending: 0, failed: 0, state: 'idle', message: '' };   // state: idle | sending | waiting | blocked
  var WAITS = [3000, 8000, 20000, 60000, 120000];

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
    var out = {};
    for (var k in item) if (k !== 'audio' && k !== 'failed' && k !== 'error' && k !== 'createdAt') out[k] = item[k];
    var audio = item.audio || [];
    return Promise.all(audio.map(function (a) {
      return toBase64(a.buffer).then(function (b64) {
        return {
          slot: a.slot, b64: b64, sampleRate: a.sampleRate, durationSec: a.durationSec, peak: a.peak,
          echoCancellation: a.echoCancellation, noiseSuppression: a.noiseSuppression, autoGainControl: a.autoGainControl
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
      setStatus({ pending: list.length - failed, failed: failed });
      return list;
    });
  }

  function step() {
    var session = KS.state && KS.state.session;
    if (!session) { running = false; setStatus({ state: 'idle', pending: 0, failed: 0 }); return; }
    refreshCounts().then(function (list) {
      var next = null;
      for (var i = 0; i < list.length; i++) if (!list[i].failed) { next = list[i]; break; }
      if (!next) { running = false; tries = 0; setStatus({ state: 'idle', message: '' }); return null; }
      setStatus({ state: 'sending', message: '' });
      return toPayload(next).then(function (payload) {
        return KS.api.save(session.token, payload);
      }).then(function () {
        return KS.db.remove(next.sid);
      }).then(function () {
        tries = 0;
        KS.bus.emit('synced', { sid: next.sid, itemId: next.itemId });
        step();
      });
    }).catch(function (err) {
      running = false;
      var code = err && err.code;
      if (code === 'auth' || code === 'disabled' || code === 'closed') {
        setStatus({ state: 'blocked', message: (err && err.message) || '' });
        KS.bus.emit('sync-blocked', err);
        return;
      }
      if (code === 'bad_request' || code === 'too_large') {
        // この回答は何度送っても通らない。列を止めないよう「送れなかった」しるしをつけて次へ進む
        KS.db.all().then(function (items) {
          var list = mine(items), bad = null;
          for (var i = 0; i < list.length; i++) if (!list[i].failed) { bad = list[i]; break; }
          if (!bad) return null;
          bad.failed = true; bad.error = (err && err.message) || '';
          return KS.db.put(bad);
        }).then(function () { KS.sync.kick(); });
        return;
      }
      tries++;
      var wait = WAITS[Math.min(tries - 1, WAITS.length - 1)];
      setStatus({ state: 'waiting', message: (err && err.message) || '' });
      window.clearTimeout(timer);
      timer = window.setTimeout(KS.sync.kick, wait);
    });
  }

  KS.sync = {
    status: function () { return { pending: status.pending, failed: status.failed, state: status.state, message: status.message }; },

    // 回答を端末にとっておき、送信をはじめる
    enqueue: function (item) {
      item.createdAt = Date.now();
      return KS.db.put(item).then(function () {
        return refreshCounts();
      }).then(function () { KS.sync.kick(); });
    },

    kick: function () {
      window.clearTimeout(timer);
      if (running) return;
      if (!(KS.state && KS.state.session)) { refreshCounts(); return; }
      running = true;
      step();
    },

    // 「送れなかった」しるしを外して、もう一度ためす
    retryFailed: function () {
      return KS.db.all().then(function (items) {
        return Promise.all(mine(items).filter(function (i) { return i.failed; }).map(function (i) {
          i.failed = false; i.error = '';
          return KS.db.put(i);
        }));
      }).then(function () { tries = 0; KS.sync.kick(); });
    },

    // まだ送っていない回答の設問ID（この端末・この参加者）
    pendingItemIds: function () {
      return KS.db.all().then(function (items) { return mine(items).map(function (i) { return i.itemId; }); });
    },

    reset: function () { window.clearTimeout(timer); running = false; tries = 0; status = { pending: 0, failed: 0, state: 'idle', message: '' }; }
  };

  window.addEventListener('online', function () { tries = 0; KS.sync.kick(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) KS.sync.kick(); });
})();
