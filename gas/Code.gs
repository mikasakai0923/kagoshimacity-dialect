/**
 * かごしま ことばさんぽ（市民参加型の方言調査サイト）
 * Google 側の保存プログラム（Google Apps Script）
 *
 * 役割
 *   ・参加者ナンバーとパスワードでログインを確かめる
 *   ・調査項目（「項目」シート）を参加者の画面に渡す
 *   ・回答を「回答」シートに1行ずつ追記し、録音（WAV）を Google ドライブに保存する
 *
 * 使い方は docs/setup-google.md を見てください。
 * このファイルは、回答を保存したいスプレッドシートの
 * 「拡張機能 → Apps Script」に貼り付けて使います。
 */

var KS_VERSION = '0.3.0';
var KS_TZ = 'Asia/Tokyo';
var KS_TOKEN_DAYS = 30;            // ログインの有効日数
var KS_LOGIN_MAX_FAILS = 8;        // この回数まちがえると、しばらくログインできなくなる
var KS_LOGIN_LOCK_SEC = 900;       // ログインできなくなる時間（秒）
var KS_MAX_AUDIO_B64 = 9000000;    // 録音1本の上限（Base64の文字数。約6.7MB）
var KS_MAX_TEXT = 600;             // 文字の回答1欄の上限
var KS_NOISE_WARN_DB = 20;         // 「まわりの音が大きい」と注意を出す目安（設定シートで変えられる）

var KS_SHEETS = {
  settings: '設定',
  people: '参加者',
  steps: '歩',
  items: '項目',
  answers: '回答',
  progress: '進み具合'
};

var KS_HEADERS = {
  settings: ['項目', '値', '説明'],
  people: ['参加者ナンバー', 'パスワード', '状態', 'メモ', '登録日', '最終ログイン'],
  steps: ['歩', 'タイトル', 'アイコン'],
  items: ['歩', '順', '設問ID', '種別', '提示語・例文', '場面・意味・読み', '提案例文（語彙）',
          '文節の区切り', 'イラスト', '出す', '記述項目', '調査の狙い'],
  answers: ['送信日時', '参加者ナンバー', '歩', '設問ID', '種別', '提示語・例文', '回答の状態',
            '回答（地域の言葉）', '文節（提示）', '文節（回答）', '提案例文の回答', '別形・意味・補足',
            '録音1', '録音1リンク', '録音2', '録音2リンク', '録音なしの理由', '録音の長さ（秒）',
            'サンプリング周波数', '回答にかかった秒数', '端末', '端末での回答日時', '送信ID', '技術情報',
            '声と雑音の差（dB）'],
  progress: ['参加者ナンバー', '回答した設問', '全設問', '録音なしの回答', '知らない・使わない・思い出せない',
             '最初の回答', '最後の回答']
};

var KS_DEFAULT_SETTINGS = [
  ['受付', '受付中', '「停止中」にすると、だれもログイン・送信できなくなります。'],
  ['お知らせ', '', '書くと、参加者の地図の画面の上に表示されます。空欄なら何も出ません。'],
  ['教示文', 'あなたの自然な方言（小学校のころの同級生など、親しい人と話す時のことば）で何というか教えてください。',
   'すべての設問の上に出る説明です。'],
  ['語彙の質問文', '「{語}」のことをなんといいますか？', '{語} のところに提示語が入ります。'],
  ['例文の質問文', '「{文}」をなんといいますか？', '{文} のところに例文が入ります。'],
  ['録音の上限（秒）', 20, '1回の録音の長さの上限です（5〜60）。長くすると、通信の弱い場所では送信に時間がかかります。'],
  ['雑音の注意の目安（dB）', KS_NOISE_WARN_DB,
   '声と、まわりの音の大きさの差（「回答」シートの「声と雑音の差（dB）」）が、この数字より小さい録音に「まわりの音が大きいようです」と注意を出します（5〜40）。数字を大きくすると、きびしくなります。0 にすると注意を出しません。'],
  ['参加者ナンバーの頭文字', 'K', 'メニュー「参加者を追加」で自動的に作るナンバーの頭文字です。']
];

var KS_STATUSES = ['回答済', '知らない', '使わない', '思い出せない'];


