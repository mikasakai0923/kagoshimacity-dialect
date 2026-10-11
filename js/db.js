/* かごしま ことばさんぽ — まだ送っていない回答を、端末の中にとっておく場所（IndexedDB） */
(function () {
  'use strict';
  var KS = window.KS = window.KS || {};

  var DB_NAME = 'ks-kotoba-sanpo', STORE = 'queue';
  var dbPromise = null;
  var memory = {};          // IndexedDB が使えないとき（プライベートブラウズなど）の代わり
  var useMemory = false;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      var idb = window.indexedDB;
      if (!idb) { useMemory = true; resolve(null); return; }
      var req;
      try { req = idb.open(DB_NAME, 1); } catch (e) { useMemory = true; resolve(null); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'sid' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { useMemory = true; resolve(null); };
      req.onblocked = function () { useMemory = true; resolve(null); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      if (!db || useMemory) return fn(null);
      return new Promise(function (resolve, reject) {
        var t, result;
        try { t = db.transaction(STORE, mode); } catch (e) { useMemory = true; resolve(fn(null)); return; }
        var store = t.objectStore(STORE);
        var req = fn(store);
        if (req) req.onsuccess = function () { result = req.result; };
        t.oncomplete = function () { resolve(result); };
        t.onerror = t.onabort = function () { reject(t.error || new Error('端末への保存に失敗しました')); };
      });
    });
  }

  KS.db = {
    put: function (item) {
      return tx('readwrite', function (store) {
        if (!store) { memory[item.sid] = item; return undefined; }
        return store.put(item);
      }).catch(function () {
        // 端末に保存できないときは、この画面を開いているあいだだけ覚えておく
        useMemory = true; memory[item.sid] = item;
      });
    },
    remove: function (sid) {
      delete memory[sid];
      return tx('readwrite', function (store) { return store ? store.delete(sid) : undefined; }).catch(function () { /* 何もしない */ });
    },
    all: function () {
      return tx('readonly', function (store) {
        return store ? store.getAll() : undefined;
      }).then(function (list) {
        var out = (list || []).slice();
        var seen = {};
        out.forEach(function (i) { seen[i.sid] = true; });
        for (var k in memory) if (!seen[k]) out.push(memory[k]);
        out.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        return out;
      }).catch(function () {
        var out = [];
        for (var k in memory) out.push(memory[k]);
        return out;
      });
    },
    volatile: function () { return useMemory; }
  };
})();
