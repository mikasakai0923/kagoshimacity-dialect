/**
 * かごしま ことばさんぽ（市民参加型の方言調査サイト）
 * Google 側の保存プログラム（Google Apps Script）
 *
 * 役割
 *   ・参加者ナンバーとパスワードでログインを確かめる
 *   ・調査項目（「項目」シート）を参加者の画面に渡す
 *   ・回答を「回答」シートに1行ずつ追記し、録音（WAV）を Google ドライブに保存する
 *   ・調査者のための「管理画面」を出す（進み具合・回答と録音の確認・参加者の登録・設定）
 *
 * 使い方は docs/setup-google.md を見てください。
 * このファイルは、回答を保存したいスプレッドシートの
 * 「拡張機能 → Apps Script」に貼り付けて使います。
 */

var KS_VERSION = '0.4.0';
var KS_TZ = 'Asia/Tokyo';
var KS_TOKEN_DAYS = 30;            // ログインの有効日数
var KS_LOGIN_MAX_FAILS = 8;        // この回数まちがえると、しばらくログインできなくなる
var KS_LOGIN_LOCK_SEC = 900;       // ログインできなくなる時間（秒）
var KS_MAX_AUDIO_B64 = 9000000;    // 録音1本の上限（Base64の文字数。約6.7MB）
var KS_MAX_TEXT = 600;             // 文字の回答1欄の上限
var KS_NOISE_WARN_DB = 20;         // 「まわりの音が大きい」と注意を出す目安（設定シートで変えられる）
var KS_SITE_URL = '';              // 参加者に案内するサイトのアドレス（はじめて設定するときの値。あとから「設定」シートで変えられる）
var KS_ADMIN_TOKEN_HOURS = 12;     // 管理画面を開いたままで使える時間
var KS_ADMIN_PAGE_MAX = 200;       // 管理画面の回答の一覧で、1回に渡す行数の上限
var KS_ADMIN_AUDIO_MAX = 8388608;  // 管理画面で再生できる録音の大きさの上限（バイト。8MB）
var KS_ADMIN_MEMO_MAX = 500;       // 管理画面で書ける「メモ」の長さの上限（文字）

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
  ['参加者ナンバーの頭文字', 'K', 'メニュー「参加者を追加」で自動的に作るナンバーの頭文字です。'],
  ['サイトのURL', KS_SITE_URL, '参加者に案内するサイトのアドレスです。管理画面の「参加者の画面を開く」と、参加者カードの印刷に使います。']
];

var KS_STATUSES = ['回答済', '知らない', '使わない', '思い出せない'];


/* ============================================================
 * メニューと初期設定
 * ============================================================ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('方言調査')
    .addItem('管理画面を開く', 'menuOpenAdmin')
    .addSeparator()
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

  // 参加者（列の場所は、見出しの名前から決める。調査者が列を足したり並べかえたりしていても、正しい列を整える）
  sh = ksEnsureSheet_(ss, KS_SHEETS.people, KS_HEADERS.people, made);
  ksAddMissingHeaders_(sh, ['メモ', '登録日', '最終ログイン'], made);      // なくても動く列だけを足す（ナンバー・パスワード・状態は、勝手には足さない）
  var pl = ksPeopleLayout_(sh);
  var pcol = function (name) { var a = ksColA1_(pl.col[name]); return sh.getRange(a + ':' + a); };
  pcol('参加者ナンバー').setNumberFormat('@');   // 「001」のような頭のゼロが消えないように、文字として扱う
  pcol('パスワード').setNumberFormat('@');
  if (pl.found['登録日']) pcol('登録日').setNumberFormat('yyyy-mm-dd hh:mm');
  if (pl.found['最終ログイン']) pcol('最終ログイン').setNumberFormat('yyyy-mm-dd hh:mm');
  sh.setColumnWidth(pl.col['参加者ナンバー'] + 1, 140); sh.setColumnWidth(pl.col['パスワード'] + 1, 120);
  if (pl.found['メモ']) sh.setColumnWidth(pl.col['メモ'] + 1, 240);
  if (pl.found['登録日']) sh.setColumnWidth(pl.col['登録日'] + 1, 140);
  if (pl.found['最終ログイン']) sh.setColumnWidth(pl.col['最終ログイン'] + 1, 140);

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
  if (!sh) throw ksError_('server_error', '「設定」シートが見つかりません。シートの名前を元にもどすか、初期設定をやり直してください。');
  var last = sh.getLastRow();
  var keys = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues() : [];
  var cells = [];
  // 同じ項目の行がいくつもあるときは、どの行が読まれても同じになるように、すべての行に書く
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]).trim() === key) cells.push(sh.getRange(i + 2, 2));
  }
  if (!cells.length) {
    sh.appendRow([key, '', note || '']);
    cells.push(sh.getRange(sh.getLastRow(), 2));
  }
  for (var c = 0; c < cells.length; c++) {
    // 文字の値は「書式なしテキスト」で入れる（「10/20」のような文字が、日付や数字に変わらないように）
    if (typeof value === 'string') cells[c].setNumberFormat('@');
    cells[c].setValue(value);
  }
}

/**
 * 「参加者」シートの列の場所を、1行目の見出しの名前から決めます。
 * 調査者が列を足したり並べかえたりしても、見出しの名前が同じなら、正しい列を読み書きできます。
 *
 * 返すもの：col[見出し] ＝ 列の場所（0 が A列）、found[見出し] ＝ その見出しが見つかったか、missing ＝ 見つからなかった見出し。
 * 見出しが見つからないときは、はじめに作ったときの場所（A列から順）にあるものとして読みます（これまでと同じ動き）。
 * ただし、書きこむのは、見出しが見つかった列だけです（ちがう列に上書きしてしまわないように）。
 */
function ksPeopleLayout_(sheet) {
  var names = KS_HEADERS.people;
  var lastCol = sheet.getLastColumn();
  var head = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var at = Object.create(null);
  for (var i = 0; i < head.length; i++) {
    var h = String(head[i]).trim();
    if (h && at[h] === undefined) at[h] = i;
  }
  var col = {}, found = {}, missing = [];
  for (var n = 0; n < names.length; n++) {
    found[names[n]] = at[names[n]] !== undefined;
    col[names[n]] = found[names[n]] ? at[names[n]] : n;
    if (!found[names[n]]) missing.push(names[n]);
  }
  var width = Math.min(Math.max(head.length, names.length), sheet.getMaxColumns());
  return { col: col, found: found, missing: missing, width: width };
}