/* ============================================================
 * メニューと初期設定
 * ============================================================ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('方言調査')
    .addItem('初期設定（最初に1回）', 'menuSetup')
    .addItem('参加者を追加（ナンバーとパスワードを自動で作る）', 'menuAddParticipants')
    .addSeparator()
    .addItem('進み具合を更新', 'menuRefreshProgress')
    .addItem('録音フォルダを開く', 'menuOpenAudioFolder')
    .addToUi();
}

function menuSetup() {
  var msg = setup();
  SpreadsheetApp.getUi().alert('初期設定', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * 初期設定。シートと録音フォルダを作ります。何度実行しても、すでにあるデータは消しません。
 * Apps Script の画面で、関数「setup」を選んで「実行」を押してください。
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('スプレッドシートから開いた Apps Script で実行してください。');
  ss.setSpreadsheetTimeZone(KS_TZ);

  var props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  if (!props.getProperty('TOKEN_SECRET')) {
    props.setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }

  var made = [];

  // 設定
  var sh = ksEnsureSheet_(ss, KS_SHEETS.settings, KS_HEADERS.settings, made);
  if (sh.getLastRow() < 2) {
    sh.getRange(2, 1, KS_DEFAULT_SETTINGS.length, 3).setValues(KS_DEFAULT_SETTINGS);
  } else {
    ksAddMissingSettings_(sh, made);      // プログラムを新しくして、設定の項目が増えたとき
  }
  sh.setColumnWidth(1, 180); sh.setColumnWidth(2, 420); sh.setColumnWidth(3, 420);
  sh.getRange('B:B').setWrap(true);

  // 参加者
  sh = ksEnsureSheet_(ss, KS_SHEETS.people, KS_HEADERS.people, made);
  sh.getRange('A:B').setNumberFormat('@');   // 「001」のような頭のゼロが消えないように、文字として扱う
  sh.getRange('E:F').setNumberFormat('yyyy-mm-dd hh:mm');
  sh.setColumnWidth(1, 140); sh.setColumnWidth(2, 120); sh.setColumnWidth(4, 240);
  sh.setColumnWidth(5, 140); sh.setColumnWidth(6, 140);

  // 歩
  sh = ksEnsureSheet_(ss, KS_SHEETS.steps, KS_HEADERS.steps, made);
  if (sh.getLastRow() < 2 && KS_INITIAL_STEPS.length) {
    sh.getRange(2, 1, KS_INITIAL_STEPS.length, 3).setValues(KS_INITIAL_STEPS);
  }
  sh.setColumnWidth(2, 220);

  // 項目
  sh = ksEnsureSheet_(ss, KS_SHEETS.items, KS_HEADERS.items, made);
  sh.getRange('C:I').setNumberFormat('@');
  if (sh.getLastRow() < 2 && KS_INITIAL_ITEMS.length) {
    sh.getRange(2, 1, KS_INITIAL_ITEMS.length, KS_HEADERS.items.length).setValues(KS_INITIAL_ITEMS);
  }
  sh.setColumnWidth(3, 90); sh.setColumnWidth(5, 300); sh.setColumnWidth(6, 300);
  sh.setColumnWidth(7, 220); sh.setColumnWidth(8, 300); sh.setColumnWidth(9, 180);
  sh.setColumnWidth(11, 240); sh.setColumnWidth(12, 240);

  // 回答
  sh = ksEnsureSheet_(ss, KS_SHEETS.answers, KS_HEADERS.answers, made);
  ksAddMissingHeaders_(sh, KS_HEADERS.answers, made);      // プログラムを新しくして、列が増えたとき
  sh.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  // 回答の文字が数字や数式として扱われないように、文字の列は「書式なしテキスト」にする（リンクの列 N・P は除く）
  sh.getRange('B:B').setNumberFormat('@');
  sh.getRange('D:M').setNumberFormat('@');
  sh.getRange('O:O').setNumberFormat('@');
  sh.getRange('Q:Q').setNumberFormat('@');
  sh.getRange('U:X').setNumberFormat('@');
  sh.setColumnWidth(1, 150); sh.setColumnWidth(6, 260); sh.setColumnWidth(8, 220);
  sh.setColumnWidth(9, 240); sh.setColumnWidth(10, 240); sh.setColumnWidth(11, 220); sh.setColumnWidth(12, 220);

  // 最初からある空のシート（「シート1」など）を片づける
  var all = ss.getSheets();
  var ours = {};
  for (var k in KS_SHEETS) ours[KS_SHEETS[k]] = true;
  for (var i = 0; i < all.length; i++) {
    var s0 = all[i];
    if (!ours[s0.getName()] && s0.getLastRow() === 0 && s0.getLastColumn() === 0 && ss.getSheets().length > 1) {
      ss.deleteSheet(s0);
    }
  }

  // 録音フォルダ
  var folder = ksAudioFolderOrNull_();
  if (!folder) {
    var parent = null;
    try {
      var parents = DriveApp.getFileById(ss.getId()).getParents();
      if (parents.hasNext()) parent = parents.next();
    } catch (err) { parent = null; }
    var name = '方言調査の録音（' + ss.getName() + '）';
    folder = parent ? parent.createFolder(name) : DriveApp.createFolder(name);
    props.setProperty('AUDIO_FOLDER_ID', folder.getId());
    made.push('録音フォルダ「' + name + '」');
  }
  ksSetSetting_(ss, '録音フォルダ', folder.getUrl(), '録音が保存されるGoogleドライブのフォルダです（自動で入ります。書き換えないでください）。');

  var msg = '初期設定が終わりました。\n' +
    (made.length ? '新しく作ったもの：' + made.join('、') + '\n' : 'すでに設定ずみでした（データはそのままです）。\n') +
    '次は「参加者」シートに参加者を登録し、「デプロイ」でウェブアプリとして公開してください。';
  ss.toast('初期設定が終わりました。', '方言調査', 8);
  console.log(msg);
  return msg;
}

function ksEnsureSheet_(ss, name, headers, made) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name, ss.getSheets().length);
    made.push('「' + name + '」シート');
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#E6F5F9');
  sh.setFrozenRows(1);
  return sh;
}

/** すでにあるシートの見出し（1行目）に、足りない見出しを右はしに足します。あるデータは動かしません。 */
function ksAddMissingHeaders_(sh, headers, made) {
  var lastCol = sh.getLastColumn();
  var head = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var have = {};
  for (var i = 0; i < head.length; i++) have[String(head[i]).trim()] = true;
  var missing = [];
  for (var j = 0; j < headers.length; j++) if (!have[headers[j]]) missing.push(headers[j]);
  if (!missing.length) return;
  if (lastCol + missing.length > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), lastCol + missing.length - sh.getMaxColumns());
  sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]).setFontWeight('bold').setBackground('#E6F5F9');
  made.push('「' + sh.getName() + '」シートの列「' + missing.join('」「') + '」');
}

