/* かごしま ことばさんぽ — 保存先（Google 側）とのやりとり */
(function () {
  'use strict';
  var KS = window.KS = window.KS || {};

  KS.ApiError = function (code, message) {
    this.name = 'ApiError';
    this.code = code;
    this.message = message || '';
  };
  KS.ApiError.prototype = Object.create(Error.prototype);

  var cfg = window.KS_CONFIG || {};
  var apiUrl = String(cfg.apiUrl || '').trim();
  // 保存先として受けつけるのは Apps Script のウェブアプリだけ（書きまちがいで、回答を別の場所へ送らないため）。
  // localhost は開発・テスト用。
  if (apiUrl && !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(apiUrl) &&
      !/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(apiUrl)) {
    if (window.console) console.warn('config.js の apiUrl が Apps Script のURL（https://script.google.com/macros/s/…/exec）ではないため、お試しモードで動かします。');
    apiUrl = '';
  }
  var forceDemo = /[?&]demo(=1|&|$)/.test(window.location.search);
  var demo = !apiUrl || forceDemo;

  var NET_MSG = '通信できませんでした。電波のよい場所で、もう一度お試しください。';

  /* ---------- 本番：Apps Script のウェブアプリ ---------- */
  function post(payload, timeoutMs) {
    var ctrl = window.AbortController ? new window.AbortController() : null;
    var timer = window.setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 30000);
    // Content-Type を text/plain にするのは、ブラウザの「事前確認」を出さないため（Apps Script は事前確認に答えない）
    return window.fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new KS.ApiError('http_' + res.status, NET_MSG);
      return res.text();
    }).then(function (text) {
      var data;
      try { data = JSON.parse(text); }
      catch (e) { throw new KS.ApiError('bad_response', '保存先から正しい返事がありませんでした。時間をおいて、もう一度お試しください。'); }
      if (!data || data.ok !== true) {
        throw new KS.ApiError((data && data.error) || 'server_error', (data && data.message) || '保存先でエラーが起きました。');
      }
      return data;
    }).then(function (data) {
      window.clearTimeout(timer);
      return data;
    }, function (err) {
      window.clearTimeout(timer);
      if (err instanceof KS.ApiError) throw err;
      throw new KS.ApiError(err && err.name === 'AbortError' ? 'timeout' : 'network', NET_MSG);
    });
  }

  var live = {
    login: function (id, password) { return post({ action: 'login', id: id, password: password }, 30000); },
    bootstrap: function (token) { return post({ action: 'bootstrap', token: token }, 45000); },
    save: function (token, submission) { return post({ action: 'save', token: token, submission: submission }, 120000); }
  };

  /* ---------- お試しモード：どこにも送らず、この端末の中だけで動く ---------- */
  function later(fn, ms) {
    return new Promise(function (resolve, reject) {
      window.setTimeout(function () { try { resolve(fn()); } catch (e) { reject(e); } }, ms || 350);
    });
  }
  var demoApi = {
    login: function (id, password) {
      return later(function () {
        if (!KS.norm(id) || !KS.norm(password)) throw new KS.ApiError('bad_credentials', '参加者ナンバーとパスワードを入れてください。');
        return { ok: true, token: 'demo', participant: { id: KS.normId(id) }, expiresAt: Date.now() + 30 * 86400000 };
      });
    },
    bootstrap: function () {
      return later(function () {
        var d = KS.DEMO;
        return { ok: true, settings: d.settings, steps: d.steps, items: d.items, progress: KS.store.get('demo:progress', {}), serverTime: Date.now() };
      }, 250);
    },
    save: function (token, s) {
      return later(function () {
        var rows = KS.store.get('demo:answers', []);
        var audio = s.audio || [];
        rows.push({
          at: new Date().toISOString(), participant: s.participant, step: s.step, itemId: s.itemId, type: s.type, prompt: s.prompt,
          status: s.status, answer: s.answer, segPrompt: s.segPrompt, segAnswer: s.segAnswer, exampleAnswer: s.exampleAnswer, note: s.note,
          audio1: audio[0] ? '（お試しモードでは保存しません）' : '', audio2: audio[1] ? '（お試しモードでは保存しません）' : '',
          noAudioReason: s.noAudioReason, durationSec: audio[0] ? audio[0].durationSec : '', sampleRate: audio[0] ? audio[0].sampleRate : '',
          elapsedSec: s.elapsedSec, device: s.device, clientTime: s.clientTime, sid: s.sid
        });
        KS.store.set('demo:answers', rows.slice(-500));
        var p = KS.store.get('demo:progress', {});
        p[s.itemId] = { status: s.status, at: Date.now(), count: ((p[s.itemId] && p[s.itemId].count) || 0) + 1 };
        KS.store.set('demo:progress', p);
        return { ok: true, sid: s.sid, saved: true };
      }, 500);
    }
  };

  KS.api = demo ? demoApi : live;
  KS.api.demo = demo;

  // お試しモードの回答を、本番の「回答」シートと同じ列のCSVにする
  KS.demoCsv = function () {
    var head = ['送信日時', '参加者ナンバー', '歩', '設問ID', '種別', '提示語・例文', '回答の状態', '回答（地域の言葉）', '文節（提示）', '文節（回答）',
      '提案例文の回答', '別形・意味・補足', '録音1', '録音2', '録音なしの理由', '録音の長さ（秒）', 'サンプリング周波数', '回答にかかった秒数', '端末', '端末での回答日時', '送信ID'];
    var keys = ['at', 'participant', 'step', 'itemId', 'type', 'prompt', 'status', 'answer', 'segPrompt', 'segAnswer',
      'exampleAnswer', 'note', 'audio1', 'audio2', 'noAudioReason', 'durationSec', 'sampleRate', 'elapsedSec', 'device', 'clientTime', 'sid'];
    function cell(v) {
      var s = String(v == null ? '' : v);
      if (/^[=+\-@]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    }
    var rows = KS.store.get('demo:answers', []);
    var lines = [head.map(cell).join(',')];
    rows.forEach(function (r) { lines.push(keys.map(function (k) { return cell(r[k]); }).join(',')); });
    return '﻿' + lines.join('\r\n') + '\r\n';
  };
})();