/** 列の場所（0 が A列）を、A・B・…・Z・AA・… の文字に直します。 */
function ksColA1_(index) {
  var n = index + 1, out = '';
  while (n > 0) {
    var r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
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
  var layout = ksPeopleLayout_(sh);
  var cId = layout.col['参加者ナンバー'], cPw = layout.col['パスワード'], cStatus = layout.col['状態'];
  var last = sh.getLastRow();
  var ids = last >= 2 ? sh.getRange(2, cId + 1, last - 1, 1).getValues() : [];
  var max = 0;
  var re = new RegExp('^' + prefix + '(\\d+)$');
  for (var i = 0; i < ids.length; i++) {
    var m = re.exec(ksNormId_(ids[i][0]));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  var out = [], colId = [], colPw = [], colStatus = [], colDate = [];
  var now = new Date();
  for (var j = 1; j <= n; j++) {
    var num = String(max + j);
    while (num.length < 3) num = '0' + num;
    var id = prefix + num;
    out.push(id);
    colId.push([id]); colPw.push([ksRandomDigits_(6)]); colStatus.push(['有効']); colDate.push([now]);
  }
  var start = Math.max(last, 1) + 1;
  // シートの行が足りなければ、足してから書く
  var over = start + n - 1 - sh.getMaxRows();
  if (over > 0) sh.insertRowsAfter(sh.getMaxRows(), over + 50);
  // 書くのは、自分の列だけ（調査者が足した列には、さわらない）。パスワードを先に書き、ナンバーを最後に書く
  // （とちゅうで止まっても、「ナンバーはあるのにパスワードがない行」ができないように）
  sh.getRange(start, cPw + 1, n, 1).setNumberFormat('@').setValues(colPw);
  sh.getRange(start, cStatus + 1, n, 1).setValues(colStatus);
  if (layout.found['登録日']) sh.getRange(start, layout.col['登録日'] + 1, n, 1).setValues(colDate);
  sh.getRange(start, cId + 1, n, 1).setNumberFormat('@').setValues(colId);
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
  var query = (e && e.parameter) || {};
  if (Object.prototype.hasOwnProperty.call(query, 'admin')) return ksAdminGet_();
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
    if (person.loginCol) ksSs_().getSheetByName(KS_SHEETS.people).getRange(person.row, person.loginCol).setValue(new Date());
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
  var layout = ksPeopleLayout_(sh);
  var cId = layout.col['参加者ナンバー'], cPw = layout.col['パスワード'], cStatus = layout.col['状態'];
  var vals = sh.getRange(2, 1, last - 1, layout.width).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (ksNormId_(vals[i][cId]) === id) {
      var status = String(vals[i][cStatus] || '').trim();
      return { id: id, password: ksNorm_(vals[i][cPw]), disabled: (status === '停止' || status === '停止中' || status === '無効'), row: i + 2,
               loginCol: layout.found['最終ログイン'] ? layout.col['最終ログイン'] + 1 : 0 };
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
 * 管理画面（調査者のための画面）
 *
 * 開き方は2つあります。
 *   ・スプレッドシートのメニュー「方言調査」→「管理画面を開く」
 *   ・ウェブアプリのURLの最後に「?admin=1」を付けて開く
 *     （このプログラムの持ち主の Google アカウントでログインしているときだけ開けます）
 *
 * 管理画面からの操作は、画面を開いたときに渡す「管理用の印（トークン）」を持っているときだけ受けつけます。
 * 印は、上のどちらかの方法で画面を開いた人にしか渡しません。
 * ============================================================ */

/** メニュー：管理画面を開く（スプレッドシートの上に、大きな窓で開きます） */
function menuOpenAdmin() {
  var ui = SpreadsheetApp.getUi();
  if (!ksIsReady_()) { ui.alert('先に初期設定をしてください（メニュー「方言調査」→「初期設定」）。'); return; }
  ui.showModalDialog(ksAdminPage_('dialog').setWidth(1180).setHeight(640), '方言調査 管理画面');
}

/** ウェブアプリのURLに「?admin=1」を付けて開いたとき */
function ksAdminGet_() {
  if (!ksIsReady_()) {
    return ksPlain_('保存先の初期設定が、まだ終わっていません。\n' +
      'スプレッドシートを開いて、メニュー「方言調査」→「初期設定」を先に行ってください。');
  }
  if (!ksIsOwnerVisit_()) {
    return ksPlain_('この画面は開けませんでした。\n\n' +
      '管理画面は、このスプレッドシートの持ち主の Google アカウントでログインしているときだけ開けます。\n\n' +
      '・ほかの Google アカウントにもログインしているときは、持ち主のアカウントだけでログインした窓\n' +
      '　（シークレット ウィンドウなど）で開いてください。\n' +
      '・それでも開けないときは、スプレッドシートを開いて、\n' +
      '　メニュー「方言調査」→「管理画面を開く」から開いてください。');
  }
  return ksAdminPage_('web');
}

function ksPlain_(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
}

/**
 * いまページを開いているのが、このプログラムの持ち主本人かどうか。
 * ウェブアプリは「自分（持ち主）として実行」されるので、開いた人のメールアドレスが持ち主と同じときだけ本人とみなします。
 * （持ち主以外の人や、ログインしていない人のメールアドレスは、Google の決まりで空になります。）
 */
function ksIsOwnerVisit_() {
  var active = '', effective = '';
  try { active = String(Session.getActiveUser().getEmail() || ''); } catch (err) { active = ''; }
  try { effective = String(Session.getEffectiveUser().getEmail() || ''); } catch (err) { effective = ''; }
  return !!active && active.toLowerCase() === effective.toLowerCase();
}

/** 管理画面のページを作ります。mode は 'web'（URLから）か 'dialog'（メニューから）。 */
function ksAdminPage_(mode) {
  var boot = JSON.stringify({ mode: mode, token: ksMakeAdminToken_(), version: KS_VERSION, hours: KS_ADMIN_TOKEN_HOURS })
    .replace(/</g, '\\u003c');
  var html = KS_ADMIN_HTML.replace('"__KS_BOOT__"', function () { return boot; });
  var out = HtmlService.createHtmlOutput(html).setTitle('方言調査 管理画面');
  if (mode === 'web') out.addMetaTag('viewport', 'width=device-width, initial-scale=1');
  return out;
}

/* ---------- 管理用の印（トークン） ---------- */

function ksMakeAdminToken_() {
  var head = 'adm1.' + (Math.floor(Date.now() / 1000) + KS_ADMIN_TOKEN_HOURS * 3600);
  return head + '.' + ksSign_(head);
}
function ksReadAdminToken_(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'adm1') return false;
  var head = parts[0] + '.' + parts[1];
  var sig = ksSign_(head);
  if (sig.length !== parts[2].length) return false;
  var diff = 0;
  for (var i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ parts[2].charCodeAt(i);
  if (diff !== 0) return false;
  var exp = Number(parts[1]);
  return !!exp && exp * 1000 >= Date.now();
}

/* ---------- 管理画面からの呼び出し口 ---------- */

/**
 * 管理画面のボタンなどから呼ばれます（google.script.run）。返すのは JSON の文字です。
 * token：管理用の印、action：してほしいこと、payloadJson：くわしい内容（JSON の文字）
 */
function ksAdminCall(token, action, payloadJson) {
  var out;
  try {
    if (!ksIsReady_()) throw ksError_('not_ready', '保存先の初期設定がまだ終わっていません。');
    if (!ksReadAdminToken_(token)) throw ksError_('admin_auth', '開いてから時間がたったため、続けられません。管理画面を開き直してください。');
    var p = {};
    if (payloadJson) {
      try { p = JSON.parse(String(payloadJson)); } catch (err) { throw ksError_('bad_request', '送られた内容を読めませんでした。'); }
      if (!p || typeof p !== 'object') p = {};
    }
    switch (String(action || '')) {
      case 'overview':        out = ksAdminOverview_(); break;
      case 'answers':         out = ksAdminAnswers_(p); break;
      case 'audio':           out = ksAdminAudio_(p); break;
      case 'passwords':       out = ksAdminPasswords_(); break;
      case 'addParticipants': out = ksAdminAddParticipants_(p); break;
      case 'setParticipant':  out = ksAdminSetParticipant_(p); break;
      case 'saveSettings':    out = ksAdminSaveSettings_(p); break;
      default: throw ksError_('bad_request', 'この操作には対応していません。');
    }
    out.ok = true;
  } catch (err) {
    if (err && err.ksError) {
      out = { ok: false, error: err.code, message: err.message };
    } else {
      console.error('ksAdminCall error: ' + (err && err.stack ? err.stack : err));
      out = { ok: false, error: 'server_error', message: '保存先でエラーが起きました。時間をおいて、もう一度お試しください。' };
    }
  }
  return JSON.stringify(out);
}

/* ---------- 全体のようす（ダッシュボード・参加者・項目の画面で使う） ---------- */

function ksAdminOverview_() {
  var ss = ksSs_();
  var set = ksSettings_();
  var items = ksReadItems_();
  var steps = ksReadSteps_(items);
  var noiseTh = ksNoiseWarnDb_(set['雑音の注意の目安（dB）']) || KS_NOISE_WARN_DB;
  var problems = [];
  var now = Date.now();
  var todayNo = ksDayNo_(now);

  // 項目
  var itemStep = Object.create(null), itemStat = Object.create(null), stepIndex = Object.create(null);
  var i, j;
  for (i = 0; i < steps.length; i++) stepIndex[steps[i].no] = i;
  for (i = 0; i < items.length; i++) {
    itemStep[items[i].id] = items[i].step;
    itemStat[items[i].id] = [0, 0, 0, 0];           // KS_STATUSES の順（回答済・知らない・使わない・思い出せない）
  }

  // 参加者
  var people = [], byId = Object.create(null);
  function person(id, registered) {
    var p = { id: id, registered: registered, disabled: false, memo: '', registeredAt: 0, lastLoginAt: 0,
              latest: Object.create(null), rows: 0, noisy: 0, noAudio: 0, firstAt: 0, lastAt: 0 };
    byId[id] = p; people.push(p);
    return p;
  }
  if (!ss.getSheetByName(KS_SHEETS.settings)) problems.push('「設定」シートが見つかりません。このままでは、設定を読むことも変えることもできません。シートの名前を元にもどすか、初期設定をやり直してください。');
  if (!ss.getSheetByName(KS_SHEETS.items)) problems.push('「項目」シートが見つかりません。このままでは、参加者の画面に設問が出ません。シートの名前を元にもどしてください。');
  var psh = ss.getSheetByName(KS_SHEETS.people);
  if (!psh) problems.push('「参加者」シートが見つかりません。シートの名前を元にもどすか、初期設定をやり直してください。');
  var plast = psh ? psh.getLastRow() : 0;
  var pl = psh ? ksPeopleLayout_(psh) : null;
  if (pl && pl.missing.length) {
    problems.push('「参加者」シートの1行目に、見出し「' + pl.missing.join('」「') + '」が見つかりません。見出しの名前を元にもどしてください' +
      '（「メモ」「登録日」「最終ログイン」は、初期設定をやり直すと、右はしに足されます）。');
  }
  var pvals = plast >= 2 ? psh.getRange(2, 1, plast - 1, pl.width).getValues() : [];
  for (i = 0; i < pvals.length; i++) {
    var pid = ksNormId_(pvals[i][pl.col['参加者ナンバー']]);
    if (!pid || byId[pid]) continue;
    var pp = person(pid, true);
    var pst = String(pvals[i][pl.col['状態']] || '').trim();
    pp.disabled = (pst === '停止' || pst === '停止中' || pst === '無効');
    pp.memo = ksMemoText_(pvals[i][pl.col['メモ']]);
    pp.registeredAt = ksMs_(pvals[i][pl.col['登録日']]);
    pp.lastLoginAt = ksMs_(pvals[i][pl.col['最終ログイン']]);
  }

  // 回答
  var ash = ss.getSheetByName(KS_SHEETS.answers);
  var layout = null, vals = [];
  if (!ash) {
    problems.push('「回答」シートが見つかりません。このままでは回答を保存できません。シートの名前を元にもどすか、初期設定をやり直してください。');
  } else {
    try { layout = ksAnswerLayout_(ash); }
    catch (err) { problems.push('「回答」シートの1行目の見出しが書きかえられています。このままでは回答を保存できません。見出しを元にもどしてください。'); }
    if (layout && ash.getLastRow() >= 2) vals = ash.getRange(2, 1, ash.getLastRow() - 1, layout.width).getValues();
  }
  var idx = layout ? layout.idx : {};
  var cAt = idx['送信日時'], cPid = idx['参加者ナンバー'], cItem = idx['設問ID'], cStatus = idx['回答の状態'];
  var cLink1 = idx['録音1リンク'], cLink2 = idx['録音2リンク'], cSnr = idx['声と雑音の差（dB）'];
  var daily = Object.create(null);
  var totalRows = 0, audioFiles = 0, noisyRows = 0, noAudioRows = 0, todayRows = 0;
  var order = [];
  for (i = 0; i < vals.length; i++) {
    var v = vals[i];
    var rid = ksNormId_(v[cPid]);
    var itemId = String(v[cItem] == null ? '' : v[cItem]);
    if (!rid || !itemId) continue;
    var t = ksMs_(v[cAt]);
    var status = String(v[cStatus] || '回答済');
    var hasAudio = cLink1 !== undefined && !!v[cLink1];
    var snr = cSnr === undefined ? null : ksNumOrNull_(v[cSnr]);
    var pr = byId[rid] || person(rid, false);
    totalRows++;
    pr.rows++;
    if (hasAudio) audioFiles++;
    if (cLink2 !== undefined && v[cLink2]) audioFiles++;
    if (snr !== null && snr < noiseTh) { noisyRows++; pr.noisy++; }
    if (status === '回答済' && !hasAudio) { noAudioRows++; pr.noAudio++; }
    if (t) {
      if (!pr.firstAt || t < pr.firstAt) pr.firstAt = t;
      if (t > pr.lastAt) pr.lastAt = t;
      var dn = ksDayNo_(t);
      daily[dn] = (daily[dn] || 0) + 1;
      if (dn === todayNo) todayRows++;
    }
    var prev = pr.latest[itemId];
    if (!prev || t >= prev.t) pr.latest[itemId] = { t: t, s: status };
    order.push([t, i]);
  }

  // 参加者ごとの進み具合と、設問ごとの内訳（同じ設問に何度か答えた人は、いちばん新しい回答で数える）
  var started = 0, finished = 0;
  var stepCleared = [];
  for (i = 0; i < steps.length; i++) stepCleared.push(0);
  var outPeople = [];
  for (i = 0; i < people.length; i++) {
    var q = people[i];
    var answered = 0, noAnswer = 0;
    var stepsDone = [];
    for (j = 0; j < steps.length; j++) stepsDone.push(0);
    for (var key in q.latest) {
      if (itemStep[key] === undefined) continue;        // いまは出していない設問
      answered++;
      var si = KS_STATUSES.indexOf(q.latest[key].s);
      if (si < 0) si = 0;
      if (si > 0) noAnswer++;
      itemStat[key][si]++;
      var sx = stepIndex[itemStep[key]];
      if (sx !== undefined) stepsDone[sx]++;
    }
    if (q.rows > 0) started++;
    if (items.length > 0 && answered >= items.length) finished++;
    for (j = 0; j < steps.length; j++) if (stepsDone[j] >= steps[j].count) stepCleared[j]++;
    outPeople.push({
      id: q.id, registered: q.registered, disabled: q.disabled, memo: q.memo,
      registeredAt: q.registeredAt, lastLoginAt: q.lastLoginAt,
      answered: answered, noAnswer: noAnswer, stepsDone: stepsDone,
      rows: q.rows, noisy: q.noisy, noAudio: q.noAudio, firstAt: q.firstAt, lastAt: q.lastAt
    });
  }

  // 日ごとの回答数（直近 180 日ぶん）
  var days = [];
  for (var d in daily) if (Number(d) > todayNo - 180) days.push([ksDayText_(Number(d)), daily[d]]);
  days.sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); });

  // 直近の回答
  order.sort(function (a, b) { return b[0] - a[0] || b[1] - a[1]; });
  var recent = [];
  for (i = 0; i < order.length && i < 8; i++) recent.push(ksAdminRow_(vals[order[i][1]], idx, order[i][1] + 2));

  var outItems = [];
  for (i = 0; i < items.length; i++) {
    var it = items[i];
    outItems.push({ id: it.id, type: it.type, step: it.step, prompt: it.prompt, context: it.context, example: it.example,
                    segments: it.segments, stat: itemStat[it.id] });
  }

  var folder = ksAudioFolderOrNull_();
  if (!folder) problems.push('録音フォルダが見つかりません（ごみ箱に入っていないか確かめてください）。このままでは、録音つきの回答を保存できません。');

  var gid = {};
  var names = [KS_SHEETS.settings, KS_SHEETS.people, KS_SHEETS.steps, KS_SHEETS.items, KS_SHEETS.answers];
  var base = String(ss.getUrl() || '').replace(/[#?].*$/, '');
  for (i = 0; i < names.length; i++) {
    var sh = ss.getSheetByName(names[i]);
    if (sh) gid[names[i]] = base + '#gid=' + sh.getSheetId();
  }

  return {
    version: KS_VERSION,
    at: now,
    today: ksDayText_(todayNo),
    name: String(ss.getName() || ''),
    settings: ksAdminSettings_(set),
    statuses: KS_STATUSES,
    noiseTh: noiseTh,
    steps: steps,
    items: outItems,
    participants: outPeople,
    totals: { participants: outPeople.length, started: started, finished: finished, rows: totalRows, today: todayRows,
              audioFiles: audioFiles, noisy: noisyRows, noAudio: noAudioRows },
    stepCleared: stepCleared,
    daily: days,
    recent: recent,
    problems: problems,
    links: { spreadsheet: base, sheets: gid, audioFolder: folder ? String(folder.getUrl()) : '' }
  };
}

/** 管理画面に渡す設定（「設定」シートの値を、決まった形に直したもの） */
function ksAdminSettings_(set) {
  var maxSec = Number(set['録音の上限（秒）']);
  if (!(maxSec >= 5 && maxSec <= 60)) maxSec = 20;
  var open = String(set['受付'] == null ? '' : set['受付']).trim();
  function text(key) { return set[key] == null ? '' : String(set[key]); }
  return {
    open: !(open === '停止中' || open === '停止'),
    notice: text('お知らせ'),
    instruction: text('教示文'),
    wordQuestion: text('語彙の質問文'),
    sentenceQuestion: text('例文の質問文'),
    maxRecordSec: maxSec,
    noiseWarnDb: ksNoiseWarnDb_(set['雑音の注意の目安（dB）']),
    idPrefix: ksNorm_(set['参加者ナンバーの頭文字'] || 'K').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'K',
    siteUrl: ksHttpsUrl_(text('サイトのURL'))
  };
}

/* ---------- 回答の一覧 ---------- */

/**
 * 回答を、新しい順に、しぼりこんで返します。
 * p.filter = { participant, step, item, status, flag（'noisy'＝雑音が多い／'noaudio'＝録音なし）, q（さがす文字） }
 * p.offset, p.limit
 */
function ksAdminAnswers_(p) {
  var sh = ksSs_().getSheetByName(KS_SHEETS.answers);
  if (!sh) throw ksError_('server_error', '「回答」シートが見つかりません。');
  var layout;
  try { layout = ksAnswerLayout_(sh); }
  catch (err) { throw ksError_('server_error', '「回答」シートの1行目の見出しが書きかえられているため、回答を読めません。見出しを元にもどしてください。'); }
  var idx = layout.idx;
  var noiseTh = ksNoiseWarnDb_(ksSettings_()['雑音の注意の目安（dB）']) || KS_NOISE_WARN_DB;
  var limit = parseInt(p.limit, 10);
  if (!(limit >= 1)) limit = 50;
  if (limit > KS_ADMIN_PAGE_MAX) limit = KS_ADMIN_PAGE_MAX;
  var last = sh.getLastRow();
  if (last < 2) return { total: 0, all: 0, offset: 0, limit: limit, rows: [], noiseTh: noiseTh };
  var vals = sh.getRange(2, 1, last - 1, layout.width).getValues();

  var f = (p.filter && typeof p.filter === 'object') ? p.filter : {};
  var fPid = ksNormId_(f.participant);
  var fStep = parseInt(f.step, 10);
  var fItem = ksNorm_(f.item);
  var fStatus = KS_STATUSES.indexOf(String(f.status)) >= 0 ? String(f.status) : '';
  var fFlag = String(f.flag || '');
  var fq = ksNorm_(f.q).toLowerCase();
  var cAt = idx['送信日時'], cPid = idx['参加者ナンバー'], cItem = idx['設問ID'], cStatus = idx['回答の状態'];
  var cStep = idx['歩'], cLink1 = idx['録音1リンク'], cSnr = idx['声と雑音の差（dB）'];
  var searchCols = ['提示語・例文', '回答（地域の言葉）', '文節（回答）', '提案例文の回答', '別形・意味・補足'];

  var hits = [];
  var all = 0;                 // しぼりこむ前の、回答の件数（管理画面が「新しい回答が届いた」と気づくために使う）
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    var pid = ksNormId_(v[cPid]);
    var itemId = String(v[cItem] == null ? '' : v[cItem]);
    if (!pid || !itemId) continue;
    all++;
    if (fPid && pid !== fPid) continue;
    if (fItem && itemId !== fItem) continue;
    if (fStep >= 1 && (cStep === undefined || Number(v[cStep]) !== fStep)) continue;
    var status = String(v[cStatus] || '回答済');
    if (fStatus && status !== fStatus) continue;
    if (fFlag === 'noisy') {
      var snr = cSnr === undefined ? null : ksNumOrNull_(v[cSnr]);
      if (snr === null || snr >= noiseTh) continue;
    } else if (fFlag === 'noaudio') {
      if (status !== '回答済' || (cLink1 !== undefined && v[cLink1])) continue;
    }
    if (fq) {
      // 全角と半角・大文字と小文字のちがいは気にしない（さがす文字のほうも、同じようにそろえてある）
      var hay = pid + '\n' + ksNorm_(itemId);
      for (var c = 0; c < searchCols.length; c++) {
        var col = idx[searchCols[c]];
        if (col !== undefined && v[col] !== '' && v[col] != null) hay += '\n' + ksNorm_(v[col]);
      }
      if (hay.toLowerCase().indexOf(fq) < 0) continue;
    }
    hits.push([ksMs_(v[cAt]), i]);
  }
  hits.sort(function (a, b) { return b[0] - a[0] || b[1] - a[1]; });

  var total = hits.length;
  var offset = parseInt(p.offset, 10);
  if (!(offset >= 0)) offset = 0;
  if (offset >= total) offset = total > 0 ? Math.floor((total - 1) / limit) * limit : 0;
  var rows = [];
  for (var k = offset; k < total && k < offset + limit; k++) rows.push(ksAdminRow_(vals[hits[k][1]], idx, hits[k][1] + 2));
  return { total: total, all: all, offset: offset, limit: limit, rows: rows, noiseTh: noiseTh };
}

/** 「回答」シートの1行を、管理画面に渡す形に直します。 */
function ksAdminRow_(v, idx, rowNo) {
  function cell(name) { var c = idx[name]; return c === undefined ? '' : v[c]; }
  function text(name) { var x = cell(name); return x == null ? '' : String(x); }
  function audio(nameCol, linkCol) {
    var url = ksHttpsUrl_(text(linkCol));
    return url ? { name: text(nameCol), url: url } : null;
  }
  var info = null;
  var raw = text('技術情報');
  if (raw && raw.length <= 4000) {
    try { info = JSON.parse(raw); } catch (err) { info = null; }
    if (!info || typeof info !== 'object') info = null;
  }
  return {
    n: rowNo,
    at: ksMs_(cell('送信日時')),
    pid: ksNormId_(cell('参加者ナンバー')),
    step: ksNumOrNull_(cell('歩')),
    item: text('設問ID'),
    type: text('種別'),
    prompt: text('提示語・例文'),
    status: text('回答の状態') || '回答済',
    answer: text('回答（地域の言葉）'),
    segP: text('文節（提示）'),
    segA: text('文節（回答）'),
    ex: text('提案例文の回答'),
    note: text('別形・意味・補足'),
    a1: audio('録音1', '録音1リンク'),
    a2: audio('録音2', '録音2リンク'),
    noAudio: text('録音なしの理由'),
    sec: ksNumOrNull_(cell('録音の長さ（秒）')),
    hz: ksNumOrNull_(cell('サンプリング周波数')),
    elapsed: ksNumOrNull_(cell('回答にかかった秒数')),
    device: text('端末'),
    clientTime: text('端末での回答日時'),
    sid: text('送信ID'),
    snr: ksNumOrNull_(cell('声と雑音の差（dB）')),
    info: info
  };
}

/* ---------- 録音を取り出す（管理画面で再生するため） ---------- */

/** p.sid：送信ID、p.slot：'main'（回答の録音）か 'example'（提案例文の録音） */
function ksAdminAudio_(p) {
  var sid = String(p.sid || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sid)) throw ksError_('bad_request', '送信IDが正しくありません。');
  var sh = ksSs_().getSheetByName(KS_SHEETS.answers);
  if (!sh) throw ksError_('server_error', '「回答」シートが見つかりません。');
  var idx = ksAnswerLayout_(sh).idx;
  var linkCol = idx[p.slot === 'example' ? '録音2リンク' : '録音1リンク'];
  var last = sh.getLastRow();
  var url = '';
  if (last >= 2 && linkCol !== undefined) {
    var sids = sh.getRange(2, idx['送信ID'] + 1, last - 1, 1).getValues();
    for (var i = sids.length - 1; i >= 0; i--) {
      if (String(sids[i][0]) === sid) { url = String(sh.getRange(i + 2, linkCol + 1).getValue() || ''); break; }
    }
  }
  var id = ksDriveId_(url);
  if (!id) throw ksError_('not_found', 'この回答には、録音がありません。');
  var file;
  try { file = DriveApp.getFileById(id); }
  catch (err) { throw ksError_('not_found', '録音のファイルが見つかりません（消されたか、このアカウントでは開けないファイルです）。'); }
  if (file.isTrashed()) throw ksError_('not_found', '録音のファイルは、ごみ箱に入っています。');
  // 渡すのは、録音のファイルだけ（「回答」シートのリンクが書きかえられていても、ほかの種類のファイルは渡さない）
  if (String(file.getMimeType() || '').indexOf('audio/') !== 0 && !/\.wav$/i.test(String(file.getName() || ''))) {
    throw ksError_('not_found', 'このリンクの先は、録音のファイルではありません。');
  }
  if (file.getSize() > KS_ADMIN_AUDIO_MAX) {
    throw ksError_('too_large', '録音が大きいため、ここでは再生できません。「ドライブで開く」から聞いてください。');
  }
  var bytes = file.getBlob().getBytes();
  return { name: String(file.getName()), bytes: bytes.length, b64: Utilities.base64Encode(bytes) };
}

/** ドライブのファイルのアドレスから、ファイルのIDを取り出します。 */
function ksDriveId_(url) {
  var m = /\/d\/([A-Za-z0-9_-]{10,})/.exec(String(url || '')) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(String(url || ''));
  return m ? m[1] : '';
}

/* ---------- 参加者 ---------- */

/** 参加者ナンバーとパスワードの一覧（管理画面で「パスワードを表示」を押したとき・カードを印刷するとき） */
function ksAdminPasswords_() {
  var sh = ksSs_().getSheetByName(KS_SHEETS.people);
  var last = sh ? sh.getLastRow() : 0;
  var layout = sh ? ksPeopleLayout_(sh) : null;
  var vals = last >= 2 ? sh.getRange(2, 1, last - 1, layout.width).getValues() : [];
  var list = [], seen = Object.create(null);
  for (var i = 0; i < vals.length; i++) {
    var id = ksNormId_(vals[i][layout.col['参加者ナンバー']]);
    if (!id || seen[id]) continue;
    seen[id] = true;
    list.push({ id: id, password: ksNorm_(vals[i][layout.col['パスワード']]) });
  }
  return { list: list };
}

function ksAdminAddParticipants_(p) {
  var count = (typeof p.count === 'number' || typeof p.count === 'string') ? ksNorm_(p.count) : '';
  var n = /^\d{1,2}$/.test(count) ? parseInt(count, 10) : 0;      // 「2.5」や「1e1」のような書き方は受けつけない
  if (!(n >= 1 && n <= 50)) throw ksError_('invalid', '1〜50の数字を入れてください。');
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (err) { throw ksError_('busy', 'いまこみあっています。少し待ってから、もう一度お試しください。'); }
  var ids;
  try {
    ids = addParticipants(n);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  var want = Object.create(null);
  for (var i = 0; i < ids.length; i++) want[ids[i]] = true;
  var all = ksAdminPasswords_().list;
  var added = [];
  for (var j = 0; j < all.length; j++) if (want[all[j].id]) added.push(all[j]);
  return { added: added };
}

/** 参加者の「状態」（有効・停止）や「メモ」を書きかえます。p = { id, status, memo } */
function ksAdminSetParticipant_(p) {
  var id = ksNormId_(p.id);
  if (!id) throw ksError_('bad_request', '参加者ナンバーがありません。');
  var sh = ksSs_().getSheetByName(KS_SHEETS.people);
  if (!sh) throw ksError_('server_error', '「参加者」シートが見つかりません。シートの名前を元にもどしてください。');
  var layout = ksPeopleLayout_(sh);
  var cId = layout.col['参加者ナンバー'], cStatus = layout.col['状態'], cMemo = layout.col['メモ'];
  var last = sh.getLastRow();
  var vals = last >= 2 ? sh.getRange(2, 1, last - 1, layout.width).getValues() : [];
  var row = 0;
  for (var i = 0; i < vals.length; i++) if (ksNormId_(vals[i][cId]) === id) { row = i + 2; break; }
  if (!row) throw ksError_('not_found', 'この参加者ナンバーは、「参加者」シートに見つかりません。');
  var status = String(vals[row - 2][cStatus] || '').trim();
  var memo = ksMemoText_(vals[row - 2][cMemo]);

  // 先に、ぜんぶの中身を確かめる（かたほうだけ書いてから、もうかたほうでことわることがないように）
  var newStatus = null, newMemo = null;
  if (p.status !== undefined) {
    if (p.status !== '有効' && p.status !== '停止') throw ksError_('invalid', '状態は「有効」か「停止」にしてください。');
    // 見出しが見つからない列には、書かない（ちがう列を上書きしてしまわないように）
    if (!layout.found['状態']) throw ksError_('invalid', '「参加者」シートの1行目に、見出し「状態」が見つかりません。見出しの名前を元にもどしてから、もう一度お試しください。');
    newStatus = p.status;
  }
  if (p.memo !== undefined) {
    if (!layout.found['メモ']) throw ksError_('invalid', '「参加者」シートの1行目に、見出し「メモ」が見つかりません。見出しの名前を元にもどすか、メニュー「方言調査」→「初期設定」で列を足してから、もう一度お試しください。');
    var raw = String(p.memo == null ? '' : p.memo).replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    // 長すぎるときは、切らずにことわる（だまって後ろを切ると、書いたものがなくなってしまうため）
    if (raw.length > KS_ADMIN_MEMO_MAX) {
      throw ksError_('invalid', 'メモは ' + KS_ADMIN_MEMO_MAX + ' 文字までにしてください（いまは ' + raw.length + ' 文字です）。長いメモは、スプレッドシートの「参加者」シートに直接書いてください。');
    }
    newMemo = ksText_(raw, KS_ADMIN_MEMO_MAX);
  }
  if (newStatus !== null) {
    status = newStatus;
    sh.getRange(row, cStatus + 1).setValue(status);
    // 「停止」にしたら、すぐに送信できなくなるように、覚えてある状態を消す
    CacheService.getScriptCache().remove('person:' + id);
  }
  if (newMemo !== null) {
    memo = newMemo.replace(/^'/, '');
    sh.getRange(row, cMemo + 1).setNumberFormat('@').setValue(newMemo);
  }
  SpreadsheetApp.flush();
  return { participant: { id: id, disabled: (status === '停止' || status === '停止中' || status === '無効'), memo: memo } };
}

/* ---------- 設定 ---------- */

/** 管理画面の「設定」で保存を押したとき。p.values = { 設定シートの項目名: 値 } */
function ksAdminSaveSettings_(p) {
  var values = (p.values && typeof p.values === 'object') ? p.values : {};
  var clean = {};
  function has(key) { return Object.prototype.hasOwnProperty.call(values, key); }
  function fail(message) { throw ksError_('invalid', message); }

  if (has('受付')) {
    if (values['受付'] !== '受付中' && values['受付'] !== '停止中') fail('受付は「受付中」か「停止中」にしてください。');
    clean['受付'] = values['受付'];
  }
  // 文章。長すぎるときは、切らずにことわる（だまって後ろを切ると、書いたものがなくなってしまうため）
  function text(key, max) {
    var raw = String(values[key] == null ? '' : values[key]).replace(/\r\n?/g, '\n').trim();
    if (raw.length > max) fail('「' + key + '」は ' + max + ' 文字までにしてください（いまは ' + raw.length + ' 文字です）。');
    return ksText_(raw, max);
  }
  if (has('お知らせ')) clean['お知らせ'] = text('お知らせ', 300);
  if (has('教示文')) clean['教示文'] = text('教示文', 400);
  if (has('語彙の質問文')) {
    clean['語彙の質問文'] = text('語彙の質問文', 200);
    if (clean['語彙の質問文'].indexOf('{語}') < 0) fail('語彙の質問文には、提示語が入る場所「{語}」を入れてください。');
  }
  if (has('例文の質問文')) {
    clean['例文の質問文'] = text('例文の質問文', 200);
    if (clean['例文の質問文'].indexOf('{文}') < 0) fail('例文の質問文には、例文が入る場所「{文}」を入れてください。');
  }
  // 数字。ふつうの書き方（「30」「17.5」）だけを受けつける（「1e1」「0x10」のような書き方は、ことわる）
  function digits(key) {
    var v = values[key];
    return (typeof v === 'number' || typeof v === 'string') ? ksNorm_(v) : '';
  }
  if (has('録音の上限（秒）')) {
    var secText = digits('録音の上限（秒）');
    var sec = /^\d{1,2}$/.test(secText) ? parseInt(secText, 10) : NaN;
    if (!(sec >= 5 && sec <= 60)) fail('録音の上限は、5〜60の数字（秒）にしてください。');
    clean['録音の上限（秒）'] = sec;
  }
  if (has('雑音の注意の目安（dB）')) {
    var dbText = digits('雑音の注意の目安（dB）');
    var db = /^\d{1,2}(\.\d)?$/.test(dbText) ? Number(dbText) : NaN;
    if (!(db === 0 || (db >= 5 && db <= 40))) {
      fail('雑音の注意の目安は、5〜40の数字にしてください（注意を出さないときは 0）。');
    }
    clean['雑音の注意の目安（dB）'] = db;
  }
  if (has('参加者ナンバーの頭文字')) {
    var prefix = ksNorm_(values['参加者ナンバーの頭文字']).toUpperCase();
    if (!/^[A-Z0-9]{1,4}$/.test(prefix)) fail('参加者ナンバーの頭文字は、半角の英数字1〜4文字にしてください。');
    clean['参加者ナンバーの頭文字'] = prefix;
  }
  if (has('サイトのURL')) {
    var url = ksNorm_(values['サイトのURL']);
    if (url && (!ksHttpsUrl_(url) || url.length > 200)) fail('サイトのURLは、https:// で始まるアドレスにしてください。');
    clean['サイトのURL'] = url;
  }

  var ss = ksSs_();
  if (!ss.getSheetByName(KS_SHEETS.settings)) throw ksError_('invalid', '「設定」シートが見つかりません。シートの名前を元にもどすか、初期設定をやり直してから、もう一度お試しください。');
  for (var key in clean) ksSetSetting_(ss, key, clean[key], '');
  SpreadsheetApp.flush();
  return { settings: ksAdminSettings_(ksSettings_()) };
}

/* ---------- 管理画面のための小さな道具 ---------- */

/**
 * 「メモ」のセルの値を、画面に出す文字に直す。
 * スプレッドシートに直接「10/20」と書くと、表が日付に直してしまうことがあるので、そのときは日付の形の文字にする。
 */
function ksMemoText_(v) {
  if (v == null) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, KS_TZ, 'yyyy/MM/dd');
  return String(v);
}
/** 日付の入ったセルの値を、1970年からのミリ秒に直す（日付でなければ 0）。 */
function ksMs_(v) {
  return (v instanceof Date && !isNaN(v.getTime())) ? v.getTime() : 0;
}
/** 数字なら数字を、そうでなければ null を返す。 */
function ksNumOrNull_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(v)) return Number(v);
  return null;
}
/** https:// で始まるアドレスならそのまま、そうでなければ空の文字を返す（画面のリンクに使ってよいものだけを通す）。 */
function ksHttpsUrl_(v) {
  var s = String(v == null ? '' : v).trim();
  return /^https:\/\/[^\s"'<>\\]+$/.test(s) ? s : '';
}
/** 日本時間で数えた「日」の番号（1970-01-01 が 0）。日本には夏時間がないので、9時間ずらして割るだけでよい。 */
function ksDayNo_(ms) {
  return Math.floor((ms + 9 * 3600000) / 86400000);
}
/** 「日」の番号を 2026-10-12 の形の文字に直す。 */
function ksDayText_(dayNo) {
  var d = new Date(dayNo * 86400000);
  function two(n) { return n < 10 ? '0' + n : String(n); }
  return d.getUTCFullYear() + '-' + two(d.getUTCMonth() + 1) + '-' + two(d.getUTCDate());
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
  if (/^[=+\-@']/.test(s)) s = "'" + s;      // 先頭の ' は表が「文字のしるし」として取ってしまうので、' で始まる文字にも ' を足す
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
 * 管理画面の中身（HTML）
 * tools/build-gas.js が gas/admin.html から作ります。ここを手で書きかえないでください。
 * ============================================================ */

// KS:ADMIN-HTML:BEGIN
var KS_ADMIN_HTML = [
"<!DOCTYPE html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"robots\" content=\"noindex, nofollow\">\n<base target=\"_blank\">\n<title>方言調査 管理画面</title>\n<style>\n/* 方言調査 管理画面 — 見た目\n *\n * 参加者のサイト（かごしま ことばさんぽ）と同じ色・同じ決まりで作る：\n *   押せるもの（ボタン・えらんだメニュー）は「藍色の太い線＋下の影」、読むだけの面は「細い線」。\n * 進み具合は、すごろくのマスをならべた形で見せる。\n */\n:root {\n  color-scheme: light;\n  --ink: #1D2B53;\n  --ink-2: #4A5680;\n  --ink-3: #5C6789;\n  --sky: #E6F5F9;\n  --plane: #F4F8FB;\n  --card: #FFFFFF;\n  --line: #D5DEEA;\n  --line-2: #E8EDF4;\n  --link: #0E5A75;\n  --bay-pale: #D3EEF5;\n  --mikan: #FF9A2E;\n  --leaf: #37B679;\n  --leaf-pale: #DCF5E7;\n  --sun: #FFD84D;\n  --sun-pale: #FFF3BF;\n  --rec: #D13B40;\n  --rec-deep: #B4232A;\n  --rec-pale: #FFE4E5;\n  --ash: #C9CEDA;\n  --ash-pale: #EEF1F6;\n  /* グラフの色。色覚のちがいがあっても、どの2色がとなり合っても見分けられる組み合わせを、道具で確かめたもの */\n  --series-1: #1284B0;\n  --series-2: #EB6834;\n  --series-3: #1BAF7A;\n  --series-4: #6250D6",
";\n  --grid: #E3EAF2;\n  --axis: #BCC8D8;\n  --drop: 0 3px 0 var(--ink);\n  --font: \"Hiragino Sans\", \"Hiragino Kaku Gothic ProN\", \"Yu Gothic UI\", \"Meiryo\", \"Noto Sans JP\", system-ui, -apple-system, \"Segoe UI\", sans-serif;\n}\n*, *::before, *::after { box-sizing: border-box; }\n/* scroll-padding：Tab キーで下のほうの入力欄へ移ったとき、画面の下にとどまる「保存」の帯のうしろに、かくれないようにする */\nhtml { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; scroll-padding-bottom: 116px; }\nbody {\n  margin: 0; background: var(--plane); color: var(--ink);\n  font-family: var(--font); font-size: 15px; line-height: 1.6; -webkit-font-smoothing: antialiased;\n  overflow-wrap: anywhere; line-break: strict;\n}\nh1, h2, h3, p, ul, ol, dl, dd, figure { margin: 0; }\nul, ol { padding: 0; list-style: none; }\nbutton, input, select, textarea { font: inherit; color: inherit; }\nbutton { cursor: pointer; }\nbutton:disabled { cursor: default; }\na { color: var(--li",
"nk); }\n:focus-visible { outline: 3px solid #2AA9C9; outline-offset: 2px; }\n.icon { display: block; width: 20px; height: 20px; }\n.sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }\n.num { font-variant-numeric: tabular-nums; }\n.muted { color: var(--ink-2); }\n.nowrap { white-space: nowrap; }\n\n/* ---------- 骨組み ---------- */\n.app { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100vh; min-height: 100dvh; }\n.side {\n  position: sticky; top: 0; align-self: start; height: 100vh; height: 100dvh; overflow-y: auto;\n  display: flex; flex-direction: column; padding: 18px 14px 14px;\n  background: var(--sky); border-right: 2px solid var(--ink);\n}\n.brand { display: flex; align-items: center; padding: 0 6px 14px; }\n.brand__mark { width: 46px; flex: none; margin",
"-right: 10px; }\n.brand__mark svg { display: block; width: 100%; height: auto; }\n.brand__name { font-weight: 700; font-size: 17px; line-height: 1.3; }\n.brand__sub { display: block; font-size: 12.5px; font-weight: 500; color: var(--ink-2); }\n.side__site { margin: 0 2px 16px; }\n.side__site .btn { width: 100%; }\n.nav { display: grid; gap: 6px; }\n.nav__item {\n  display: flex; align-items: center; width: 100%; padding: 9px 12px;\n  border: 2px solid transparent; border-radius: 12px; background: transparent;\n  text-align: left; font-weight: 700; font-size: 15px; color: var(--ink);\n}\n.nav__item:hover:not(:disabled) { background: rgba(255, 255, 255, .65); }\n.nav__item[aria-current=\"page\"] { background: #fff; border-color: var(--ink); box-shadow: var(--drop); }\n.nav__item:disabled, .tabs__item:disabled { opacity: .45; }\n.nav__icon { flex: none; margin-right: 10px; }\n.side__foot { margin-top: auto; ",
"padding-top: 18px; display: grid; gap: 2px; font-size: 13.5px; }\n.side__link { display: flex; align-items: center; padding: 6px 8px; border-radius: 8px; color: var(--ink); text-decoration: none; font-weight: 500; white-space: nowrap; }\n.side__link:hover { background: rgba(255, 255, 255, .65); }\n.side__link .icon { width: 18px; height: 18px; margin-right: 8px; flex: none; }\n.side__ver { padding: 8px 8px 0; color: var(--ink-2); font-size: 12px; }\n.main { min-width: 0; padding: 26px 30px 64px; }\n.main__inner { max-width: 1180px; margin: 0 auto; }\n.is-loading .main__inner { opacity: .62; transition: opacity 200ms ease; }\n.tabs { display: none; }\n.app[data-mode=\"dialog\"] { grid-template-columns: 212px minmax(0, 1fr); }\n.app[data-mode=\"dialog\"] .main { padding: 18px 20px 40px; }\n.app[data-mode=\"dialog\"] .side { padding-left: 12px; padding-right: 12px; }\n.app[data-mode=\"dialog\"] .side__foot { f",
"ont-size: 13px; }\n\n/* ---------- ボタン ---------- */\n.btn {\n  display: inline-flex; align-items: center; justify-content: center;\n  min-height: 40px; padding: 6px 16px;\n  border: 2px solid var(--ink); border-radius: 12px; background: #fff; color: var(--ink);\n  box-shadow: var(--drop); font-weight: 700; font-size: 14.5px; line-height: 1.3; text-decoration: none; white-space: nowrap;\n  transition: transform 70ms ease, box-shadow 70ms ease;\n}\n.btn:active:not(:disabled) { transform: translateY(3px); box-shadow: 0 0 0 var(--ink); }\n.btn--primary { background: var(--mikan); }\n.btn--danger { background: var(--rec-pale); }\n.btn--small { min-height: 32px; padding: 3px 11px; font-size: 13px; border-radius: 10px; box-shadow: 0 2px 0 var(--ink); }\n.btn--small:active:not(:disabled) { transform: translateY(2px); }\n.btn:disabled { background: var(--ash-pale); color: var(--ink-3); border-color: var(--ash)",
"; box-shadow: 0 3px 0 var(--ash); }\n.btn--small:disabled { box-shadow: 0 2px 0 var(--ash); }\n.btn .icon { width: 18px; height: 18px; margin-right: 6px; }\n.btn--small .icon { width: 15px; height: 15px; margin-right: 5px; }\n.textbtn {\n  display: inline-flex; align-items: center; padding: 2px 6px; margin: 0 -6px; border: 0; border-radius: 6px; background: none;\n  color: var(--link); font-weight: 700; font-size: 13.5px; text-decoration: underline; text-underline-offset: 3px; white-space: nowrap;\n}\n.textbtn:hover:not(:disabled) { background: var(--bay-pale); }\n.textbtn:disabled { color: var(--ink-3); text-decoration: none; }\n.textbtn .icon { width: 15px; height: 15px; margin-right: 4px; }\n.spin { animation: spin 900ms linear infinite; }\n@keyframes spin { to { transform: rotate(360deg); } }\n\n/* ---------- 見出し・カード ---------- */\n.head { display: flex; align-items: flex-end; justify-content: spac",
"e-between; flex-wrap: wrap; gap: 10px 16px; margin-bottom: 18px; }\n.head__title { font-size: 26px; line-height: 1.3; font-weight: 700; letter-spacing: .01em; outline: none; }\n.head__sub { margin-top: 2px; color: var(--ink-2); font-size: 14px; }\n.head__tools { display: flex; align-items: center; gap: 10px; }\n.head__time { color: var(--ink-2); font-size: 13px; }\n.stack > * + * { margin-top: 16px; }\n.grid { display: grid; gap: 16px; }\n.grid--tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); }\n.grid--2-1 { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }\n.grid--1-1 { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n.card { background: var(--card); border: 1.5px solid var(--line); border-radius: 18px; padding: 18px 20px; min-width: 0; }\n.card__head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; margin-bottom: 12px; }\n.ca",
"rd__title { font-size: 16px; font-weight: 700; }\n.card__tools { display: flex; align-items: center; gap: 10px; }\n.card__note { margin-top: 12px; color: var(--ink-2); font-size: 13px; }\n.empty { padding: 22px 8px; text-align: center; color: var(--ink-2); font-size: 14px; }\n\n/* ---------- 数字のカード ---------- */\n.tile { background: #fff; border: 1.5px solid var(--line); border-radius: 18px; padding: 15px 18px 14px; min-width: 0; }\n.tile__label { color: var(--ink-2); font-size: 13.5px; font-weight: 700; }\n.tile__value { display: flex; align-items: baseline; margin-top: 1px; font-size: 32px; line-height: 1.3; font-weight: 700; letter-spacing: .01em; }\n.tile__unit { font-size: 16px; margin-left: 3px; }\n.tile__value--state { align-items: center; font-size: 26px; line-height: 1.6; }\n.tile__sub { margin-top: 1px; color: var(--ink-2); font-size: 13px; }\n.dot { flex: none; width: 14px; height: 14px; ",
"margin-right: 9px; border-radius: 50%; border: 2px solid var(--ink); background: var(--leaf); }\n.dot--stop { background: var(--rec); border-radius: 3px; }\n\n/* ---------- 知らせ ---------- */\n.notice { display: flex; align-items: flex-start; padding: 12px 14px; border: 1.5px solid #B9DCE8; border-radius: 14px; background: var(--sky); font-size: 14px; }\n.notice .icon { flex: none; margin: 1px 10px 0 0; }\n.notice--bad { background: var(--rec-pale); border: 2px solid var(--rec-deep); }\n.notice--new { background: var(--leaf-pale); border-color: #9AD8B7; align-items: center; margin-bottom: 14px; }\n.notice--new .icon { margin-top: 0; }\n.notice__grow { flex: 1 1 auto; min-width: 0; }\n.notice .btn { flex: none; margin-left: 12px; }\n.flags { display: flex; flex-wrap: wrap; gap: 10px; }\n.flag {\n  display: inline-flex; align-items: center; padding: 5px 13px 5px 10px;\n  border: 2px solid var(--ink); bor",
"der-radius: 999px; background: var(--sun-pale); box-shadow: 0 2px 0 var(--ink);\n  font-weight: 700; font-size: 13.5px;\n}\n.flag:active { transform: translateY(2px); box-shadow: none; }\n.flag .icon { width: 17px; height: 17px; margin-right: 6px; }\n\n/* ---------- 小さな札 ---------- */\n.pid {\n  display: inline-block; flex: none; padding: 0 8px; border: 1.5px solid var(--ink); border-radius: 8px; background: var(--sky);\n  font-weight: 700; font-size: 13px; line-height: 21px; letter-spacing: .03em; font-variant-numeric: tabular-nums; white-space: nowrap;\n  max-width: 13em; overflow: hidden; text-overflow: ellipsis; vertical-align: middle;\n}\nbutton.pid:hover { background: #fff; }\n.chip {\n  display: inline-flex; align-items: center; flex: none; padding: 0 9px; border: 1.5px solid var(--ink-2); border-radius: 999px; background: #fff;\n  font-size: 12.5px; font-weight: 700; line-height: 21px; white-sp",
"ace: nowrap;\n}\n.chip .icon { width: 13px; height: 13px; margin-right: 4px; }\n.chip--ok { background: var(--leaf-pale); border-color: var(--ink); }\n.chip--warn { background: var(--sun-pale); border-color: var(--ink); }\n.chip--stop { background: var(--rec-pale); border-color: var(--rec-deep); }\n.chip--mute { background: var(--ash-pale); border-color: var(--ash); color: var(--ink-2); }\n\n/* ---------- すごろくのマス（進み具合） ---------- */\n.strip { display: inline-flex; flex: none; flex-wrap: wrap; gap: 3px; vertical-align: middle; }\n.strip__cell { position: relative; flex: none; width: 17px; height: 17px; border-radius: 5px; background: var(--ash-pale); border: 1.5px solid var(--ash); overflow: hidden; }\n.strip__cell[data-state=\"done\"] { background: var(--leaf); border-color: var(--ink); }\n.strip__cell[data-state=\"part\"] { background: #fff; border-color: var(--ink-2); }\n.strip__cell[data-state=\"part\"]",
"::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: var(--part, 50%); background: var(--leaf); opacity: .6; }\n.progress { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; }\n.table .progress { flex-wrap: nowrap; }\n.progress__count { font-size: 13px; color: var(--ink-2); font-variant-numeric: tabular-nums; white-space: nowrap; }\n\n/* ---------- グラフ ---------- */\n.seg { display: inline-flex; padding: 3px; border-radius: 10px; background: var(--ash-pale); }\n.seg__btn { border: 0; background: transparent; padding: 3px 12px; border-radius: 8px; font-size: 13px; font-weight: 700; color: var(--ink-2); }\n.seg__btn[aria-pressed=\"true\"] { background: #fff; color: var(--ink); box-shadow: 0 0 0 1.5px var(--ink); }\n.card--chart { display: flex; flex-direction: column; }\n#chart-plot { flex: 1 1 auto; min-height: 224px; }\n.chart { position: relative; outlin",
"e: none; border-radius: 8px; }\n.chart:focus-visible { box-shadow: 0 0 0 3px #2AA9C9; }\n.chart svg { display: block; }\n.chart text { font-family: var(--font); font-size: 11.5px; fill: var(--ink-3); font-variant-numeric: tabular-nums; }\n.chart text.chart__none { font-size: 13.5px; fill: var(--ink-2); }\n.chart__bar { fill: var(--series-1); }\n.chart__bar[data-on=\"true\"] { fill: #0C6A90; }\n.chart__tip {\n  position: absolute; z-index: 2; pointer-events: none; transform: translate(-50%, -100%);\n  padding: 5px 10px 6px; border-radius: 10px; background: var(--ink); color: #fff; font-size: 12px; line-height: 1.45; white-space: nowrap; text-align: center;\n}\n.chart__tip strong { display: block; font-size: 15px; }\n.chart__table { max-height: 232px; overflow-y: auto; }\n.steps { display: grid; grid-template-columns: minmax(0, 1fr); gap: 11px; max-height: 452px; overflow-y: auto; }\n.steprow__label { dis",
"play: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; font-size: 13.5px; }\n.steprow__name { font-weight: 700; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px; }\n.steprow__val { flex: none; color: var(--ink-2); font-variant-numeric: tabular-nums; }\n.meter { height: 12px; border-radius: 6px; background: var(--bay-pale); overflow: hidden; }\n.meter__fill { height: 100%; min-width: 0; background: var(--series-1); border-radius: 0 6px 6px 0; }\n\n/* ---------- 一覧 ---------- */\n.list__row { padding: 11px 0; border-top: 1.5px solid var(--line-2); }\n.list__row:first-child { border-top: 0; padding-top: 2px; }\n.list__row:last-child { padding-bottom: 2px; }\n.list__top { display: flex; align-items: center; gap: 8px; }\n.list__grow { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap",
"; color: var(--ink-2); font-size: 13.5px; }\n.list__time { flex: none; color: var(--ink-2); font-size: 12.5px; white-space: nowrap; }\n.list__main { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin-top: 5px; }\n.answer { font-weight: 700; font-size: 15.5px; }\n.answer__sub { display: block; margin-top: 2px; color: var(--ink-2); font-size: 13px; font-weight: 500; }\n.audio { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; }\n.playbtn {\n  display: inline-flex; align-items: center; min-height: 30px; padding: 2px 11px 2px 8px;\n  border: 2px solid var(--ink); border-radius: 999px; background: #fff; box-shadow: 0 2px 0 var(--ink);\n  font-size: 13px; font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums;\n}\n.playbtn:active { transform: translateY(2px); box-shadow: none; }\n.playbtn .icon { width: 15px; height: 15px; margin-right: 5px; ",
"}\n.playbtn[data-state=\"playing\"] { background: var(--mikan); }\n.playbtn[data-state=\"loading\"] { color: var(--ink-2); }\n\n/* ---------- 表 ----------\n * 表の中に、もうひとつ小さな表（文節ごとの回答）が入ることがあるので、決まりは「すぐ下の子」だけに当てる。 */\n.tablewrap { position: relative; overflow-x: auto; margin: 0 -20px; padding: 0 20px; }\n.table { width: 100%; border-collapse: collapse; font-size: 14px; }\n.table > thead > tr > th { text-align: left; vertical-align: middle; font-size: 12.5px; color: var(--ink-2); font-weight: 700; padding: 6px 10px 8px; border-bottom: 1.5px solid var(--line); white-space: nowrap; }\n.table > tbody > tr > td { padding: 11px 10px; border-bottom: 1.5px solid var(--line-2); vertical-align: top; }\n.table > tbody > tr:last-child > td { border-bottom: 0; }\n.table > thead > tr > th:first-child, .table > tbody > tr > td:first-child { padding-left: 0; }\n.table > thead > tr > th:last-child, .table > tbody > tr > t",
"d:last-child { padding-right: 0; }\n.table > thead > tr > .right, .table > tbody > tr > .right { text-align: right; }\n.table > tbody > tr[data-off=\"true\"] > td { background: #FAFBFD; }\n.cell-q { min-width: 180px; max-width: 320px; }\n.cell-q__id, .subline { display: block; margin-top: 2px; color: var(--ink-3); font-size: 12.5px; }\n.cell-a { min-width: 160px; max-width: 340px; }\n.table > tbody > tr.detail > td { background: #FAFCFE; padding: 14px 16px 16px; }\n.detail__box > * + * { margin-top: 14px; }\n.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr) max-content minmax(0, 1fr); gap: 4px 14px; font-size: 13.5px; }\n.kv dt { color: var(--ink-2); }\n.kv dd { margin-right: 14px; }\n.kv__parts { display: flex; flex-wrap: wrap; gap: 0 14px; }\n.segs__wrap { overflow-x: auto; }\n.segs { border-collapse: collapse; font-size: 14px; background: #fff; }\n.segs th, .segs td { border: 1.5",
"px solid var(--line); padding: 5px 12px; text-align: center; white-space: nowrap; }\n.segs th { background: var(--ash-pale); font-weight: 500; color: var(--ink-2); font-size: 13px; }\n.segs td { font-weight: 700; }\n.detail__links { display: flex; flex-wrap: wrap; gap: 8px 18px; }\n.pager { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-top: 14px; padding-top: 14px; border-top: 1.5px solid var(--line-2); font-size: 13.5px; color: var(--ink-2); }\n.pager__btns { display: flex; gap: 10px; }\n.table--items { table-layout: fixed; }\n.table--items .col-n { width: 96px; }\n.table--items .col-bar { width: 30%; }\n.table--items .col-go { width: 96px; }\n.table--items .cell-q { max-width: none; }\n.stackbar { display: flex; height: 12px; min-width: 120px; }\n.stackbar__seg { height: 100%; margin-right: 2px; }\n.stackbar__seg:first-child { border-radius: ",
"4px 0 0 4px; }\n.stackbar__seg:last-child { margin-right: 0; border-radius: 0 4px 4px 0; }\n.stackbar__seg:only-child { border-radius: 4px; }\n.stackbar--none { background: var(--ash-pale); border-radius: 4px; }\n.legend { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 13px; color: var(--ink-2); }\n.legend__item { display: inline-flex; align-items: center; }\n.legend__key { width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; }\n.breakdown { margin-top: 4px; font-size: 12.5px; color: var(--ink-2); }\n.stephead { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; margin: 22px 0 6px; }\n.stephead:first-child { margin-top: 0; }\n.stephead__title { font-size: 15px; font-weight: 700; }\n\n/* 表が横に入りきらないとき・スマートフォンでは、1行を1枚のカードの形にする（JavaScript が is-stacked を付ける） */\n.table--stack.is-stacked > thead { display: none; }\n.pickall.pickall--stack { display: none; }\n.has-st",
"acked > .pickall.pickall--stack { display: flex; padding: 2px 0 12px; border-bottom: 1.5px solid var(--line-2); font-size: 13.5px; font-weight: 700; }\n.table--stack.is-stacked, .table--stack.is-stacked > tbody, .table--stack.is-stacked > tbody > tr, .table--stack.is-stacked > tbody > tr > td { display: block; }\n.table--stack.is-stacked { table-layout: auto; }\n.table--stack.is-stacked > tbody > tr { padding: 12px 0; border-bottom: 1.5px solid var(--line-2); }\n.table--stack.is-stacked > tbody > tr:last-child { border-bottom: 0; }\n.table--stack.is-stacked > tbody > tr > td { padding: 3px 0; border: 0; max-width: none; min-width: 0; width: auto; }\n.table--stack.is-stacked > tbody > tr > td:empty { display: none; }\n.table--stack.is-stacked > tbody > tr > td[data-label] { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 8px; align-items: start; justify-items: start; }\n.table--st",
"ack.is-stacked > tbody > tr > td[data-label]::before { content: attr(data-label); color: var(--ink-2); font-size: 12.5px; padding-top: 2px; }\n.table--stack.is-stacked > tbody > tr > td[data-label] > .grow { justify-self: stretch; }\n.table--stack.is-stacked > tbody > tr > td.right { text-align: left; }\n.table--stack.is-stacked > tbody > tr.detail { border-bottom: 1.5px solid var(--line-2); padding: 0 0 12px; }\n.table--stack.is-stacked > tbody > tr.detail > td { padding: 12px; border-radius: 12px; }\n.table--stack.is-stacked .rowactions { justify-content: flex-start; }\n.table--stack.is-stacked .progress { flex-wrap: wrap; }\n/* 参加者の表：あまった幅は、メモの列に回す（メモを読みやすく、書きやすくする） */\n.table--people:not(.is-stacked) > tbody > tr > td.c-memo { width: 36%; }\n/* 回答：1件を、ひとまとまりの小さなカードにする */\n.table--answers.is-stacked > tbody > tr.arow { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }\n.table",
"--answers.is-stacked .c-pid { order: 1; align-self: flex-start; }\n.table--answers.is-stacked .c-q { order: 2; flex: 1 1 0; align-self: flex-start; color: var(--ink-2); font-size: 13.5px; }\n.table--answers.is-stacked .c-time { order: 3; align-self: flex-start; color: var(--ink-2); font-size: 12.5px; }\n.table--answers.is-stacked .c-a { order: 4; flex: 0 0 100%; }\n.table--answers.is-stacked .c-audio { order: 5; }\n.table--answers.is-stacked .c-snr { order: 6; font-size: 13px; }\n.table--answers.is-stacked .c-snr::before { content: '声と雑音の差 '; color: var(--ink-2); font-size: 12.5px; }\n.table--answers.is-stacked .c-audio--none, .table--answers.is-stacked .c-snr--none { display: none; }\n.table--answers.is-stacked .c-more { order: 7; margin-left: auto; }\n/* 参加者 */\n.table--people.is-stacked > tbody > tr { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }\n.table--people.is-stacke",
"d .c-id { order: 1; }\n.table--people.is-stacked .c-last { order: 2; margin-left: auto; color: var(--ink-2); font-size: 12.5px; }\n.table--people.is-stacked .c-last::before { content: '最後の回答 '; }\n.table--people.is-stacked .c-last .subline { text-align: right; }\n.table--people.is-stacked .c-prog { order: 3; flex: 0 0 100%; }\n.table--people.is-stacked .c-pw { order: 4; flex: 0 0 100%; }\n.table--people.is-stacked .c-memo { order: 6; flex: 0 0 100%; }\n.table--people.is-stacked .c-act { order: 7; flex: 0 0 100%; }\n\n/* ---------- 入力 ---------- */\n.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 14px; }\n.toolbar__grow { flex: 1 1 180px; min-width: 150px; }\n.toolbar__end { margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }\n.input, .select, .textarea {\n  width: 100%; min-height: 40px; padding: 6px 11px; border: 2px solid var",
"(--ink); border-radius: 10px; background: #fff; font-size: 15px; line-height: 1.5;\n}\n.input:disabled, .textarea:disabled, .select:disabled { background: var(--ash-pale); border-color: var(--ash); color: var(--ink-3); }\n.textarea { min-height: 84px; resize: vertical; line-height: 1.6; }\n.select {\n  -webkit-appearance: none; appearance: none; padding-right: 32px;\n  background-image: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%231D2B53' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9.500l6 6 6-6'/%3E%3C/svg%3E\");\n  background-repeat: no-repeat; background-position: right 9px center; background-size: 16px;\n}\n.toolbar .select { width: auto; max-width: 100%; }\n.input--narrow { max-width: 120px; }\n.field + .field { margin-top: 16px; }\n.field__label { display: block; font-weight: 700; font-size: 14",
"px; margin-bottom: 4px; }\n.field__hint { margin-top: 4px; color: var(--ink-2); font-size: 13px; }\n.check { display: inline-flex; align-items: center; font-size: 13.5px; font-weight: 700; cursor: pointer; }\n.check input { flex: none; width: 18px; height: 18px; margin: 0 7px 0 0; accent-color: var(--ink); }\n/* 保存の帯：画面の下にとどまる。帯の下や横から、うしろの文字がのぞかないように、地の色の帯を敷く */\n.savebar { position: sticky; bottom: 0; z-index: 5; margin-top: 6px; padding: 10px 0 14px; background: linear-gradient(rgba(244, 248, 251, 0), var(--plane) 10px); }\n.savebar__box { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; padding: 12px 16px; border: 2px solid var(--ink); border-radius: 14px; background: #fff; box-shadow: var(--drop); }\n.stack > .savebar + * { margin-top: 2px; }\n.savebar__msg { font-size: 13.5px; color: var(--ink-2); }\n.savebar__msg--bad { color: var(--rec-deep); font-weight: 700; }\n.openrow",
" { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }\n.openrow__state { display: flex; align-items: center; font-size: 20px; font-weight: 700; }\n.linkrow { display: flex; flex-wrap: wrap; gap: 10px; }\n.memo { display: flex; align-items: flex-start; gap: 6px; min-width: 110px; }\n.memo__text { flex: 1 1 auto; min-width: 0; font-size: 13.5px; }\n.memo__edit { flex: none; border: 0; background: none; padding: 2px; border-radius: 6px; color: var(--ink-2); }\n.memo__edit:hover { background: var(--bay-pale); color: var(--ink); }\n.memo__edit .icon { width: 16px; height: 16px; }\n.memo .input { min-height: 34px; padding: 3px 8px; font-size: 14px; }\n.pw { font-variant-numeric: tabular-nums; letter-spacing: .08em; white-space: nowrap; }\n.rowactions { display: flex; align-items: center; gap: 8px 12px; justify-content: flex-end; }\n.idcell { display: flex; a",
"lign-items: center; gap: 8px; }\n.notes { margin-top: 6px; }\n.pick { flex: none; width: 18px; height: 18px; margin: 0; accent-color: var(--ink); }\n.pick--none { visibility: hidden; }\n.pickall { display: flex; align-items: center; gap: 8px; }\n\n/* ---------- 窓・知らせ・読みこみ ---------- */\n.layer { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 50; display: none; align-items: center; justify-content: center; padding: 16px; background: rgba(29, 43, 83, .45); }\n.layer[data-open=\"true\"] { display: flex; }\n.dialog { width: 100%; max-width: 460px; max-height: calc(100vh - 32px); overflow: auto; background: #fff; border: 2px solid var(--ink); border-radius: 18px; padding: 20px; box-shadow: 0 6px 0 var(--ink); }\n.dialog--wide { max-width: 560px; }\n.dialog__title { font-size: 18px; font-weight: 700; line-height: 1.4; margin-bottom: 8px; outline: none; }\n.dialog__body { font-size: 14.5px; ",
"}\n.dialog__body p + p { margin-top: 8px; }\n.dialog__error { margin-top: 10px; color: var(--rec-deep); font-weight: 700; font-size: 13.5px; }\n.dialog__actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 10px; margin-top: 18px; }\n.newlist { margin-top: 10px; border: 1.5px solid var(--line); border-radius: 12px; max-height: 240px; overflow: auto; }\n.newlist table { width: 100%; border-collapse: collapse; font-size: 15px; }\n.newlist th, .newlist td { padding: 7px 14px; text-align: left; border-bottom: 1.5px solid var(--line-2); }\n.newlist tr:last-child td { border-bottom: 0; }\n.newlist th { font-size: 12.5px; color: var(--ink-2); }\n.toast { position: fixed; left: 50%; bottom: 26px; z-index: 60; transform: translateX(-50%); width: max-content; max-width: calc(100vw - 32px); padding: 9px 16px; border-radius: 12px; background: var(--ink); color: #fff; font-weight: 700; fon",
"t-size: 14px; }\nbody[data-screen=\"settings\"] .toast { bottom: 108px; }\n.screen { display: grid; justify-items: center; align-content: center; min-height: 60vh; padding: 24px; text-align: center; }\n.screen__mark { width: 92px; margin-bottom: 12px; }\n.screen__title { font-size: 19px; font-weight: 700; margin-bottom: 8px; outline: none; }\n.screen__text { max-width: 520px; color: var(--ink-2); font-size: 14.5px; }\n.screen__text + .screen__text { margin-top: 8px; }\n.screen .btn { margin-top: 18px; }\n.screen__detail { margin-top: 14px; max-width: 520px; font-size: 12px; color: var(--ink-3); word-break: break-all; }\n.rescue { width: 100%; max-width: 560px; margin-top: 22px; text-align: left; }\n.rescue .field__label { margin-top: 12px; }\n\n/* ---------- 参加者カード（印刷） ----------\n * A4 の紙1枚に、たて3段×よこ2列で6枚。 */\n#print-root { display: none; }\nbody.printing { background: #fff; }\nbody.printing > .app, body.",
"printing > .layer { display: none !important; }\nbody.printing > #print-root { display: block; padding: 18px; }\n.print__bar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; max-width: 190mm; margin: 0 auto 16px; padding: 12px 16px; border: 1.5px solid #B9DCE8; border-radius: 14px; background: var(--sky); }\n.print__bar p { flex: 1 1 220px; font-size: 14px; }\n.print__title { font-weight: 700; outline: none; }\n.pcards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: 84mm; gap: 5mm; max-width: 190mm; margin: 0 auto; }\n.pcard { display: flex; flex-direction: column; break-inside: avoid; page-break-inside: avoid; overflow: hidden; padding: 6mm 6.5mm 5mm; border: 0.4mm dashed #8A93AD; border-radius: 3mm; color: #111; background: #fff; }\n.pcard__title { font-size: 11pt; font-weight: 700; margin-bottom: 3mm; }\n.pcard__top { display: flex; jus",
"tify-content: space-between; align-items: flex-start; }\n.pcard__kv { min-width: 0; }\n.pcard__kv dt { font-size: 9pt; color: #444; line-height: 1.4; }\n.pcard__kv dd { font-size: 21pt; font-weight: 700; letter-spacing: .1em; font-variant-numeric: tabular-nums; line-height: 1.25; margin-bottom: 2mm; }\n.pcard__kv dd.is-long { font-size: 13pt; letter-spacing: .04em; }\n.pcard__kv dd.is-xlong { font-size: 9pt; letter-spacing: 0; line-height: 1.35; word-break: break-all; }\n.pcard__kv dd.is-none { font-size: 11pt; letter-spacing: 0; font-weight: 500; color: #444; }\n.pcard__qr { flex: none; width: 30mm; height: 30mm; margin: -1mm -1.5mm 0 3mm; }\n.pcard__qr svg { display: block; width: 100%; height: 100%; }\n.pcard__site { margin-top: auto; font-size: 9.5pt; line-height: 1.45; word-break: normal; overflow-wrap: anywhere; }\n.pcard__label { display: block; font-size: 8pt; color: #444; }\n.pcard__hint {",
" margin-top: 2mm; font-size: 7.5pt; color: #444; line-height: 1.5; }\n@page { size: A4; margin: 10mm; }\n@media print {\n  html, body { background: #fff !important; }\n  body.printing > #print-root { padding: 0; }\n  .print__bar, .toast { display: none !important; }\n  .pcards { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; grid-auto-rows: 84mm !important; max-width: none; }\n}\n\n/* ---------- 中くらいの幅（タブレット・小さめの窓）：表が表の形のまま入りやすいように、すきまをつめる ---------- */\n@media screen and (min-width: 861px) and (max-width: 1180px) {\n  .app { grid-template-columns: 208px minmax(0, 1fr); }\n  .side { padding-left: 10px; padding-right: 10px; }\n  .main { padding: 20px 18px 56px; }\n  .card { padding: 16px; }\n  .tablewrap { margin: 0 -16px; padding: 0 16px; }\n  .table > thead > tr > th, .table > tbody > tr > td { padding-left: 6px; padding-right: 6px; }\n  .cell-q { min-width: 140px; }\n  .cell-a { min-width:",
" 120px; }\n  .memo { min-width: 72px; }\n  .table--people .c-last .subline { white-space: normal; }\n}\n\n/* ---------- せまい画面（スマートフォン） ---------- */\n@media screen and (max-width: 860px) {\n  .app, .app[data-mode=\"dialog\"] { display: block; }\n  .side { display: none; }\n  .main, .app[data-mode=\"dialog\"] .main { padding: 18px 16px 96px; }\n  .tabs {\n    position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; display: grid; grid-template-columns: repeat(5, 1fr);\n    background: #fff; border-top: 2px solid var(--ink); padding-bottom: env(safe-area-inset-bottom);\n  }\n  .tabs__item { display: grid; justify-items: center; gap: 1px; padding: 7px 2px 6px; border: 0; background: none; font-size: 11px; font-weight: 700; color: var(--ink-2); }\n  .tabs__item[aria-current=\"page\"] { color: var(--ink); background: var(--sky); }\n  .tabs__item .icon { width: 22px; height: 22px; }\n  .head__title { font-size: 2",
"2px; }\n  .grid--tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }\n  .grid--2-1, .grid--1-1 { grid-template-columns: minmax(0, 1fr); }\n  .card { padding: 16px; border-radius: 16px; }\n  .tile { padding: 12px 14px; border-radius: 16px; }\n  .tile__value { font-size: 26px; }\n  .tile__value--state { font-size: 21px; }\n  .tablewrap { margin: 0 -16px; padding: 0 16px; }\n  .toast { bottom: 84px; }\n  body[data-screen=\"settings\"] .toast { bottom: 196px; }\n  html { scroll-padding-bottom: 210px; }\n  .toolbar__end { margin-left: 0; }\n  .toolbar .select { flex: 1 1 140px; }\n  .kv { grid-template-columns: max-content minmax(0, 1fr); }\n  .kv dd { margin-right: 0; }\n  .savebar { bottom: calc(56px + env(safe-area-inset-bottom)); }\n  .notice--new { flex-wrap: wrap; }\n  .notice--new .btn { margin: 8px 0 0 30px; }\n  .pcards { grid-template-columns: minmax(0, 1fr); grid-auto-rows: auto; }\n",
"  .pcard { min-height: 70mm; }\n  /* 指で押しやすい大きさにする。入力欄の文字は 16px 以上（iPhone が画面を勝手に拡大しないように） */\n  .btn--small { min-height: 40px; padding: 6px 14px; font-size: 14px; }\n  .textbtn { padding: 9px 8px; margin: -5px -8px; font-size: 14px; }\n  .playbtn { min-height: 40px; padding: 4px 14px 4px 11px; font-size: 14px; }\n  .seg__btn { padding: 9px 14px; font-size: 14px; }\n  .flag { min-height: 40px; }\n  .pick, .check input { width: 24px; height: 24px; }\n  .memo__edit { padding: 12px; margin: -10px -8px -10px 0; }\n  button.pid, button.chip { line-height: 30px; padding-left: 12px; padding-right: 12px; }\n  .input, .select, .textarea, .memo .input { font-size: 16px; }\n  .input, .select { min-height: 44px; }\n  .memo .input { min-height: 40px; }\n}\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after { animation: none !important; transition: none !important; }\n}\n</style>\n</head>\n<body>\n<div ",
"id=\"app\" class=\"app\"></div>\n<div id=\"layer\" class=\"layer\"></div>\n<div id=\"print-root\"></div>\n<script>\n/*\n * QRコードを作る（参加者カードに、サイトのアドレスを印刷するため）。\n * 外の部品は読みこまず、ここに書いてあるものだけで作る。\n * 8ビットの文字・誤り訂正レベル M・型番 1〜10（半角で 213 文字まで）に対応。\n */\nvar KSQR = (function () {\n  'use strict';\n  // 型番 1〜10、誤り訂正レベル M のときの決まった数（JIS X 0510 の表から）\n  var ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];          // 1ブロックあたりの誤り訂正の語数\n  var BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];                  // ブロックの数\n  var RAW = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];    // 全体の語数\n  var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];\n\n  // 誤り訂正（リード・ソロモン符号）\n  function mul(x, y) {\n    var z = 0;\n    for (var i = 7; i >= 0; i--) {\n      z = (z << 1) ^ ((z >>> 7) * 0x11D);\n      z ^= ((y >>> i) & 1) * x;\n    }\n    return z;\n  }\n  function divisor(degree) ",
"{\n    var result = [], root = 1, i, j;\n    for (i = 0; i < degree - 1; i++) result.push(0);\n    result.push(1);\n    for (i = 0; i < degree; i++) {\n      for (j = 0; j < result.length; j++) {\n        result[j] = mul(result[j], root);\n        if (j + 1 < result.length) result[j] ^= result[j + 1];\n      }\n      root = mul(root, 2);\n    }\n    return result;\n  }\n  function remainder(data, div) {\n    var result = [], i, k;\n    for (i = 0; i < div.length; i++) result.push(0);\n    for (k = 0; k < data.length; k++) {\n      var factor = data[k] ^ result.shift();\n      result.push(0);\n      for (i = 0; i < div.length; i++) result[i] ^= mul(div[i], factor);\n    }\n    return result;\n  }\n\n  function utf8(text) {\n    var s = unescape(encodeURIComponent(String(text))), out = [];\n    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));\n    return out;\n  }\n  function capacity(version) { return RA",
"W[version] - ECC[version] * BLOCKS[version]; }\n  function fits(count, version) { return 4 + (version < 10 ? 8 : 16) + count * 8 <= capacity(version) * 8; }\n\n  // 文字を、データの語の列にする\n  function dataCodewords(bytes, version) {\n    var total = capacity(version) * 8, bits = [], i, j;\n    function put(value, len) { for (var n = len - 1; n >= 0; n--) bits.push((value >>> n) & 1); }\n    put(4, 4);                                                    // 8ビットの文字のしるし\n    put(bytes.length, version < 10 ? 8 : 16);\n    for (i = 0; i < bytes.length; i++) put(bytes[i], 8);\n    put(0, Math.min(4, total - bits.length));                     // 終わりのしるし\n    put(0, (8 - bits.length % 8) % 8);\n    for (var pad = 0xEC; bits.length < total; pad ^= 0xEC ^ 0x11) put(pad, 8);\n    var out = [];\n    for (i = 0; i < bits.length; i += 8) {\n      var b = 0;\n      for (j = 0; j < 8; j++) b = (b << 1) | bits[i + j];\n      out.p",
"ush(b);\n    }\n    return out;\n  }\n  // ブロックに分けて誤り訂正の語を付け、決まった順にまぜる\n  function interleave(data, version) {\n    var numBlocks = BLOCKS[version], eccLen = ECC[version], raw = RAW[version];\n    var numShort = numBlocks - raw % numBlocks, shortLen = Math.floor(raw / numBlocks);\n    var blocks = [], div = divisor(eccLen), k = 0, i, j;\n    for (i = 0; i < numBlocks; i++) {\n      var dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));\n      k += dat.length;\n      var ecc = remainder(dat, div);\n      if (i < numShort) dat.push(0);\n      blocks.push(dat.concat(ecc));\n    }\n    var result = [];\n    for (i = 0; i < blocks[0].length; i++) {\n      for (j = 0; j < blocks.length; j++) {\n        if (i !== shortLen - eccLen || j >= numShort) result.push(blocks[j][i]);\n      }\n    }\n    return result;\n  }\n\n  var MASKS = [\n    function (x, y) { return (x + y) % 2 === 0; },\n    function (x, ",
"y) { return y % 2 === 0; },\n    function (x, y) { return x % 3 === 0; },\n    function (x, y) { return (x + y) % 3 === 0; },\n    function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; },\n    function (x, y) { return x * y % 2 + x * y % 3 === 0; },\n    function (x, y) { return (x * y % 2 + x * y % 3) % 2 === 0; },\n    function (x, y) { return ((x + y) % 2 + x * y % 3) % 2 === 0; }\n  ];\n\n  // 読みとりにくい模様（同じ色の続き・かたまり・目印に似た並び・白黒のかたより）ほど、点が高くなる\n  function penalty(m) {\n    var size = m.length, score = 0, dark = 0, x, y, run, line, col;\n    function runs(cells) {\n      var total = 0, len = 1;\n      for (var i = 1; i <= cells.length; i++) {\n        if (i < cells.length && cells[i] === cells[i - 1]) { len++; continue; }\n        if (len >= 5) total += len - 2;\n        len = 1;\n      }\n      return total;\n    }\n    function finderLike(cells) {\n      var text = '', n = 0, at;\n     ",
" for (var i = 0; i < cells.length; i++) text += cells[i] ? '1' : '0';\n      for (at = text.indexOf('10111010000'); at >= 0; at = text.indexOf('10111010000', at + 1)) n++;\n      for (at = text.indexOf('00001011101'); at >= 0; at = text.indexOf('00001011101', at + 1)) n++;\n      return n * 40;\n    }\n    for (y = 0; y < size; y++) {\n      line = m[y]; col = [];\n      for (x = 0; x < size; x++) { col.push(m[x][y]); if (m[y][x]) dark++; }\n      score += runs(line) + runs(col) + finderLike(line) + finderLike(col);\n    }\n    for (y = 0; y < size - 1; y++) {\n      for (x = 0; x < size - 1; x++) {\n        run = m[y][x];\n        if (run === m[y][x + 1] && run === m[y + 1][x] && run === m[y + 1][x + 1]) score += 3;\n      }\n    }\n    var total = size * size;\n    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;\n    return score;\n  }\n\n  function build(version, codewords, forced",
"Mask) {\n    var size = version * 4 + 17, m = [], fn = [], x, y, i, j, dx, dy;\n    for (y = 0; y < size; y++) {\n      m.push([]); fn.push([]);\n      for (x = 0; x < size; x++) { m[y].push(false); fn[y].push(false); }\n    }\n    function set(px, py, dark) { m[py][px] = !!dark; fn[py][px] = true; }\n    function finder(cx, cy) {\n      for (dy = -4; dy <= 4; dy++) {\n        for (dx = -4; dx <= 4; dx++) {\n          var dist = Math.max(Math.abs(dx), Math.abs(dy)), xx = cx + dx, yy = cy + dy;\n          if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, dist !== 2 && dist !== 4);\n        }\n      }\n    }\n    function drawFormat(mask) {\n      var rem = mask, k;                                          // 誤り訂正レベル M のしるしは 00\n      for (k = 0; k < 10; k++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);\n      var bits = ((mask << 10) | rem) ^ 0x5412;\n      function bit(n) { return ((bits >>> n) & ",
"1) !== 0; }\n      for (k = 0; k <= 5; k++) set(8, k, bit(k));\n      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));\n      for (k = 9; k < 15; k++) set(14 - k, 8, bit(k));\n      for (k = 0; k < 8; k++) set(size - 1 - k, 8, bit(k));\n      for (k = 8; k < 15; k++) set(8, size - 15 + k, bit(k));\n      set(8, size - 8, true);\n    }\n    function applyMask(mask) {\n      for (var yy = 0; yy < size; yy++) for (var xx = 0; xx < size; xx++) if (!fn[yy][xx] && MASKS[mask](xx, yy)) m[yy][xx] = !m[yy][xx];\n    }\n\n    // 決まった模様（位置を知るための目印など）\n    for (i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }\n    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);\n    var pos = ALIGN[version];\n    for (i = 0; i < pos.length; i++) {\n      for (j = 0; j < pos.length; j++) {\n        if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0",
")) continue;\n        for (dy = -2; dy <= 2; dy++) for (dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);\n      }\n    }\n    drawFormat(0);                                                // 場所をとっておく（あとで書き直す）\n    if (version >= 7) {\n      var rem = version;\n      for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);\n      var vbits = (version << 12) | rem;\n      for (i = 0; i < 18; i++) {\n        var on = ((vbits >>> i) & 1) !== 0, a = size - 11 + i % 3, b = Math.floor(i / 3);\n        set(a, b, on); set(b, a, on);\n      }\n    }\n\n    // データを、右下からジグザグに置く\n    var n = 0, right, vert;\n    for (right = size - 1; right >= 1; right -= 2) {\n      if (right === 6) right = 5;\n      for (vert = 0; vert < size; vert++) {\n        for (j = 0; j < 2; j++) {\n          x = right - j;\n          y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert",
";\n          if (!fn[y][x] && n < codewords.length * 8) {\n            m[y][x] = ((codewords[n >>> 3] >>> (7 - (n & 7))) & 1) !== 0;\n            n++;\n          }\n        }\n      }\n    }\n\n    // いちばん読みとりやすい模様（マスク）をえらぶ\n    var best = forcedMask, bestScore = Infinity;\n    if (!(best >= 0 && best <= 7)) {\n      for (i = 0; i < 8; i++) {\n        applyMask(i); drawFormat(i);\n        var score = penalty(m);\n        if (score < bestScore) { bestScore = score; best = i; }\n        applyMask(i);\n      }\n    }\n    applyMask(best); drawFormat(best);\n    return { version: version, size: size, mask: best, modules: m };\n  }\n\n  /** 文字を QRコードにする。返すのは { size, modules[y][x]（黒なら true）, version, mask }。長すぎるときは null。 */\n  function encode(text, forcedMask) {\n    var bytes = utf8(text), version = 1;\n    while (version <= 10 && !fits(bytes.length, version)) version++;\n    if (version > 10 || !bytes.length) return n",
"ull;\n    return build(version, interleave(dataCodewords(bytes, version), version), forcedMask);\n  }\n  return { encode: encode };\n})();\n</script>\n<script>var KS_BOOT = \"__KS_BOOT__\";</script>\n<script>\n(function () {\n  'use strict';\n\n  var BOOT = (typeof KS_BOOT === 'object' && KS_BOOT) || { mode: 'web', token: '', version: '', hours: 12 };\n  var gs = window.google && window.google.script;\n  var D = null;                 // 保存先から受け取った「全体のようす」\n  var loadedAt = 0;             // それを受け取ったときの、この端末の時計\n  var view = 'home';\n  var blocked = false;          // 開き直しが必要になった\n  // 名前で引く入れもの。ふつうの {} とちがって、「constructor」のような名前がはじめから入っていない\n  function bag() { return Object.create(null); }\n  var state = {\n    chart: { range: '14', table: false },\n    people: { q: '', filter: 'all', pw: null, pwLoading: false, selected: bag(), editing: '', memoDraft: '', memoStart: '', memoSaving: bag(), busy: bag() },\n    an",
"swers: { filter: blankFilter(), qDraft: '', offset: 0, data: null, loading: false, error: '', open: bag(), loud: true, fresh: 0 },\n    settings: { draft: null, touched: bag(), dirty: false, saving: false, toggling: false, message: '', bad: false }\n  };\n  function blankFilter() { return { participant: '', step: '', status: '', flag: '', item: '', q: '' }; }\n  function byId(id) { return document.getElementById(id); }\n\n  /* ============================================================\n   * 小さな道具\n   * ============================================================ */\n  function h(tag, attrs) {\n    var el = document.createElement(tag);\n    if (attrs) {\n      for (var k in attrs) {\n        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;\n        var v = attrs[k];\n        if (v == null || v === false) continue;\n        if (k === 'class') el.className = v;\n        else if (k === 'text'",
") el.textContent = v;\n        else if (k === 'svg') el.innerHTML = v;            // 決まった絵（アイコン）だけに使う。回答などの文字は、ここには入れない\n        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);\n        else if (v === true) el.setAttribute(k, '');\n        else el.setAttribute(k, String(v));\n      }\n    }\n    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);\n    return el;\n  }\n  function add(el, child) {\n    if (child == null || child === false) return el;\n    if (Array.isArray(child)) { for (var i = 0; i < child.length; i++) add(el, child[i]); return el; }\n    el.appendChild(child.nodeType ? child : document.createTextNode(String(child)));\n    return el;\n  }\n  function ic(inner, filled) {\n    return '<svg class=\"icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" ' +\n      (filled ? 'fill=\"currentColor\"' : 'fill=\"none\" stroke=\"curren",
"tColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"') + '>' + inner + '</svg>';\n  }\n  var ICON = {\n    grid: ic('<rect x=\"4\" y=\"4\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"13\" y=\"4\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"4\" y=\"13\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"13\" y=\"13\" width=\"7\" height=\"7\" rx=\"2\"/>'),\n    people: ic('<circle cx=\"9\" cy=\"8.500\" r=\"3.200\"/><path d=\"M3.500 19c.400-3.200 2.700-5 5.500-5s5.100 1.800 5.500 5\"/><path d=\"M15.500 5.700a3 3 0 0 1 0 5.600M17.500 14.300c1.700.700 2.800 2.300 3 4.700\"/>'),\n    wave: ic('<path d=\"M4 10v4M8 6.500v11M12 4v16M16 7.500v9M20 10.500v3\"/>'),\n    list: ic('<path d=\"M9.500 6.500H20M9.500 12H20M9.500 17.500H20M4.500 6.500h.100M4.500 12h.100M4.500 17.500h.100\"/>'),\n    sliders: ic('<path d=\"M4 7h9.800M18.200 7H20M4 17h1.800M10.200 17H20\"/><circle cx=\"16\" cy=\"7\" r=\"2.200\"/><circle cx=\"8\" cy=\"17\" r=\"2.200\"/>'),\n    refre",
"sh: ic('<path d=\"M19.500 12a7.500 7.500 0 1 1-2.300-5.400\"/><path d=\"M19.500 4.500v4.800h-4.800\"/>'),\n    out: ic('<path d=\"M13.500 5H19v5.500M19 5l-8 8\"/><path d=\"M10 6.500H7a2 2 0 0 0-2 2V17a2 2 0 0 0 2 2h8.500a2 2 0 0 0 2-2v-3\"/>'),\n    play: ic('<path d=\"M8.300 5.200a1 1 0 0 1 1.500-.900l10 6.800a1 1 0 0 1 0 1.700l-10 6.800a1 1 0 0 1-1.500-.800z\"/>', true),\n    stop: ic('<rect x=\"6.500\" y=\"6.500\" width=\"11\" height=\"11\" rx=\"2.200\"/>', true),\n    warn: ic('<path d=\"M12 4.500l8.500 14.500h-17z\"/><path d=\"M12 10v4M12 16.800v.200\"/>'),\n    check: ic('<path d=\"M5 12.800l4.600 4.600L19 7.600\"/>'),\n    plus: ic('<path d=\"M12 5v14M5 12h14\"/>'),\n    print: ic('<path d=\"M7.500 9V4.500h9V9\"/><rect x=\"4\" y=\"9\" width=\"16\" height=\"7.500\" rx=\"2\"/><path d=\"M7.500 14h9v5.500h-9z\"/>'),\n    eye: ic('<path d=\"M2.800 12s3.400-6.200 9.200-6.200 9.200 6.200 9.200 6.200-3.400 6.200-9.200 6.200S2.800 12 2.800",
" 12z\"/><circle cx=\"12\" cy=\"12\" r=\"2.700\"/>'),\n    save: ic('<path d=\"M12 4.500v10.500M7.500 11l4.500 4.500 4.500-4.500M5 19.500h14\"/>'),\n    sheet: ic('<rect x=\"4.500\" y=\"4\" width=\"15\" height=\"16\" rx=\"2\"/><path d=\"M4.500 9.500h15M4.500 14.500h15M10 9.500V20\"/>'),\n    folder: ic('<path d=\"M3.500 7.500a2 2 0 0 1 2-2h4l2 2.500h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z\"/>'),\n    pencil: ic('<path d=\"M4.500 19.500l1-4.200L16.300 4.500a1.800 1.800 0 0 1 2.600 0l.600.600a1.800 1.800 0 0 1 0 2.600L8.700 18.500z\"/>'),\n    micoff: ic('<path d=\"M12 3a3 3 0 0 0-3 3v5.500a3 3 0 0 0 4.900 2.300M15 9.500V6a3 3 0 0 0-1.500-2.600\"/><path d=\"M5.500 11.500a6.500 6.500 0 0 0 10.700 5M18.500 11.500a6.500 6.500 0 0 1-.400 2.200M12 18v3M4 4l16 16\"/>')\n  };\n  // 案内役（桜島大根）。参加者のサイトと同じ絵\n  var DAIKON = (function () {\n    var s = 'stroke=\"#1D2B53\" stroke-width=\"3.5\" stroke-linecap=\"round\" stroke-linejoin=\"",
"round\"';\n    return '<svg viewBox=\"0 0 122 132\" aria-hidden=\"true\" focusable=\"false\">' +\n      '<path d=\"M57 47C42 41 31 27 30 12c14 2 24 17 28 33z\" fill=\"#3FB173\" ' + s + '/>' +\n      '<path d=\"M63 47c15-6 26-20 27-35-14 2-24 17-28 33z\" fill=\"#3FB173\" ' + s + '/>' +\n      '<path d=\"M60 47C50 33 52 12 60 4c8 8 10 29 0 43z\" fill=\"#62C98B\" ' + s + '/>' +\n      '<path d=\"M53 111c2 8 5 15 8 18 2-4 4-10 6-18z\" fill=\"#fff\" ' + s + '/>' +\n      '<path d=\"M22 86L10 96\" fill=\"none\" ' + s + '/><circle cx=\"9\" cy=\"97\" r=\"4.500\" fill=\"#fff\" ' + s + '/>' +\n      '<path d=\"M98 78l13-17\" fill=\"none\" ' + s + '/><circle cx=\"112\" cy=\"59\" r=\"4.500\" fill=\"#fff\" ' + s + '/>' +\n      '<ellipse cx=\"60\" cy=\"80\" rx=\"42\" ry=\"36\" fill=\"#fff\" ' + s + '/>' +\n      '<path d=\"M91 91c-6 13-21 20-38 19\" fill=\"none\" stroke=\"#DCE8F0\" stroke-width=\"5\" stroke-linecap=\"round\"/>' +\n      '<ellipse cx=\"37\" cy=\"88\" rx=\"5.500\" ry",
"=\"3.200\" fill=\"#FF9FB2\"/><ellipse cx=\"83\" cy=\"88\" rx=\"5.500\" ry=\"3.200\" fill=\"#FF9FB2\"/>' +\n      '<circle cx=\"47\" cy=\"77\" r=\"3.800\" fill=\"#1D2B53\"/><circle cx=\"73\" cy=\"77\" r=\"3.800\" fill=\"#1D2B53\"/>' +\n      '<path d=\"M53 86q7 7 14 0\" fill=\"none\" ' + s + '/>' +\n      '<ellipse cx=\"46\" cy=\"119\" rx=\"9\" ry=\"5\" fill=\"#FF9A2E\" ' + s + '/><ellipse cx=\"74\" cy=\"119\" rx=\"9\" ry=\"5\" fill=\"#FF9A2E\" ' + s + '/>' +\n      '</svg>';\n  })();\n\n  // 日時は、いつも日本時間で見せる（見ている端末の設定がどの国でも同じになるように）。\n  // 「いま」も、保存先の時計をもとにする（見ている端末の時計がずれていても、「今日」「きのう」をまちがえないように）\n  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];\n  function two(n) { return n < 10 ? '0' + n : String(n); }\n  function nowMs() { return D && loadedAt ? D.at + (Date.now() - loadedAt) : Date.now(); }\n  function jst(ms) {\n    var d = new Date(ms + 9 * 3600000);\n    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), ",
"min: d.getUTCMinutes(), s: d.getUTCSeconds(),\n             day: Math.floor((ms + 9 * 3600000) / 86400000) };\n  }\n  function fmtWhen(ms) {\n    if (!ms) return '';\n    var a = jst(ms), now = jst(nowMs()), hm = a.h + ':' + two(a.min);\n    if (a.day === now.day) return '今日 ' + hm;\n    if (a.day === now.day - 1) return 'きのう ' + hm;\n    return (a.y !== now.y ? a.y + '/' : '') + a.m + '/' + a.d + ' ' + hm;\n  }\n  function fmtFull(ms) {\n    if (!ms) return '';\n    var a = jst(ms);\n    return a.y + '年' + a.m + '月' + a.d + '日（' + WEEK[(a.day + 4) % 7] + '）' + a.h + ':' + two(a.min) + ':' + two(a.s);\n  }\n  function fmtClock(ms) { var a = jst(ms); return a.h + ':' + two(a.min); }\n  function dayNo(text) { var p = String(text).split('-'); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000); }\n  function ymd(no) { var d = new Date(no * 86400000); return { y: d.getUTCFullYear(), m: d.getUTCMo",
"nth() + 1, d: d.getUTCDate() }; }\n  function dayText(no) { var c = ymd(no); return c.y + '-' + two(c.m) + '-' + two(c.d); }\n  // 端末での回答日時（2026-10-12T16:58:24+09:00 の形）を、読みやすい形にする。読めない形なら、そのまま出す\n  function fmtClient(text) {\n    var m = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d+)?\\+09:00$/.exec(String(text || ''));\n    return m ? (+m[1]) + '年' + (+m[2]) + '月' + (+m[3]) + '日 ' + (+m[4]) + ':' + m[5] + ':' + m[6] : String(text || '');\n  }\n  function fmtSec(sec) { return (Math.round(sec * 10) / 10).toFixed(1) + '秒'; }\n  function httpsLink(url, attrs) {\n    if (!/^https:\\/\\/[^\\s\"'<>\\\\]+$/.test(String(url || ''))) return null;\n    var a = h('a', attrs);\n    a.setAttribute('href', url); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener');\n    for (var i = 2; i < arguments.length; i++) add(a, arguments[i]);\n    return a;\n  }\n  function debounce(fn, ms) { var t = n",
"ull; return function () { var args = arguments; window.clearTimeout(t); t = window.setTimeout(function () { fn.apply(null, args); }, ms); }; }\n  function stepName(st) { return st.no + '歩目' + (st.title ? ' ' + st.title : ''); }\n  function itemById(id) { for (var i = 0; i < D.items.length; i++) if (D.items[i].id === id) return D.items[i]; return null; }\n  function personById(id) { for (var i = 0; i < D.participants.length; i++) if (D.participants[i].id === id) return D.participants[i]; return null; }\n  // さがすときは、全角と半角・大文字と小文字のちがいを気にしない（「Ｋ００１」でも「k001」でも見つかるように）\n  function fold(text) {\n    var s = String(text == null ? '' : text);\n    if (s.normalize) s = s.normalize('NFKC');\n    return s.toUpperCase();\n  }\n  // 日本語の入力で、変換を決める Enter や、変換をやめる Esc を押しているところかどうか\n  function composing(e) { return !!(e && (e.isComposing || e.keyCode === 229)); }\n\n  /* ==============================================",
"==============\n   * 保存先（Google 側のプログラム）とのやりとり\n   * ============================================================ */\n  function call(action, payload) {\n    return new Promise(function (resolve, reject) {\n      if (!gs || !gs.run) { reject({ code: 'no_bridge', message: 'この画面は、Google の中で開いたときだけ動きます。' }); return; }\n      try {\n        gs.run.withSuccessHandler(function (text) {\n          var res = null;\n          try { res = JSON.parse(text); } catch (e) { res = null; }\n          if (res && res.ok) resolve(res);\n          else reject({ code: (res && res.error) || 'bad_response', message: (res && res.message) || '保存先から正しい返事がありませんでした。' });\n        }).withFailureHandler(function (err) {\n          reject({ code: 'network', message: 'Google とやりとりできませんでした。通信の状態を確かめて、もう一度お試しください。', detail: String((err && err.message) || err || '') });\n        }).ksAdminCall(BOOT.token, action, JSON.stringify(payload",
" || {}));\n      } catch (e) {\n        reject({ code: 'network', message: 'Google とやりとりできませんでした。', detail: String(e) });\n      }\n    });\n  }\n  // 表を書きかえる操作。これと重なって読みこんだ「全体のようす」は、古い内容かもしれないので使わない（epoch で見分ける）\n  var epoch = 0;\n  function mutate(action, payload) {\n    epoch++;\n    return call(action, payload).then(function (res) { epoch++; return res; }, function (err) { epoch++; throw err; });\n  }\n  // 「開き直してください」のときは、画面全体をその案内にする。それ以外は、その場で知らせる\n  function failed(err, quiet) {\n    if (err && err.code === 'admin_auth') { blockScreen(); return true; }\n    if (!quiet) toast((err && err.message) || 'うまくいきませんでした。');\n    return false;\n  }\n\n  var loadingOverview = null, lastSig = '', overviewChanged = true;\n  // 中身が前と同じかどうかを見分けるための文字（受け取った時刻は、くらべない）\n  function signature(res) {\n    var at = res.at, text;\n    res.at = 0;\n    try { text = JSON.stringify(res); } catch (e) { text = String(Math.random()",
"); }\n    res.at = at;\n    return text;\n  }\n  // quiet：自動の更新のとき。読みこんでいるあいだ、画面をうすくしない（1分ごとに画面がちらつかないように）\n  function loadOverview(quiet) {\n    if (!quiet) document.body.classList.add('is-loading');\n    if (loadingOverview) return loadingOverview;\n    var started = epoch;\n    loadingOverview = call('overview').then(function (res) {\n      loadingOverview = null;\n      if (started !== epoch) return loadOverview(true);      // 読みこみと重なって、書きかえがあった。読み直す\n      document.body.classList.remove('is-loading');\n      var sig = signature(res);\n      overviewChanged = sig !== lastSig; lastSig = sig;\n      D = res; loadedAt = Date.now();\n      if (view !== 'answers') state.answers.data = null;      // 回答の一覧は、次に開いたときに読み直す\n      if (state.people.pw && !state.people.pwLoading) refreshPasswords();\n      return res;\n    }, function (err) { loadingOverview = null; document.body.classList.remove('is-loading'); thr",
"ow err; });\n    return loadingOverview;\n  }\n  function refresh() {\n    return loadOverview().then(function () {\n      if (view === 'answers') { state.answers.data = null; state.answers.error = ''; }\n      if (typing()) {\n        // 「更新」を押したあと、返事を待つあいだに何かを書きはじめていたとき：\n        // 入力欄を作り直すと日本語の変換がとぎれるので、描き直すのは、書きおわってからにする\n        stale = true;\n        var b = byId('refresh');\n        if (b) { b.disabled = false; var icon = b.querySelector('.icon'); if (icon) icon.setAttribute('class', 'icon'); }\n        toast('新しい内容を受け取りました。書きおわると、画面に出ます。');\n        return;\n      }\n      render();\n      toast('新しい内容にしました。');\n    }, function (err) { if (!failed(err)) softRender(); });\n  }\n\n  /* ============================================================\n   * 描き直しても、キーボードの目印（フォーカス）をなくさない\n   * ============================================================ */\n  function nameOf(el) { return el.tagName + '|' + (el.",
"getAttribute('aria-label') || el.textContent || '').slice(0, 60); }\n  // 読みこみのあいだ押せなくなったボタンは、目印（フォーカス）を手放してしまう。\n  // そこで、目印がさいごにあった場所を覚えておき、描き直したときに、どこにも目印がなければ、そこへもどす\n  var lastMark = null;\n  document.addEventListener('focusin', function (e) {\n    var root = byId('view');\n    if (root && e.target && root.contains(e.target)) lastMark = markOf(e.target);\n    else if (e.target && e.target !== document.body) lastMark = null;      // メニューなど、ほかの場所へ移った\n  });\n  // 何もないところを押したときは、目印を置かないのが本人の考えなので、覚えたものを捨てる\n  document.addEventListener('pointerdown', function (e) {\n    var t = e.target;\n    if (!(t && t.closest && t.closest('button, a, input, select, textarea, label, [tabindex]'))) lastMark = null;\n  }, true);\n  function focusMark() {\n    var el = document.activeElement, root = byId('view');\n    if (!el || el === document.body) return lastMark;\n    if (!root || !root.contains(el)) return null;\n  ",
"  return markOf(el);\n  }\n  function markOf(el) {\n    var root = byId('view');\n    var mark, fk = el.getAttribute('data-fk');\n    if (el.id) mark = { id: el.id };\n    else if (fk) mark = { fk: fk };\n    else {\n      var name = nameOf(el), all = root.querySelectorAll(el.tagName), n = 0;\n      for (var i = 0; i < all.length && all[i] !== el; i++) if (nameOf(all[i]) === name) n++;\n      mark = { tag: el.tagName, name: name, n: n };\n    }\n    // 文字を書いているところなら、書いている場所（カーソル）も覚えておく\n    try { if (typeof el.selectionStart === 'number') { mark.from = el.selectionStart; mark.to = el.selectionEnd; } } catch (e) { /* 何もしない */ }\n    return mark;\n  }\n  function focusBack(mark) {\n    var root = byId('view'), el = null, i;\n    if (!mark || !root) return;\n    var now = document.activeElement;\n    if (now && now !== document.body && document.body.contains(now)) return;       // もう別のところに目印がある\n    if (mark.id",
") el = byId(mark.id);\n    else if (mark.fk) {\n      var keyed = root.querySelectorAll('[data-fk]');\n      for (i = 0; i < keyed.length; i++) if (keyed[i].getAttribute('data-fk') === mark.fk) { el = keyed[i]; break; }\n    } else {\n      var all = root.querySelectorAll(mark.tag), n = 0;\n      for (i = 0; i < all.length; i++) if (nameOf(all[i]) === mark.name) { if (n === mark.n) { el = all[i]; break; } n++; }\n    }\n    if (!el || el.disabled || !root.contains(el)) return;\n    try {\n      el.focus({ preventScroll: true });\n      if (typeof mark.from === 'number' && el.setSelectionRange) el.setSelectionRange(mark.from, mark.to);\n    } catch (e) { /* 何もしない */ }\n  }\n  function focusHeading() {\n    var t = document.querySelector(document.body.classList.contains('printing') ? '.print__title' : '.head__title, .screen__title');\n    if (t) { try { t.focus({ preventScroll: true }); } catch (e) { /* 何",
"もしない */ } }\n  }\n\n  /* ============================================================\n   * ダブルクリックは、1回押したものとして扱う\n   * （ボタンを2回つづけて押すくせがあっても、「開いてすぐ閉じる」「2回切りかわって元にもどる」とならないように）\n   * ============================================================ */\n  document.addEventListener('click', function (e) {\n    if (!(e.detail > 1)) return;                 // キーボードで押したとき（0）や、ふつうの1回目（1）は、そのまま通す\n    var t = e.target;\n    var hit = t === byId('layer') || (t && t.closest && t.closest('button, a[href], summary'));\n    if (!hit) return;\n    e.preventDefault();\n    e.stopImmediatePropagation();\n  }, true);\n\n  /* ============================================================\n   * 窓・知らせ\n   * ============================================================ */\n  var toastTimer = null;\n  function toast(message) {\n    var old = document.querySelector('.toast');\n    if (old) old.parentNode.removeChild(old);\n    var el = h('d",
"iv', { class: 'toast', role: 'status', text: message });\n    document.body.appendChild(el);\n    window.clearTimeout(toastTimer);\n    toastTimer = window.setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, Math.min(9000, 2600 + String(message).length * 70));\n  }\n  function setInert(on) {\n    var app = byId('app');\n    if (!app) return;\n    if (on) { app.setAttribute('inert', ''); app.setAttribute('aria-hidden', 'true'); }\n    else { app.removeAttribute('inert'); app.removeAttribute('aria-hidden'); }\n  }\n  // opt: { title, body（文字か部品）, wide, actions: [{ label, value, kind, run(close, setError, setBusy) }] }\n  // run があるボタンは、押しても自動では閉じない（中で close(値) を呼ぶ）。\n  // 保存先とやりとりしているあいだは setBusy(true) にして、ボタンも Esc も効かないようにする（二重に送らないため）\n  var dialogSeq = 0, dialogOpen = false;\n  function dialog(opt) {\n    return new Promise(function (resolve) {\n      var layer = byId('layer');",
"\n      var before = document.activeElement, id = ++dialogSeq, busy = false, closed = false, downOnLayer = false;\n      var beforeMark = before && byId('view') && byId('view').contains(before) ? markOf(before) : null;\n      var errorEl = h('p', { class: 'dialog__error', role: 'alert' });\n      var buttons = [], primary = null;\n      function close(value) {\n        if (closed) return;\n        closed = true;\n        document.removeEventListener('keydown', onKey, true);\n        if (id === dialogSeq) {                    // あとから別の窓が開いていたら、その窓にはさわらない\n          dialogOpen = false;\n          layer.setAttribute('data-open', 'false');\n          layer.innerHTML = '';\n          setInert(false);\n          if (before && before.focus && document.body.contains(before) && !before.disabled) { try { before.focus(); } catch (e) { /* 何もしない */ } }\n          else {\n            // 開いているあいだに画面が描き直されて、もとのボタンが作り直さ",
"れたとき\n            if (beforeMark) focusBack(beforeMark);\n            if (!document.activeElement || document.activeElement === document.body) focusHeading();\n          }\n        }\n        resolve(value);\n      }\n      function setError(message) { errorEl.textContent = message || ''; }\n      function setBusy(on) {\n        busy = !!on;\n        for (var i = 0; i < buttons.length; i++) buttons[i].disabled = busy;\n        if (busy) setError('');\n      }\n      function onKey(e) {\n        if (id !== dialogSeq || composing(e)) return;\n        if (e.key === 'Escape') { e.preventDefault(); if (!busy) close(undefined); return; }\n        if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && primary) { e.preventDefault(); if (!busy) primary.click(); return; }\n        if (e.key !== 'Tab') return;\n        var all = box.querySelectorAll('button, input, select, textarea, a[href]'), items = ",
"[];\n        for (var i = 0; i < all.length; i++) if (!all[i].disabled) items.push(all[i]);\n        if (!items.length) { e.preventDefault(); return; }\n        var first = items[0], last = items[items.length - 1], active = document.activeElement;\n        var inside = box.contains(active) && active !== title;\n        if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus(); }\n        else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); }\n      }\n      var title = h('h2', { class: 'dialog__title', id: 'dialog-title', tabindex: '-1', text: opt.title });\n      var body = h('div', { class: 'dialog__body' }, typeof opt.body === 'string' ? h('p', { text: opt.body }) : opt.body);\n      var actions = h('div', { class: 'dialog__actions' }, (opt.actions || []).map(function (a) {\n        var b = h('button', { type: 'button', class: 'btn'",
" + (a.kind ? ' btn--' + a.kind : ''), onclick: function () {\n          if (busy || closed) return;\n          if (a.run) a.run(close, setError, setBusy); else close(a.value);\n        } }, a.label);\n        buttons.push(b);\n        if (a.kind === 'primary' || a.kind === 'danger') primary = b;\n        return b;\n      }));\n      var box = h('div', { class: 'dialog' + (opt.wide ? ' dialog--wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' }, title, body, errorEl, actions);\n      layer.innerHTML = '';\n      layer.appendChild(box);\n      layer.setAttribute('data-open', 'true');\n      // 外側を押したら閉じる。ただし、窓の中で押しはじめて外で離したとき（文字をえらんでいるときなど）は閉じない\n      layer.onmousedown = function (e) { downOnLayer = e.target === layer; };\n      layer.onclick = function (e) { if (e.target === layer && downOnLayer && !busy) close(undefined); downOnLayer = false; };\n      dialogOpen = t",
"rue;\n      setInert(true);\n      document.addEventListener('keydown', onKey, true);\n      var focusEl = box.querySelector('[data-autofocus]') || title;\n      try { focusEl.focus(); if (focusEl.select) focusEl.select(); } catch (e) { /* 何もしない */ }\n    });\n  }\n  function screen(title, lines, button, detail) {\n    return h('div', { class: 'screen' },\n      h('div', { class: 'screen__mark', svg: DAIKON }),\n      h('h1', { class: 'screen__title', tabindex: '-1', text: title }),\n      (lines || []).map(function (t) { return h('p', { class: 'screen__text', text: t }); }),\n      button || null,\n      detail ? h('p', { class: 'screen__detail', text: detail }) : null);\n  }\n  function blockScreen() {\n    if (blocked) return;\n    blocked = true;\n    stopAudio();\n    if (document.body.classList.contains('printing')) { document.body.classList.remove('printing'); byId('print-root').innerHTML = ''; }\n  ",
"  var holder = byId('view');\n    if (!holder) return;\n    var page = screen('開き直してください',\n      ['管理画面を開いてから時間がたったため、続けられなくなりました（安全のため、' + (BOOT.hours || 12) + '時間で切れます）。',\n       BOOT.mode === 'dialog' ? 'この窓を閉じて、メニュー「方言調査」→「管理画面を開く」から、もう一度開いてください。' : 'ブラウザの「再読み込み」ボタンを押して、ページを読みこみ直してください。'],\n      BOOT.mode === 'dialog' && gs && gs.host ? h('button', { type: 'button', class: 'btn btn--primary', onclick: function () { gs.host.close(); } }, 'この窓を閉じる') : null);\n    // 保存していなかった設定の文章が消えてしまわないように、ここに出しておく（写しをとれるように）\n    var st = state.settings, kept = [];\n    if (st.draft && D) {\n      for (var k in SETTING_KEYS) if (st.touched[k] && st.draft[k] !== String(D.settings[k] == null ? '' : D.settings[k])) kept.push([SETTING_KEYS[k], st.draft[k]]);\n    }\n    var sp = state.people, who = sp.editing && D ? personById(sp.editing) : null;\n    if (who && sp.memoDraft !== sp.memoStart && sp.memoDraft.tri",
"m() !== String(who.memo || '')) kept.push([who.id + ' のメモ', sp.memoDraft]);\n    if (kept.length) {\n      page.appendChild(h('div', { class: 'rescue' },\n        h('p', { class: 'screen__text', text: 'まだ保存していなかった内容は、次のとおりです。必要なら、写しをとっておいてください。' }),\n        kept.map(function (x, i) {\n          var box = h('textarea', { class: 'textarea', id: 'rescue-' + i, readonly: true, rows: '3' });\n          box.value = x[1];\n          return [h('label', { class: 'field__label', for: 'rescue-' + i, text: x[0] }), box];\n        })));\n    }\n    holder.innerHTML = '';\n    holder.appendChild(page);\n    var marks = document.querySelectorAll('[data-view]');\n    for (var i = 0; i < marks.length; i++) { marks[i].disabled = true; marks[i].removeAttribute('aria-current'); }\n    var site = byId('side-site');\n    if (site) site.innerHTML = '';\n    focusHeading();\n  }\n\n  /* ==========================================",
"==================\n   * 骨組み（左のメニュー・下のタブ）\n   * ============================================================ */\n  var NAV = [\n    { id: 'home', label: 'ダッシュボード', short: 'ホーム', icon: 'grid' },\n    { id: 'people', label: '参加者', short: '参加者', icon: 'people' },\n    { id: 'answers', label: '回答と録音', short: '回答', icon: 'wave' },\n    { id: 'items', label: '項目', short: '項目', icon: 'list' },\n    { id: 'settings', label: '設定', short: '設定', icon: 'sliders' }\n  ];\n  function buildShell() {\n    var app = byId('app');\n    app.innerHTML = '';\n    app.setAttribute('data-mode', BOOT.mode === 'dialog' ? 'dialog' : 'web');\n    var nav = h('nav', { class: 'nav', 'aria-label': '画面の切りかえ' }, NAV.map(function (n) {\n      return h('button', { type: 'button', class: 'nav__item', 'data-view': n.id, onclick: function () { show(n.id); } },\n        h('span', { class: 'nav__icon', svg: ICON[n.icon] }), n.label);\n    }));",
"\n    var tabs = h('nav', { class: 'tabs', 'aria-label': '画面の切りかえ' }, NAV.map(function (n) {\n      return h('button', { type: 'button', class: 'tabs__item', 'data-view': n.id, onclick: function () { show(n.id); } },\n        h('span', { svg: ICON[n.icon] }), h('span', { text: n.short }));\n    }));\n    add(app, [\n      h('aside', { class: 'side' },\n        h('div', { class: 'brand' }, h('span', { class: 'brand__mark', svg: DAIKON }),\n          h('span', { class: 'brand__name' }, '方言調査', h('span', { class: 'brand__sub', text: '管理画面' }))),\n        h('div', { class: 'side__site', id: 'side-site' }),\n        nav,\n        h('div', { class: 'side__foot', id: 'side-foot' })),\n      h('main', { class: 'main', id: 'main' }, h('div', { class: 'main__inner', id: 'view' })),\n      tabs\n    ]);\n  }\n  function siteButton(cls) {\n    var url = D && D.settings.siteUrl;\n    var inner = [h('span', { svg: ICON",
".out }), '参加者の画面を開く'];\n    return httpsLink(url, { class: cls }, inner) ||\n      h('button', { type: 'button', class: cls, onclick: function () { show('settings'); toast('「サイトのURL」を入れると、ここから参加者の画面を開けます。'); } }, inner);\n  }\n  function paintChrome() {\n    var marks = document.querySelectorAll('[data-view]');\n    for (var i = 0; i < marks.length; i++) {\n      if (marks[i].getAttribute('data-view') === view) marks[i].setAttribute('aria-current', 'page');\n      else marks[i].removeAttribute('aria-current');\n    }\n    document.body.setAttribute('data-screen', view);\n    var site = byId('side-site'), foot = byId('side-foot');\n    site.innerHTML = ''; foot.innerHTML = '';\n    if (!D) return;\n    site.appendChild(siteButton('btn btn--small'));\n    add(foot, [\n      httpsLink(D.links.spreadsheet, { class: 'side__link' }, h('span', { svg: ICON.sheet }), 'スプレッドシートを開く'),\n      httpsLink(D.links.audio",
"Folder, { class: 'side__link' }, h('span', { svg: ICON.folder }), '録音フォルダを開く'),\n      h('p', { class: 'side__ver', text: 'バージョン ' + (D.version || BOOT.version || '') })\n    ]);\n  }\n  function head(title, sub) {\n    return h('header', { class: 'head' },\n      h('div', {}, h('h1', { class: 'head__title', tabindex: '-1', text: title }), h('p', { class: 'head__sub', text: sub })),\n      h('div', { class: 'head__tools' },\n        h('span', { class: 'head__time', text: D ? fmtClock(D.at) + ' の内容' : '' }),\n        h('button', { type: 'button', class: 'btn btn--small', id: 'refresh', onclick: function (e) {\n          var b = e.currentTarget; b.disabled = true;\n          var icon = b.querySelector('.icon'); if (icon) icon.setAttribute('class', 'icon spin');\n          refresh();\n        } }, h('span', { svg: ICON.refresh }), '更新')));\n  }\n\n  var VIEWS = {};\n  // 回答の一覧の条件を入れかえる。とちゅうの読みこみがあっても、その返事は使",
"わない\n  // （前の条件の結果を、新しい条件の下に出してしまわないように）\n  function resetAnswers(filter) {\n    var st = state.answers, f = blankFilter();\n    for (var k in filter) if (Object.prototype.hasOwnProperty.call(f, k)) f[k] = filter[k];\n    answersSeq++;\n    st.filter = f; st.qDraft = f.q; st.offset = 0; st.data = null; st.error = ''; st.open = bag(); st.loading = false; st.fresh = 0;\n  }\n  function show(name, opt) {\n    if (blocked) return;\n    if (view === 'settings' && name !== 'settings' && state.settings.saving) {\n      toast('設定を保存しています。終わるまで、少しお待ちください。');\n      return;\n    }\n    if (view === 'settings' && name !== 'settings' && state.settings.dirty) {\n      dialog({ title: '保存していない変更があります', body: '設定の変更を、まだ保存していません。',\n        actions: [{ label: '保存せずに移る', value: 1 }, { label: 'もどって保存する', value: 0, kind: 'primary' }] })\n        .then(function (v) { if (v === 1) { state.settings.dirty = false; state.settin",
"gs.draft = null; state.settings.touched = bag(); show(name, opt); } });\n      return;\n    }\n    stopAudio();\n    finishMemo();\n    view = name;\n    if (opt && opt.filter) resetAnswers(opt.filter);\n    if (opt && opt.people) state.people.filter = opt.people;\n    render();\n    window.scrollTo(0, 0);\n    focusHeading();\n  }\n  function render() {\n    if (blocked) return;\n    var mark = focusMark();\n    paintChrome();\n    var holder = byId('view');\n    holder.innerHTML = '';\n    if (!D) return;\n    holder.appendChild(VIEWS[view]());\n    if (view === 'home') drawChart();\n    if (view === 'people') paintPeople();\n    if (view === 'answers') {\n      var sa = state.answers;\n      // さがす欄に書いてあって、まだ条件になっていない文字があれば、ここで条件にする\n      if (sa.qDraft !== sa.filter.q && !sa.loading) { sa.filter.q = sa.qDraft; sa.offset = 0; sa.data = null; sa.open = bag(); }\n      if ((!sa.data || sa.error) && !sa.loading) ",
"loadAnswers(); else paintAnswers();\n    }\n    paintPlayButtons();\n    fitTables();\n    focusBack(mark);\n  }\n  // 表が横に入りきらないとき・スマートフォンでは、1行を1枚のカードの形にする\n  function fitTables() {\n    var tables = document.querySelectorAll('#view .table--stack');\n    var narrow = window.innerWidth <= 860;\n    for (var i = 0; i < tables.length; i++) {\n      var t = tables[i], wrap = t.parentNode;\n      t.classList.remove('is-stacked'); wrap.classList.remove('has-stacked');\n      if (narrow || wrap.scrollWidth > wrap.clientWidth + 1) { t.classList.add('is-stacked'); wrap.classList.add('has-stacked'); }\n    }\n  }\n\n  /* ============================================================\n   * 共通の部品\n   * ============================================================ */\n  // すごろくのマス：歩ごとに、歩きおえた（緑）・とちゅう・まだ を見せる\n  function strip(stepsDone) {\n    var cleared = 0, words = [];\n    var cells = D.steps.map(function (st, i) {\n      ",
"var n = stepsDone[i] || 0;\n      var kind = n >= st.count ? 'done' : (n > 0 ? 'part' : 'none');\n      if (kind === 'done') cleared++;\n      if (kind === 'part') words.push(st.no + '歩目はとちゅう（' + n + '/' + st.count + '問）');\n      var cell = h('span', { class: 'strip__cell', 'data-state': kind, title: stepName(st) + '：' + n + '/' + st.count + '問' });\n      if (kind === 'part') cell.style.setProperty('--part', Math.max(18, Math.round(n / st.count * 100)) + '%');\n      return cell;\n    });\n    var el = h('span', { class: 'strip', role: 'img', 'aria-label': D.steps.length + '歩のうち ' + cleared + '歩を歩きおえた' + (words.length ? '。' + words.join('、') : '') }, cells);\n    el.style.width = (Math.max(1, Math.min(D.steps.length, 10)) * 20 - 3) + 'px';      // 1段に10マスまで（歩の数が多いときは、折り返す）\n    return el;\n  }\n  function progress(p) {\n    var total = D.items.length;\n    var goal = total > 0 && p.answered >= total",
";\n    return h('div', { class: 'progress' }, strip(p.stepsDone),\n      goal ? h('span', { class: 'chip chip--ok', title: total + '問すべてに答えました' }, h('span', { svg: ICON.check }), 'ゴール')\n           : h('span', { class: 'progress__count', text: p.answered + '/' + total + '問' }));\n  }\n  function pidChip(id, clickable) {\n    if (!clickable) return h('span', { class: 'pid', title: id.length > 12 ? id : null, text: id });\n    return h('button', { type: 'button', class: 'pid', title: id + ' の回答を見る', 'aria-label': id + ' の回答を見る', onclick: function () { show('answers', { filter: { participant: id } }); } }, id);\n  }\n  function answerBlock(r) {\n    var main;\n    if (r.status !== '回答済') main = h('span', { class: 'chip chip--mute', title: r.status.length > 12 ? r.status : null, text: r.status.length > 12 ? r.status.slice(0, 12) + '…' : r.status });\n    else main = h('span', { class: 'answer', text: r.",
"answer || '（文字の回答なし）' });\n    return h('div', {}, main,\n      r.ex ? h('span', { class: 'answer__sub', text: '例文：' + r.ex }) : null,\n      r.note ? h('span', { class: 'answer__sub', text: '補足：' + r.note }) : null);\n  }\n  function snrChip(r) {\n    if (r.snr == null) return null;\n    if (r.snr < (D.noiseTh || 20)) return h('span', { class: 'chip chip--warn', title: '声とまわりの音の差が ' + r.snr + ' dB（目安 ' + D.noiseTh + ' dB より小さい）' }, h('span', { svg: ICON.warn }), '雑音');\n    return null;\n  }\n\n  /* ============================================================\n   * 録音の再生\n   * ============================================================ */\n  var player = null, playingKey = '', waitingKey = '', playSeq = 0, audioStore = bag(), audioOrder = [], silentUrl = '';\n  var lastTap = { key: '', at: 0 };\n  function audioKey(r, slot) { return r.sid + '|' + slot; }\n  function b64ToBuffer(b64) {\n    var bin = win",
"dow.atob(b64), n = bin.length, bytes = new Uint8Array(n);\n    for (var i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);\n    return bytes.buffer;\n  }\n  // WAV（16ビット）の音の場所を調べる\n  function wavInfo(buf) {\n    if (buf.byteLength < 44) return null;\n    var dv = new DataView(buf);\n    function tag(o) { return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)); }\n    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;\n    var off = 12, fmt = null;\n    while (off + 8 <= buf.byteLength) {\n      var id = tag(off), len = dv.getUint32(off + 4, true);\n      if (id === 'fmt ' && off + 24 <= buf.byteLength) fmt = { format: dv.getUint16(off + 8, true), channels: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };\n      else if (id === 'data') return fmt ? { format: fmt.format, channels: fmt.channels, rate",
": fmt.rate, bits: fmt.bits, offset: off + 8, length: Math.min(len, buf.byteLength - off - 8) } : null;\n      off += 8 + len + (len % 2);\n    }\n    return null;\n  }\n  // 聞きとりやすい音量にした写しを作る（もとの録音は変えない）。大きくする必要がなければ null\n  // 音量の小さい端末（iPhone など）の録音は、そのままだと、ほとんど聞こえないため。\n  function loudCopy(buf) {\n    var w = wavInfo(buf);\n    if (!w || w.format !== 1 || w.bits !== 16 || !w.channels || !w.rate) return null;\n    var dv = new DataView(buf), bytes = 2 * w.channels, total = Math.floor(w.length / bytes);\n    var frame = Math.max(1, Math.round(w.rate * 0.02)), powers = [], sum = 0, n = 0;\n    for (var i = 0; i < total; i++) {\n      var v = dv.getInt16(w.offset + i * bytes, true) / 32768;\n      sum += v * v;\n      if (++n === frame) { powers.push(sum / frame); sum = 0; n = 0; }\n    }\n    if (powers.length < 8) return null;\n    powers.sort(function (a, b) { return a - b; });\n    var top = powers.lengt",
"h - 3, ref = powers[top], acc = 0, used = 0;\n    for (var k = top; k >= 0 && used < 10; k--) { if (powers[k] < ref * 0.01) break; acc += powers[k]; used++; }\n    var speechDb = 10 * Math.log(Math.max(acc / used, 1e-10)) / Math.LN10;\n    if (!(speechDb > -70)) return null;\n    var gainDb = Math.min(36, -20 - speechDb);\n    if (!(gainDb > 1)) return null;\n    var gain = Math.pow(10, gainDb / 20), out = buf.slice(0), ov = new DataView(out);\n    for (var o = w.offset; o + 1 < w.offset + w.length; o += 2) {\n      var x = Math.round(dv.getInt16(o, true) * gain);\n      ov.setInt16(o, x > 32767 ? 32767 : (x < -32768 ? -32768 : x), true);\n    }\n    return out;\n  }\n  function getAudio(r, slot) {\n    var key = audioKey(r, slot);\n    if (audioStore[key]) return Promise.resolve(audioStore[key]);\n    return call('audio', { sid: r.sid, slot: slot }).then(function (res) {\n      if (audioStore[key]) retu",
"rn audioStore[key];           // 待っているあいだに、もう一方の取り寄せが先に届いた\n      var raw = b64ToBuffer(res.b64);\n      var loud = loudCopy(raw);\n      var entry = {\n        name: res.name,\n        url: window.URL.createObjectURL(new Blob([raw], { type: 'audio/wav' })),\n        loudUrl: loud ? window.URL.createObjectURL(new Blob([loud], { type: 'audio/wav' })) : ''\n      };\n      audioStore[key] = entry; audioOrder.push(key);\n      while (audioOrder.length > 24) {          // 古いものから手放す\n        var oldKey = audioOrder.shift(), old = audioStore[oldKey];\n        if (!old) continue;\n        if (oldKey === playingKey) { audioOrder.push(oldKey); if (audioOrder.length <= 25) break; continue; }\n        window.URL.revokeObjectURL(old.url); if (old.loudUrl) window.URL.revokeObjectURL(old.loudUrl); delete audioStore[oldKey];\n      }\n      return entry;\n    });\n  }\n  function paintPlayButtons() {\n    var btns = docu",
"ment.querySelectorAll('.playbtn');\n    for (var i = 0; i < btns.length; i++) {\n      var b = btns[i], key = b.getAttribute('data-akey');\n      var st = key === waitingKey ? 'loading' : (key === playingKey ? 'playing' : 'idle');\n      if (b.getAttribute('data-state') === st) continue;\n      b.setAttribute('data-state', st);\n      b.querySelector('.playbtn__icon').innerHTML = st === 'playing' ? ICON.stop : (st === 'loading' ? ICON.refresh : ICON.play);\n      if (st === 'loading') b.querySelector('.icon').setAttribute('class', 'icon spin');\n      b.setAttribute('aria-pressed', st === 'playing' ? 'true' : 'false');\n    }\n  }\n  function stopAudio() {\n    playSeq++;                                   // 取り寄せ中の録音があっても、届いたときに鳴らさない\n    var key = playingKey;\n    playingKey = ''; waitingKey = '';\n    if (player && key) { try { player.pause(); } catch (e) { /* 何もしない */ } }\n    paintPlayButtons();\n  }",
"\n  function ensurePlayer() {\n    if (player) return;\n    player = new window.Audio();\n    player.addEventListener('ended', function () { if (playingKey) stopAudio(); });\n    // イヤホンのボタンや電話の着信などで、外から止められたとき：ボタンの表示も「止まった」にそろえる\n    player.addEventListener('pause', function () { if (playingKey && player.paused && !player.ended) stopAudio(); });\n    player.addEventListener('error', function () {\n      if (!playingKey) return;\n      stopAudio();\n      toast('この録音は、ここでは再生できませんでした。「ドライブで開く」をお試しください。');\n    });\n  }\n  // 録音を取り寄せているあいだに「ボタンを押した」ことが時間切れにならないよう、押したその場で、無音を一瞬だけ鳴らしておく\n  // （iPhone・iPad は、ボタンを押した直後でないと音を鳴らせないため）\n  function prime() {\n    try {\n      if (!silentUrl) {\n        var n = 400, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);\n        var put = function (o, text) { for (var i = 0; i < text.length; i++) dv.setUint8(o + i, text.charCodeAt(i)); };\n        put(0, 'RIFF'); ",
"dv.setUint32(4, 36 + n * 2, true); put(8, 'WAVE'); put(12, 'fmt '); dv.setUint32(16, 16, true);\n        dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 8000, true); dv.setUint32(28, 16000, true);\n        dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); put(36, 'data'); dv.setUint32(40, n * 2, true);\n        silentUrl = window.URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));\n      }\n      player.src = silentUrl;\n      var p = player.play();\n      if (p && p.then) p.then(null, function () { /* 鳴らせなくても、そのまま続ける */ });\n    } catch (e) { /* 何もしない */ }\n  }\n  function togglePlay(r, slot) {\n    var key = audioKey(r, slot), now = Date.now();\n    // つづけて2回押してしまったとき（ダブルクリック）は、2回目を数えない。そうしないと「鳴らす→すぐ止める」になってしまう\n    if (lastTap.key === key && now - lastTap.at < 450) return;\n    lastTap = { key: key, at: now };\n    if (waitingKey === key) return;              // ",
"取り寄せているところ。そのまま待つ\n    if (playingKey === key) { stopAudio(); return; }\n    stopAudio();\n    ensurePlayer();\n    var seq = ++playSeq;\n    if (!audioStore[key]) prime();\n    waitingKey = key;\n    paintPlayButtons();\n    getAudio(r, slot).then(function (entry) {\n      if (seq !== playSeq) return;               // 待っているあいだに、止めたか、ほかの録音を押した\n      waitingKey = ''; playingKey = key;\n      player.src = (state.answers.loud && entry.loudUrl) ? entry.loudUrl : entry.url;\n      paintPlayButtons();\n      var p = player.play();\n      if (p && p.then) p.then(null, function () {\n        if (seq !== playSeq) return;\n        stopAudio();\n        toast('音を鳴らせませんでした。もう一度、再生のボタンを押してください。');\n      });\n    }, function (err) {\n      if (seq !== playSeq) return;\n      stopAudio();\n      failed(err);\n    });\n  }\n  function playButton(r, slot, label) {\n    var btn = h('button', { type: 'button', class: 'playbtn', '",
"data-akey': audioKey(r, slot), 'data-fk': 'play:' + audioKey(r, slot), 'data-state': 'idle', 'aria-pressed': 'false',\n      'aria-label': r.pid + ' 「' + r.prompt + '」の' + (slot === 'example' ? '例文の' : '') + '録音を聞く' },\n      h('span', { class: 'playbtn__icon', svg: ICON.play }), label);\n    btn.addEventListener('click', function () { togglePlay(r, slot); });\n    return btn;\n  }\n  function audioBlock(r) {\n    var parts = [];\n    if (r.a1) parts.push(playButton(r, 'main', r.sec != null ? fmtSec(r.sec) : '聞く'));\n    if (r.a2) parts.push(playButton(r, 'example', '例文'));\n    if (!parts.length && r.status === '回答済') {\n      parts.push(h('span', { class: 'chip chip--warn', title: r.noAudio ? '理由：' + r.noAudio : '録音がついていない回答です' }, h('span', { svg: ICON.micoff }), '録音なし'));\n    }\n    return parts.length ? h('div', { class: 'audio' }, parts) : null;\n  }\n  function saveWav(r, slot, btn) {\n    if (bt",
"n) btn.disabled = true;\n    var done = function () { if (btn) btn.disabled = false; };\n    if (!audioStore[audioKey(r, slot)]) toast('録音を取り寄せています…');\n    getAudio(r, slot).then(function (entry) {\n      done();\n      var a = h('a', { href: entry.url, download: entry.name || 'rokuon.wav' });\n      a.style.display = 'none';\n      document.body.appendChild(a);\n      a.click();\n      window.setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 0);\n      toast('「' + (entry.name || 'rokuon.wav') + '」を保存しました。');\n    }, function (err) { done(); failed(err); });\n  }\n\n  /* ============================================================\n   * ダッシュボード\n   * ============================================================ */\n  function tile(label, value, unit, sub, extra) {\n    return h('div', { class: 'tile' },\n      h('p', { class: 'tile__label', text: label }),\n      h('p', { class: 'ti",
"le__value' + (extra ? ' tile__value--state' : '') }, extra || null, h('span', { text: value }), unit ? h('span', { class: 'tile__unit', text: unit }) : null),\n      h('p', { class: 'tile__sub', text: sub }));\n  }\n  VIEWS.home = function () {\n    var t = D.totals, s = D.settings;\n    var wrap = h('div', { class: 'stack' }, head('ダッシュボード', '調査の進み具合を、ひと目で確かめられます。'));\n    D.problems.forEach(function (p) { wrap.appendChild(h('div', { class: 'notice notice--bad', role: 'alert' }, h('span', { svg: ICON.warn }), h('span', { text: p }))); });\n\n    wrap.appendChild(h('div', { class: 'grid grid--tiles' },\n      tile('受付', s.open ? '受付中' : '停止中', '', s.open ? 'ログインと回答ができます' : 'ログインも回答もできません', h('span', { class: 'dot' + (s.open ? '' : ' dot--stop') })),\n      tile('参加者', String(t.participants), '人', '回答をはじめた人 ' + t.started + '人'),\n      tile('集まった回答', String(t.rows), '件', '今日は ' + t.today + '件'),\n   ",
"   tile('ゴールした人', String(t.finished), '人', '全 ' + D.items.length + '問に答えた人')));\n\n    var flags = [];\n    if (t.noisy > 0) flags.push(h('button', { type: 'button', class: 'flag', 'data-fk': 'flag:noisy', onclick: function () { show('answers', { filter: { flag: 'noisy' } }); } }, h('span', { svg: ICON.warn }), '雑音の多い録音 ' + t.noisy + '件'));\n    if (t.noAudio > 0) flags.push(h('button', { type: 'button', class: 'flag', 'data-fk': 'flag:noaudio', onclick: function () { show('answers', { filter: { flag: 'noaudio' } }); } }, h('span', { svg: ICON.micoff }), '録音なしの回答 ' + t.noAudio + '件'));\n    if (flags.length) wrap.appendChild(h('div', { class: 'flags', role: 'group', 'aria-label': '気をつけたい回答' }, flags));\n\n    // 日ごとの回答数\n    var ranges = [['14', '14日'], ['30', '30日'], ['week', '週ごと']];\n    var chartCard = h('section', { class: 'card card--chart' },\n      h('div', { class: 'card__head' },\n       ",
" h('h2', { class: 'card__title', text: state.chart.range === 'week' ? '週ごとの回答数' : '日ごとの回答数' }),\n        h('div', { class: 'card__tools' },\n          h('button', { type: 'button', class: 'textbtn', 'data-fk': 'chart:table', 'aria-pressed': state.chart.table ? 'true' : 'false', onclick: function () { state.chart.table = !state.chart.table; render(); } }, state.chart.table ? 'グラフで見る' : '表で見る'),\n          h('div', { class: 'seg', role: 'group', 'aria-label': '期間' }, ranges.map(function (r) {\n            return h('button', { type: 'button', class: 'seg__btn', 'data-fk': 'chart:range:' + r[0], 'aria-pressed': state.chart.range === r[0] ? 'true' : 'false', onclick: function () { state.chart.range = r[0]; render(); } }, r[1]);\n          })))),\n      h('div', { id: 'chart-plot' }));\n\n    // 歩ごとのようす\n    var stepsCard = h('section', { class: 'card' },\n      h('div', { class: 'card__head' }, h('h2',",
" { class: 'card__title', text: '歩ごとのようす' })),\n      D.steps.length ? h('div', { class: 'steps' }, D.steps.map(function (st, i) {\n        var n = D.stepCleared[i] || 0, pct = t.started > 0 ? Math.round(n / t.started * 100) : 0;\n        return h('div', { class: 'steprow' },\n          h('div', { class: 'steprow__label' }, h('span', { class: 'steprow__name', title: stepName(st), text: stepName(st) }), h('span', { class: 'steprow__val', text: n + '人' })),\n          h('div', { class: 'meter', role: 'img', 'aria-label': stepName(st) + 'を歩きおえた人 ' + n + '人' }, h('div', { class: 'meter__fill', style: 'width:' + pct + '%' })));\n      })) : h('p', { class: 'empty', text: '「項目」シートに、設問がまだありません。' }),\n      D.steps.length ? h('p', { class: 'card__note', text: '回答をはじめた ' + t.started + '人のうち、その歩を歩きおえた人数です。' }) : null);\n\n    wrap.appendChild(h('div', { class: 'grid grid--2-1' }, chartCard, stepsCard));\n\n  ",
"  // 直近の回答\n    var recent = h('section', { class: 'card' },\n      h('div', { class: 'card__head' }, h('h2', { class: 'card__title', text: '直近の回答' }),\n        h('button', { type: 'button', class: 'textbtn', 'data-fk': 'all:answers', 'aria-label': '回答をすべて表示', onclick: function () { show('answers', { filter: {} }); } }, 'すべて表示')),\n      D.recent.length ? h('div', { class: 'list' }, D.recent.map(function (r) {\n        return h('div', { class: 'list__row' },\n          h('div', { class: 'list__top' }, pidChip(r.pid, true), h('span', { class: 'list__grow', text: r.prompt }), h('span', { class: 'list__time', text: fmtWhen(r.at) })),\n          h('div', { class: 'list__main' }, answerBlock(r), audioBlock(r), snrChip(r)));\n      })) : h('p', { class: 'empty', text: 'まだ回答がありません。参加者が答えると、ここに新しい順で出ます。' }));\n\n    // 参加者の進み具合\n    var active = D.participants.filter(function (p) { return p.rows > 0; }).so",
"rt(function (a, b) { return b.lastAt - a.lastAt; }).slice(0, 8);\n    var prog = h('section', { class: 'card' },\n      h('div', { class: 'card__head' }, h('h2', { class: 'card__title', text: '参加者の進み具合' }),\n        h('button', { type: 'button', class: 'textbtn', 'data-fk': 'all:people', 'aria-label': '参加者をすべて表示', onclick: function () { show('people', { people: 'all' }); } }, 'すべて表示')),\n      active.length ? h('div', { class: 'list' }, active.map(function (p) {\n        return h('div', { class: 'list__row' },\n          h('div', { class: 'list__top' }, pidChip(p.id, true), h('span', { class: 'list__grow' }), h('span', { class: 'list__time', text: fmtWhen(p.lastAt) })),\n          h('div', { class: 'list__main' }, progress(p)));\n      })) : h('p', { class: 'empty', text: D.participants.length ? 'まだ、だれも回答をはじめていません。' : 'まだ参加者がいません。「参加者」の画面で、ナンバーとパスワードを作れます。' }));\n\n    wrap.appendChild(h('div', { ",
"class: 'grid grid--1-1' }, recent, prog));\n    return wrap;\n  };\n\n  /* ---------- 回答数のグラフ ---------- */\n  var NS = 'http://www.w3.org/2000/svg';\n  function sv(tag, attrs) {\n    var el = document.createElementNS(NS, tag);\n    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, attrs[k]);\n    return el;\n  }\n  function chartSeries() {\n    var map = bag();\n    D.daily.forEach(function (d) { map[d[0]] = d[1]; });\n    var today = dayNo(D.today), out = [], i;\n    if (state.chart.range === 'week') {\n      var monday = today - ((today + 3) % 7);                 // その週の月曜日\n      for (i = 11; i >= 0; i--) {\n        var start = monday - 7 * i, sum = 0;\n        for (var k = 0; k < 7; k++) sum += map[dayText(start + k)] || 0;\n        var a = ymd(start), b = ymd(start + 6);\n        out.push({ v: sum, label: i === 0 ? '今週' : a.m + '/' + a.d, long: a.m + '月' + a.d ",
"+ '日〜' + b.m + '月' + b.d + '日' });\n      }\n    } else {\n      var n = state.chart.range === '30' ? 30 : 14;\n      for (i = n - 1; i >= 0; i--) {\n        var no = today - i, c = ymd(no);\n        out.push({ v: map[dayText(no)] || 0, label: i === 0 ? '今日' : c.m + '/' + c.d, long: c.m + '月' + c.d + '日（' + WEEK[(no + 4) % 7] + '）' });\n      }\n    }\n    return out;\n  }\n  function niceStep(max) {\n    var steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];\n    for (var i = 0; i < steps.length; i++) if (max / steps[i] <= 4) return steps[i];\n    return 20000;\n  }\n  var chartOutside = null;      // グラフの外を押したら、数の札（ツールチップ）を消すための見張り\n  function drawChart() {\n    var box = byId('chart-plot');\n    if (chartOutside) { document.removeEventListener('pointerdown', chartOutside, true); chartOutside = null; }\n    if (!box) return;\n    var data = chartSeries();\n    box.innerHTML = '';\n    if ",
"(D.totals.rows === 0) { box.appendChild(h('p', { class: 'empty', text: 'まだ回答がありません。参加者が答えると、ここに回答数のグラフが出ます。' })); return; }\n    var unit = state.chart.range === 'week' ? '週' : '日';\n    if (state.chart.table) {\n      box.appendChild(h('div', { class: 'chart__table' }, h('table', { class: 'table' },\n        h('thead', {}, h('tr', {}, h('th', { text: unit }), h('th', { class: 'right', text: '回答数' }))),\n        h('tbody', {}, data.slice().reverse().map(function (d) { return h('tr', {}, h('td', { text: d.long }), h('td', { class: 'right num', text: d.v + '件' })); })))));\n      return;\n    }\n    var max = 0;\n    data.forEach(function (d) { if (d.v > max) max = d.v; });\n    var step = niceStep(max), top = Math.max(step, Math.ceil(max / step) * step);\n    var total = data.reduce(function (a, d) { return a + d.v; }, 0);\n    // 左の余白は、目盛りの数字のけた数に合わせる（「1500」のような数字が切れないように）\n    var W = Math.max(260, ",
"Math.floor(box.clientWidth)), H = Math.max(224, Math.min(420, Math.floor(box.clientHeight)));\n    var m = { l: 16 + String(top).length * 7, r: 12, t: 18, b: 26 };\n    var pw = W - m.l - m.r, ph = H - m.t - m.b;\n    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, 'aria-hidden': 'true', focusable: 'false' });\n    for (var v = 0; v <= top; v += step) {\n      var gy = Math.round(m.t + ph - (v / top) * ph) + 0.5;\n      svg.appendChild(sv('line', { x1: m.l, x2: W - m.r, y1: gy, y2: gy, stroke: v === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }));\n      var yl = sv('text', { x: m.l - 7, y: gy + 4, 'text-anchor': 'end' });\n      yl.textContent = String(v);\n      svg.appendChild(yl);\n    }\n    var band = pw / data.length, bw = Math.min(24, Math.max(2, band - 4));\n    var every = Math.max(1, Math.ceil(42 / band));\n    var bars = [], tip = h('div', { class: 'char",
"t__tip' }), current = -1;\n    tip.style.display = 'none';\n    data.forEach(function (d, i) {\n      var x = m.l + band * i + (band - bw) / 2, base = m.t + ph;\n      var bh = d.v > 0 ? Math.max(2, (d.v / top) * ph) : 0, y = base - bh, r = Math.min(4, bw / 2, bh);\n      var bar = null;\n      if (d.v > 0) {\n        bar = sv('path', { class: 'chart__bar', d: 'M' + x + ' ' + base + 'V' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y + 'H' + (x + bw - r) + 'Q' + (x + bw) + ' ' + y + ' ' + (x + bw) + ' ' + (y + r) + 'V' + base + 'Z' });\n        svg.appendChild(bar);\n      }\n      bars.push({ el: bar, cx: x + bw / 2, top: y });\n      if ((data.length - 1 - i) % every === 0) {\n        var xl = sv('text', { x: m.l + band * i + band / 2, y: H - 8, 'text-anchor': 'middle' });\n        xl.textContent = d.label;\n        svg.appendChild(xl);\n      }\n      var hit = sv('rect', { x: m.l + band * i,",
" y: 0, width: band, height: H, fill: 'transparent' });\n      hit.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') point(i); });\n      // 指で押したとき：押した棒の数を出す。同じ棒をもう一度押したら消す\n      hit.addEventListener('pointerdown', function (e) { if (e.pointerType !== 'mouse' && current === i) point(-1); else point(i); });\n      svg.appendChild(hit);\n    });\n    if (total === 0) {\n      var none = sv('text', { class: 'chart__none', x: m.l + pw / 2, y: m.t + ph / 2, 'text-anchor': 'middle' });\n      none.textContent = 'この期間には、回答がありません。';\n      svg.appendChild(none);\n    }\n    function point(i) {\n      if (current >= 0 && bars[current].el) bars[current].el.removeAttribute('data-on');\n      current = i;\n      if (i < 0) { tip.style.display = 'none'; return; }\n      if (bars[i].el) bars[i].el.setAttribute('data-on', 'true');\n      tip.innerHTML = '';\n      add(tip, [h('strong', { t",
"ext: data[i].v + '件' }), h('span', { text: data[i].long })]);\n      tip.style.display = 'block';\n      var half = tip.offsetWidth / 2;\n      tip.style.left = Math.max(half, Math.min(W - half, bars[i].cx)) + 'px';\n      tip.style.top = Math.max(44, bars[i].top - 6) + 'px';\n    }\n    var plot = h('div', { class: 'chart', id: 'chart', tabindex: '0', role: 'group',\n      'aria-label': unit + 'ごとの回答数のグラフ。この期間の合計は ' + total + '件。左右の矢印キーで、' + unit + 'ごとの数を読めます。' });\n    plot.appendChild(svg);\n    plot.appendChild(tip);\n    // マウスがグラフの外へ出たら消す（指で押したときは、すぐに消えてしまわないように、外を押すまで出しておく）\n    plot.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') point(-1); });\n    plot.addEventListener('blur', function () { point(-1); });\n    plot.addEventListener('keydown', function (e) {\n      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;\n      e.preventDefault();\n      var n",
"ext = current < 0 ? data.length - 1 : current + (e.key === 'ArrowLeft' ? -1 : 1);\n      point(Math.max(0, Math.min(data.length - 1, next)));\n      live.textContent = data[current].long + '：' + data[current].v + '件';\n    });\n    chartOutside = function (e) { if (!plot.contains(e.target)) point(-1); };\n    document.addEventListener('pointerdown', chartOutside, true);\n    var live = h('p', { class: 'sr', 'aria-live': 'polite' });\n    box.appendChild(plot);\n    box.appendChild(live);\n  }\n  window.addEventListener('resize', debounce(function () {\n    if (!D || blocked || document.body.classList.contains('printing')) return;\n    if (view === 'home') drawChart();\n    fitTables();\n  }, 150));\n\n  /* ============================================================\n   * 参加者\n   * ============================================================ */\n  function peopleShown() {\n    var st = state.people, q = fol",
"d(st.q.trim()), total = D.items.length;\n    return D.participants.filter(function (p) {\n      if (q && fold(p.id).indexOf(q) < 0 && fold(p.memo).indexOf(q) < 0) return false;\n      if (st.filter === 'started') return p.rows > 0;\n      if (st.filter === 'none') return p.rows === 0;\n      if (st.filter === 'finished') return total > 0 && p.answered >= total;\n      if (st.filter === 'stopped') return p.disabled;\n      return true;\n    });\n  }\n  VIEWS.people = function () {\n    var st = state.people;\n    var search = h('input', { type: 'search', class: 'input', id: 'people-q', placeholder: 'ナンバー・メモでさがす', 'aria-label': 'ナンバー・メモでさがす', value: st.q,\n      oninput: function (e) { st.q = e.target.value; if (D.participants.length > 80) paintPeopleSoon(); else paintPeople(); } });\n    var filter = h('select', { class: 'select', id: 'people-filter', 'aria-label': '表示する参加者', onchange: function (e) { s",
"t.filter = e.target.value; paintPeople(); } },\n      [['all', 'すべての参加者'], ['started', '回答をはじめた人'], ['none', 'まだ回答のない人'], ['finished', 'ゴールした人'], ['stopped', '停止中の人']].map(function (o) {\n        return h('option', { value: o[0], selected: st.filter === o[0], text: o[1] });\n      }));\n    return h('div', { class: 'stack' },\n      head('参加者', '参加者ナンバーとパスワードの管理と、ひとりひとりの進み具合の確認ができます。'),\n      h('section', { class: 'card' },\n        h('div', { class: 'toolbar' },\n          h('div', { class: 'toolbar__grow' }, search), filter,\n          h('div', { class: 'toolbar__end' },\n            h('button', { type: 'button', class: 'btn btn--small', id: 'pw-toggle', disabled: st.pwLoading, onclick: togglePasswords }, h('span', { svg: ICON.eye }),\n              st.pwLoading ? '読みこんでいます…' : (st.pw ? 'パスワードをかくす' : 'パスワードを表示')),\n            h('button', { type: 'button', class: 'btn btn--small', id: 'print-card",
"s', onclick: printSelected }, h('span', { svg: ICON.print }), 'カードを印刷'),\n            h('button', { type: 'button', class: 'btn btn--small btn--primary', id: 'add-people', onclick: addPeople }, h('span', { svg: ICON.plus }), '参加者を追加'))),\n        h('div', { id: 'people-body' })));\n  };\n  // 参加者1人分の行\n  function personRow(p, showPw) {\n    var st = state.people;\n    var memoCell;\n    if (st.editing === p.id) {\n      var saving = !!st.memoSaving[p.id];\n      var input = h('input', { type: 'text', class: 'input', id: 'memo-input', maxlength: '500', value: st.memoDraft, disabled: saving, 'aria-label': p.id + ' のメモ', 'data-memo': p.id,\n        oninput: function () { st.memoDraft = input.value; },\n        onkeydown: function (e) {\n          if (composing(e)) return;                    // 日本語の変換を決める Enter では、保存しない\n          if (e.key === 'Enter') { e.preventDefault(); commitMemo(p.id, input.value);",
" }\n          else if (e.key === 'Escape') { e.preventDefault(); st.editing = ''; st.memoDraft = ''; paintPeople(); focusMemoButton(p.id); }\n        },\n        // ほかのところを押したら、書いたメモを保存する（少し待つのは、すぐ右の「保存」を押したときに二重にならないように）\n        onblur: function () {\n          window.setTimeout(function () {\n            if (st.editing !== p.id) return;\n            var cur = byId('memo-input');\n            if (cur && document.activeElement === cur) return;      // まだ、この欄で書いている（ほかの窓へ行って、もどってきたときなど）\n            commitMemo(p.id, cur ? cur.value : st.memoDraft);\n          }, 150);\n        } });\n      memoCell = h('div', { class: 'memo grow' }, input,\n        h('button', { type: 'button', class: 'btn btn--small', 'data-fk': 'memosave:' + p.id, disabled: saving, onclick: function () { commitMemo(p.id, input.value); } }, saving ? '保存中…' : '保存'));\n    } else {\n      memoCell = h('div', { class: 'memo grow' }, h('sp",
"an', { class: 'memo__text', text: p.memo || '' }),\n        p.registered ? h('button', { type: 'button', class: 'memo__edit', 'data-fk': 'memo:' + p.id, 'aria-label': p.id + ' のメモを書く', title: 'メモを書く', onclick: function () { editMemo(p.id); } }, h('span', { svg: ICON.pencil })) : null);\n    }\n    var notes = [];\n    if (p.noisy > 0) notes.push(h('button', { type: 'button', class: 'chip chip--warn', 'data-fk': 'noisy:' + p.id, title: '雑音の多い録音を見る', onclick: function () { show('answers', { filter: { participant: p.id, flag: 'noisy' } }); } }, h('span', { svg: ICON.warn }), '雑音 ' + p.noisy));\n    if (p.noAudio > 0) notes.push(h('button', { type: 'button', class: 'chip chip--warn', 'data-fk': 'noaudio:' + p.id, title: '録音なしの回答を見る', onclick: function () { show('answers', { filter: { participant: p.id, flag: 'noaudio' } }); } }, h('span', { svg: ICON.micoff }), '録音なし ' + p.noAudio));\n    var mark",
"2 = !p.registered ? h('span', { class: 'chip chip--mute', title: '「参加者」シートにないナンバーです（回答だけが残っています）', text: '登録なし' })\n      : (p.disabled ? h('span', { class: 'chip chip--stop', text: '停止中' }) : null);\n    var busy = !!st.busy[p.id];\n    return h('tr', { 'data-off': p.disabled ? 'true' : null, 'data-pid': p.id },\n      h('td', { class: 'c-id' }, h('div', { class: 'idcell' },\n        p.registered ? h('input', { type: 'checkbox', class: 'pick', 'data-fk': 'pick:' + p.id, 'aria-label': p.id + ' をえらぶ', checked: !!st.selected[p.id],\n          onchange: function (e) { if (e.target.checked) st.selected[p.id] = true; else delete st.selected[p.id]; paintPicked(); } }) : h('span', { class: 'pick pick--none' }),\n        h('span', { class: 'pid', title: p.id.length > 12 ? p.id : null, text: p.id }), mark2)),\n      showPw ? h('td', { class: 'c-pw', 'data-label': 'パスワード' }, !p.registered ? h('span', { cl",
"ass: 'muted', text: '—' })\n        : h('span', { class: 'pw', text: Object.prototype.hasOwnProperty.call(st.pw, p.id) || st.pw[p.id] !== undefined ? (st.pw[p.id] || '（なし）') : '…' })) : null,\n      h('td', { class: 'c-prog' }, progress(p), notes.length ? h('div', { class: 'audio notes' }, notes) : null),\n      h('td', { class: 'c-last nowrap' }, p.lastAt ? fmtWhen(p.lastAt) : [h('span', { class: 'muted', text: 'まだ' }),\n        p.lastLoginAt ? h('span', { class: 'subline', title: 'ログインはしたけれど、まだ回答を送っていません', text: 'ログイン ' + fmtWhen(p.lastLoginAt) }) : null]),\n      h('td', { class: 'c-memo', 'data-label': 'メモ' }, memoCell),\n      h('td', { class: 'c-act' }, h('div', { class: 'rowactions' },\n        p.rows > 0 ? h('button', { type: 'button', class: 'textbtn', 'data-fk': 'answers:' + p.id, 'aria-label': p.id + ' の回答を見る', onclick: function () { show('answers', { filter: { participant: p.id } })",
"; } }, '回答を見る') : null,\n        p.registered ? h('button', { type: 'button', class: 'btn btn--small', 'data-fk': 'stop:' + p.id, disabled: busy, 'aria-label': p.id + ' を' + (p.disabled ? '再開する' : '停止する'),\n          onclick: function () { toggleStop(p.id); } }, busy ? '…' : (p.disabled ? '再開する' : '停止する')) : null)));\n  }\n  var paintPeopleSoon = debounce(function () { if (view === 'people' && !blocked) paintPeople(); }, 140);\n  function pickedIds() {\n    return D.participants.filter(function (p) { return p.registered && state.people.selected[p.id]; }).map(function (p) { return p.id; });\n  }\n  // えらんだ人数を、「カードを印刷」のボタンと、見出しのチェックに映す\n  function paintPicked() {\n    var n = pickedIds().length, btn = byId('print-cards');\n    if (btn) btn.lastChild.textContent = n ? 'カードを印刷（' + n + '人）' : 'カードを印刷';\n    var shown = peopleShown().filter(function (p) { return p.registered; });\n    var every = shown.len",
"gth > 0 && shown.every(function (p) { return state.people.selected[p.id]; });\n    ['pick-all', 'pick-all-2'].forEach(function (id) { var all = byId(id); if (all) all.checked = every; });\n  }\n  function paintPeople() {\n    var body = byId('people-body');\n    if (!body) return;\n    var mark = focusMark();\n    var st = state.people, list = peopleShown();\n    if (st.editing && !st.memoSaving[st.editing] && !personById(st.editing)) { st.editing = ''; st.memoDraft = ''; }\n    body.innerHTML = '';\n    if (!D.participants.length) { body.appendChild(h('p', { class: 'empty', text: 'まだ参加者がいません。「参加者を追加」を押すと、ナンバーとパスワードを作れます。' })); paintPicked(); return; }\n    if (!list.length) { body.appendChild(h('p', { class: 'empty', text: '条件に合う参加者はいません。' })); paintPicked(); return; }\n    var showPw = !!st.pw;\n    var rows = list.map(function (p) { return personRow(p, showPw); });\n    var pickEvery = function (e)",
" {\n      list.forEach(function (p) { if (!p.registered) return; if (e.target.checked) st.selected[p.id] = true; else delete st.selected[p.id]; });\n      paintPeople();\n    };\n    var pickAll = h('label', { class: 'pickall' },\n      h('input', { type: 'checkbox', class: 'pick', id: 'pick-all', 'aria-label': '表示している参加者をすべてえらぶ', onchange: pickEvery }), 'ナンバー');\n    // 表が1人1枚のカードの形になっているとき（スマートフォンなど）は、見出しの行が出ないので、ここに出す\n    var pickAll2 = h('label', { class: 'pickall pickall--stack' },\n      h('input', { type: 'checkbox', class: 'pick', id: 'pick-all-2', onchange: pickEvery }), '表示している人を、すべてえらぶ');\n    body.appendChild(h('div', { class: 'tablewrap' }, pickAll2, h('table', { class: 'table table--stack table--people' },\n      h('thead', {}, h('tr', {}, h('th', {}, pickAll), showPw ? h('th', { text: 'パスワード' }) : null,\n        ['進み具合', '最後の回答', 'メモ'].map(function (t) { return h('th', { text: t });",
" }), h('th', {}, h('span', { class: 'sr', text: '操作' })))),\n      h('tbody', {}, rows))));\n    body.appendChild(h('p', { class: 'card__note', text: list.length + '人を表示しています（登録は ' + D.participants.filter(function (p) { return p.registered; }).length + '人）。カードを印刷する人をえらぶときは、左のチェックを入れてください。' }));\n    paintPicked();\n    fitTables();\n    focusBack(mark);\n  }\n  // メモを書いているとちゅうかどうか\n  function typingMemo() {\n    var el = document.activeElement;\n    return !!(el && el.id === 'memo-input' && state.people.editing);\n  }\n  // 1人分の行だけを描き直す。ほかの人のメモを書いているとちゅうなら、その入力欄にさわらないように、その行だけを入れかえる\n  // （日本語の変換のとちゅうで入力欄を作り直すと、変換がとぎれてしまうため）\n  function repaintPerson(id) {\n    if (view !== 'people' || blocked || document.body.classList.contains('printing')) return;\n    if (!typingMemo()) { paintPeople(); return; }\n    var rows = document.querySelectorAll('#people-body tr[data-pid]'), p = personById(id);\n    for (var i",
" = 0; i < rows.length; i++) {\n      var old = rows[i];\n      if (old.getAttribute('data-pid') !== id) continue;\n      if (!p) break;\n      var fresh = personRow(p, !!state.people.pw);\n      if (state.people.editing !== id) { old.parentNode.replaceChild(fresh, old); break; }\n      // 同じ人のメモを書いているとちゅう：メモの欄はそのままにして、ほかの欄だけを入れかえる\n      var before = Array.prototype.slice.call(old.children), after = Array.prototype.slice.call(fresh.children);\n      if (before.length !== after.length) break;\n      for (var k = 0; k < before.length; k++) {\n        if (before[k].className.indexOf('c-memo') < 0) old.replaceChild(after[k], before[k]);\n      }\n      if (p.disabled) old.setAttribute('data-off', 'true'); else old.removeAttribute('data-off');\n      break;\n    }\n    paintPicked();\n  }\n  function loadPasswords() {\n    return call('passwords').then(function (res) {\n      var map = bag();\n      res.list.for",
"Each(function (x) { map[x.id] = x.password; });\n      return map;\n    });\n  }\n  // パスワードを出しているあいだに参加者がふえたときなどのために、読み直す\n  function refreshPasswords() {\n    loadPasswords().then(function (map) {\n      if (!state.people.pw) return;\n      state.people.pw = map;\n      // メモを書いているとちゅうなら、描き直さない（次に描き直すときに、新しい内容になる）\n      if (view === 'people' && !blocked && !document.body.classList.contains('printing') && !typingMemo()) paintPeople();\n    }, function (err) { failed(err, true); });\n  }\n  // 「パスワードを表示」のボタンの文字と、一覧だけを描き直す\n  // （上の「さがす」欄や、書いているとちゅうのメモの入力欄は、作り直さない。日本語の変換がとぎれないように）\n  function paintPasswords() {\n    var st = state.people, b = byId('pw-toggle');\n    if (b) {\n      b.disabled = st.pwLoading;\n      b.lastChild.textContent = st.pwLoading ? '読みこんでいます…' : (st.pw ? 'パスワードをかくす' : 'パスワードを表示');\n    }\n    if (view === 'people' && !blocked && !document.body.classList.contains('printing') && !typing",
"Memo()) paintPeople();\n  }\n  function togglePasswords() {\n    var st = state.people;\n    if (st.pwLoading) return;\n    if (st.pw) { st.pw = null; paintPasswords(); return; }\n    st.pwLoading = true;\n    paintPasswords();\n    loadPasswords().then(function (map) { st.pwLoading = false; st.pw = map; paintPasswords(); }, function (err) { st.pwLoading = false; if (!failed(err)) paintPasswords(); });\n  }\n  function focusMemoButton(id) {\n    var c = document.querySelectorAll('[data-fk]');\n    for (var i = 0; i < c.length; i++) if (c[i].getAttribute('data-fk') === 'memo:' + id) { try { c[i].focus({ preventScroll: true }); } catch (e) { /* 何もしない */ } return; }\n  }\n  function editMemo(id) {\n    var st = state.people, p = personById(id);\n    if (!p) return;\n    if (st.editing && st.editing !== id) commitMemo(st.editing, st.memoDraft);      // 書きかけのほかのメモは、先に保存する\n    st.editing = id; st.memoDraft = S",
"tring(p.memo || '');\n    paintPeople();\n    var el = byId('memo-input');\n    if (!el) return;\n    // 入力欄に出た、はじめの文字を覚えておく（何も書きかえずに閉じたときに、保存しないため。\n    // 表に直接書いた改行つきのメモなどは、入力欄では1行になって出るので、元のメモとくらべるだけでは見分けられない）\n    st.memoStart = st.memoDraft = el.value;\n    el.focus(); el.select();\n  }\n  // 書きかけのメモがあれば保存する（画面を切りかえるときなど）\n  function finishMemo() {\n    var st = state.people;\n    if (st.editing && D && !st.memoSaving[st.editing]) commitMemo(st.editing, st.memoDraft);\n  }\n  function commitMemo(id, text) {\n    var st = state.people, p = D && personById(id);\n    if (!p || st.memoSaving[id]) return;\n    var typed = String(text == null ? '' : text);\n    text = typed.replace(/[\\r\\n\\t]+/g, ' ').trim();\n    if ((st.editing === id && typed === st.memoStart) || text === String(p.memo || '')) {             // 変わっていなければ、何も送らない\n      if (st.editing === id) { st.editing = ''; st.memoDraft = ''; if (view ===",
" 'people') { paintPeople(); } }\n      return;\n    }\n    st.memoSaving[id] = true;\n    if (view === 'people') repaintPerson(id);\n    mutate('setParticipant', { id: id, memo: text }).then(function (res) {\n      delete st.memoSaving[id];\n      var cur = personById(id);\n      if (cur) cur.memo = res.participant.memo;\n      var mine = st.editing === id;\n      if (mine) { st.editing = ''; st.memoDraft = ''; }\n      repaintPerson(id);\n      // キーボードで使っているとき：目印がどこにもなくなっていたら、メモのえんぴつのボタンにもどす\n      if (mine && view === 'people' && (!document.activeElement || document.activeElement === document.body)) focusMemoButton(id);\n      toast('メモを保存しました。');\n    }, function (err) {\n      delete st.memoSaving[id];\n      if (failed(err)) return;\n      repaintPerson(id);                                // 書いた文字は、入力欄に残してある\n    });\n  }\n  function toggleStop(id) {\n    var st = state.people, p = personById(id);\n    i",
"f (!p || st.busy[id]) return;\n    var stop = !p.disabled;\n    var go = function () {\n      st.busy[id] = true;\n      paintPeople();\n      mutate('setParticipant', { id: id, status: stop ? '停止' : '有効' }).then(function (res) {\n        delete st.busy[id];\n        var cur = personById(id);\n        if (cur) cur.disabled = res.participant.disabled;\n        repaintPerson(id);\n        toast(id + (stop ? ' を停止しました。' : ' を再開しました。'));\n      }, function (err) { delete st.busy[id]; if (!failed(err)) repaintPerson(id); });\n    };\n    if (!stop) { go(); return; }\n    dialog({ title: id + ' を停止しますか？', body: 'この参加者は、ログインも回答の送信もできなくなります。これまでの回答は残ります。あとで「再開する」を押せば、元にもどせます。',\n      actions: [{ label: 'やめる', value: 0 }, { label: '停止する', value: 1, kind: 'danger' }] }).then(function (v) { if (v === 1) go(); });\n  }\n  function addPeople() {\n    var input = h('input', { type: 'text', class: 'input input--narrow'",
", value: '5', inputmode: 'numeric', autocomplete: 'off', maxlength: '2', id: 'add-count', 'data-autofocus': true });\n    var body = h('div', {}, h('p', { text: 'ナンバーと6けたのパスワードを、自動で作ります。' }),\n      h('div', { class: 'field', style: 'margin-top:12px' }, h('label', { class: 'field__label', for: 'add-count', text: '何人分つくりますか？（1〜50）' }), input));\n    dialog({ title: '参加者を追加', body: body, actions: [\n      { label: 'やめる', value: null },\n      { label: 'つくる', kind: 'primary', run: function (close, setError, setBusy) {\n        var text = fold(input.value).replace(/\\s/g, '');\n        var n = /^\\d{1,2}$/.test(text) ? parseInt(text, 10) : 0;\n        if (!(n >= 1 && n <= 50)) { setError('1〜50の数字を入れてください。'); return; }\n        setBusy(true);\n        mutate('addParticipants', { count: n }).then(function (res) { close(res.added); }, function (err) {\n          if (failed(err, true)) { close(null); return;",
" }\n          setBusy(false);\n          setError(err.message);\n        });\n      } }\n    ] }).then(function (added) {\n      if (!added || !added.length) return;\n      if (state.people.pw) added.forEach(function (x) { state.people.pw[x.id] = x.password; });\n      // 追加した人を、まず手もとの一覧に足す（このあとの読み直しがうまくいかなくても、一覧に出るように）\n      added.forEach(function (x) {\n        if (personById(x.id)) return;\n        D.participants.push({ id: x.id, registered: true, disabled: false, memo: '', registeredAt: nowMs(), lastLoginAt: 0, answered: 0, noAnswer: 0,\n          stepsDone: D.steps.map(function () { return 0; }), rows: 0, noisy: 0, noAudio: 0, firstAt: 0, lastAt: 0 });\n        D.totals.participants++;\n      });\n      if (view === 'people') paintPeople();\n      loadOverview().then(softRender, function (err) {\n        if (!failed(err, true)) toast('追加はできましたが、新しい内容を読みこめませんでした。あとで「更新」を押してください。');\n      });\n      v",
"ar table = h('div', { class: 'newlist' }, h('table', {},\n        h('thead', {}, h('tr', {}, h('th', { text: '参加者ナンバー' }), h('th', { text: 'パスワード' }))),\n        h('tbody', {}, added.map(function (x) { return h('tr', {}, h('td', {}, h('span', { class: 'pid', text: x.id })), h('td', { class: 'pw', text: x.password })); }))));\n      dialog({ title: added.length + '人分を追加しました', wide: true,\n        body: h('div', {}, h('p', { text: 'ナンバーとパスワードを、登録のときに参加者へお渡しください。あとからでも、「パスワードを表示」や「カードを印刷」で確かめられます。' }), table),\n        actions: [{ label: 'とじる', value: 0 }, { label: 'カードを印刷', value: 1, kind: 'primary' }] }).then(function (v) { if (v === 1) openPrint(added); });\n    });\n  }\n  function printSelected() {\n    var ids = pickedIds();\n    var all = !ids.length;\n    if (all) ids = D.participants.filter(function (p) { return p.registered && !p.disabled; }).map(function (p) { return p.id; });\n    if (!ids.",
"length) { toast('印刷する参加者がいません。'); return; }\n    var btn = byId('print-cards');\n    var go = function () {\n      if (btn) btn.disabled = true;\n      loadPasswords().then(function (map) {\n        if (btn) btn.disabled = false;\n        if (view !== 'people' || blocked || dialogOpen) return;      // 待っているあいだに、ほかの画面へ移った\n        openPrint(ids.map(function (id) { return { id: id, password: map[id] || '' }; }));\n      }, function (err) { if (btn) btn.disabled = false; failed(err); });\n    };\n    if (!all) { go(); return; }\n    dialog({ title: '有効な参加者 ' + ids.length + '人分のカードを作りますか？', body: '一部の人だけ印刷したいときは、一覧の左のチェックでえらんでから「カードを印刷」を押してください。',\n      actions: [{ label: 'やめる', value: 0 }, { label: ids.length + '人分を作る', value: 1, kind: 'primary' }] }).then(function (v) { if (v === 1) go(); });\n  }\n  // アドレスは、「/」のあとで折り返せるようにする。「/」と「/」のあいだは、とちゅうで折り返さない\n  // （「-」のあとで行が変わると、その「-」がアドレスの一部なのかどうか、紙の上ではわかりにくい",
"ので）\n  function urlNodes(url) {\n    var parts = String(url).split('/'), out = [];\n    for (var i = 0; i < parts.length; i++) {\n      var last = i === parts.length - 1;\n      var text = parts[i] + (last ? '' : '/');\n      if (!text) continue;\n      out.push(text.length <= 34 ? h('span', { class: 'nowrap', text: text }) : text);      // とても長いまとまりは、入りきるように、どこででも折り返す\n      if (!last && parts[i] && parts[i].slice(-1) !== ':') out.push(h('wbr'));\n    }\n    return out;\n  }\n  // QRコードの絵を作る（作れないときは null）\n  function qrSvg(text) {\n    var q = null;\n    try { q = (typeof KSQR === 'object' && KSQR) ? KSQR.encode(text) : null; } catch (e) { q = null; }\n    if (!q) return null;\n    var n = q.size, quiet = 4, d = '', x, y, start, len;\n    for (y = 0; y < n; y++) {\n      for (x = 0; x < n; x++) {\n        if (!q.modules[y][x]) continue;\n        start = x;\n        while (x + 1 < n && q.modules[y][x + 1]) x+",
"+;\n        len = x - start + 1;\n        d += 'M' + (start + quiet) + ' ' + (y + quiet) + 'h' + len + 'v1h-' + len + 'z';\n      }\n    }\n    var full = n + quiet * 2;\n    var svg = sv('svg', { viewBox: '0 0 ' + full + ' ' + full, role: 'img', 'aria-label': 'サイトのアドレスのQRコード', 'shape-rendering': 'crispEdges' });\n    svg.appendChild(sv('rect', { width: full, height: full, fill: '#fff' }));\n    svg.appendChild(sv('path', { d: d, fill: '#000' }));\n    return svg;\n  }\n  // 長いナンバーやパスワードは、カードに入るように、小さめの文字にする\n  function sizeClass(text) { return text.length > 22 ? 'is-long is-xlong' : (text.length > 9 ? 'is-long' : null); }\n  function openPrint(list) {\n    var root = byId('print-root');\n    var site = D.settings.siteUrl;\n    stopAudio();\n    root.innerHTML = '';\n    add(root, [\n      h('div', { class: 'print__bar' },\n        h('p', {}, h('span', { class: 'print__title', tabindex: '-1', text: list.len",
"gth + '人分の参加者カードです。' }),\n          'A4 の紙1枚に6枚ずつ入ります。' + (site ? '' : '「設定」で「サイトのURL」を入れると、サイトのアドレスとQRコードも印刷されます。')),\n        h('button', { type: 'button', class: 'btn btn--primary', id: 'print-go', onclick: function () {\n          try { window.print(); } catch (e) { toast('印刷をはじめられませんでした。ブラウザのメニューから印刷してください。'); }\n        } }, h('span', { svg: ICON.print }), '印刷する'),\n        h('button', { type: 'button', class: 'btn', id: 'print-close', onclick: closePrint }, 'とじる')),\n      h('div', { class: 'pcards' }, list.map(function (x) {\n        var qr = site ? qrSvg(site) : null;\n        return h('div', { class: 'pcard' },\n          h('p', { class: 'pcard__title', text: '方言調査 参加者カード' }),\n          h('div', { class: 'pcard__top' },\n            h('dl', { class: 'pcard__kv' },\n              h('dt', { text: '参加者ナンバー' }), h('dd', { class: sizeClass(x.id), text: x.id }),\n              h('dt', { text: 'パ",
"スワード' }), x.password ? h('dd', { class: sizeClass(x.password), text: x.password })\n                : h('dd', { class: 'is-none', text: '（「参加者」シートに、まだ入っていません）' })),\n            qr ? h('div', { class: 'pcard__qr' }, qr) : null),\n          site ? h('p', { class: 'pcard__site' }, h('span', { class: 'pcard__label', text: qr ? 'サイトのアドレス（QRコードからも開けます）' : 'サイトのアドレス' }), urlNodes(site)) : null,\n          h('p', { class: 'pcard__hint', text: 'iPhone は Safari、Android は Chrome で開いてください。このカードは、ほかの人に見せないでください。' }));\n      }))\n    ]);\n    document.body.classList.add('printing');\n    window.scrollTo(0, 0);\n    var go = byId('print-go');\n    if (go) go.focus();\n  }\n  function closePrint() {\n    if (!document.body.classList.contains('printing')) return;\n    document.body.classList.remove('printing');\n    byId('print-root').innerHTML = '';\n    render();\n    var back = byId('print-cards');\n    if (back) { t",
"ry { back.focus(); } catch (e) { focusHeading(); } } else focusHeading();\n  }\n  document.addEventListener('keydown', function (e) {\n    if (e.key === 'Escape' && !composing(e) && !dialogOpen && document.body.classList.contains('printing')) { e.preventDefault(); closePrint(); }\n  });\n\n  /* ============================================================\n   * 回答と録音\n   * ============================================================ */\n  var answersSeq = 0;\n  function loadAnswers() {\n    var st = state.answers, seq = ++answersSeq;\n    st.loading = true; st.error = '';\n    paintAnswers();\n    call('answers', { filter: st.filter, offset: st.offset, limit: 50 }).then(function (res) {\n      if (seq !== answersSeq) return;            // そのあとで条件が変わった。新しいほうの結果を待つ\n      st.loading = false; st.data = res; st.offset = res.offset; st.fresh = 0;\n      if (res.noiseTh) D.noiseTh = res.noiseTh;\n      paintAnsw",
"ers();\n    }, function (err) {\n      if (seq !== answersSeq) return;\n      st.loading = false;\n      if (failed(err, true)) return;\n      st.error = err.message;\n      paintAnswers();\n    });\n  }\n  function setFilter(key, value) {\n    var st = state.answers;\n    st.filter[key] = value; st.offset = 0; st.open = bag();\n    if (key === 'q') st.qDraft = value;\n    stopAudio();\n    loadAnswers();\n  }\n  VIEWS.answers = function () {\n    var st = state.answers, f = st.filter;\n    function select(label, key, options) {\n      return h('select', { class: 'select', id: 'answers-' + key, 'aria-label': label, onchange: function (e) { setFilter(key, e.target.value); } },\n        options.map(function (o) { return h('option', { value: o[0], selected: String(f[key]) === String(o[0]), text: o[1] }); }));\n    }\n    var people = [['', 'すべての参加者']].concat(D.participants.filter(function (p) { return p.rows > 0",
" || p.id === f.participant; }).map(function (p) { return [p.id, p.id]; }));\n    var steps = [['', 'すべての歩']].concat(D.steps.map(function (s) { return [String(s.no), stepName(s)]; }));\n    var statuses = [['', 'すべての状態']].concat(D.statuses.map(function (s) { return [s, s]; }));\n    // 書いた文字は、条件になる前から qDraft に覚えておく（とちゅうで描き直しても、消えないように）\n    var search = h('input', { type: 'search', class: 'input', id: 'answers-q', placeholder: '設問・回答の文字でさがす', 'aria-label': '設問・回答の文字でさがす', value: st.qDraft });\n    var converting = false;                      // 日本語の変換のとちゅう\n    // この入力欄が画面に出ているあいだだけ、さがす（画面を切りかえたあとに、おくれて動かないように）\n    var apply = function () { if (!converting && document.body.contains(search) && view === 'answers' && search.value !== state.answers.filter.q) setFilter('q', search.value); };\n    var later = debounce(apply, 450);\n    search.addEventListener('compositionstart', function () { convertin",
"g = true; });\n    search.addEventListener('compositionend', function () { converting = false; st.qDraft = search.value; later(); });\n    search.addEventListener('input', function () { st.qDraft = search.value; later(); });\n    search.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !composing(e)) apply(); });\n    if (st.qDraft !== f.q) later();              // 前の読みこみが終わるのを待っていた文字\n    var item = f.item ? itemById(f.item) : null;\n    return h('div', { class: 'stack' },\n      head('回答と録音', '届いた回答を新しい順に見て、録音をその場で聞けます。'),\n      h('section', { class: 'card' },\n        h('div', { class: 'toolbar' },\n          select('参加者', 'participant', people), select('歩', 'step', steps), select('回答の状態', 'status', statuses),\n          select('録音', 'flag', [['', 'すべての録音'], ['noisy', '雑音の多い録音'], ['noaudio', '録音なしの回答']]),\n          h('div', { class: 'toolbar__grow' }, search),\n          h('div",
"', { class: 'toolbar__end' },\n            h('label', { class: 'check', title: '音量の小さい録音（iPhone など）を、聞きとりやすい大きさにして流します。保存されている録音は変わりません。' },\n              h('input', { type: 'checkbox', id: 'answers-loud', checked: st.loud, onchange: function (e) { st.loud = e.target.checked; stopAudio(); } }), '音を大きくして再生'))),\n        f.item ? h('div', { class: 'notice', style: 'margin-bottom:14px' }, h('span', { svg: ICON.list }),\n          h('span', {}, '設問 ' + f.item + (item ? '「' + item.prompt + '」' : '') + ' の回答だけを表示しています。　',\n            h('button', { type: 'button', class: 'textbtn', onclick: function () { var now = state.answers.filter; now.item = ''; resetAnswers(now); stopAudio(); render(); } }, 'この条件を外す'))) : null,\n        h('div', { id: 'answers-body' })));\n  };\n  function freshNotice() {\n    var st = state.answers;\n    return h('div', { class: 'notice notice--new', id: 'answers-fresh-box', rol",
"e: 'status' }, h('span', { svg: ICON.refresh }),\n      h('span', { class: 'notice__grow', text: '新しい回答が ' + st.fresh + '件 届いています。' }),\n      h('button', { type: 'button', class: 'btn btn--small', id: 'answers-fresh', onclick: function () { st.offset = 0; st.open = bag(); stopAudio(); loadAnswers(); } }, '表示する'));\n  }\n  // 知らせだけを、一覧の上に出す。一覧そのものは作り直さない（開いている「くわしく」や、押そうとしているボタンが、作り直されないように）\n  function paintFresh() {\n    var body = byId('answers-body'), st = state.answers;\n    if (!body) return;\n    var old = byId('answers-fresh-box');\n    if (!(st.fresh > 0) || st.error || !st.data) { if (old) old.parentNode.removeChild(old); return; }\n    if (old) old.parentNode.replaceChild(freshNotice(), old);\n    else body.insertBefore(freshNotice(), body.firstChild);\n  }\n  function paintAnswers() {\n    var body = byId('answers-body');\n    if (!body) return;\n    var mark = focusMark();\n    var st = stat",
"e.answers, data = st.data;\n    body.innerHTML = '';\n    body.style.opacity = (st.loading && data) ? '.55' : '';      // 読みこみ中は、前の内容をうすく残す（画面がとばないように）\n    if (st.error) {\n      body.appendChild(h('div', { class: 'notice notice--bad', role: 'alert' }, h('span', { svg: ICON.warn }), h('span', { class: 'notice__grow', text: st.error }),\n        h('button', { type: 'button', class: 'btn btn--small', id: 'answers-retry', onclick: function () { loadAnswers(); } }, 'もう一度ためす')));\n      focusBack(mark);\n      return;\n    }\n    if (!data) { body.appendChild(h('p', { class: 'empty', text: '読みこんでいます…' })); return; }\n    if (st.fresh > 0) body.appendChild(freshNotice());\n    if (!data.rows.length) {\n      var any = false;\n      for (var k in st.filter) if (st.filter[k]) any = true;\n      body.appendChild(h('div', { class: 'empty' }, h('p', { text: any ? '条件に合う回答はありません。' : 'まだ回答がありません。' }),\n        any",
" ? h('p', { style: 'margin-top:10px' }, h('button', { type: 'button', class: 'btn btn--small', onclick: function () { show('answers', { filter: {} }); } }, '条件をすべて外す')) : null));\n      focusBack(mark);\n      return;\n    }\n    var tbody = h('tbody', {});\n    data.rows.forEach(function (r) {\n      var open = !!st.open[r.sid];\n      var audio = audioBlock(r);\n      var tr = h('tr', { class: 'arow' },\n        h('td', { class: 'c-time nowrap', title: fmtFull(r.at) }, fmtWhen(r.at) || '—'),\n        h('td', { class: 'c-pid' }, pidChip(r.pid, st.filter.participant !== r.pid)),\n        h('td', { class: 'c-q cell-q' }, r.prompt, h('span', { class: 'cell-q__id', text: r.item + (r.step != null ? '　' + r.step + '歩目' : '') })),\n        h('td', { class: 'c-a cell-a' }, answerBlock(r)),\n        h('td', { class: 'c-audio' + (audio ? '' : ' c-audio--none') }, audio || h('span', { class: 'muted', text: '—'",
" })),\n        h('td', { class: 'c-snr nowrap' + (r.snr != null ? '' : ' c-snr--none') }, r.snr != null ? [h('span', { class: 'num', text: (Math.round(r.snr * 10) / 10).toFixed(1) + ' dB' }), ' ', snrChip(r)] : h('span', { class: 'muted', text: '—' })),\n        h('td', { class: 'c-more right' }, h('button', { type: 'button', class: 'textbtn', 'data-fk': 'more:' + r.sid, 'aria-expanded': open ? 'true' : 'false',\n          'aria-label': r.pid + ' 「' + r.prompt + '」の回答を' + (open ? 'とじる' : 'くわしく見る'),\n          onclick: function () { if (open) delete st.open[r.sid]; else st.open[r.sid] = true; paintAnswers(); } }, open ? 'とじる' : 'くわしく')));\n      tbody.appendChild(tr);\n      if (open) tbody.appendChild(h('tr', { class: 'detail' }, h('td', { colspan: '7' }, detail(r))));\n    });\n    body.appendChild(h('div', { class: 'tablewrap' }, h('table', { class: 'table table--stack table--answers' },\n     ",
" h('thead', {}, h('tr', {}, ['日時', '参加者', '設問', '回答', '録音', '声と雑音の差'].map(function (t) { return h('th', { text: t }); }), h('th', {}, h('span', { class: 'sr', text: 'くわしい内容' })))), tbody)));\n    var from = data.offset + 1, to = data.offset + data.rows.length;\n    body.appendChild(h('div', { class: 'pager' },\n      h('span', { text: from + '〜' + to + '件目（全 ' + data.total + '件）' }),\n      h('div', { class: 'pager__btns' },\n        h('button', { type: 'button', class: 'btn btn--small', id: 'answers-prev', disabled: data.offset <= 0 || st.loading, onclick: function () { st.offset = Math.max(0, data.offset - data.limit); st.open = bag(); stopAudio(); loadAnswers(); window.scrollTo(0, 0); } }, '前の' + data.limit + '件'),\n        h('button', { type: 'button', class: 'btn btn--small', id: 'answers-next', disabled: to >= data.total || st.loading, onclick: function () { st.offset = data.offset + dat",
"a.limit; st.open = bag(); stopAudio(); loadAnswers(); window.scrollTo(0, 0); } }, '次の' + data.limit + '件'))));\n    paintPlayButtons();\n    fitTables();\n    focusBack(mark);\n    // さいごのページでは「次の50件」が押せなくなる。目印がなくならないように、となりのボタンへ移す\n    if (mark && (mark.id === 'answers-next' || mark.id === 'answers-prev') && (!document.activeElement || document.activeElement === document.body)) {\n      var other = byId(mark.id === 'answers-next' ? 'answers-prev' : 'answers-next');\n      if (other && !other.disabled) { try { other.focus({ preventScroll: true }); } catch (e) { /* 何もしない */ } }\n    }\n  }\n  function detail(r) {\n    var box = h('div', { class: 'detail__box' });\n    if (r.segP || r.segA) {\n      var ps = String(r.segP || '').split('｜'), as = String(r.segA || '').split('｜');\n      var n = Math.max(ps.length, as.length), top = h('tr', {}), bottom = h('tr', {});\n      for (var i = 0; i < n; i++) { top",
".appendChild(h('th', { scope: 'col', text: ps[i] || '' })); bottom.appendChild(h('td', { text: as[i] || '—' })); }\n      box.appendChild(h('div', { class: 'segs__wrap' }, h('table', { class: 'segs' }, h('caption', { class: 'sr', text: '文節ごとの回答' }), h('tbody', {}, top, bottom))));\n    }\n    var list = h('dl', { class: 'kv' });\n    // v が配列のときは、ひとつひとつを、とちゅうで折り返さないまとまりにする\n    function kv(k, v) {\n      if (v === '' || v == null) return;\n      list.appendChild(h('dt', { text: k }));\n      list.appendChild(Array.isArray(v) ? h('dd', { class: 'kv__parts' }, v.map(function (t) { return h('span', { class: 'nowrap', text: t }); })) : h('dd', { text: v }));\n    }\n    var main = (r.info && r.info.main) || null;\n    kv('届いた日時', fmtFull(r.at));\n    kv('端末での回答日時', fmtClient(r.clientTime));\n    kv('回答にかかった時間', r.elapsed != null ? Math.round(r.elapsed) + '秒' : '');\n    kv('端末', r.device);\n    kv('録音の形式',",
" r.hz != null ? r.hz + ' Hz' + (r.sec != null ? '　' + fmtSec(r.sec) : '') : '');\n    if (main) {\n      kv('端末の自動補正', ['エコー除去 ' + (main.ec ? '入' : '切'), '雑音除去 ' + (main.ns ? '入' : '切'), '音量の自動調整 ' + (main.agc ? '入' : '切')]);\n      kv('最大の音量', typeof main.peak === 'number' ? main.peak + '（いちばん大きいと 1）' : '');\n      kv('まわりの音の大きさ', typeof main.noise === 'number' ? main.noise + ' dB' : '');\n      kv('マイク', main.input === 'bluetooth' ? '無線のイヤホンなど（音の帯域がせまくなります）' : '');\n    }\n    kv('録音なしの理由', r.noAudio);\n    kv('送信ID', r.sid);\n    box.appendChild(list);\n    var sheet = D.links.sheets && D.links.sheets['回答'];\n    box.appendChild(h('div', { class: 'detail__links' },\n      r.a1 ? httpsLink(r.a1.url, { class: 'textbtn' }, h('span', { svg: ICON.out }), 'ドライブで開く') : null,\n      r.a2 ? httpsLink(r.a2.url, { class: 'textbtn' }, h('span', { svg: ICON.out }), '例文の録音をドライブで開く') : null,\n      r.a1 ? h('butt",
"on', { type: 'button', class: 'textbtn', 'data-fk': 'wav:' + r.sid, onclick: function (e) { saveWav(r, 'main', e.currentTarget); } }, h('span', { svg: ICON.save }), 'WAVを保存') : null,\n      r.a2 ? h('button', { type: 'button', class: 'textbtn', 'data-fk': 'wav2:' + r.sid, onclick: function (e) { saveWav(r, 'example', e.currentTarget); } }, h('span', { svg: ICON.save }), '例文のWAVを保存') : null,\n      sheet ? httpsLink(sheet + '&range=A' + r.n, { class: 'textbtn' }, h('span', { svg: ICON.sheet }), '表でこの行を開く') : null));\n    return box;\n  }\n\n  /* ============================================================\n   * 項目\n   * ============================================================ */\n  var STATUS_COLOR = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];\n  VIEWS.items = function () {\n    var card = h('section', { class: 'card' });\n    card.appendChild(h('div', { class: '",
"card__head' },\n      h('div', { class: 'legend', 'aria-label': '色の意味' }, D.statuses.map(function (s, i) {\n        return h('span', { class: 'legend__item' }, h('span', { class: 'legend__key', style: 'background:' + STATUS_COLOR[i] }), s);\n      })),\n      httpsLink(D.links.sheets && D.links.sheets['項目'], { class: 'btn btn--small' }, h('span', { svg: ICON.sheet }), '「項目」シートを開く')));\n    if (!D.items.length) card.appendChild(h('p', { class: 'empty', text: '「項目」シートに、設問がまだありません。' }));\n    D.steps.forEach(function (st) {\n      var items = D.items.filter(function (it) { return it.step === st.no; });\n      card.appendChild(h('div', { class: 'stephead' }, h('h2', { class: 'stephead__title', text: stepName(st) }), h('span', { class: 'muted', style: 'font-size:13px', text: items.length + '問' })));\n      card.appendChild(h('div', { class: 'tablewrap' }, h('table', { class: 'table table--stack table-",
"-items' },\n        h('thead', {}, h('tr', {}, h('th', { text: '設問' }), h('th', { class: 'col-n', text: '回答した人' }), h('th', { class: 'col-bar', text: '内訳' }), h('th', { class: 'col-go' }, h('span', { class: 'sr', text: '回答を見る' })))),\n        h('tbody', {}, items.map(function (it) {\n          var total = it.stat.reduce(function (a, b) { return a + b; }, 0);\n          var bar = total ? h('div', { class: 'stackbar', role: 'img', 'aria-label': D.statuses.map(function (s, i) { return s + ' ' + it.stat[i] + '人'; }).join('、') },\n            it.stat.map(function (n, i) { return n > 0 ? h('span', { class: 'stackbar__seg', style: 'flex:' + n + ' 1 0;background:' + STATUS_COLOR[i], title: D.statuses[i] + '：' + n + '人' }) : null; }))\n            : h('div', { class: 'stackbar stackbar--none', role: 'img', 'aria-label': 'まだ回答がありません' });\n          var words = [];\n          for (var i = 0; i < it.stat.le",
"ngth; i++) if (it.stat[i] > 0) words.push(D.statuses[i] + ' ' + it.stat[i]);\n          return h('tr', {},\n            h('td', { class: 'cell-q' }, it.prompt, h('span', { class: 'cell-q__id', text: it.id + '　' + it.type + (it.context ? '　' + it.context : '') })),\n            h('td', { class: 'nowrap num', 'data-label': '回答した人' }, h('span', { text: total + '人' })),\n            h('td', { 'data-label': '内訳' }, h('div', { class: 'grow' }, bar, h('p', { class: 'breakdown', text: words.join('　') || 'まだ回答がありません' }))),\n            h('td', { class: 'right' }, total ? h('button', { type: 'button', class: 'textbtn', 'data-fk': 'item:' + it.id, 'aria-label': '「' + it.prompt + '」の回答を見る', onclick: function () { show('answers', { filter: { item: it.id } }); } }, '回答を見る') : null));\n        })))));\n    });\n    return h('div', { class: 'stack' },\n      head('項目', '設問ごとに、何人が答えたか、どう答えたかを確かめられます。'),\n      h('",
"div', { class: 'notice' }, h('span', { svg: ICON.sheet }), h('span', { text: '設問の追加や書きかえは、スプレッドシートの「項目」シートで行います。同じ設問に何度か答えた人は、いちばん新しい回答で数えています。' })),\n      card);\n  };\n\n  /* ============================================================\n   * 設定\n   * ============================================================ */\n  var SETTING_KEYS = { notice: 'お知らせ', instruction: '教示文', wordQuestion: '語彙の質問文', sentenceQuestion: '例文の質問文',\n    maxRecordSec: '録音の上限（秒）', noiseWarnDb: '雑音の注意の目安（dB）', idPrefix: '参加者ナンバーの頭文字', siteUrl: 'サイトのURL' };\n  VIEWS.settings = function () {\n    var st = state.settings, s = D.settings;\n    if (!st.draft) { st.draft = {}; st.touched = bag(); st.dirty = false; st.message = ''; st.bad = false; }\n    // 自分で書きかえていない欄には、いつも保存先のいまの内容を出す（書きかえた欄は、書いたままにしておく）\n    for (var k in SETTING_KEYS) if (!st.touched[k]) st.draft[k] = String(s[k] == null ? '' : s[k]);\n    var saveBtn = h('butto",
"n', { type: 'button', class: 'btn btn--primary', id: 'settings-save', disabled: !st.dirty || st.saving, onclick: saveSettings }, st.saving ? '保存しています…' : '保存する');\n    var msg = h('span', { class: 'savebar__msg' + (st.bad ? ' savebar__msg--bad' : ''), id: 'settings-msg', role: 'status', tabindex: '-1',\n      text: st.saving ? '' : (st.message || (st.dirty ? 'まだ保存していない変更があります。' : '変更はありません。')) });\n    function changed(key, value) {\n      st.draft[key] = value; st.touched[key] = true; st.dirty = true; st.message = ''; st.bad = false;\n      saveBtn.disabled = false;\n      msg.className = 'savebar__msg'; msg.textContent = 'まだ保存していない変更があります。';\n    }\n    function field(key, label, hint, kind, extra) {\n      var id = 'set-' + key, input;\n      // 保存しているあいだは、書きかえられないようにする（送ったものと、画面に見えているものが食いちがわないように）\n      var attrs = { id: id, class: kind === 'textarea' ? 'textarea' : 'input' + (kind === 'numbe",
"r' || kind === 'short' ? ' input--narrow' : ''), disabled: st.saving, oninput: function (e) { changed(key, e.target.value); } };\n      if (extra) for (var a in extra) attrs[a] = extra[a];\n      if (kind === 'textarea') { input = h('textarea', attrs); input.value = st.draft[key]; }\n      else { attrs.type = kind === 'url' ? 'url' : 'text'; attrs.value = st.draft[key]; input = h('input', attrs); }\n      return h('div', { class: 'field' }, h('label', { class: 'field__label', for: id, text: label }), input, hint ? h('p', { class: 'field__hint', text: hint }) : null);\n    }\n    return h('div', { class: 'stack' },\n      head('設定', '受付の開始・停止や、参加者の画面に出す文章を変えられます。'),\n      openCard(),\n      h('section', { class: 'card' },\n        h('div', { class: 'card__head' }, h('h2', { class: 'card__title', text: '参加者の画面に出す文章' })),\n        field('notice', 'お知らせ', '書くと、参加者の地図の画面の上に出ます。空欄なら何も出ません。', 'textarea',",
" { maxlength: '300' }),\n        field('instruction', '教示文', 'すべての設問の上に出る説明です。', 'textarea', { maxlength: '400' }),\n        field('wordQuestion', '語彙の質問文', '{語} のところに、提示語が入ります。', 'text', { maxlength: '200' }),\n        field('sentenceQuestion', '例文の質問文', '{文} のところに、例文が入ります。', 'text', { maxlength: '200' })),\n      h('section', { class: 'card' },\n        h('div', { class: 'card__head' }, h('h2', { class: 'card__title', text: '録音' })),\n        field('maxRecordSec', '録音の上限（秒）', '1回の録音の長さの上限です（5〜60）。長くすると、通信のおそい場所では送信に時間がかかります。', 'number', { maxlength: '3', inputmode: 'numeric', autocomplete: 'off' }),\n        field('noiseWarnDb', '雑音の注意の目安（dB）', '声と、まわりの音の大きさの差がこの数字より小さい録音に、注意を出します（5〜40）。数字を大きくすると、きびしくなります。0 にすると注意を出しません。', 'number', { maxlength: '3', inputmode: 'numeric', autocomplete: 'off' })),\n      h('section', { class: 'card' },\n        h('div', { class: 'card__head' }, h('h2', { class: ",
"'card__title', text: '参加者の登録' })),\n        field('idPrefix', '参加者ナンバーの頭文字', '「参加者を追加」で自動的に作るナンバーの頭文字です（半角の英数字1〜4文字）。', 'short', { maxlength: '4', autocapitalize: 'characters' }),\n        field('siteUrl', 'サイトのURL', '参加者に案内するサイトのアドレスです。「参加者の画面を開く」と、参加者カードの印刷に使います。', 'url', { maxlength: '200', placeholder: 'https://' })),\n      h('div', { class: 'savebar' }, h('div', { class: 'savebar__box' }, saveBtn, msg)),\n      h('section', { class: 'card' },\n        h('div', { class: 'card__head' }, h('h2', { class: 'card__title', text: 'データの置き場所' })),\n        h('div', { class: 'linkrow' },\n          httpsLink(D.links.spreadsheet, { class: 'btn btn--small' }, h('span', { svg: ICON.sheet }), 'スプレッドシートを開く'),\n          httpsLink(D.links.audioFolder, { class: 'btn btn--small' }, h('span', { svg: ICON.folder }), '録音フォルダを開く'),\n          siteButton('btn btn--small')),\n        h('p', { class: 'card__note', te",
"xt: '回答は「' + D.name + '」の「回答」シートに、録音は録音フォルダに入っています。プログラムのバージョンは ' + D.version + ' です。' })));\n  };\n  function saveSettings() {\n    var st = state.settings, values = {};\n    if (st.saving) return;\n    // 送るのは、自分で書きかえた欄だけ（開いているあいだに、表のほうで変えられた欄を、古い内容にもどしてしまわないように）\n    var any = false;\n    for (var k in SETTING_KEYS) if (st.touched[k] && st.draft[k] !== String(D.settings[k] == null ? '' : D.settings[k])) { values[SETTING_KEYS[k]] = st.draft[k]; any = true; }\n    if (!any) {                                    // 書きかえたあと、元にもどしただけ\n      st.dirty = false; st.draft = null; st.touched = bag();\n      render();\n      toast('変更はありません。');\n      return;\n    }\n    st.saving = true; st.message = ''; st.bad = false;\n    render();\n    mutate('saveSettings', { values: values }).then(function (res) {\n      D.settings = res.settings;\n      st.saving = false; st.dirty = false; st.draft = null; st.touched = bag(",
");\n      render();\n      var m = byId('settings-msg');\n      if (m && (!document.activeElement || document.activeElement === document.body)) { try { m.focus({ preventScroll: true }); } catch (e) { /* 何もしない */ } }\n      toast('設定を保存しました。');\n      // 目安の数字などが変わると、数えなおしが必要なものがあるので、全体を読み直す\n      loadOverview().then(function () { if (view !== 'settings' || !state.settings.dirty) render(); }, function (err) { failed(err, true); });\n    }, function (err) {\n      st.saving = false;\n      if (failed(err, true)) return;\n      st.message = err.message; st.bad = true;\n      render();\n    });\n  }\n  // 「受付」のカード\n  function openCard() {\n    var st = state.settings, s = D.settings;\n    return h('section', { class: 'card', id: 'open-card' },\n      h('div', { class: 'card__head' }, h('h2', { class: 'card__title', text: '受付' })),\n      h('div', { class: 'openrow' },\n        h('div', {}, h('p', { class: 'ope",
"nrow__state' }, h('span', { class: 'dot' + (s.open ? '' : ' dot--stop') }), s.open ? '受付中' : '停止中'),\n          h('p', { class: 'field__hint', text: s.open ? '参加者はログインして回答できます。' : 'だれもログイン・回答の送信ができません。回答は参加者の端末に残り、再開すると送られます。' })),\n        h('button', { type: 'button', class: 'btn' + (s.open ? ' btn--danger' : ' btn--primary'), id: 'open-toggle', disabled: st.toggling, onclick: toggleOpen }, s.open ? '受付を止める' : '受付を再開する')));\n  }\n  // 「受付」のカードだけを描き直す（下の入力欄は作り直さない。書いているとちゅうの文字や、日本語の変換がとぎれないように）\n  function paintOpen() {\n    var old = byId('open-card');\n    if (view !== 'settings' || !old) { softRender(); return; }\n    var mark = focusMark();\n    old.parentNode.replaceChild(openCard(), old);\n    paintChrome();\n    focusBack(mark);\n  }\n  function toggleOpen() {\n    var st = state.settings, open = D.settings.open;\n    if (st.toggling) return;\n    var go = function () {\n      st.toggling = true;",
"\n      paintOpen();\n      mutate('saveSettings', { values: { '受付': open ? '停止中' : '受付中' } }).then(function (res) {\n        st.toggling = false;\n        D.settings.open = res.settings.open;\n        paintOpen();\n        toast(res.settings.open ? '受付を再開しました。' : '受付を止めました。');\n      }, function (err) { st.toggling = false; if (!failed(err)) paintOpen(); });\n    };\n    if (!open) { go(); return; }\n    dialog({ title: '受付を止めますか？', body: 'すべての参加者が、ログインも回答の送信もできなくなります。書きかけ・未送信の回答は参加者の端末に残り、再開すると送られます。',\n      actions: [{ label: 'やめる', value: 0 }, { label: '受付を止める', value: 1, kind: 'danger' }] }).then(function (v) { if (v === 1) go(); });\n  }\n\n  /* ============================================================\n   * はじまり\n   * ============================================================ */\n  // メニューから開いた窓の大きさ：ブラウザの窓（わからなければ画面）に入る大きさにする\n  function dialogSize() {\n    var w = (window.screen && window.scr",
"een.availWidth) || 1280, hgt = (window.screen && window.screen.availHeight) || 800;\n    var ow = window.outerWidth, oh = window.outerHeight;\n    if (ow > 0 && ow !== window.innerWidth) w = Math.min(w, ow);\n    if (oh > window.innerHeight + 10) hgt = Math.min(hgt, oh);\n    return { w: Math.max(720, Math.min(1500, w - 80)), h: Math.max(420, Math.min(940, hgt - 230)) };\n  }\n  function start() {\n    buildShell();\n    // メニューから開いた窓は、画面の大きさに合わせて広げる\n    if (BOOT.mode === 'dialog' && gs && gs.host && gs.host.setWidth) {\n      try {\n        var size = dialogSize();\n        gs.host.setWidth(size.w);\n        gs.host.setHeight(size.h);\n      } catch (e) { /* 大きさを変えられなくても、そのまま使える */ }\n    }\n    firstLoad();\n  }\n  function firstLoad() {\n    var holder = byId('view');\n    holder.innerHTML = '';\n    holder.appendChild(screen('読みこんでいます…', []));\n    loadOverview().then(render, function (err) {\n      if (f",
"ailed(err, true)) return;\n      holder.innerHTML = '';\n      holder.appendChild(screen('読みこめませんでした',\n        [err.message, 'ほかの Google アカウントにもログインしていると、うまく動かないことがあります。その場合は、ほかのアカウントからログアウトするか、シークレット ウィンドウで、このスプレッドシートの持ち主のアカウントだけにログインして開いてください。'],\n        h('button', { type: 'button', class: 'btn btn--primary', onclick: firstLoad }, 'もう一度ためす'),\n        err.detail || ''));\n    });\n  }\n  // 1分ごとに、新しい内容にする（見ているあいだだけ）。\n  // 何かを書いているとちゅうには、画面を描き直さない（日本語の変換がとぎれたり、書いている場所がとんだりしないように）\n  var stale = false;            // 新しい内容を受け取ったが、まだ画面に出していない\n  // 入力欄やリストに目印があるだけでは「書いているとちゅう」とはみなさない（えらんだあと、そのままにしていることが多いので）。\n  // さいごにキーを押したり、えらんだりしてから 20 秒のあいだと、日本語の変換のとちゅうだけを「書いているとちゅう」とする\n  var lastTypedAt = 0, convertingNow = false;\n  function noteTyping(e) {\n    var t = e.target;\n    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.type !== 'checkbox') lastTypedAt = Date.now();\n  }\n  document.addEven",
"tListener('keydown', noteTyping, true);\n  document.addEventListener('input', noteTyping, true);\n  document.addEventListener('pointerdown', noteTyping, true);\n  document.addEventListener('compositionstart', function () { convertingNow = true; lastTypedAt = Date.now(); }, true);\n  document.addEventListener('compositionend', function () { convertingNow = false; lastTypedAt = Date.now(); }, true);\n  document.addEventListener('focusout', function () {\n    convertingNow = false;\n    // 書きおわって入力欄をはなれたら、待たせていた描き直しを行う\n    if (stale) window.setTimeout(function () { if (stale && !typing()) showFresh(); }, 400);\n  }, true);\n  function typing() {\n    var el = document.activeElement;\n    if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.type === 'checkbox') { convertingNow = false; return false; }\n    return convertingNow || Date.now() - lastTypedAt < 20000;\n  }\n  // いまの画面を描き直す。書いているとちゅうな",
"ら、あとで（書きおわってから）描き直す\n  function softRender() {\n    if (typing()) { stale = true; return; }\n    render();\n  }\n  function showFresh() {\n    if (blocked || dialogOpen || document.body.classList.contains('printing') || typing()) { stale = true; return; }\n    stale = false;\n    if (view === 'answers' && state.answers.data && !state.answers.error) {\n      // 見ている一覧は、勝手には入れかえない。新しい回答が届いていたら、知らせだけ出す\n      var st = state.answers;\n      if (typeof st.data.all === 'number' && D.totals.rows > st.data.all && st.fresh !== D.totals.rows - st.data.all) {\n        st.fresh = D.totals.rows - st.data.all;\n        if (!st.loading) paintFresh();\n      }\n      paintChrome();\n    } else {\n      render();                                  // 設定の画面でも、書きかえた欄は書いたままで残る\n    }\n    var time = document.querySelector('.head__time');\n    if (time) time.textContent = fmtClock(D.at) + ' の内容';\n  }\n  window.setInterval(function",
" () {\n    if (!D || blocked || document.hidden || dialogOpen || loadingOverview || document.body.classList.contains('printing')) return;\n    if (state.settings.saving || state.settings.toggling || playingKey || waitingKey || typing()) return;\n    if (stale) { showFresh(); return; }\n    if (Date.now() - loadedAt < 55000) return;\n    loadOverview(true).then(function () {\n      if (overviewChanged || view === 'answers') showFresh();\n      else { var time = document.querySelector('.head__time'); if (time) time.textContent = fmtClock(D.at) + ' の内容'; }\n    }, function (err) { failed(err, true); });\n  }, 15000);\n\n  start();\n})();\n</script>\n</body>\n</html>\n"
].join('');
// KS:ADMIN-HTML:END


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