/** すでにある「設定」シートに、足りない項目の行を足します。書いてある値は変えません。 */
function ksAddMissingSettings_(sh, made) {
  var last = sh.getLastRow();
  var keys = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues() : [];
  var have = {};
  for (var i = 0; i < keys.length; i++) have[String(keys[i][0]).trim()] = true;
  for (var j = 0; j < KS_DEFAULT_SETTINGS.length; j++) {
    var row = KS_DEFAULT_SETTINGS[j];
    if (have[row[0]]) continue;
    sh.appendRow(row);
    made.push('「設定」シートの項目「' + row[0] + '」');
  }
}

function ksSetSetting_(ss, key, value, note) {
  var sh = ss.getSheetByName(KS_SHEETS.settings);
  var last = sh.getLastRow();
  var keys = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues() : [];
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]).trim() === key) {
      sh.getRange(i + 2, 2).setValue(value);
      return;
    }
  }
  sh.appendRow([key, value, note || '']);
}

/** メニュー：参加者を追加（ナンバーとパスワードを自動で作る） */
function menuAddParticipants() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('参加者を追加', '何人分つくりますか？（1〜200）', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var n = parseInt(ksNorm_(res.getResponseText()), 10);
  if (!(n >= 1 && n <= 200)) { ui.alert('1〜200の数字を入れてください。'); return; }
  var added = addParticipants(n);
  ui.alert('参加者を追加しました',
    added.length + '人分を「参加者」シートに追加しました（' + added[0] + ' 〜 ' + added[added.length - 1] + '）。\n' +
    'ナンバーとパスワードを、登録のときに参加者へお渡しください。', ui.ButtonSet.OK);
}

