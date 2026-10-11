#!/usr/bin/env node
/*
 * 開発用：Google Apps Script の「まね」をするサーバー。
 * gas/Code.gs をそのまま読みこみ、スプレッドシートとドライブをメモリ上でまねて動かします。
 * サイトの自動テスト（tools/e2e.js）や、手元での動作確認に使います。
 *
 *   node tools/mock-gas.js [--port 8766] [--code gas/Code.gs]
 *
 * Google の実物とまったく同じではありません。公開前には実物での確認が必要です。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const crypto = require('crypto');

function createGasWorld(codePath) {
  const TZ_OFFSET_MIN = 9 * 60; // Asia/Tokyo
  let now = () => Date.now();

  // ---------- スプレッドシート ----------
  function looksNumeric(s) { return typeof s === 'string' && s.trim() !== '' && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s.trim()); }

  class Range {
    constructor(sheet, row, col, nr, nc) { this.sheet = sheet; this.row = row; this.col = col; this.nr = nr; this.nc = nc; }
    getValues() {
      const out = [];
      for (let r = 0; r < this.nr; r++) {
        const line = [];
        for (let c = 0; c < this.nc; c++) line.push(this.sheet._get(this.row + r, this.col + c));
        out.push(line);
      }
      return out;
    }
    setValues(vals) {
      if (vals.length !== this.nr || vals.some(v => v.length !== this.nc)) throw new Error(`setValues: 範囲(${this.nr}x${this.nc})とデータの大きさが合いません`);
      for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet._set(this.row + r, this.col + c, vals[r][c]);
      return this;
    }
    setValue(v) { for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet._set(this.row + r, this.col + c, v); return this; }
    setNumberFormat(f) {
      for (let c = 0; c < this.nc; c++) {
        // 列全体の書式は「そのとき存在していた行」までにしか付かないものとして扱う（厳しめの想定）
        if (this.nr >= 100000) this.sheet.colFormat[this.col + c] = { f, upTo: this.sheet.maxRows };
        else for (let r = 0; r < this.nr; r++) this.sheet.cellFormat[(this.row + r) + ':' + (this.col + c)] = f;
      }
      return this;
    }
    getNumberFormats() {
      const out = [];
      for (let r = 0; r < this.nr; r++) { const line = []; for (let c = 0; c < this.nc; c++) line.push(this.sheet._format(this.row + r, this.col + c) || '0.###############'); out.push(line); }
      return out;
    }
    setNumberFormats(fm) {
      if (fm.length !== this.nr || fm.some(v => v.length !== this.nc)) throw new Error('setNumberFormats: 大きさが合いません');
      for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet.cellFormat[(this.row + r) + ':' + (this.col + c)] = fm[r][c];
      return this;
    }
    setFontWeight() { return this; }
    setBackground() { return this; }
    setWrap() { return this; }
  }

  class Sheet {
    constructor(name) { this.name = name; this.rows = []; this.colFormat = {}; this.cellFormat = {}; this.formulas = []; this.maxRows = 1000; this.maxCols = 26; }
    getName() { return this.name; }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxCols; }
    insertRowsAfter(after, n) { if (after > this.maxRows || after < 1) throw new Error('mock: その行はシートの外です'); this.maxRows += n; return this; }
    insertColumnsAfter(after, n) { if (after > this.maxCols || after < 1) throw new Error('mock: その列はシートの外です'); this.maxCols += n; return this; }
    _format(r, c) {
      if (this.cellFormat[r + ':' + c]) return this.cellFormat[r + ':' + c];
      const cf = this.colFormat[c];
      return cf && r <= cf.upTo ? cf.f : '';
    }
    _get(r, c) { const row = this.rows[r - 1]; const v = row ? row[c - 1] : ''; return v === undefined ? '' : v; }
    _set(r, c, v) {
      if (r > this.maxRows) throw new Error('mock: シートの行数（' + this.maxRows + '）をこえて書きこもうとしました');
      if (c > this.maxCols) throw new Error('mock: シートの列数（' + this.maxCols + '）をこえて書きこもうとしました');
      while (this.rows.length < r) this.rows.push([]);
      const row = this.rows[r - 1];
      while (row.length < c) row.push('');
      if (v === null || v === undefined) v = '';
      if (typeof v === 'string') {
        const text = this._format(r, c) === '@';
        if (v.charAt(0) === "'") v = v.slice(1);                       // 先頭の ' は「文字として扱う」印
        else if (!text && /^=/.test(v)) { this.formulas.push({ r, c, v }); v = '#FORMULA!'; }
        else if (!text && looksNumeric(v)) v = Number(v);              // 実物と同じく、数字に見える文字は数になる
      }
      row[c - 1] = v;
    }
    getLastRow() {
      for (let r = this.rows.length; r >= 1; r--) if (this.rows[r - 1].some(v => v !== '' && v != null)) return r;
      return 0;
    }
    getLastColumn() {
      let m = 0;
      for (const row of this.rows) for (let c = row.length; c >= 1; c--) if (row[c - 1] !== '' && row[c - 1] != null) { m = Math.max(m, c); break; }
      return m;
    }
    getRange(a, b, c, d) {
      if (typeof a === 'string') {
        const m = /^([A-Z]+):([A-Z]+)$/.exec(a);
        if (!m) throw new Error('mock: この範囲の書き方には対応していません: ' + a);
        const col = s => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
        return new Range(this, 1, col(m[1]), 1000000, col(m[2]) - col(m[1]) + 1);
      }
      return new Range(this, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
    }
    getDataRange() { return new Range(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
    appendRow(arr) { const r = this.getLastRow() + 1; if (r > this.maxRows) this.maxRows = r; if (arr.length > this.maxCols) this.maxCols = arr.length; arr.forEach((v, i) => this._set(r, i + 1, v)); return this; }
    clearContents() { this.rows = []; return this; }
    setFrozenRows() {} setColumnWidth() {}
  }

  class Spreadsheet {
    constructor(id, name) { this.id = id; this.name = name; this.sheets = [new Sheet('シート1')]; this.toasts = []; }
    getId() { return this.id; } getName() { return this.name; }
    setSpreadsheetTimeZone(tz) { this.tz = tz; }
    getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
    insertSheet(n) { if (this.getSheetByName(n)) throw new Error('同じ名前のシートがあります'); const s = new Sheet(n); this.sheets.push(s); return s; }
    getSheets() { return this.sheets.slice(); }
    deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
    toast(msg) { this.toasts.push(msg); }
  }

  const ss = new Spreadsheet('SS_' + crypto.randomBytes(6).toString('hex'), '方言調査データ（テスト）');

  const uiLog = [];
  const ui = {
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' }, Button: { OK: 'OK', CANCEL: 'CANCEL' },
    _promptAnswer: '3',
    createMenu() { const m = { addItem() { return m; }, addSeparator() { return m; }, addToUi() { uiLog.push('menu'); } }; return m; },
    alert(...a) { uiLog.push(['alert', ...a]); return 'OK'; },
    prompt(...a) { uiLog.push(['prompt', ...a]); return { getSelectedButton: () => 'OK', getResponseText: () => ui._promptAnswer }; }
  };

  // ---------- ドライブ ----------
  const driveItems = {};
  function iter(arr) { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; }
  class DFile {
    constructor(name, bytes, mime, parent) { this.id = 'F_' + crypto.randomBytes(8).toString('hex'); this.name = name; this.bytes = bytes; this.mime = mime; this.parent = parent; driveItems[this.id] = this; }
    getId() { return this.id; } getName() { return this.name; }
    getUrl() { return 'https://drive.google.com/file/d/' + this.id + '/view'; }
    getParents() { return iter(this.parent ? [this.parent] : []); }
    isTrashed() { return !!this.trashed || !!(this.parent && this.parent.isTrashed && this.parent.isTrashed()); }
    setTrashed(v) { this.trashed = !!v; return this; }
  }
  class DFolder {
    constructor(name, parent) { this.id = 'D_' + crypto.randomBytes(8).toString('hex'); this.name = name; this.parent = parent; this.children = []; this.trashed = false; driveItems[this.id] = this; }
    getId() { return this.id; } getName() { return this.name; }
    getUrl() { return 'https://drive.google.com/drive/folders/' + this.id; }
    isTrashed() { return this.trashed || !!(this.parent && this.parent.isTrashed()); }
    setTrashed(v) { this.trashed = !!v; return this; }
    createFolder(name) { const f = new DFolder(name, this); this.children.push(f); return f; }
    getFoldersByName(name) { return iter(this.children.filter(c => c instanceof DFolder && c.name === name)); }
    getFilesByName(name) { return iter(this.children.filter(c => c instanceof DFile && c.name === name)); }
    createFile(blob) { const f = new DFile(blob.getName(), Buffer.from(Uint8Array.from(blob.getBytes().map(b => (b + 256) % 256))), blob.getContentType(), this); this.children.push(f); return f; }
  }
  const myDrive = new DFolder('マイドライブ', null);
  const ssFile = new DFile(ss.name, Buffer.alloc(0), 'application/vnd.google-apps.spreadsheet', myDrive);
  ssFile.id = ss.id; driveItems[ss.id] = ssFile; myDrive.children.push(ssFile);

  // ---------- そのほかのサービス ----------
  const props = {};
  const cache = {};
  const control = { lockBusy: 0, failAppend: 0, delayMs: 0, calls: [] };

  function toSigned(buf) { return Array.from(buf).map(b => (b > 127 ? b - 256 : b)); }
  function fromSigned(arr) { return Buffer.from(Uint8Array.from(arr.map(b => (b + 256) % 256))); }
  function blob(data, mime, name) {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : fromSigned(data);
    return { getBytes: () => toSigned(buf), getDataAsString: () => buf.toString('utf8'), getName: () => name, getContentType: () => mime };
  }
  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }

  const sandbox = {
    console,
    JSON, Math, Date, String, Number, Array, Object, RegExp, parseInt, parseFloat, isNaN, isFinite, Error,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      flush: () => { control.flushes = (control.flushes || 0) + 1; },
      openById: (id) => { if (id !== ss.id) throw new Error('mock: 見つからないスプレッドシート ' + id); return ss; },
      getUi: () => ui
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    CacheService: {
      getScriptCache: () => ({
        get: k => { const e = cache[k]; if (!e) return null; if (e.exp < now()) { delete cache[k]; return null; } return e.v; },
        put: (k, v, ttl) => { if (typeof v !== 'string') throw new Error('mock: cache の値は文字だけ'); cache[k] = { v, exp: now() + (ttl || 600) * 1000 }; },
        remove: k => { delete cache[k]; }
      })
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => { if (control.lockBusy > 0) { control.lockBusy--; throw new Error('Lock timeout'); } },
        releaseLock: () => {}
      })
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => {
        if (tz !== 'Asia/Tokyo') throw new Error('mock: Asia/Tokyo だけ対応');
        const t = new Date(d.getTime() + TZ_OFFSET_MIN * 60000);
        const map = { yyyy: t.getUTCFullYear(), MM: pad(t.getUTCMonth() + 1), dd: pad(t.getUTCDate()), HH: pad(t.getUTCHours()), mm: pad(t.getUTCMinutes()), ss: pad(t.getUTCSeconds()) };
        return fmt.replace(/yyyy|MM|dd|HH|mm|ss/g, k => map[k]);
      },
      base64Decode: s => { if (!/^[A-Za-z0-9+/=\s]*$/.test(s)) throw new Error('bad base64'); return toSigned(Buffer.from(s, 'base64')); },
      base64EncodeWebSafe: data => (typeof data === 'string' ? Buffer.from(data, 'utf8') : fromSigned(data)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64DecodeWebSafe: s => toSigned(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
      computeHmacSha256Signature: (value, key) => toSigned(crypto.createHmac('sha256', key).update(value, 'utf8').digest()),
      newBlob: blob
    },
    DriveApp: {
      getFileById: id => { const f = driveItems[id]; if (!f) throw new Error('mock: ファイルなし'); return f; },
      getFolderById: id => { const f = driveItems[id]; if (!(f instanceof DFolder)) throw new Error('mock: フォルダなし'); return f; },
      createFolder: name => myDrive.createFolder(name)
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ _text: text, _mime: 'text/plain', setMimeType(m) { this._mime = m; return this; }, getContent() { return this._text; } })
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), sandbox, { filename: path.basename(codePath) });

  // テスト用：「回答」シートへの書きこみを失敗させる仕掛け
  const origAppend = Sheet.prototype.appendRow;
  Sheet.prototype.appendRow = function (arr) {
    if (this.name === '回答' && control.failAppend > 0) { control.failAppend--; throw new Error('mock: 追記に失敗（テスト）'); }
    return origAppend.call(this, arr);
  };
  const origSetValues = Range.prototype.setValues;
  Range.prototype.setValues = function (vals) {
    if (this.sheet.name === '回答' && this.row > 1 && control.failAppend > 0) { control.failAppend--; throw new Error('mock: 追記に失敗（テスト）'); }
    return origSetValues.call(this, vals);
  };

  return {
    sandbox, ss, ui, uiLog, props, cache, control, myDrive, driveItems, DFolder, DFile,
    setNow(fn) { now = fn; },
    call(name, ...args) { return vm.runInContext(name, sandbox)(...args); },
    post(obj) {
      const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
      const out = this.call('doPost', { postData: { contents: body, length: body.length, type: 'text/plain' }, parameter: {} });
      return JSON.parse(out.getContent());
    },
    sheetRows(name) { const s = ss.getSheetByName(name); return s ? s.rows.map(r => r.slice()) : null; },
    files(includeTrashed) {
      const out = [];
      (function walk(folder, prefix) {
        for (const c of folder.children) {
          if (!includeTrashed && c.isTrashed()) continue;
          if (c instanceof DFolder) walk(c, prefix + c.name + '/');
          else if (c.id !== ss.id) out.push({ path: prefix + c.name, bytes: c.bytes.length, id: c.id, trashed: c.isTrashed() });
        }
      })(myDrive, '');
      return out;
    },
    folder(pathParts) {
      let f = myDrive;
      for (const part of pathParts) { f = f.children.find(c => c instanceof DFolder && c.name === part && !c.isTrashed()) || f.children.find(c => c instanceof DFolder && c.name === part); if (!f) return null; }
      return f;
    },
    fileBytes(id) { return driveItems[id].bytes; }
  };
}

function startServer(world, port) {
  const echoes = {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const send = (code, headers, body) => { res.writeHead(code, headers); res.end(body); };

    if (req.method === 'OPTIONS') {
      // 実物の Apps Script は事前確認（プリフライト）に答えない。ここでも同じように失敗させる。
      return send(405, {}, 'Method Not Allowed');
    }
    if (url.pathname === '/echo') {
      const e = echoes[url.searchParams.get('id')];
      if (!e) return send(404, cors, 'gone');
      return send(200, Object.assign({ 'Content-Type': e.mime + '; charset=utf-8' }, cors), e.text);
    }
    if (url.pathname === '/__dump') {
      const sheets = {};
      for (const s of world.ss.sheets) sheets[s.name] = s.rows;
      return send(200, Object.assign({ 'Content-Type': 'application/json' }, cors), JSON.stringify({ sheets, files: world.files(), formulas: world.ss.sheets.flatMap(s => s.formulas), calls: world.control.calls }));
    }
    if (url.pathname === '/__control') {
      for (const [k, v] of url.searchParams) if (k in world.control) world.control[k] = Number(v);
      return send(200, cors, JSON.stringify(world.control));
    }
    if (url.pathname !== '/exec') return send(404, cors, 'not found');

    const finish = out => {
      const id = crypto.randomBytes(8).toString('hex');
      echoes[id] = { text: out._text, mime: out._mime };
      // 実物と同じように、いったん別のサーバー名のアドレスへ転送してから結果を返す
      // （実物は script.google.com → script.googleusercontent.com。ここでは localhost → 127.0.0.1）
      setTimeout(() => send(302, Object.assign({ Location: `http://127.0.0.1:${port}/echo?id=${id}` }, cors), ''), world.control.delayMs || 0);
    };
    if (req.method === 'GET') {
      return finish(world.call('doGet', { parameter: Object.fromEntries(url.searchParams) }));
    }
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const ct = String(req.headers['content-type'] || '');
        if (!/^text\/plain/i.test(ct)) return send(400, cors, 'mock: Content-Type は text/plain で送ってください（それ以外は実物では事前確認が必要になり失敗します）');
        const body = Buffer.concat(chunks).toString('utf8');
        let action = '';
        try { action = JSON.parse(body).action; } catch (e) {}
        world.control.calls.push(action);
        finish(world.call('doPost', { postData: { contents: body, length: body.length, type: ct }, parameter: {} }));
      });
      return;
    }
    send(405, cors, 'Method Not Allowed');
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

module.exports = { createGasWorld, startServer };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
  const port = Number(opt('port', 8766));
  const code = path.resolve(opt('code', path.join(__dirname, '..', 'gas', 'Code.gs')));
  const world = createGasWorld(code);
  world.call('setup');
  world.ui._promptAnswer = '3';
  const added = world.call('addParticipants', 3);
  const people = world.sheetRows('参加者').slice(1).map(r => `${r[0]} / ${r[1]}`);
  startServer(world, port).then(() => {
    console.log(`まねサーバー: http://localhost:${port}/exec`);
    console.log('テスト用の参加者（ナンバー / パスワード）:\n  ' + people.join('\n  '));
    console.log('中身を見る: http://localhost:' + port + '/__dump');
  });
}
