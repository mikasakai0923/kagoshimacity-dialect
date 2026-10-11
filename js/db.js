/* かごしま ことばさんぽ — まだ送っていない回答を、端末の中にとっておく場所（IndexedDB） */
(function () {
  'use strict';
  var KS = window.KS = window.KS || {};

  var DB_NAME = 'ks-kotoba-sanpo', STORE = 'queue';
  var dbPromise = null;
  var memory = {};          // 端末に保存できなかった回答（この画面を開いているあいだだけ覚えている）

  function open(fresh) {
    if (fresh) dbPromise = null;
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var idb = window.indexedDB;
      if (!idb) { reject(new Error('この端末では保存場所を使えません')); return; }
      var req;
      try { req = idb.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'sid' });
      };
      req.onsuccess = function () {
        var db = req.result;
        // 端末の都合で接続が切れたら、次に使うときに開き直す
        db.onclose = function () { dbPromise = null; };
        db.onversionchange = function () { try { db.close(); } catch (e) { /* 何もしない */ } dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { reject(req.error || new Error('保存場所を開けませんでした')); };
    });
    dbPromise.then(null, function () { dbPromise = null; });
    return dbPromise;
  }

  // 1回の読み書き。失敗したら reject する（ここでは「なかったこと」にしない）
  function run(mode, fn, fresh) {
    return open(fresh).then(function (db) {
      return new Promise(function (resolve, reject) {
        var t, result;
        try { t = db.transaction(STORE, mode); } catch (e) { reject(e); return; }
        var req;
        try { req = fn(t.objectStore(STORE)); } catch (e2) { reject(e2); return; }
        if (req) req.onsuccess = function () { result = req.result; };
        t.oncomplete = function () { resolve(result); };
        t.onerror = t.onabort = function () { reject(t.error || new Error('端末への保存に失敗しました')); };
      });
    });
  }
  // 失敗したら、保存場所を開き直してもう一度だけためす（iPhone では、しばらく裏にいたあと接続が切れていることがある）
  function runWithRetry(mode, fn) {
    return run(mode, fn, false).then(null, function () { return run(mode, fn, true); });
  }

  KS.db = {
    // 回答をとっておく。端末に保存できたら {persisted:true}、できずに「覚えているだけ」なら {persisted:false}
    put: function (item) {
      return runWithRetry('readwrite', function (store) { return store.put(item); }).then(function () {
        delete memory[item.sid];
        return { persisted: true };
      }, function () {
        memory[item.sid] = item;
        return { persisted: false };
      });
    },
    remove: function (sid) {
      delete memory[sid];
      return runWithRetry('readwrite', function (store) { return store.delete(sid); }).then(null, function () { /* 何もしない */ });
    },
    all: function () {
      return runWithRetry('readonly', function (store) { return store.getAll(); }).then(function (list) {
        return list || [];
      }, function () {
        return [];
      }).then(function (list) {
        var out = list.slice();
        var seen = {};
        out.forEach(function (i) { seen[i.sid] = true; });
        for (var k in memory) {
          if (Object.prototype.hasOwnProperty.call(memory, k) && !Object.prototype.hasOwnProperty.call(seen, k)) out.push(memory[k]);
        }
        out.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        return out;
      });
    },
    // 端末に保存できず「覚えているだけ」になっている回答の数
    volatileCount: function () {
      var n = 0;
      for (var k in memory) if (Object.prototype.hasOwnProperty.call(memory, k)) n++;
      return n;
    }
  };
})();