/** 参加者を n 人分追加して、作った参加者ナンバーの一覧を返します。 */
function addParticipants(n) {
  var ss = ksSs_();
  var sh = ss.getSheetByName(KS_SHEETS.people);
  if (!sh) throw new Error('先に初期設定をしてください。');
  // 頭文字は英数字だけ（それ以外の文字は取りのぞく）
  var prefix = ksNorm_(ksSettings_()['参加者ナンバーの頭文字'] || 'K').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'K';
  var last = sh.getLastRow();
  var ids = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues() : [];
  var max = 0;
  var re = new RegExp('^' + prefix + '(\\d+)$');
  for (var i = 0; i < ids.length; i++) {
    var m = re.exec(ksNormId_(ids[i][0]));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  var rows = [], out = [];
  for (var j = 1; j <= n; j++) {
    var num = String(max + j);
    while (num.length < 3) num = '0' + num;
    var id = prefix + num;
    rows.push([id, ksRandomDigits_(6), '有効', '', new Date(), '']);
    out.push(id);
  }
  var start = Math.max(last, 1) + 1;
  sh.getRange(start, 1, rows.length, 2).setNumberFormat('@');
  sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
  return out;
}

function ksRandomDigits_(len) {
  var out = '';
  while (out.length < len) {
    var hex = Utilities.getUuid().replace(/-/g, '');
    for (var i = 0; i + 2 <= hex.length && out.length < len; i += 2) {
      var v = parseInt(hex.substr(i, 2), 16);
      if (v < 250) out += String(v % 10);   // かたよりが出ないように 250 以上は捨てる
    }
  }
  return out;
}

/** メニュー：進み具合を更新 */
function menuRefreshProgress() {
  var n = refreshProgress();
  SpreadsheetApp.getActiveSpreadsheet().toast(n + '人分の進み具合を更新しました。', '方言調査', 6);
}

/** 「進み具合」シートを作り直して、参加者の人数を返します。 */
function refreshProgress() {
  var ss = ksSs_();
  var items = ksReadItems_();
  var total = items.length;
  var itemIds = Object.create(null);
  for (var i = 0; i < items.length; i++) itemIds[items[i].id] = true;

  var people = ksReadTable_(ss.getSheetByName(KS_SHEETS.people));
  var stat = Object.create(null), order = [];
  for (var p = 0; p < people.length; p++) {
    var pid = ksNormId_(people[p]['参加者ナンバー']);
    if (!pid || stat[pid]) continue;
    stat[pid] = { latest: Object.create(null), first: null, last: null };
    order.push(pid);
  }
  var rows = ksReadTable_(ss.getSheetByName(KS_SHEETS.answers));
  for (var r = 0; r < rows.length; r++) {
    var id = ksNormId_(rows[r]['参加者ナンバー']);
    if (!id) continue;
    if (!stat[id]) { stat[id] = { latest: Object.create(null), first: null, last: null }; order.push(id); }
    var at = rows[r]['送信日時'];
    var t = at instanceof Date ? at.getTime() : 0;
    var st = stat[id];
    var itemId = String(rows[r]['設問ID']);
    var prev = st.latest[itemId];
    if (!prev || t >= prev.t) {
      st.latest[itemId] = { t: t, status: String(rows[r]['回答の状態']), noAudio: String(rows[r]['録音なしの理由'] || '') };
    }
    if (t && (!st.first || t < st.first)) st.first = t;
    if (t && (!st.last || t > st.last)) st.last = t;
  }
  var out = [];
  for (var o = 0; o < order.length; o++) {
    var s = stat[order[o]];
    var done = 0, noAudio = 0, noAnswer = 0;
    for (var key in s.latest) {
      if (!itemIds[key]) continue;
      done++;
      if (s.latest[key].status !== '回答済') noAnswer++;
      else if (s.latest[key].noAudio) noAudio++;
    }
    out.push([order[o], done, total, noAudio, noAnswer,
              s.first ? new Date(s.first) : '', s.last ? new Date(s.last) : '']);
  }
  var sh = ss.getSheetByName(KS_SHEETS.progress);
  if (!sh) sh = ss.insertSheet(KS_SHEETS.progress, ss.getSheets().length);
  sh.clearContents();
  sh.getRange(1, 1, 1, KS_HEADERS.progress.length).setValues([KS_HEADERS.progress])
    .setFontWeight('bold').setBackground('#E6F5F9');
  sh.setFrozenRows(1);
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange('F:G').setNumberFormat('yyyy-mm-dd hh:mm');
  if (out.length) sh.getRange(2, 1, out.length, out[0].length).setValues(out);
  return out.length;
}

function menuOpenAudioFolder() {
  var folder = ksAudioFolderOrNull_();
  var ui = SpreadsheetApp.getUi();
  if (!folder) { ui.alert('録音フォルダがまだありません。先に初期設定をしてください。'); return; }
  ui.alert('録音フォルダ', '次のアドレスを開いてください。\n' + folder.getUrl(), ui.ButtonSet.OK);
}


/* ============================================================
 * 参加者の画面とのやりとり（ウェブアプリ）
 * ============================================================ */

/** ブラウザでウェブアプリのURLを開いたときの表示。接続の確認に使います。 */
function doGet(e) {
  return ksJson_({
    ok: true,
    name: 'kagoshima-kotoba-sanpo',
    message: '方言調査の保存プログラムは動いています。',
    version: KS_VERSION,
    ready: ksIsReady_(),
    time: Utilities.formatDate(new Date(), KS_TZ, 'yyyy-MM-dd HH:mm:ss')
  });
}

function doPost(e) {
  var out;
  try {
    var body = e && e.postData && e.postData.contents;
    if (!body) throw ksError_('bad_request', '送られた内容が空でした。');
    var req;
    try { req = JSON.parse(body); } catch (err) { throw ksError_('bad_request', '送られた内容を読めませんでした。'); }
    if (!req || typeof req !== 'object') throw ksError_('bad_request', '送られた内容を読めませんでした。');
    if (!ksIsReady_()) throw ksError_('not_ready', '保存先の初期設定がまだ終わっていません。調査の担当者にお知らせください。');

    switch (String(req.action || '')) {
      case 'ping':      out = ksOk_({ version: KS_VERSION, ready: true }); break;
      case 'login':     out = ksHandleLogin_(req); break;
      case 'bootstrap': out = ksHandleBootstrap_(req); break;
      case 'save':      out = ksHandleSave_(req); break;
      default: throw ksError_('bad_request', 'この操作には対応していません。');
    }
  } catch (err) {
    if (err && err.ksError) {
      out = { ok: false, error: err.code, message: err.message };
    } else {
      console.error('doPost error: ' + (err && err.stack ? err.stack : err));
      out = { ok: false, error: 'server_error', message: '保存先でエラーが起きました。時間をおいて、もう一度お試しください。' };
    }
  }
  return ksJson_(out);
}

function ksJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function ksOk_(obj) { obj = obj || {}; obj.ok = true; return obj; }
function ksError_(code, message) { return { ksError: true, code: code, message: message }; }

function ksIsReady_() {
  var props = PropertiesService.getScriptProperties();
  return !!(props.getProperty('SPREADSHEET_ID') && props.getProperty('TOKEN_SECRET') && props.getProperty('AUDIO_FOLDER_ID'));
}

/* ---------- ログイン ---------- */

function ksHandleLogin_(req) {
  var id = ksNormId_(req.id);
  var pw = ksNorm_(req.password);
  if (!id || !pw) throw ksError_('bad_credentials', '参加者ナンバーとパスワードを入れてください。');
  if (id.length > 40 || pw.length > 80) throw ksError_('bad_credentials', '参加者ナンバーかパスワードがちがいます。');
  ksRequireOpen_();

  var cache = CacheService.getScriptCache();
  var key = 'fail:' + id;
  var person;
  // まちがいの回数を正しく数えるため、ログインの確認は1つずつ順番に行う
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (err) { throw ksError_('busy', 'いまこみあっています。少し待ってから、もう一度お試しください。'); }
  try {
    var fails = Number(cache.get(key) || 0);
    if (fails >= KS_LOGIN_MAX_FAILS) {
      throw ksError_('locked', 'まちがいが続いたため、しばらくログインできません。15分ほどたってから、もう一度お試しください。');
    }
    person = ksFindPerson_(id);
    if (!person || !person.password || person.password !== pw) {
      cache.put(key, String(fails + 1), KS_LOGIN_LOCK_SEC);
      throw ksError_('bad_credentials', '参加者ナンバーかパスワードがちがいます。');
    }
    if (person.disabled) {
      throw ksError_('disabled', 'この参加者ナンバーは、いま使えません。調査の担当者にお問い合わせください。');
    }
    cache.remove(key);
  } finally {
    lock.releaseLock();
  }

  try {
    ksSs_().getSheetByName(KS_SHEETS.people).getRange(person.row, 6).setValue(new Date());
  } catch (err) { /* 最終ログインの記録に失敗しても、ログインは続ける */ }

  var exp = Math.floor(Date.now() / 1000) + KS_TOKEN_DAYS * 86400;
  return ksOk_({ token: ksMakeToken_(person.id, exp), participant: { id: person.id }, expiresAt: exp * 1000 });
}

function ksRequireOpen_() {
  var v = String(ksSettings_()['受付'] || '').trim();
  if (v === '停止中' || v === '停止') {
    throw ksError_('closed', 'いまは受付を止めています。調査の担当者からの連絡をお待ちください。');
  }
}

function ksFindPerson_(id) {
  var sh = ksSs_().getSheetByName(KS_SHEETS.people);
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, 1, last - 1, 3).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (ksNormId_(vals[i][0]) === id) {
      var status = String(vals[i][2] || '').trim();
      return { id: id, password: ksNorm_(vals[i][1]), disabled: (status === '停止' || status === '停止中' || status === '無効'), row: i + 2 };
    }
  }
  return null;
}

/* ---------- ログインの印（トークン） ---------- */

function ksSecret_() {
  var s = PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET');
  if (!s) throw ksError_('not_ready', '保存先の初期設定がまだ終わっていません。');
  return s;
}
function ksSign_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, ksSecret_()));
}
function ksMakeToken_(id, exp) {
  var head = 'v1.' + Utilities.base64EncodeWebSafe(Utilities.newBlob(id).getBytes()) + '.' + exp;
  return head + '.' + ksSign_(head);
}
function ksReadToken_(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  var head = parts[0] + '.' + parts[1] + '.' + parts[2];
  var sig = ksSign_(head);
  if (sig.length !== parts[3].length) return null;
  var diff = 0;
  for (var i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ parts[3].charCodeAt(i);
  if (diff !== 0) return null;
  var exp = Number(parts[2]);
  if (!exp || exp * 1000 < Date.now()) return null;
  var id;
  try { id = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[1])).getDataAsString(); } catch (err) { return null; }
  return { id: id, exp: exp };
}

/** トークンを確かめて、参加者の情報を返します。だめなら「もう一度ログイン」のエラーにします。 */
function ksRequirePerson_(token) {
  var t = ksReadToken_(token);
  if (!t) throw ksError_('auth', 'ログインの有効期限が切れました。もう一度ログインしてください。');
  ksRequireOpen_();
  var cache = CacheService.getScriptCache();
  var key = 'person:' + t.id;
  var state = cache.get(key);
  if (!state) {
    var person = ksFindPerson_(t.id);
    state = !person ? 'none' : (person.disabled ? 'disabled' : 'ok');
    cache.put(key, state, 120);
  }
  if (state === 'none') throw ksError_('auth', 'この参加者ナンバーは登録されていません。もう一度ログインしてください。');
  if (state === 'disabled') throw ksError_('disabled', 'この参加者ナンバーは、いま使えません。調査の担当者にお問い合わせください。');
  return { id: t.id };
}

/* ---------- 調査項目と進み具合を渡す ---------- */

function ksHandleBootstrap_(req) {
  var person = ksRequirePerson_(req.token);
  var set = ksSettings_();
  var items = ksReadItems_();
  var maxSec = Number(set['録音の上限（秒）']);
  if (!(maxSec >= 5 && maxSec <= 60)) maxSec = 20;
  return ksOk_({
    participant: { id: person.id },
    settings: {
      instruction: String(set['教示文'] || ''),
      wordQuestion: String(set['語彙の質問文'] || '「{語}」のことをなんといいますか？'),
      sentenceQuestion: String(set['例文の質問文'] || '「{文}」をなんといいますか？'),
      notice: String(set['お知らせ'] || ''),
      maxRecordSec: maxSec,
      noiseWarnDb: ksNoiseWarnDb_(set['雑音の注意の目安（dB）'])
    },
    steps: ksReadSteps_(items),
    items: items,
    progress: ksReadProgress_(person.id),
    serverTime: Date.now(),
    version: KS_VERSION
  });
}

/** 「雑音の注意の目安（dB）」の値を読みます。0 は「注意を出さない」。空欄や読めない値は、ふだんの目安にします。 */
function ksNoiseWarnDb_(v) {
  if (v === '' || v == null) return KS_NOISE_WARN_DB;
  var n = Number(ksNorm_(v));
  if (isNaN(n)) return KS_NOISE_WARN_DB;
  if (n <= 0) return 0;
  return Math.min(40, Math.max(5, n));
}

function ksReadItems_() {
  var rows = ksReadTable_(ksSs_().getSheetByName(KS_SHEETS.items));
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var id = ksNorm_(r['設問ID']);
    var prompt = String(r['提示語・例文'] == null ? '' : r['提示語・例文']).trim();
    if (!id || !prompt) continue;
    var show = r['出す'];
    if (show === false || /^(false|いいえ|no|×|x|0|出さない)$/i.test(String(show).trim())) continue;
    var segs = ksSplitSegments_(r['文節の区切り']);
    var type = String(r['種別'] || '').trim();
    if (type !== '語彙' && type !== '例文') type = segs.length ? '例文' : '語彙';
    var step = parseInt(r['歩'], 10);
    var order = Number(r['順']);
    out.push({
      id: id,
      type: type,
      step: step >= 1 ? step : 1,
      order: isNaN(order) ? i + 1 : order,
      prompt: prompt,
      context: String(r['場面・意味・読み'] == null ? '' : r['場面・意味・読み']).trim(),
      example: String(r['提案例文（語彙）'] == null ? '' : r['提案例文（語彙）']).trim(),
      segments: segs,
      art: String(r['イラスト'] == null ? '' : r['イラスト']).trim(),
      _row: i
    });
  }
  out.sort(function (a, b) { return a.step - b.step || a.order - b.order || a._row - b._row; });
  var seen = Object.create(null);
  var uniq = [];
  for (var j = 0; j < out.length; j++) {
    if (seen[out[j].id]) continue;      // 同じ設問IDが2回あったら、最初の1つだけ使う
    seen[out[j].id] = true;
    delete out[j]._row;
    uniq.push(out[j]);
  }
  return uniq;
}

function ksSplitSegments_(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return [];
  var parts = s.split(/[｜|／\/]/);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (p) out.push(p);
  }
  return out;
}

function ksReadSteps_(items) {
  var rows = ksReadTable_(ksSs_().getSheetByName(KS_SHEETS.steps));
  var titles = Object.create(null);
  for (var i = 0; i < rows.length; i++) {
    var no = parseInt(rows[i]['歩'], 10);
    if (no >= 1) titles[no] = { title: String(rows[i]['タイトル'] || '').trim(), icon: String(rows[i]['アイコン'] || '').trim() };
  }
  var counts = Object.create(null);
  for (var j = 0; j < items.length; j++) counts[items[j].step] = (counts[items[j].step] || 0) + 1;
  var nos = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });
  return nos.map(function (no) {
    var t = titles[no] || {};
    return { no: no, title: t.title || '', icon: t.icon || '', count: counts[no] };
  });
}

function ksReadProgress_(personId) {
  var sh = ksSs_().getSheetByName(KS_SHEETS.answers);
  var last = sh.getLastRow();
  var out = Object.create(null);
  if (last < 2) return out;
  var idx = ksAnswerLayout_(sh).idx;
  var cAt = idx['送信日時'], cId = idx['参加者ナンバー'], cItem = idx['設問ID'], cStatus = idx['回答の状態'];
  var first = Math.min(cAt, cId, cItem, cStatus), width = Math.max(cAt, cId, cItem, cStatus) - first + 1;
  var vals = sh.getRange(2, first + 1, last - 1, width).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (ksNormId_(vals[i][cId - first]) !== personId) continue;
    var itemId = String(vals[i][cItem - first]);
    if (!itemId) continue;
    var at = vals[i][cAt - first] instanceof Date ? vals[i][cAt - first].getTime() : 0;
    var status = String(vals[i][cStatus - first] || '回答済');
    var prev = out[itemId];
    if (!prev) out[itemId] = { status: status, at: at, count: 1 };
    else {
      prev.count++;
      if (at >= prev.at) { prev.at = at; prev.status = status; }
    }
  }
  return out;
}

/**
 * 「回答」シートの見出し（1行目）を読んで、どの見出しが何列目にあるかを返します。
 * 調査者が列を足したり並べかえたりしても、見出しの名前が同じなら正しい列に書きこめます。
 */
function ksAnswerLayout_(sheet) {
  var lastCol = sheet.getLastColumn();
  var head = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var idx = Object.create(null);
  for (var i = 0; i < head.length; i++) {
    var h = String(head[i]).trim();
    if (h && idx[h] === undefined) idx[h] = i;
  }
  var need = ['送信日時', '参加者ナンバー', '設問ID', '回答の状態', '送信ID'];
  for (var n = 0; n < need.length; n++) {
    if (idx[need[n]] === undefined) {
      console.error('「回答」シートの見出し「' + need[n] + '」が見つかりません。1行目の見出しを元にもどしてください。');
      throw ksError_('server_error', '保存先の表の形が変わっているため、保存できませんでした。調査の担当者にお知らせください。');
    }
  }
  return { head: head, idx: idx, width: head.length };
}

/**
 * 回答を1行、表のいちばん下に書きこみます（record は「見出し → 値」）。
 * 文字の欄は、書きこむ前に「書式なしテキスト」にします。こうしておくと、「001」のような回答が数字に
 * 変わったり、「=」で始まる回答が数式として動いたりしません。
 */
function ksAppendAnswer_(sheet, layout, record) {
  var row = sheet.getLastRow() + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 500);
  var range = sheet.getRange(row, 1, 1, layout.width);
  var formats = range.getNumberFormats()[0];
  var values = [];
  for (var c = 0; c < layout.width; c++) {
    var h = String(layout.head[c]).trim();
    var v = (h && Object.prototype.hasOwnProperty.call(record, h)) ? record[h] : '';
    if (v instanceof Date) formats[c] = 'yyyy-mm-dd hh:mm:ss';
    else if (typeof v === 'string' && v !== '' && !/リンク$/.test(h)) formats[c] = '@';
    values.push(v);
  }
  range.setNumberFormats([formats]);
  range.setValues([values]);
}

/* ---------- 回答と録音を保存する ---------- */

function ksHandleSave_(req) {
  var person = ksRequirePerson_(req.token);
  var s = req.submission;
  if (!s || typeof s !== 'object') throw ksError_('bad_request', '回答の内容が空でした。');

  var sid = String(s.submissionId || s.sid || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sid)) throw ksError_('bad_request', '送信IDが正しくありません。');
  var itemId = ksText_(s.itemId, 60);
  if (!itemId) throw ksError_('bad_request', '設問IDがありません。');
  var status = KS_STATUSES.indexOf(String(s.status)) >= 0 ? String(s.status) : '回答済';

  var cache = CacheService.getScriptCache();
  var sheet = ksSs_().getSheetByName(KS_SHEETS.answers);
  if (!sheet) {
    console.error('「回答」シートが見つかりません。シートの名前を元にもどすか、初期設定をやり直してください。');
    throw ksError_('server_error', '保存先の表が見つからないため、保存できませんでした。調査の担当者にお知らせください。');
  }
  var layout = ksAnswerLayout_(sheet);
  if (cache.get('sid:' + sid) || ksHasSid_(sheet, layout, sid)) {
    return ksOk_({ sid: sid, duplicate: true });       // 同じ回答がもう保存されている（送り直し）
  }

  // 録音をドライブに保存する
  var audio = Array.isArray(s.audio) ? s.audio.slice(0, 2) : [];
  var files = {};
  var saved = 0;
  var info = { app: ksText_(s.app, 40) };
  if (audio.length) {
    var folder = ksPersonFolder_(person.id);
    var stamp = ksFileStamp_(s.clientTime);
    for (var i = 0; i < audio.length; i++) {
      var a = audio[i] || {};
      var slot = a.slot === 'example' ? 'example' : 'main';
      var b64 = String(a.b64 || '');
      if (!b64 || files[slot]) continue;
      if (b64.length > KS_MAX_AUDIO_B64) throw ksError_('too_large', '録音が長すぎて保存できませんでした。短く録り直してください。');
      var bytes;
      try { bytes = Utilities.base64Decode(b64); } catch (err) { throw ksError_('bad_request', '録音のデータを読めませんでした。'); }
      if (bytes.length < 44 || bytes[0] !== 82 || bytes[1] !== 73 || bytes[2] !== 70 || bytes[3] !== 70) {
        throw ksError_('bad_request', '録音のデータを読めませんでした。');
      }
      var name = ksSafeName_(person.id) + '_' + ksSafeName_(itemId) + '_' + (slot === 'example' ? 'reibun' : 'kaitou') +
                 '_' + stamp + '_' + sid.substr(0, 6) + '.wav';
      // 送り直しで同じ名前の録音がもうあれば、それを使う（ごみ箱の中のものは使わない）
      var file = null;
      var existing = folder.getFilesByName(name);
      while (existing.hasNext()) {
        var f = existing.next();
        if (!f.isTrashed()) { file = f; break; }
      }
      if (!file) file = folder.createFile(Utilities.newBlob(bytes, 'audio/wav', name));
      files[slot] = { name: name, url: file.getUrl() };
      saved++;
      var tag = slot === 'example' ? 'ex' : 'main';
      info[tag] = {
        sec: ksNum_(a.durationSec), hz: ksNum_(a.sampleRate), peak: ksNum_(a.peak), bytes: bytes.length,
        ec: a.echoCancellation === true, ns: a.noiseSuppression === true, agc: a.autoGainControl === true
      };
      if (a.trackHz) info[tag].trackHz = ksNum_(a.trackHz);
      if (a.input) info[tag].input = ksText_(a.input, 20);
      // 声と、まわりの音の差（参加者の端末で見積もった値）。小さいほど、まわりの音が大きい
      if (ksNum_(a.snrDb) !== '') info[tag].snr = ksNum_(a.snrDb);
      if (ksNum_(a.noiseDb) !== '') info[tag].noise = ksNum_(a.noiseDb);
    }
  }

  var main = info.main || {};
  var record = {
    '送信日時': new Date(),
    '参加者ナンバー': person.id,
    '歩': ksNum_(s.step),
    '設問ID': itemId,
    '種別': ksText_(s.type, 10),
    '提示語・例文': ksText_(s.prompt, KS_MAX_TEXT),
    '回答の状態': status,
    '回答（地域の言葉）': ksText_(s.answer, KS_MAX_TEXT),
    '文節（提示）': ksText_(s.segPrompt, KS_MAX_TEXT),
    '文節（回答）': ksText_(s.segAnswer, KS_MAX_TEXT),
    '提案例文の回答': ksText_(s.exampleAnswer, KS_MAX_TEXT),
    '別形・意味・補足': ksText_(s.note, KS_MAX_TEXT),
    '録音1': files.main ? files.main.name : '',
    '録音1リンク': files.main ? files.main.url : '',
    '録音2': files.example ? files.example.name : '',
    '録音2リンク': files.example ? files.example.url : '',
    '録音なしの理由': ksText_(s.noAudioReason, 60),
    '録音の長さ（秒）': main.sec === '' || main.sec == null ? '' : main.sec,
    'サンプリング周波数': main.hz === '' || main.hz == null ? '' : main.hz,
    '回答にかかった秒数': ksNum_(s.elapsedSec),
    '端末': ksText_(s.device, 200),
    '端末での回答日時': ksText_(s.clientTime, 40),
    '送信ID': sid,
    '技術情報': JSON.stringify(info),
    '声と雑音の差（dB）': main.snr === '' || main.snr == null ? '' : main.snr
  };

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (err) {
    throw ksError_('busy', 'いま保存先がこみあっています。少しあとで自動的に送り直します。');
  }
  try {
    SpreadsheetApp.flush();     // ほかの人の書きこみを反映してから、二重登録でないかをもう一度確かめる
    if (cache.get('sid:' + sid) || ksHasSid_(sheet, layout, sid)) return ksOk_({ sid: sid, duplicate: true });
    ksAppendAnswer_(sheet, layout, record);
    SpreadsheetApp.flush();     // 表に書きこまれたことを確かめてから「保存した」と答える
    cache.put('sid:' + sid, '1', 21600);
  } finally {
    lock.releaseLock();
  }
  return ksOk_({ sid: sid, saved: true, audio: saved });
}

function ksHasSid_(sheet, layout, sid) {
  var last = sheet.getLastRow();
  if (last < 2) return false;
  var vals = sheet.getRange(2, layout.idx['送信ID'] + 1, last - 1, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0]) === sid) return true;
  }
  return false;
}

function ksAudioFolderOrNull_() {
  var id = PropertiesService.getScriptProperties().getProperty('AUDIO_FOLDER_ID');
  return id ? ksLiveFolder_(id) : null;
}

/** IDからフォルダを取り出す。なくなっていたり、ごみ箱に入っていたりしたら null。 */
function ksLiveFolder_(id) {
  try {
    var f = DriveApp.getFolderById(id);
    return f.isTrashed() ? null : f;
  } catch (err) { return null; }
}

/** 参加者ごとの録音フォルダ（なければ作る。ごみ箱に入っているものは使わない）。 */
function ksPersonFolder_(personId) {
  var cache = CacheService.getScriptCache();
  var key = 'folder:' + personId;
  var cached = cache.get(key);
  var folder = cached ? ksLiveFolder_(cached) : null;
  if (folder) return folder;

  var root = ksAudioFolderOrNull_();
  if (!root) {
    console.error('録音フォルダが見つかりません（ごみ箱に入っていないか確かめるか、初期設定をやり直してください）。');
    throw ksError_('server_error', '録音の保存先が見つからないため、保存できませんでした。調査の担当者にお知らせください。');
  }
  var name = ksSafeName_(personId);
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { throw ksError_('busy', 'いま保存先がこみあっています。少しあとで自動的に送り直します。'); }
  try {
    cached = cache.get(key);                      // 待っているあいだに、ほかの処理が作ったかもしれない
    folder = cached ? ksLiveFolder_(cached) : null;
    if (!folder) {
      var it = root.getFoldersByName(name);
      while (it.hasNext()) {
        var f = it.next();
        if (!f.isTrashed()) { folder = f; break; }
      }
      if (!folder) folder = root.createFolder(name);
      cache.put(key, folder.getId(), 21600);
    }
  } finally {
    lock.releaseLock();
  }
  return folder;
}

/* ============================================================
 * 小さな道具
 * ============================================================ */

var KS_SS_CACHE_ = null;     // 1回の処理の中では、スプレッドシートを開くのは1度だけにする
function ksSs_() {
  if (KS_SS_CACHE_) return KS_SS_CACHE_;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw ksError_('not_ready', '保存先の初期設定がまだ終わっていません。');
  KS_SS_CACHE_ = ss;
  return ss;
}

/** シートを「見出し → 値」の形の行の配列として読みます。 */
function ksReadTable_(sheet) {
  if (!sheet) return [];
  var last = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (last < 2 || lastCol < 1) return [];
  var vals = sheet.getRange(1, 1, last, lastCol).getValues();
  var head = vals[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var i = 1; i < vals.length; i++) {
    var o = {}, empty = true;
    for (var c = 0; c < head.length; c++) {
      if (!head[c]) continue;
      o[head[c]] = vals[i][c];
      if (vals[i][c] !== '' && vals[i][c] != null) empty = false;
    }
    if (!empty) out.push(o);
  }
  return out;
}

function ksSettings_() {
  var rows = ksReadTable_(ksSs_().getSheetByName(KS_SHEETS.settings));
  var out = {};
  for (var i = 0; i < rows.length; i++) {
    var k = String(rows[i]['項目'] || '').trim();
    if (k) out[k] = rows[i]['値'];
  }
  return out;
}

/** 全角の英数字を半角にそろえ、前後の空白をとる。 */
function ksNorm_(v) {
  var s = String(v == null ? '' : v);
  if (s.normalize) s = s.normalize('NFKC');
  return s.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}
function ksNormId_(v) { return ksNorm_(v).replace(/\s+/g, '').toUpperCase(); }

/** 表に書きこむ文字。長すぎるものを切り、数式として動かないようにする。 */
function ksText_(v, max) {
  if (v == null) return '';
  var s = String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim();
  if (s.length > max) s = s.substr(0, max);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}
function ksNum_(v) {
  var n = Number(v);
  return (v === '' || v == null || isNaN(n) || !isFinite(n)) ? '' : Math.round(n * 1000) / 1000;
}
function ksSafeName_(v) {
  var s = ksNorm_(v).replace(/[^A-Za-z0-9\-]/g, '_');
  return s.substr(0, 40) || 'x';
}
function ksFileStamp_(clientTime) {
  var d = new Date(String(clientTime || ''));
  if (isNaN(d.getTime()) || Math.abs(d.getTime() - Date.now()) > 400 * 86400000) d = new Date();
  return Utilities.formatDate(d, KS_TZ, 'yyyyMMdd-HHmmss');
}


/* ============================================================
 * 初期設定のときに「歩」「項目」シートへ入れる内容
 * （見本です。実際の調査項目は、初期設定のあと「項目」シートを書き換えてください）
 * ============================================================ */

// KS:INITIAL-DATA:BEGIN
var KS_INITIAL_STEPS = [
  [1, '鹿児島中央駅', 'station'],
  [2, '桜島', 'volcano']
];

// 列：歩, 順, 設問ID, 種別, 提示語・例文, 場面・意味・読み, 提案例文（語彙）, 文節の区切り, イラスト, 出す, 記述項目, 調査の狙い
var KS_INITIAL_ITEMS = [
  [1, 1, 'S001', '語彙', '頭', '読み：あたま', '', '', 'head', true, '', '見本'],
  [1, 2, 'S002', '例文', '頭が痛い。', '', '', '頭が｜痛い', 'head', true, '', '見本'],
  [1, 3, 'S003', '語彙', '目', '読み：め', '目が大きい。', '', 'eye', true, '', '見本'],
  [2, 1, 'S004', '例文', '雨が降っている。', '外を見て知らせる。', '', '雨が｜降っている', 'rain umbrella', true, '', '見本'],
  [2, 2, 'S005', '例文', '猫が魚を食べた。', '', '', '猫が｜魚を｜食べた', 'cat fish', true, '', '見本']
];
// KS:INITIAL-DATA:END
