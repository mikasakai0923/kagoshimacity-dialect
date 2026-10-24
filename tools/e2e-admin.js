#!/usr/bin/env node
/*
 * 開発用：管理画面を本物のブラウザで動かして確かめる自動テスト。
 * Google 側は tools/mock-gas.js（まねサーバー）を使います。本物の Google へは、決して送りません。
 *
 *   node tools/e2e-admin.js [gas/Code.gs] [--shots フォルダ]
 *
 * Playwright（Chromium）が必要です。
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const { createGasWorld, startServer } = require('./mock-gas');
const seed = require('./seed-admin');

const args = process.argv.slice(2);
const shotsIdx = args.indexOf('--shots');
const shots = shotsIdx >= 0 ? path.resolve(args[shotsIdx + 1]) : null;
const codeArg = args.find((a, i) => !a.startsWith('--') && (shotsIdx < 0 || i !== shotsIdx + 1));
const code = path.resolve(codeArg || path.join(__dirname, '..', 'gas', 'Code.gs'));
const PORT = 8767, PORT_EMPTY = 8768;
const base = `http://localhost:${PORT}`;
const SITE = 'https://example.github.io/kotoba/';

let failed = 0, passed = 0;
const only = process.env.E2E_ONLY || '';
async function test(name, fn) {
  if (only && name.indexOf(only) < 0) return;
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) {
    failed++;
    console.error('  NG  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 7).join('\n      '));
    if (shots && test.page) { try { fs.mkdirSync(shots, { recursive: true }); await test.page.screenshot({ path: path.join(shots, 'NG-' + failed + '.png'), fullPage: true }); } catch (e2) { /* 何もしない */ } }
  }
}

(async () => {
  const quiet = console.log; console.log = () => {};
  const world = createGasWorld(code);
  world.call('setup');
  const made = seed(world, {});
  console.log = quiet;
  const token = world.call('ksMakeAdminToken_');
  const admin = (action, payload) => JSON.parse(world.call('ksAdminCall', token, action, JSON.stringify(payload || {})));
  assert.strictEqual(admin('saveSettings', { values: { 'サイトのURL': SITE } }).ok, true);
  const items = world.call('ksReadItems_');
  const answers = world.ss.getSheetByName('回答');
  const col = name => world.sheetRows('回答')[0].indexOf(name);
  // ページ送りを確かめるため、「参加者」シートにない人の古い回答を 65 件足す
  for (let i = 0; i < 65; i++) {
    const row = world.sheetRows('回答')[0].map(() => '');
    row[col('送信日時')] = new Date(Date.now() - (20 + (i % 15)) * 86400000 - i * 60000);
    row[col('参加者ナンバー')] = 'T900'; row[col('歩')] = items[i % items.length].step; row[col('設問ID')] = items[i % items.length].id; row[col('種別')] = items[i % items.length].type;
    row[col('提示語・例文')] = items[i % items.length].prompt; row[col('回答の状態')] = '回答済'; row[col('回答（地域の言葉）')] = 'ふるいこたえ' + (i + 1); row[col('送信ID')] = 'old-' + String(i).padStart(6, '0');
    answers.appendRow(row);
  }
  const sheetPeople = () => world.sheetRows('参加者').slice(1);
  const setting = key => (world.sheetRows('設定').find(r => r[0] === key) || [])[1];
  const overview = () => admin('overview');

  world.webUser = world.OWNER;
  const server = await startServer(world, PORT);
  const browser = await chromium.launch();
  const errors = [];

  async function newPage(opt) {
    opt = opt || {};
    const ctx = await browser.newContext({ viewport: opt.viewport || { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'ja-JP', timezoneId: opt.tz || 'Asia/Tokyo', acceptDownloads: true });
    // 念のため：本物の Google へは、テストからは決して送らない
    await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, route => { errors.push('外へ出ようとした: ' + route.request().url()); return route.abort(); });
    await ctx.addInitScript(() => {
      window.__plays = []; window.__printed = 0;
      window.print = function () { window.__printed++; };
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () { window.__plays.push(this.src); window.__player = this; return play.apply(this, arguments); };
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push('console: ' + m.text()); });
    test.page = page;
    return page;
  }
  async function openAdmin(opt) {
    const page = await newPage(opt);
    await page.goto(base + ((opt && opt.url) || '/exec?admin=1'));
    await page.waitForSelector('.tile');
    return page;
  }
  const shot = async (page, name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: path.join(shots, name + '.png'), fullPage: true }); } };
  const go = async (page, id) => { await page.locator('.nav [data-view="' + id + '"]').click(); await page.waitForFunction(v => document.querySelector('.nav [aria-current="page"]').getAttribute('data-view') === v, id); };
  const title = page => page.locator('.head__title').innerText();
  // 知らせ（トースト）が出るのを待つ。確かめたら消しておく（同じ文の知らせを、次に待つときにまちがえないように）
  const toast = async (page, re) => {
    await page.waitForFunction(src => { const t = document.querySelector('.toast'); return !!t && new RegExp(src).test(t.textContent); }, re.source, { timeout: 5000 });
    await page.evaluate(() => { const t = document.querySelector('.toast'); if (t) t.parentNode.removeChild(t); });
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const runs = () => world.control.runs || [];
  // 保存先への呼び出しが n 回に届くまで待つ
  const waitRuns = async n => { for (let i = 0; i < 500 && runs().length < n; i++) await sleep(10); assert.ok(runs().length >= n, '保存先への呼び出しが届かない'); };
  const toWide = text => String(text).replace(/[!-~]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
  const tableFits = page => page.evaluate(() => Array.from(document.querySelectorAll('#view .tablewrap')).filter(w => w.scrollWidth > w.clientWidth + 1).length === 0);
  const noOverflow = async (page, label) => {
    const o = await page.evaluate(() => {
      const iw = window.innerWidth, wide = [];
      document.querySelectorAll('body *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > iw + 0.5 && !el.closest('.tablewrap, .segs__wrap, .newlist, .chart__table')) wide.push(el.tagName.toLowerCase() + '.' + String(el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(' ')[0] + '(' + Math.round(r.right) + ')');
      });
      return { sw: document.documentElement.scrollWidth, iw, wide: wide.slice(0, 6) };
    });
    assert.ok(o.sw <= o.iw && !o.wide.length, label + '：横にはみ出している（' + o.sw + ' > ' + o.iw + '） ' + o.wide.join(' '));
  };
  // 回答の画面を、しぼりこみなしで開く
  const allAnswers = async page => {
    await go(page, 'home');
    await page.locator('.card', { hasText: '直近の回答' }).locator('.textbtn', { hasText: 'すべて表示' }).click();
    await answersLoaded(page);
  };
  const answersLoaded = page => page.waitForFunction(() => { const b = document.getElementById('answers-body'); return !!b && !b.style.opacity && (b.querySelector('.table') || b.querySelector('.empty p')) && !/読みこんでいます/.test(b.textContent); });
  const rowsOf = page => page.locator('.table--answers tbody tr.arow');

  /* ============================================================ */
  console.log('開ける人・開けない人');
  await test('ログインしていない人・ほかの人には、文字だけが出る', async () => {
    const page = await newPage();
    for (const who of ['', 'someone@example.com']) {
      world.webUser = who;
      await page.goto(base + '/exec?admin=1');
      const text = await page.evaluate(() => document.body.innerText);
      assert.ok(/この画面は開けませんでした/.test(text), text.slice(0, 80));
      assert.strictEqual(await page.evaluate(() => typeof window.google), 'undefined', 'Google とやりとりする道具が渡されている');
      assert.strictEqual(await page.locator('#app').count(), 0);
    }
    world.webUser = world.OWNER;
    await page.context().close();
  });

  const page = await openAdmin();

  console.log('ダッシュボード');
  await test('数字のカードが、保存先の内容と合っている', async () => {
    const o = overview();
    const tiles = await page.locator('.tile').evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
    assert.strictEqual(tiles.length, 4);
    assert.ok(/^受付 受付中/.test(tiles[0]), tiles[0]);
    assert.ok(new RegExp('^参加者 ' + o.totals.participants + ' ?人 回答をはじめた人 ' + o.totals.started + '人').test(tiles[1]), tiles[1]);
    assert.ok(new RegExp('^集まった回答 ' + o.totals.rows + ' ?件 今日は ' + o.totals.today + '件').test(tiles[2]), tiles[2]);
    assert.ok(new RegExp('^ゴールした人 ' + o.totals.finished + ' ?人 全 ' + items.length + '問').test(tiles[3]), tiles[3]);
    assert.strictEqual(await title(page), 'ダッシュボード');
    assert.ok(/バージョン 0\.5\.0/.test(await page.locator('.side__ver').innerText()));
    await shot(page, 'home');
  });
  await test('グラフ：14日・30日・週ごとを切りかえられる。表でも見られる', async () => {
    const o = overview();
    const days = n => { const set = {}; o.daily.forEach(d => { set[d[0]] = d[1]; }); let c = 0; const t = Date.parse(o.today + 'T00:00:00Z'); for (let i = 0; i < n; i++) if (set[new Date(t - i * 86400000).toISOString().slice(0, 10)]) c++; return c; };
    assert.strictEqual(await page.locator('.chart__bar').count(), days(14));
    assert.strictEqual(await page.locator('.card--chart .card__title').innerText(), '日ごとの回答数');
    assert.ok(/今日/.test(await page.locator('.chart svg').innerHTML()));
    await page.locator('.seg__btn', { hasText: '30日' }).click();
    assert.strictEqual(await page.locator('.chart__bar').count(), days(30));
    assert.ok(days(30) > days(14), 'テストの見本に、15〜30日前の回答がない');
    await page.locator('.seg__btn', { hasText: '週ごと' }).click();
    assert.strictEqual(await page.locator('.card--chart .card__title').innerText(), '週ごとの回答数');
    assert.ok(/今週/.test(await page.locator('.chart svg').innerHTML()));
    await page.locator('.card--chart .textbtn', { hasText: '表で見る' }).click();
    assert.strictEqual(await page.locator('.chart__table tbody tr').count(), 12);
    const sum = (await page.locator('.chart__table tbody td.num').allInnerTexts()).reduce((n, t) => n + parseInt(t, 10), 0);
    const from = Date.parse(o.today + 'T00:00:00Z') - 83 * 86400000;
    assert.ok(sum > 0 && sum <= o.daily.filter(d => Date.parse(d[0] + 'T00:00:00Z') >= from - 7 * 86400000).reduce((n, d) => n + d[1], 0));
    await page.locator('.card--chart .textbtn', { hasText: 'グラフで見る' }).click();
    await page.locator('.seg__btn', { hasText: '14日' }).click();
    assert.strictEqual(await page.locator('.chart__bar').count(), days(14));
  });
  await test('グラフ：マウスを乗せると数が出る。矢印キーでも読める', async () => {
    const o = overview();
    const todayCount = (o.daily.find(d => d[0] === o.today) || [0, 0])[1];
    const box = await page.locator('.chart svg').boundingBox();
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
    await page.waitForSelector('.chart__tip', { state: 'visible' });
    assert.ok(new RegExp('^' + todayCount + '件').test(await page.locator('.chart__tip').innerText()));
    await page.mouse.move(5, 5);
    await page.locator('.chart').focus();
    await page.keyboard.press('ArrowLeft');
    assert.ok(new RegExp('：' + todayCount + '件$').test(await page.locator('#chart-plot [aria-live]').innerText()));
    await page.keyboard.press('ArrowLeft');
    const y = new Date(Date.parse(o.today + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    const yCount = (o.daily.find(d => d[0] === y) || [0, 0])[1];
    assert.ok(new RegExp('：' + yCount + '件$').test(await page.locator('#chart-plot [aria-live]').innerText()));
    assert.ok(/合計は \d+件/.test(await page.locator('.chart').getAttribute('aria-label')));
  });
  await test('グラフ：指で押して出した数は、指を離しても残る。グラフの外を押すと消える', async () => {
    const box = await page.locator('.chart svg').boundingBox();
    const at = [box.x + box.width - 20, box.y + box.height / 2];
    const tap = () => page.evaluate(([x, y]) => document.elementFromPoint(x, y).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y })), at);
    const shown = () => page.evaluate(() => document.querySelector('.chart__tip').style.display !== 'none');
    await tap();
    assert.strictEqual(await shown(), true, '指で押しても、数が出ない');
    await page.evaluate(() => document.getElementById('chart').dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'touch' })));
    assert.strictEqual(await shown(), true, '指を離したら、数が消えた');
    await page.evaluate(() => document.querySelector('.head__title').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })));
    assert.strictEqual(await shown(), false, 'グラフの外を押しても、数が消えない');
    await tap();
    assert.strictEqual(await shown(), true);
    await tap();
    assert.strictEqual(await shown(), false, '同じ棒をもう一度押しても、数が消えない');
  });
  await test('歩ごとのようす・直近の回答・参加者の進み具合', async () => {
    const o = overview();
    assert.strictEqual(await page.locator('.steprow').count(), o.steps.length);
    const vals = await page.locator('.steprow__val').allInnerTexts();
    assert.deepStrictEqual(vals, o.stepCleared.map(n => n + '人'));
    assert.strictEqual(await page.locator('.card', { hasText: '直近の回答' }).locator('.list__row').count(), 8);
    assert.strictEqual(await page.locator('.card', { hasText: '直近の回答' }).locator('.list__row .pid').first().innerText(), o.recent[0].pid);
    const active = o.participants.filter(p => p.rows > 0).sort((a, b) => b.lastAt - a.lastAt).slice(0, 8);
    const prog = page.locator('.card', { hasText: '参加者の進み具合' });
    assert.deepStrictEqual(await prog.locator('.pid').allInnerTexts(), active.map(p => p.id));
    assert.strictEqual(await prog.locator('.list__row').first().locator('.strip__cell').count(), o.steps.length);
    const goals = active.filter(p => p.answered >= items.length).length;
    assert.strictEqual(await prog.locator('.chip--ok').count(), goals);
  });
  await test('「雑音の多い録音」「録音なしの回答」を押すと、その回答だけが出る', async () => {
    const o = overview();
    await page.locator('.flag', { hasText: '雑音の多い録音 ' + o.totals.noisy + '件' }).click();
    assert.strictEqual(await title(page), '回答と録音');
    await answersLoaded(page);
    assert.strictEqual(await page.locator('select[aria-label="録音"]').inputValue(), 'noisy');
    assert.strictEqual(await rowsOf(page).count(), o.totals.noisy);
    assert.strictEqual(await page.locator('.table--answers .chip--warn', { hasText: '雑音' }).count(), o.totals.noisy);
    await go(page, 'home');
    await page.locator('.flag', { hasText: '録音なしの回答 ' + o.totals.noAudio + '件' }).click();
    await answersLoaded(page);
    assert.ok(o.totals.noAudio > 50, 'テストの見本の「録音なし」が少ない');
    assert.strictEqual(await page.locator('.pager span').first().innerText(), '1〜50件目（全 ' + o.totals.noAudio + '件）');
    assert.strictEqual(await rowsOf(page).count(), 50);
    assert.strictEqual(await page.locator('.table--answers .chip--warn', { hasText: '録音なし' }).count(), 50);
    assert.strictEqual(await page.locator('.table--answers .playbtn').count(), 0);
    await go(page, 'home');
    await page.locator('.card', { hasText: '直近の回答' }).locator('.textbtn', { hasText: 'すべて表示' }).click();
    await answersLoaded(page);
    assert.strictEqual(await page.locator('select[aria-label="録音"]').inputValue(), '', '「すべて表示」で、しぼりこみが外れていない');
    await go(page, 'home');
  });
  await test('画面を切りかえると、見出しに目印（フォーカス）が移る', async () => {
    for (const [id, name] of [['people', '参加者'], ['answers', '回答と録音'], ['items', '項目'], ['settings', '設定'], ['home', 'ダッシュボード']]) {
      await go(page, id);
      assert.strictEqual(await title(page), name);
      assert.strictEqual(await page.evaluate(() => document.activeElement && document.activeElement.className), 'head__title');
    }
  });

  /* ============================================================ */
  console.log('参加者');
  await test('一覧・さがす・しぼりこむ', async () => {
    await go(page, 'people');
    const o = overview();
    const rows = page.locator('.table--people tbody tr');
    assert.strictEqual(await rows.count(), o.participants.length);
    assert.strictEqual(await page.locator('.table--people th', { hasText: 'パスワード' }).count(), 0, 'はじめは、パスワードの列を出さない');
    assert.strictEqual(await page.locator('#pick-all').isVisible(), true);
    assert.strictEqual(await page.locator('#pick-all-2').isVisible(), false, '表の形のときに、カードの形のための「すべてえらぶ」まで出ている');
    assert.ok(!(await page.locator('#people-body').innerText()).includes(made.people[0].pw));
    await page.locator('select[aria-label="表示する参加者"]').selectOption('stopped');
    assert.strictEqual(await rows.count(), 1);
    assert.strictEqual(await rows.locator('.chip--stop').innerText(), '停止中');
    await page.locator('select[aria-label="表示する参加者"]').selectOption('finished');
    assert.strictEqual(await rows.count(), o.totals.finished);
    await page.locator('select[aria-label="表示する参加者"]').selectOption('none');
    assert.strictEqual(await rows.count(), o.participants.filter(p => p.rows === 0).length);
    await page.locator('select[aria-label="表示する参加者"]').selectOption('all');
    await page.locator('input[aria-label="ナンバー・メモでさがす"]').fill('登録の予定');
    assert.strictEqual(await rows.count(), 1);
    await page.locator('input[aria-label="ナンバー・メモでさがす"]').fill(made.people[2].id.toLowerCase());
    assert.strictEqual(await rows.count(), 1);
    assert.strictEqual(await rows.locator('.pid').innerText(), made.people[2].id);
    await page.locator('#people-q').fill(toWide(made.people[2].id.toLowerCase()));
    assert.strictEqual(await rows.count(), 1, '全角で入れたナンバーでは、見つからない');
    assert.strictEqual(await rows.locator('.pid').innerText(), made.people[2].id);
    await page.locator('input[aria-label="ナンバー・メモでさがす"]').fill('zzzz');
    assert.ok(/条件に合う参加者はいません/.test(await page.locator('#people-body').innerText()));
    await page.locator('input[aria-label="ナンバー・メモでさがす"]').fill('');
    const ghost = page.locator('.table--people tbody tr[data-pid="T900"]');
    assert.strictEqual(await ghost.locator('.chip--mute').innerText(), '登録なし');
    assert.strictEqual(await ghost.locator('input[type=checkbox]').count(), 0);
    assert.strictEqual(await ghost.locator('.btn').count(), 0, '登録のない人には、停止のボタンを出さない');
    await shot(page, 'people');
  });
  await test('パスワードは、ボタンを押したときだけ出る', async () => {
    await page.locator('#pw-toggle').click();
    await page.waitForSelector('.table--people th:has-text("パスワード")');
    const shown = await page.locator('.table--people tbody tr').evaluateAll(trs => trs.map(tr => [tr.getAttribute('data-pid'), (tr.querySelector('.pw') || {}).textContent || '']));
    for (const p of sheetPeople()) assert.strictEqual((shown.find(x => x[0] === p[0]) || [])[1], p[1], p[0] + ' のパスワード');
    assert.strictEqual(await page.locator('#pw-toggle').innerText(), 'パスワードをかくす');
    await page.locator('#pw-toggle').click();
    await page.waitForFunction(() => !document.querySelector('.pw'));
    assert.strictEqual(await page.locator('#pw-toggle').innerText(), 'パスワードを表示');
  });
  await test('参加者を追加できる。作ったナンバーとパスワードが出る', async () => {
    const before = sheetPeople().length;
    await page.locator('.btn', { hasText: '参加者を追加' }).click();
    const dlg = page.locator('.dialog');
    assert.strictEqual(await dlg.locator('.dialog__title').innerText(), '参加者を追加');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'add-count');
    await dlg.locator('#add-count').fill('0');
    await dlg.locator('.btn', { hasText: 'つくる' }).click();
    assert.strictEqual(await dlg.locator('.dialog__error').innerText(), '1〜50の数字を入れてください。');
    assert.strictEqual(sheetPeople().length, before);
    world.control.lockBusy = 1;
    await dlg.locator('#add-count').fill('2');
    await dlg.locator('.btn', { hasText: 'つくる' }).click();
    await page.waitForFunction(() => /こみあっています/.test((document.querySelector('.dialog__error') || {}).textContent || ''));
    assert.strictEqual(sheetPeople().length, before, 'こみあっているときは、追加されない');
    await dlg.locator('.btn', { hasText: 'つくる' }).click();
    await page.waitForSelector('.dialog__title:has-text("2人分を追加しました")');
    const added = sheetPeople().slice(before);
    assert.strictEqual(added.length, 2);
    const cells = await page.locator('.newlist tbody tr').evaluateAll(trs => trs.map(tr => Array.from(tr.children).map(td => td.textContent)));
    assert.deepStrictEqual(cells, added.map(r => [r[0], r[1]]));
    await shot(page, 'people-added');
    await page.locator('.dialog .btn', { hasText: 'とじる' }).click();
    await page.waitForSelector('.table--people tbody tr[data-pid="' + added[1][0] + '"]');
    assert.strictEqual(await page.locator('.layer[data-open="true"]').count(), 0);
  });
  await test('窓は Esc キーや、外側を押して閉じられる。Tab キーで外へ出ない', async () => {
    await page.locator('.btn', { hasText: '参加者を追加' }).click();
    await page.waitForSelector('.dialog');
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => !!document.activeElement.closest('.dialog')), 'Tab キーで、窓の外へ出た');
    }
    await page.keyboard.press('Escape');
    assert.strictEqual(await page.locator('.dialog').count(), 0);
    assert.ok(/参加者を追加/.test(await page.evaluate(() => document.activeElement.textContent)), '閉じたあと、もとのボタンにもどらない');
    await page.locator('.btn', { hasText: '参加者を追加' }).click();
    await page.waitForSelector('.dialog');
    await page.mouse.click(8, 8);
    assert.strictEqual(await page.locator('.dialog').count(), 0);
  });
  await test('窓：Shift+Tab でも外へ出ない。中で押しはじめて外で離しても閉じない。数字の欄で Enter を押すと進む', async () => {
    const before = sheetPeople().length;
    await page.locator('#add-people').click();
    await page.waitForSelector('.dialog');
    await page.evaluate(() => document.getElementById('dialog-title').focus());
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('Shift+Tab');
      assert.ok(await page.evaluate(() => { const el = document.activeElement; return !!el.closest('.dialog') && /^(BUTTON|INPUT)$/.test(el.tagName); }), 'Shift+Tab で、窓の外へ出た（' + (i + 1) + '回目）');
    }
    const box = await page.locator('.dialog').boundingBox();
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(8, 8);
    await page.mouse.up();
    assert.strictEqual(await page.locator('.dialog').count(), 1, '窓の中で押しはじめて外で離したら、閉じてしまった');
    // 数字でないもの・小数は受けつけない
    for (const bad of ['2.', 'ab', '']) {
      await page.locator('#add-count').fill(bad);
      await page.locator('#add-count').press('Enter');
      assert.strictEqual(await page.locator('.dialog__error').innerText(), '1〜50の数字を入れてください。', bad);
    }
    assert.strictEqual(sheetPeople().length, before);
    await page.locator('#add-count').fill('１');                 // 全角の数字でもよい
    await page.locator('#add-count').press('Enter');
    await page.waitForSelector('.dialog__title:has-text("1人分を追加しました")');
    assert.strictEqual(sheetPeople().length, before + 1);
    await page.locator('.dialog .btn', { hasText: 'とじる' }).click();
    await page.waitForSelector('.table--people tbody tr[data-pid="' + sheetPeople()[before][0] + '"]');
  });
  await test('「つくる」をつづけて2回押しても、1回分だけ追加される。追加しているあいだは、窓を閉じられない', async () => {
    const before = sheetPeople().length, n = runs().length;
    await page.locator('#add-people').click();
    await page.locator('#add-count').fill('2');
    world.control.runDelayMs = 500;
    await page.locator('.dialog .btn', { hasText: 'つくる' }).dblclick();
    await waitRuns(n + 1);
    world.control.runDelayMs = 0;
    assert.strictEqual(await page.locator('.dialog .btn', { hasText: 'つくる' }).isDisabled(), true, '追加しているあいだも、ボタンを押せる');
    await page.keyboard.press('Escape');
    await page.mouse.click(8, 8);
    assert.strictEqual(await page.locator('.dialog__title').innerText(), '参加者を追加', '追加しているとちゅうで、窓が閉じた');
    await page.waitForSelector('.dialog__title:has-text("2人分を追加しました")');
    assert.strictEqual(sheetPeople().length, before + 2, '2回分、追加された');
    assert.strictEqual(runs().slice(n).filter(r => r[1] === 'addParticipants').length, 1);
    await page.locator('.dialog .btn', { hasText: 'とじる' }).click();
    await page.waitForSelector('.table--people tbody tr[data-pid="' + sheetPeople()[before + 1][0] + '"]');
  });
  await test('パスワードを出しているあいだに増えた人のパスワードも、出る', async () => {
    await page.locator('#pw-toggle').click();
    await page.waitForSelector('.table--people th:has-text("パスワード")');
    const before = sheetPeople().length;
    await page.locator('#add-people').click();
    await page.locator('#add-count').fill('1');
    await page.locator('.dialog .btn', { hasText: 'つくる' }).click();
    await page.waitForSelector('.dialog__title:has-text("1人分を追加しました")');
    await page.locator('.dialog .btn', { hasText: 'とじる' }).click();
    const mine = sheetPeople()[before];
    await page.waitForSelector('.table--people tbody tr[data-pid="' + mine[0] + '"]');
    assert.strictEqual(await page.locator('.table--people tbody tr[data-pid="' + mine[0] + '"] .pw').innerText(), mine[1], '追加したばかりの人のパスワードが出ない');
    // スプレッドシートのほうで足された人も、「更新」を押せば出る
    world.call('addParticipants', 1);
    const other = sheetPeople()[before + 1];
    await page.locator('#refresh').click();
    await page.waitForFunction(([id, pw]) => { const el = document.querySelector('.table--people tbody tr[data-pid="' + id + '"] .pw'); return !!el && el.textContent === pw; }, [other[0], other[1]]);
    await toast(page, /新しい内容にしました/);
    await page.locator('#pw-toggle').click();
    await page.waitForFunction(() => !document.querySelector('.pw'));
  });
  await test('追加のあとの読み直しに失敗しても、追加した人は一覧に出て、そのことを知らせる', async () => {
    const before = sheetPeople().length, n = runs().length;
    await page.locator('#add-people').click();
    await page.locator('#add-count').fill('1');
    world.control.runDelayMs = 400;
    await page.locator('.dialog .btn', { hasText: 'つくる' }).click();
    await waitRuns(n + 1);                                    // 追加の呼び出しが届いた（返事は、少しあとで届く）
    world.control.runDelayMs = 0;
    world.control.runFail = 1;                                // そのあとの読み直しを、失敗させる
    await page.waitForSelector('.dialog__title:has-text("1人分を追加しました")');
    await toast(page, /追加はできましたが、新しい内容を読みこめませんでした/);
    const mine = sheetPeople()[before];
    assert.strictEqual(await page.locator('.table--people tbody tr[data-pid="' + mine[0] + '"]').count(), 1, '追加した人が、一覧に出ていない');
    assert.ok((await page.locator('#people-body .card__note').innerText()).includes('登録は ' + (before + 1) + '人'));
    await page.locator('.dialog .btn', { hasText: 'とじる' }).click();
    await page.locator('#refresh').click();
    await toast(page, /新しい内容にしました/);
  });
  await test('「カードを印刷」を押してすぐにほかの画面へ移ったら、あとからカードの画面が出てこない', async () => {
    const box = page.locator('.table--people tbody tr[data-pid="' + made.people[0].id + '"] input[type=checkbox]');
    await box.check();
    const n = runs().length;
    world.control.runDelayMs = 600;
    await page.locator('#print-cards').click();
    await waitRuns(n + 1);
    world.control.runDelayMs = 0;
    await page.locator('.nav [data-view="items"]').click();
    await page.waitForTimeout(900);
    assert.strictEqual(await page.evaluate(() => document.body.classList.contains('printing')), false, 'ほかの画面の上に、カードの画面が出た');
    assert.strictEqual(await title(page), '項目');
    await go(page, 'people');
    await box.uncheck();
  });
  await test('参加者を停止できる（確かめの窓が出る）。元にもどせる', async () => {
    const id = made.people[6].id;
    const row = page.locator('.table--people tbody tr[data-pid="' + id + '"]');
    await row.locator('.btn', { hasText: '停止する' }).click();
    assert.ok((await page.locator('.dialog__title').innerText()).includes(id + ' を停止しますか'));
    await page.locator('.dialog .btn', { hasText: 'やめる' }).click();
    assert.strictEqual(sheetPeople().find(r => r[0] === id)[2], '有効');
    await row.locator('.btn', { hasText: '停止する' }).click();
    await page.locator('.dialog .btn', { hasText: '停止する' }).click();
    await toast(page, /を停止しました/);
    assert.strictEqual(sheetPeople().find(r => r[0] === id)[2], '停止');
    assert.strictEqual(await row.locator('.chip--stop').innerText(), '停止中');
    assert.strictEqual(await row.getAttribute('data-off'), 'true');
    assert.strictEqual(await row.locator('.btn', { hasText: '再開する' }).getAttribute('aria-label'), id + ' を再開する');
    await row.locator('.btn', { hasText: '再開する' }).click();
    await toast(page, /を再開しました/);
    assert.strictEqual(sheetPeople().find(r => r[0] === id)[2], '有効');
    assert.strictEqual(await row.locator('.chip--stop').count(), 0);
  });
  await test('メモを書ける（Enter で保存、Esc でやめる）', async () => {
    const id = made.people[4].id;
    const row = page.locator('.table--people tbody tr[data-pid="' + id + '"]');
    await row.locator('.memo__edit').click();
    assert.strictEqual(await page.evaluate(() => document.activeElement.getAttribute('data-memo')), id);
    await page.keyboard.type('70代・谷山');
    await page.keyboard.press('Enter');
    await toast(page, /メモを保存しました/);
    assert.strictEqual(sheetPeople().find(r => r[0] === id)[3], '70代・谷山');
    assert.strictEqual(await row.locator('.memo__text').innerText(), '70代・谷山');
    await row.locator('.memo__edit').click();
    await page.keyboard.type('けすつもり');
    await page.keyboard.press('Escape');
    assert.strictEqual(await row.locator('.memo__text').innerText(), '70代・谷山');
    assert.strictEqual(sheetPeople().find(r => r[0] === id)[3], '70代・谷山');
    await row.locator('.memo__edit').click();
    await page.locator('[data-memo]').fill('');
    await row.locator('.btn', { hasText: '保存' }).click();
    await toast(page, /メモを保存しました/);
    assert.strictEqual(sheetPeople().find(r => r[0] === id)[3], '');
  });
  await test('メモ：日本語の変換を決める Enter では保存しない。ほかのところを押すと保存される', async () => {
    const id = made.people[4].id;
    const row = page.locator('.table--people tbody tr[data-pid="' + id + '"]');
    await row.locator('.memo__edit').click();
    await page.locator('#memo-input').fill('かごしま');
    const key = (k, composing) => page.evaluate(([k, composing]) => document.getElementById('memo-input').dispatchEvent(new KeyboardEvent('keydown', { key: k, keyCode: composing ? 229 : 0, isComposing: composing, bubbles: true, cancelable: true })), [k, composing]);
    await key('Enter', true);
    await page.waitForTimeout(250);
    assert.strictEqual(await page.locator('#memo-input').count(), 1, '変換を決める Enter で、入力欄が閉じた');
    assert.strictEqual(sheetPeople().find(r => r[0] === id)[3], '', '変換を決める Enter で、保存された');
    await key('Escape', true);
    assert.strictEqual(await page.locator('#memo-input').inputValue(), 'かごしま', '変換をやめる Esc で、書いた文字が消えた');
    await page.locator('.head__title').click();
    await toast(page, /メモを保存しました/);
    assert.strictEqual(sheetPeople().find(r => r[0] === id)[3], 'かごしま');
    assert.strictEqual(await page.locator('#memo-input').count(), 0);
    assert.strictEqual(await row.locator('.memo__text').innerText(), 'かごしま');
  });
  await test('メモ：つづけてほかの人のメモを書きはじめても、前のメモは保存される。書いているとちゅうの入力欄は作り直さない', async () => {
    const a = made.people[4].id, b = made.people[5].id;
    const rowA = page.locator('.table--people tbody tr[data-pid="' + a + '"]'), rowB = page.locator('.table--people tbody tr[data-pid="' + b + '"]');
    await rowA.locator('.memo__edit').click();
    await page.locator('#memo-input').fill('1人目のメモ');
    const n = runs().length;
    world.control.runDelayMs = 600;
    await rowB.locator('.memo__edit').click();                 // 1人目の保存がはじまる（返事は、ゆっくり届く）
    await waitRuns(n + 1);
    world.control.runDelayMs = 0;
    assert.strictEqual(await page.evaluate(() => document.activeElement.getAttribute('data-memo')), b);
    await page.keyboard.type('2人目');
    await page.evaluate(() => { window.__memoEl = document.getElementById('memo-input'); });
    await toast(page, /メモを保存しました/);
    assert.strictEqual(sheetPeople().find(r => r[0] === a)[3], '1人目のメモ');
    assert.strictEqual(await rowA.locator('.memo__text').innerText(), '1人目のメモ', '保存したメモが、画面に出ていない');
    assert.strictEqual(await page.evaluate(() => document.getElementById('memo-input') === window.__memoEl && document.activeElement === window.__memoEl), true, '書いているとちゅうの入力欄が、作り直された');
    assert.strictEqual(await page.locator('#memo-input').inputValue(), '2人目');
    await page.keyboard.press('Enter');
    await toast(page, /メモを保存しました/);
    assert.strictEqual(sheetPeople().find(r => r[0] === b)[3], '2人目');
    assert.strictEqual(await page.evaluate(() => document.activeElement.getAttribute('data-fk')), 'memo:' + b, '保存のあと、キーボードの目印がなくなった');
    // あとのテストのために、消しておく
    for (const id of [a, b]) admin('setParticipant', { id, memo: '' });
    await page.locator('#refresh').click();
    await toast(page, /新しい内容にしました/);
  });
  await test('メモ：開いて何も書きかえずに閉じたときは、保存しない。長すぎるメモは、切らずにことわる', async () => {
    const id = made.people[4].id;
    const sh = world.ss.getSheetByName('参加者');
    const i = sh.rows.findIndex(r => r[0] === id);
    const row = page.locator('.table--people tbody tr[data-pid="' + id + '"]');
    // スプレッドシートに直接書いた、改行と空白のあるメモ
    sh.rows[i][3] = '1行目\n2行目  （空白が2つ）';
    await page.locator('#refresh').click();
    await toast(page, /新しい内容にしました/);
    let n = runs().length;
    await row.locator('.memo__edit').click();
    await page.locator('.head__title').click();
    await page.waitForFunction(() => !document.getElementById('memo-input'));
    await page.waitForTimeout(300);
    assert.strictEqual(runs().slice(n).filter(r => r[1] === 'setParticipant').length, 0, '何も書きかえていないのに、保存した');
    assert.strictEqual(sh.rows[i][3], '1行目\n2行目  （空白が2つ）', '表に書いてあったメモが、書きかえられた');
    // 500文字より長いメモ（表に直接書いたもの）を、ここで書きかえようとしたとき
    sh.rows[i][3] = 'あ'.repeat(600);
    await page.locator('#refresh').click();
    await toast(page, /新しい内容にしました/);
    await row.locator('.memo__edit').click();
    await page.locator('#memo-input').press('End');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    await toast(page, /メモは 500 文字まで/);
    assert.strictEqual(sh.rows[i][3].length, 600, 'ことわったのに、書きかえた（後ろを切ってしまった）');
    assert.strictEqual((await page.locator('#memo-input').inputValue()).length, 599, '書いたものが、入力欄に残っていない');
    await page.keyboard.press('Escape');
    sh.rows[i][3] = '';
    await page.locator('#refresh').click();
    await toast(page, /新しい内容にしました/);
  });
  await test('読みこみのとちゅうで操作しても、あとから届いた古い内容で上書きされない', async () => {
    const id = made.people[6].id;
    const row = page.locator('.table--people tbody tr[data-pid="' + id + '"]');
    const n = runs().length;
    world.control.runDelayMs = 800;
    await page.locator('#refresh').click();                    // 「全体のようす」が、ゆっくり届く
    await waitRuns(n + 1);
    world.control.runDelayMs = 0;
    await row.locator('.btn', { hasText: '停止する' }).click();
    await page.locator('.dialog .btn', { hasText: '停止する' }).click();
    await toast(page, /を停止しました/);
    assert.strictEqual(await row.locator('.chip--stop').count(), 1);
    await toast(page, /新しい内容にしました/);                   // 古い内容が届いたあと、読み直してから出る
    assert.strictEqual(await row.locator('.chip--stop').count(), 1, '古い内容で上書きされた');
    assert.strictEqual(await row.locator('.btn', { hasText: '再開する' }).count(), 1);
    assert.ok(runs().slice(n).filter(r => r[1] === 'overview').length >= 2, '読み直していない');
    await row.locator('.btn', { hasText: '再開する' }).click();
    await toast(page, /を再開しました/);
  });
  await test('えらんだ人の参加者カードを作れる（ナンバー・パスワード・QRコード）', async () => {
    const ids = [made.people[0].id, made.people[2].id];
    for (const id of ids) await page.locator('.table--people tbody tr[data-pid="' + id + '"] input[type=checkbox]').check();
    assert.strictEqual(await page.locator('#print-cards').innerText(), 'カードを印刷（2人）');
    await page.locator('#print-cards').click();
    await page.waitForSelector('.pcard');
    const cards = await page.locator('.pcard').evaluateAll(els => els.map(e => ({ dd: Array.from(e.querySelectorAll('dd')).map(d => d.textContent), site: e.querySelector('.pcard__site').textContent, qr: (e.querySelector('.pcard__qr svg') || { getAttribute() { return ''; } }).getAttribute('viewBox') })));
    assert.strictEqual(cards.length, 2);
    for (let i = 0; i < 2; i++) {
      const p = sheetPeople().find(r => r[0] === ids[i]);
      assert.deepStrictEqual(cards[i].dd, [p[0], p[1]]);
      assert.ok(cards[i].site.includes(SITE), cards[i].site);
    }
    const size = await page.evaluate(url => window.KSQR.encode(url).size, SITE);
    assert.strictEqual(cards[0].qr, '0 0 ' + (size + 8) + ' ' + (size + 8));
    assert.strictEqual(await page.locator('#app').isVisible(), false, 'カードのほかのものが出ている');
    await shot(page, 'cards');
    await page.locator('#print-go').click();
    assert.strictEqual(await page.evaluate(() => window.__printed), 1);
    await page.locator('.print__bar .btn', { hasText: 'とじる' }).click();
    assert.strictEqual(await page.locator('.pcard').count(), 0);
    assert.strictEqual(await title(page), '参加者');
    assert.strictEqual(await page.locator('.table--people tbody tr[data-pid="' + ids[0] + '"] input[type=checkbox]').isChecked(), true, 'えらんだ印が消えた');
    // Esc キーでも閉じられる。閉じたら、目印は「カードを印刷」のボタンにもどる
    await page.locator('#print-cards').click();
    await page.waitForSelector('.pcard');
    await page.keyboard.press('Escape');
    assert.strictEqual(await page.locator('.pcard').count(), 0, 'Esc キーで閉じない');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'print-cards');
    await page.locator('#pick-all').check();
    const registered = overview().participants.filter(p => p.registered).length;
    assert.strictEqual(await page.locator('#print-cards').innerText(), 'カードを印刷（' + registered + '人）');
    // 画面を描き直しても、えらんだ人数とチェックが残る
    await page.locator('#refresh').click();
    await toast(page, /新しい内容にしました/);
    assert.strictEqual(await page.locator('#print-cards').innerText(), 'カードを印刷（' + registered + '人）', '描き直したら、えらんだ人数が消えた');
    assert.strictEqual(await page.locator('#pick-all').isChecked(), true, '描き直したら、見出しのチェックが外れた');
    await page.locator('#pick-all').uncheck();
    assert.strictEqual(await page.locator('#print-cards').innerText(), 'カードを印刷');
  });
  await test('パスワードが入っていない人のカードには、そのことを書く', async () => {
    const sh = world.ss.getSheetByName('参加者');
    const i = sh.rows.findIndex(r => r[0] === made.people[6].id);
    const keep = sh.rows[i][1];
    sh.rows[i][1] = '';
    await page.locator('.table--people tbody tr[data-pid="' + made.people[6].id + '"] input[type=checkbox]').check();
    await page.locator('#print-cards').click();
    await page.waitForSelector('.pcard');
    assert.ok(/まだ入っていません/.test(await page.locator('.pcard dd.is-none').innerText()));
    sh.rows[i][1] = keep;
    await page.locator('#print-close').click();
    await page.locator('.table--people tbody tr[data-pid="' + made.people[6].id + '"] input[type=checkbox]').uncheck();
  });
  await test('一覧のとちゅうまで送ってから操作しても、画面の位置がとばない', async () => {
    await page.setViewportSize({ width: 1440, height: 420 });
    const last = page.locator('.table--people tbody tr').last();
    await last.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 40));
    const y = await page.evaluate(() => window.scrollY);
    assert.ok(y > 100, '画面を送れていない（' + y + '）');
    // いま画面に見えている行の、メモのえんぴつを押す（一覧を描き直す操作）
    const pid = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.table--people .memo__edit')).filter(b => { const r = b.getBoundingClientRect(); return r.top > 40 && r.bottom < window.innerHeight - 40; })[0];
      return btn ? btn.closest('tr').getAttribute('data-pid') : '';
    });
    assert.ok(pid, '画面の中に、メモを書ける行がない');
    await page.evaluate(id => Array.from(document.querySelectorAll('.table--people tbody tr')).filter(tr => tr.getAttribute('data-pid') === id)[0].querySelector('.memo__edit').click(), pid);
    assert.strictEqual(await page.locator('#memo-input').count(), 1);
    assert.ok(Math.abs((await page.evaluate(() => window.scrollY)) - y) <= 2, '描き直したら、画面の位置がとんだ');
    await page.keyboard.press('Escape');
    assert.ok(Math.abs((await page.evaluate(() => window.scrollY)) - y) <= 2);
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  await test('だれもえらばずに押すと、有効な人の全員分を作るかを確かめる', async () => {
    const active = overview().participants.filter(p => p.registered && !p.disabled).length;
    await page.locator('#print-cards').click();
    assert.ok((await page.locator('.dialog__title').innerText()).includes('有効な参加者 ' + active + '人分'));
    await page.locator('.dialog .btn--primary').click();
    await page.waitForSelector('.pcard');
    assert.strictEqual(await page.locator('.pcard').count(), active);
    await page.locator('.print__bar .btn', { hasText: 'とじる' }).click();
  });

  /* ============================================================ */
  console.log('回答と録音');
  await test('新しい順に50件ずつ出る。次の50件へ進める', async () => {
    await allAnswers(page);
    const all = admin('answers', { limit: 200 });
    assert.strictEqual(await rowsOf(page).count(), 50);
    assert.strictEqual(await page.locator('.pager span').first().innerText(), '1〜50件目（全 ' + all.total + '件）');
    assert.strictEqual(await page.locator('.pager .btn', { hasText: '前の50件' }).isDisabled(), true);
    assert.strictEqual(await rowsOf(page).first().locator('.pid').innerText(), all.rows[0].pid);
    await page.locator('.pager .btn', { hasText: '次の50件' }).click();
    await page.waitForFunction(() => /^51〜/.test(document.querySelector('.pager span').textContent));
    await answersLoaded(page);
    assert.strictEqual(await rowsOf(page).count(), Math.min(50, all.total - 50));
    await page.locator('.pager .btn', { hasText: '前の50件' }).click();
    await page.waitForFunction(() => /^1〜50/.test(document.querySelector('.pager span').textContent));
    await shot(page, 'answers');
  });
  await test('参加者・状態・文字でしぼりこめる', async () => {
    const pid = made.people[1].id;
    await page.locator('select[aria-label="参加者"]').selectOption(pid);
    await answersLoaded(page);
    const mine = admin('answers', { filter: { participant: pid }, limit: 200 });
    assert.strictEqual(await rowsOf(page).count(), mine.total);
    assert.deepStrictEqual(Array.from(new Set(await rowsOf(page).locator('.pid').allInnerTexts())), [pid]);
    await page.locator('select[aria-label="回答の状態"]').selectOption('知らない');
    await answersLoaded(page);
    const dk = admin('answers', { filter: { participant: pid, status: '知らない' } });
    assert.ok(dk.total >= 1);
    assert.strictEqual(await rowsOf(page).count(), dk.total);
    assert.strictEqual(await rowsOf(page).first().locator('.chip--mute').innerText(), '知らない');
    assert.strictEqual(await rowsOf(page).first().locator('.playbtn').count(), 0);
    await page.locator('select[aria-label="回答の状態"]').selectOption('');
    await page.locator('select[aria-label="参加者"]').selectOption('');
    await answersLoaded(page);
    await page.locator('input[aria-label="設問・回答の文字でさがす"]').fill('ふるいこたえ6');
    await page.waitForFunction(() => /全 7件/.test((document.querySelector('.pager span') || {}).textContent || ''));       // 6, 60〜65
    await page.locator('input[aria-label="設問・回答の文字でさがす"]').fill('どこにもないことば');
    await page.waitForFunction(() => /条件に合う回答はありません/.test(document.getElementById('answers-body').textContent));
    await page.locator('#answers-body .btn', { hasText: '条件をすべて外す' }).click();
    await answersLoaded(page);
    assert.strictEqual(await page.locator('input[aria-label="設問・回答の文字でさがす"]').inputValue(), '');
    assert.strictEqual(await rowsOf(page).count(), 50);
  });
  await test('条件をつづけて変えても、さいごに選んだ条件の結果が出る', async () => {
    const a = made.people[0].id, b = made.people[3].id;
    world.control.runDelayMs = 250;
    await page.locator('select[aria-label="参加者"]').selectOption(a);
    await page.locator('select[aria-label="参加者"]').selectOption(b);
    await page.waitForTimeout(900);
    world.control.runDelayMs = 0;
    await answersLoaded(page);
    assert.deepStrictEqual(Array.from(new Set(await rowsOf(page).locator('.pid').allInnerTexts())), [b]);
    await page.locator('select[aria-label="参加者"]').selectOption('');
    await answersLoaded(page);
  });
  await test('条件を変えた直後にべつの条件へ移っても、前の条件の結果が、新しい条件の下に出ることはない', async () => {
    // 1) 歩をえらんだ直後に、一覧の参加者ナンバーを押す
    let n = runs().length;
    world.control.runDelayMs = 700;
    await page.locator('#answers-step').selectOption(String(items[items.length - 1].step));
    await waitRuns(n + 1);
    const chip = rowsOf(page).first().locator('button.pid');
    const who = await chip.innerText();
    await chip.click();
    world.control.runDelayMs = 0;
    await page.waitForTimeout(1000);                           // 前の条件（歩）の返事が、おくれて届く
    await answersLoaded(page);
    assert.strictEqual(await page.locator('#answers-participant').inputValue(), who);
    assert.strictEqual(await page.locator('#answers-step').inputValue(), '');
    const want = admin('answers', { filter: { participant: who }, limit: 200 });
    assert.strictEqual(await page.locator('.pager span').first().innerText(), '1〜' + Math.min(50, want.total) + '件目（全 ' + want.total + '件）');
    assert.strictEqual(await rowsOf(page).count(), Math.min(50, want.total));
    assert.deepStrictEqual(await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('.table--answers tr.arow .c-pid .pid')).map(e => e.textContent)))), [who]);
    // 2) 何も見つからなかったあと、状態をえらんだ直後に「条件をすべて外す」を押す
    await page.locator('#answers-q').fill('どこにもないことば');
    await page.waitForFunction(() => /条件に合う回答はありません/.test(document.getElementById('answers-body').textContent));
    n = runs().length;
    world.control.runDelayMs = 700;
    await page.locator('#answers-status').selectOption('回答済');
    await waitRuns(n + 1);
    await page.locator('#answers-body .btn', { hasText: '条件をすべて外す' }).click();
    world.control.runDelayMs = 0;
    await page.waitForTimeout(1000);
    await answersLoaded(page);
    assert.strictEqual(await page.locator('#answers-status').inputValue(), '');
    assert.strictEqual(await page.locator('#answers-q').inputValue(), '');
    assert.strictEqual(await rowsOf(page).count(), 50, '条件を外したのに、回答が出ていない');
    assert.strictEqual(await page.locator('.pager span').first().innerText(), '1〜50件目（全 ' + admin('answers', {}).total + '件）');
  });
  await test('「くわしく」で、文節ごとの回答・端末の情報・リンクが出る', async () => {
    const pid = made.people[0].id;
    await page.locator('select[aria-label="参加者"]').selectOption(pid);
    await answersLoaded(page);
    const data = admin('answers', { filter: { participant: pid }, limit: 200 }).rows;
    const i = data.findIndex(r => r.type === '例文' && r.a1);
    const r = data[i];
    await rowsOf(page).nth(i).locator('.textbtn').click();
    const det = page.locator('tr.detail');
    assert.strictEqual(await det.count(), 1);
    assert.deepStrictEqual(await det.locator('.segs th').allInnerTexts(), r.segP.split('｜'));
    assert.deepStrictEqual(await det.locator('.segs td').allInnerTexts(), r.segA.split('｜'));
    const kv = await det.locator('.kv').innerText();
    assert.ok(kv.includes(r.sid) && kv.includes('16000 Hz') && kv.includes('エコー除去 切') && kv.includes(r.device), kv);
    assert.ok(/端末での回答日時\s*\d{4}年\d{1,2}月\d{1,2}日 \d{1,2}:\d{2}:\d{2}/.test(kv), kv);
    const drive = det.locator('a', { hasText: 'ドライブで開く' });
    assert.strictEqual(await drive.getAttribute('href'), r.a1.url);
    assert.strictEqual(await drive.getAttribute('target'), '_blank');
    assert.ok(/noopener/.test(await drive.getAttribute('rel')));
    assert.ok(new RegExp('#gid=' + world.ss.getSheetByName('回答').getSheetId() + '&range=A' + r.n + '$').test(await det.locator('a', { hasText: '表でこの行を開く' }).getAttribute('href')));
    await shot(page, 'answers-detail');
    await rowsOf(page).nth(i).locator('.textbtn').click();
    assert.strictEqual(await page.locator('tr.detail').count(), 0);
  });
  // 再生した音の、いちばん大きな値を調べる
  const playedPeak = p => p.evaluate(async () => {
    const buf = await (await fetch(window.__plays[window.__plays.length - 1])).arrayBuffer();
    const dv = new DataView(buf); let peak = 0;
    for (let o = 44; o + 1 < buf.byteLength; o += 2) peak = Math.max(peak, Math.abs(dv.getInt16(o, true)));
    return { peak, bytes: buf.byteLength };
  });
  await test('録音をその場で聞ける。小さい音は、大きくして流す（保存してある録音は変えない）', async () => {
    const pid = made.people[0].id;                         // 声の小さい録音（iPhone のような端末）
    const data = admin('answers', { filter: { participant: pid }, limit: 200 }).rows;
    const i = data.findIndex(r => r.a1);
    const r = data[i];
    const stored = world.fileBytes(/\/d\/([^/]+)/.exec(r.a1.url)[1]);
    let rawPeak = 0;
    for (let o = 44; o + 1 < stored.length; o += 2) rawPeak = Math.max(rawPeak, Math.abs(stored.readInt16LE(o)));
    const btn = rowsOf(page).nth(i).locator('.playbtn').first();
    assert.strictEqual(await btn.getAttribute('data-state'), 'idle');
    world.control.runDelayMs = 300;
    await btn.click();
    assert.strictEqual(await btn.getAttribute('data-state'), 'loading');
    world.control.runDelayMs = 0;
    await page.waitForFunction(el => el.getAttribute('data-state') === 'playing', await btn.elementHandle());
    assert.strictEqual(await btn.getAttribute('aria-pressed'), 'true');
    const loud = await playedPeak(page);
    assert.strictEqual(loud.bytes, stored.length);
    assert.ok(loud.peak > rawPeak * 3 && loud.peak <= 32767, '大きくなっていない: ' + loud.peak + ' / ' + rawPeak);
    assert.ok(/^blob:/.test(await page.evaluate(() => window.__plays[window.__plays.length - 1])));
    await page.waitForTimeout(500);                        // すぐにつづけて押したもの（ダブルクリック）とは区別される間をあける
    await btn.click();
    assert.strictEqual(await btn.getAttribute('data-state'), 'idle');
    assert.strictEqual(await page.evaluate(() => window.__player.paused), true);
    // 大きくしないで再生
    await page.locator('.check', { hasText: '音を大きくして再生' }).locator('input').uncheck();
    const calls = world.control.runs.length;
    await page.waitForTimeout(500);
    await btn.click();
    await page.waitForFunction(el => el.getAttribute('data-state') === 'playing', await btn.elementHandle());
    assert.strictEqual(world.control.runs.length, calls, '同じ録音を、もう一度取り寄せた');
    const raw = await playedPeak(page);
    assert.strictEqual(raw.peak, rawPeak);
    // 終わりまで流れたら、ボタンが元にもどる
    await page.waitForFunction(el => el.getAttribute('data-state') === 'idle', await btn.elementHandle(), { timeout: 8000 });
    await page.locator('.check', { hasText: '音を大きくして再生' }).locator('input').check();
    assert.ok(Buffer.compare(stored, world.fileBytes(/\/d\/([^/]+)/.exec(r.a1.url)[1])) === 0, '保存してある録音が変わった');
  });
  await test('ほかの録音を押すと、前の録音は止まる。大きな声の録音は、そのまま流す', async () => {
    await page.locator('select[aria-label="参加者"]').selectOption(made.people[1].id);       // 声の大きい録音
    await answersLoaded(page);
    const data = admin('answers', { filter: { participant: made.people[1].id }, limit: 200 }).rows;
    const idx = data.map((r, i) => (r.a1 ? i : -1)).filter(i => i >= 0);
    const b1 = rowsOf(page).nth(idx[0]).locator('.playbtn').first(), b2 = rowsOf(page).nth(idx[1]).locator('.playbtn').first();
    await b1.click();
    await page.waitForFunction(el => el.getAttribute('data-state') === 'playing', await b1.elementHandle());
    const stored = world.fileBytes(/\/d\/([^/]+)/.exec(data[idx[0]].a1.url)[1]);
    let rawPeak = 0;
    for (let o = 44; o + 1 < stored.length; o += 2) rawPeak = Math.max(rawPeak, Math.abs(stored.readInt16LE(o)));
    assert.strictEqual((await playedPeak(page)).peak, rawPeak, 'じゅうぶん大きな声の録音は、変えずに流す');
    await b2.click();
    await page.waitForFunction(el => el.getAttribute('data-state') === 'playing', await b2.elementHandle());
    assert.strictEqual(await b1.getAttribute('data-state'), 'idle');
    assert.strictEqual(await page.locator('.playbtn[data-state="playing"]').count(), 1);
    await go(page, 'items');
    assert.strictEqual(await page.evaluate(() => window.__player.paused), true, '画面を切りかえても、音が止まらない');
    await go(page, 'answers');
    await answersLoaded(page);
  });
  await test('再生のボタンをつづけて2回押しても（ダブルクリック）、止まらずに流れる。外から止められたら、ボタンも元にもどる', async () => {
    const data = admin('answers', { filter: { participant: made.people[1].id }, limit: 200 }).rows;
    const i = data.findIndex(r => r.a1);
    const btn = rowsOf(page).nth(i).locator('.playbtn').first();
    await btn.dblclick();
    await page.waitForFunction(el => el.getAttribute('data-state') === 'playing', await btn.elementHandle());
    await page.waitForTimeout(250);
    assert.strictEqual(await btn.getAttribute('data-state'), 'playing', 'ダブルクリックで、すぐに止まってしまった');
    assert.strictEqual(await page.evaluate(() => window.__player.paused), false);
    await page.evaluate(() => window.__player.pause());        // イヤホンのボタンなどで、外から止められたとき
    await page.waitForFunction(el => el.getAttribute('data-state') === 'idle', await btn.elementHandle());
    // 取り寄せているあいだにもう一度押しても、取りやめにならない
    const j = data.map((r, k) => (r.a1 ? k : -1)).filter(k => k >= 0)[2];
    const slow = rowsOf(page).nth(j).locator('.playbtn').first();
    const n = runs().length;
    world.control.runDelayMs = 1600;
    await slow.click();
    await waitRuns(n + 1);
    world.control.runDelayMs = 0;
    await page.waitForTimeout(600);
    assert.strictEqual(await slow.getAttribute('data-state'), 'loading');
    await slow.click();
    assert.strictEqual(await slow.getAttribute('data-state'), 'loading', '取り寄せているあいだに押したら、取りやめになった');
    await page.waitForFunction(el => el.getAttribute('data-state') === 'playing', await slow.elementHandle());
    await page.waitForTimeout(500);
    await slow.click();
    assert.strictEqual(await slow.getAttribute('data-state'), 'idle');
  });
  await test('録音のファイルがなくなっているときは、知らせが出る', async () => {
    const data = admin('answers', { filter: { participant: made.people[1].id }, limit: 200 }).rows;
    const i = data.map((r, k) => (r.a1 ? k : -1)).filter(k => k >= 0).pop();
    const file = world.driveItems[/\/d\/([^/]+)/.exec(data[i].a1.url)[1]];
    file.setTrashed(true);
    const btn = rowsOf(page).nth(i).locator('.playbtn').first();
    await btn.click();
    await toast(page, /ごみ箱に入っています/);
    assert.strictEqual(await btn.getAttribute('data-state'), 'idle');
    file.setTrashed(false);
  });
  await test('WAV を、そのままの中身で保存できる', async () => {
    const data = admin('answers', { filter: { participant: made.people[1].id }, limit: 200 }).rows;
    const i = data.findIndex(r => r.a1);
    await rowsOf(page).nth(i).locator('.textbtn').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('tr.detail .textbtn', { hasText: 'WAVを保存' }).first().click()]);
    assert.strictEqual(download.suggestedFilename(), data[i].a1.name);
    await toast(page, /を保存しました/);
    const saved = fs.readFileSync(await download.path());
    assert.ok(saved.equals(world.fileBytes(/\/d\/([^/]+)/.exec(data[i].a1.url)[1])), '保存した中身がちがう');
    await rowsOf(page).nth(i).locator('.textbtn').click();
    await page.locator('select[aria-label="参加者"]').selectOption('');
    await answersLoaded(page);
  });

  await test('回答の読みこみに失敗したら、その場で「もう一度ためす」を押せる', async () => {
    world.control.runFail = 1;
    await page.locator('#answers-status').selectOption('知らない');
    await page.waitForSelector('#answers-retry');
    assert.ok(/Google とやりとりできませんでした/.test(await page.locator('#answers-body .notice--bad').innerText()));
    await page.locator('#answers-retry').click();
    await answersLoaded(page);
    assert.strictEqual(await page.locator('#answers-body .notice--bad').count(), 0);
    assert.strictEqual(await rowsOf(page).count(), Math.min(50, admin('answers', { filter: { status: '知らない' } }).total));
    // 失敗したまま、ほかの画面へ行ってもどってきたときは、読み直す
    world.control.runFail = 1;
    await page.locator('#answers-status').selectOption('');
    await page.waitForSelector('#answers-retry');
    await go(page, 'items');
    await go(page, 'answers');
    await answersLoaded(page);
    assert.strictEqual(await page.locator('#answers-body .notice--bad').count(), 0, '失敗の知らせが、出たままになっている');
    assert.strictEqual(await rowsOf(page).count(), 50);
  });
  await test('さがす文字：日本語の変換のとちゅうでは、さがしはじめない。入れてすぐにほかの画面へ移っても、あとから勝手に動かない', async () => {
    let n = runs().length;
    await page.evaluate(() => {
      const el = document.getElementById('answers-q');
      el.focus();
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.value = 'ふるいこたえ6';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    await page.waitForTimeout(700);
    assert.strictEqual(runs().slice(n).filter(r => r[1] === 'answers').length, 0, '変換のとちゅうで、さがしはじめた');
    await page.evaluate(() => document.getElementById('answers-q').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ふるいこたえ6' })));
    await page.waitForFunction(() => /全 7件/.test((document.querySelector('.pager span') || {}).textContent || ''));
    await page.locator('#answers-q').fill('');
    await page.waitForFunction(() => /^1〜50件目/.test((document.querySelector('.pager span') || {}).textContent || ''));
    await answersLoaded(page);
    n = runs().length;
    await page.locator('#answers-q').fill('ふるいこたえ');
    await go(page, 'home');
    await page.waitForTimeout(700);
    assert.strictEqual(runs().slice(n).filter(r => r[1] === 'answers').length, 0, 'ほかの画面へ移ったあとで、さがしはじめた');
    // もどってくると、書いた文字は入力欄に残っていて、その文字でさがした結果が出る
    await go(page, 'answers');
    await answersLoaded(page);
    assert.strictEqual(await page.locator('#answers-q').inputValue(), 'ふるいこたえ', '書いた文字が消えた');
    assert.strictEqual(await page.locator('.pager span').first().innerText(), '1〜50件目（全 65件）');
    // 書いてすぐ「更新」を押しても、書いた文字は消えず、その文字でさがす
    await page.locator('#answers-q').fill('ふるいこたえ6');
    await page.locator('#refresh').click();
    await toast(page, /新しい内容にしました/);
    await answersLoaded(page);
    assert.strictEqual(await page.locator('#answers-q').inputValue(), 'ふるいこたえ6', '「更新」で、書いた文字が消えた');
    await page.waitForFunction(() => /全 7件/.test((document.querySelector('.pager span') || {}).textContent || ''));
    await page.locator('#answers-q').fill('');
    await page.waitForFunction(() => /^1〜50件目/.test((document.querySelector('.pager span') || {}).textContent || ''));
    await answersLoaded(page);
  });
  await test('送信IDが「constructor」のような名前でも、「くわしく」の開け閉めがおかしくならない', async () => {
    const odd = ['constructor', 'toString', '__proto__'];
    odd.forEach((sid, i) => {
      const row = world.sheetRows('回答')[0].map(() => '');
      row[col('送信日時')] = new Date(Date.now() + 60000 + i * 1000);
      row[col('参加者ナンバー')] = 'T901'; row[col('歩')] = items[0].step; row[col('設問ID')] = items[0].id; row[col('種別')] = items[0].type;
      row[col('提示語・例文')] = items[0].prompt; row[col('回答の状態')] = '回答済'; row[col('回答（地域の言葉）')] = 'へんなID' + i; row[col('送信ID')] = sid;
      answers.appendRow(row);
    });
    try {
      await page.locator('#refresh').click();
      await toast(page, /新しい内容にしました/);
      await answersLoaded(page);
      assert.deepStrictEqual((await rowsOf(page).locator('.c-a .answer').allInnerTexts()).slice(0, 3), ['へんなID2', 'へんなID1', 'へんなID0']);
      assert.strictEqual(await page.locator('tr.detail').count(), 0, '押していないのに、くわしい内容が開いている');
      for (let i = 0; i < 3; i++) {
        await rowsOf(page).nth(i).locator('.c-more .textbtn').click();
        assert.strictEqual(await page.locator('tr.detail').count(), 1);
        assert.ok((await page.locator('tr.detail .kv').innerText()).includes(odd[2 - i]));
        await page.waitForTimeout(520);              // つづけて押したもの（ダブルクリック）と区別される間をあける
        await rowsOf(page).nth(i).locator('.c-more .textbtn').click();
        assert.strictEqual(await page.locator('tr.detail').count(), 0);
      }
    } finally {
      for (let i = 0; i < 3; i++) answers.rows.pop();
    }
    await page.locator('#refresh').click();
    await toast(page, /新しい内容にしました/);
    await answersLoaded(page);
  });

  await test('ボタンをつづけて2回押しても（ダブルクリック）、1回押したのと同じになる', async () => {
    await rowsOf(page).first().locator('.c-more .textbtn').dblclick();
    await page.waitForTimeout(150);
    assert.strictEqual(await page.locator('tr.detail').count(), 1, '「くわしく」が、開いてすぐ閉じた');
    await page.waitForTimeout(520);
    await rowsOf(page).first().locator('.c-more .textbtn').click();
    assert.strictEqual(await page.locator('tr.detail').count(), 0);
    await go(page, 'people');
    const row = page.locator('.table--people tbody tr[data-pid="' + made.people[6].id + '"]');
    await row.locator('.btn', { hasText: '停止する' }).dblclick();
    await page.waitForTimeout(200);
    assert.strictEqual(await page.locator('.dialog__title').count(), 1, '開いた窓が、2回目のクリックで閉じた');
    await page.locator('.dialog .btn', { hasText: 'やめる' }).click();
    await page.locator('#pw-toggle').dblclick();
    await page.waitForSelector('.pw');
    await page.waitForTimeout(300);
    assert.strictEqual(await page.locator('#pw-toggle').innerText(), 'パスワードをかくす');
    await page.waitForTimeout(300);
    await page.locator('#pw-toggle').dblclick();
    await page.waitForTimeout(400);
    assert.strictEqual(await page.locator('.pw').count(), 0, '「パスワードをかくす」を2回押したら、また表示された');
    await go(page, 'answers');
    await answersLoaded(page);
  });

  /* ============================================================ */
  console.log('項目');
  await test('設問ごとの内訳が出る。「回答を見る」で、その設問の回答だけが出る', async () => {
    await go(page, 'items');
    const o = overview();
    assert.strictEqual(await page.locator('.stephead').count(), o.steps.length);
    assert.strictEqual(await page.locator('.table--items tbody tr').count(), o.items.length);
    const it = o.items[1];
    const row = page.locator('.table--items tbody tr', { hasText: it.id }).first();
    const total = it.stat.reduce((a, b) => a + b, 0);
    assert.ok((await row.innerText()).includes(total + '人'));
    assert.strictEqual(await row.locator('.stackbar__seg').count(), it.stat.filter(n => n > 0).length);
    assert.strictEqual(await row.locator('.breakdown').innerText(), o.statuses.map((s, i) => (it.stat[i] > 0 ? s + ' ' + it.stat[i] : '')).filter(Boolean).join('　'));
    assert.strictEqual(await page.locator('.legend__item').count(), 4);
    await shot(page, 'items');
    await row.locator('.textbtn', { hasText: '回答を見る' }).click();
    await answersLoaded(page);
    assert.strictEqual(await title(page), '回答と録音');
    const mine = admin('answers', { filter: { item: it.id }, limit: 200 });
    assert.strictEqual(await rowsOf(page).count(), Math.min(50, mine.total));
    assert.ok((await page.locator('.card .notice').innerText()).includes('設問 ' + it.id));
    await page.locator('.card .notice .textbtn', { hasText: 'この条件を外す' }).click();
    await answersLoaded(page);
    assert.strictEqual(await page.locator('.card .notice').count(), 0);
    assert.strictEqual(await rowsOf(page).count(), 50);
  });

  /* ============================================================ */
  console.log('設定');
  await test('文章を変えて保存できる', async () => {
    await go(page, 'settings');
    assert.strictEqual(await page.locator('#set-instruction').inputValue(), setting('教示文'));
    assert.strictEqual(await page.locator('#set-maxRecordSec').inputValue(), '20');
    assert.strictEqual(await page.locator('#set-siteUrl').inputValue(), SITE);
    assert.strictEqual(await page.locator('#settings-save').isDisabled(), true);
    await page.locator('#set-notice').fill('10/20 は、お休みします。');
    await page.locator('#set-maxRecordSec').fill('30');
    assert.strictEqual(await page.locator('#settings-save').isDisabled(), false);
    assert.ok(/まだ保存していない/.test(await page.locator('.savebar__msg').innerText()));
    await page.locator('#settings-save').click();
    await toast(page, /設定を保存しました/);
    assert.strictEqual(setting('お知らせ'), '10/20 は、お休みします。');
    assert.strictEqual(setting('録音の上限（秒）'), 30);
    assert.strictEqual(await page.locator('#settings-save').isDisabled(), true);
    assert.strictEqual(await page.locator('#set-notice').inputValue(), '10/20 は、お休みします。');
    await shot(page, 'settings');
  });
  await test('決まりに合わない値は保存されず、理由が出る', async () => {
    const before = setting('語彙の質問文');
    await page.locator('#set-wordQuestion').fill('なんといいますか？');
    await page.locator('#settings-save').click();
    await page.waitForFunction(() => /\{語\}/.test((document.querySelector('.savebar__msg--bad') || {}).textContent || ''));
    assert.strictEqual(setting('語彙の質問文'), before);
    assert.strictEqual(await page.locator('#set-wordQuestion').inputValue(), 'なんといいますか？', '書いたものが消えた');
    assert.strictEqual(await page.locator('#settings-save').isDisabled(), false);
    await page.locator('#set-wordQuestion').fill('「{語}」は、なんといいますか？');
    await page.locator('#settings-save').click();
    await toast(page, /設定を保存しました/);
    assert.strictEqual(setting('語彙の質問文'), '「{語}」は、なんといいますか？');
  });
  await test('保存しているあいだは、入力欄を書きかえられない。雑音の目安を変えると、ダッシュボードの数にもすぐ出る', async () => {
    const before = overview().totals.noisy;
    await page.locator('#set-noiseWarnDb').fill('40');
    const n = runs().length;
    world.control.runDelayMs = 500;
    await page.locator('#settings-save').click();
    await waitRuns(n + 1);
    world.control.runDelayMs = 0;
    assert.strictEqual(await page.locator('#set-notice').isDisabled(), true, '保存しているあいだも、書きかえられる');
    assert.strictEqual(await page.locator('#settings-save').innerText(), '保存しています…');
    await toast(page, /設定を保存しました/);
    assert.strictEqual(await page.locator('#set-notice').isDisabled(), false);
    const after = overview().totals.noisy;
    assert.ok(after > before, 'テストの見本では、目安を上げても雑音の件数が変わらない');
    await go(page, 'home');
    await page.waitForSelector('.flag:has-text("雑音の多い録音 ' + after + '件")');
    await go(page, 'settings');
    await page.locator('#set-noiseWarnDb').fill('20');
    await page.locator('#settings-save').click();
    await toast(page, /設定を保存しました/);
    // 書きかえたあと、元の文字にもどしただけなら、何も送らない
    const m = runs().length;
    const notice = await page.locator('#set-notice').inputValue();
    await page.locator('#set-notice').fill(notice + 'あ');
    await page.locator('#set-notice').fill(notice);
    await page.locator('#settings-save').click();
    await toast(page, /変更はありません/);
    assert.strictEqual(runs().slice(m).filter(r => r[1] === 'saveSettings').length, 0);
    assert.strictEqual(await page.locator('#settings-save').isDisabled(), true);
  });
  await test('保存していない変更があるときは、ほかの画面へ移る前に確かめる', async () => {
    await page.locator('#set-notice').fill('書きかけ');
    await page.locator('.nav [data-view="home"]').click();
    assert.strictEqual(await page.locator('.dialog__title').innerText(), '保存していない変更があります');
    await page.locator('.dialog .btn', { hasText: 'もどって保存する' }).click();
    assert.strictEqual(await title(page), '設定');
    assert.strictEqual(await page.locator('#set-notice').inputValue(), '書きかけ');
    await page.locator('.nav [data-view="home"]').click();
    await page.locator('.dialog .btn', { hasText: '保存せずに移る' }).click();
    assert.strictEqual(await title(page), 'ダッシュボード');
    assert.strictEqual(setting('お知らせ'), '10/20 は、お休みします。');
    await go(page, 'settings');
    assert.strictEqual(await page.locator('#set-notice').inputValue(), '10/20 は、お休みします。');
  });
  await test('保存しているとちゅうでほかの画面を押しても、「保存していない変更があります」とは出ない', async () => {
    const keep = setting('お知らせ');
    await page.locator('#set-notice').fill('保存のとちゅうで移る');
    const n = runs().length;
    world.control.runDelayMs = 700;
    await page.locator('#settings-save').click();
    await waitRuns(n + 1);
    world.control.runDelayMs = 0;
    await page.locator('.nav [data-view="home"]').click();
    assert.strictEqual(await page.locator('.dialog').count(), 0, '保存しているのに、「保存していない変更があります」と出た');
    await toast(page, /設定を保存しています/);
    await toast(page, /設定を保存しました/);
    assert.strictEqual(await title(page), '設定');
    assert.strictEqual(setting('お知らせ'), '保存のとちゅうで移る');
    await go(page, 'home');
    assert.strictEqual(await page.locator('.dialog').count(), 0);
    await go(page, 'settings');
    await page.locator('#set-notice').fill(keep);
    await page.locator('#settings-save').click();
    await toast(page, /設定を保存しました/);
  });
  await test('Tab キーで移った入力欄が、画面の下にとどまる「保存」の帯のうしろにかくれない', async () => {
    for (const vp of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const p = await openAdmin({ viewport: vp });
      await p.locator((vp.width <= 860 ? '.tabs' : '.nav') + ' [data-view="settings"]').click();
      await p.locator('#open-toggle').focus();
      const seen = [];
      for (let i = 0; i < 10; i++) {
        await p.keyboard.press('Tab');
        await p.waitForTimeout(60);
        const r = await p.evaluate(() => {
          const el = document.activeElement, b = el.getBoundingClientRect(), bar = document.querySelector('.savebar__box').getBoundingClientRect();
          return { id: el.id, field: /^(INPUT|TEXTAREA)$/.test(el.tagName), top: b.top, bottom: b.bottom, bar: bar.top };
        });
        if (!r.field) continue;
        seen.push(r.id);
        assert.ok(r.top >= 0 && r.bottom <= r.bar + 1, vp.width + 'px：' + r.id + ' が、保存の帯のうしろにかくれている（' + Math.round(r.bottom) + ' > ' + Math.round(r.bar) + '）');
      }
      assert.ok(seen.length >= 8, 'Tab キーで、入力欄を回れていない: ' + seen.join(','));
      await p.context().close();
    }
  });
  await test('受付を止められる（確かめの窓が出る）。再開できる', async () => {
    assert.strictEqual(await page.locator('.openrow__state').innerText(), '受付中');
    await page.locator('#open-toggle').click();
    assert.strictEqual(await page.locator('.dialog__title').innerText(), '受付を止めますか？');
    await page.locator('.dialog .btn', { hasText: 'やめる' }).click();
    assert.strictEqual(setting('受付'), '受付中');
    await page.locator('#open-toggle').click();
    await page.locator('.dialog .btn', { hasText: '受付を止める' }).click();
    await toast(page, /受付を止めました/);
    assert.strictEqual(setting('受付'), '停止中');
    assert.strictEqual(await page.locator('.openrow__state').innerText(), '停止中');
    await go(page, 'home');
    assert.ok(/停止中/.test(await page.locator('.tile').first().innerText()));
    await go(page, 'settings');
    await page.locator('#open-toggle').click();
    await toast(page, /受付を再開しました/);
    assert.strictEqual(setting('受付'), '受付中');
  });
  await test('「参加者の画面を開く」は、設定したサイトを新しいタブで開く。設定がなければ案内する', async () => {
    const link = page.locator('#side-site a');
    assert.strictEqual(await link.getAttribute('href'), SITE);
    assert.strictEqual(await link.getAttribute('target'), '_blank');
    await page.locator('#set-siteUrl').fill('');
    await page.locator('#settings-save').click();
    await toast(page, /設定を保存しました/);
    assert.strictEqual(await page.locator('#side-site a').count(), 0);
    await go(page, 'home');
    await page.locator('#side-site button').click();
    assert.strictEqual(await title(page), '設定');
    await toast(page, /サイトのURL/);
    await page.locator('#set-siteUrl').fill('http://example.com/');
    await page.locator('#settings-save').click();
    await page.waitForFunction(() => /https:\/\//.test((document.querySelector('.savebar__msg--bad') || {}).textContent || ''));
    await page.locator('#set-siteUrl').fill(SITE);
    await page.locator('#settings-save').click();
    await toast(page, /設定を保存しました/);
    assert.strictEqual(await page.locator('#side-site a').getAttribute('href'), SITE);
  });

  /* ============================================================ */
  console.log('こわれにくさ');
  await test('回答やメモに書かれたタグや記号は、ただの文字として出る（プログラムとして動かない）', async () => {
    const evil = '<img src=x onerror="window.__xss=1">', evil2 = '"><script>window.__xss=2</script><svg onload=window.__xss=3>';
    const p = made.people[5];
    const login = world.post({ action: 'login', id: p.id, password: p.pw });
    const res = world.post({ action: 'save', token: login.token, submission: { submissionId: 'evil-000001', itemId: items[0].id, step: items[0].step, type: '例文', prompt: evil, status: '回答済',
      answer: evil, segPrompt: evil + '｜' + evil2, segAnswer: evil2 + '｜' + evil, exampleAnswer: evil2, note: evil, noAudioReason: evil2, device: evil2, clientTime: evil, audio: [] } });
    assert.strictEqual(res.saved, true);
    const row = world.sheetRows('回答').length;
    answers.rows[row - 1][col('技術情報')] = JSON.stringify({ main: { peak: evil, noise: evil2, input: evil, ec: evil } });
    answers.rows[row - 1][col('回答の状態')] = evil;
    const keep = { step: world.ss.getSheetByName('歩').rows[1][1], notice: setting('お知らせ'), instruction: setting('教示文'), name: world.ss.name };
    world.ss.getSheetByName('参加者').rows[1][3] = evil2;
    world.ss.getSheetByName('参加者').appendRow([evil.replace(/\s/g, ''), evil, '有効', evil, '', '']);
    world.ss.getSheetByName('項目').appendRow([1, 99, 'EVIL<b>1', '語彙', evil, evil2, evil, '', '', true, '', '']);
    world.ss.getSheetByName('歩').rows[1][1] = evil;
    world.ss.name = evil2;
    admin('saveSettings', { values: { 'お知らせ': evil, '教示文': evil2 } });
    try {
      await page.locator('#refresh').click();
      await toast(page, /新しい内容にしました/);
      // 長いナンバーやパスワードがあると、一覧は「1人1枚のカード」の形になることがある。そのときは、そちらの「すべてえらぶ」を使う
      const pickAll = page.locator('#pick-all:visible, #pick-all-2:visible');
      for (const id of ['home', 'people', 'answers', 'items', 'settings']) {
        await go(page, id);
        if (id === 'answers') { await answersLoaded(page); await rowsOf(page).first().locator('.textbtn').click(); }
        if (id === 'people') {
          await page.locator('#pw-toggle').click();
          await page.waitForSelector('.pw');
          await noOverflow(page, 'とても長いナンバー・パスワードのある参加者の一覧');
          assert.ok(await tableFits(page), 'とても長いナンバー・パスワードがあると、表の列が画面の外にかくれる');
          await pickAll.check();
          await page.locator('#print-cards').click();
          await page.waitForSelector('.pcard');
          // とても長いナンバーやパスワードでも、カードのわくからあふれない
          const over = await page.locator('.pcard').evaluateAll(els => els.map(e => e.scrollHeight - e.clientHeight));
          assert.ok(over.every(v => v <= 1), 'カードの中身が、わくからあふれている: ' + over.join(','));
          await page.locator('#print-close').click();
          await pickAll.uncheck();
          await page.locator('#pw-toggle').click();
        }
        await page.waitForTimeout(150);
        assert.strictEqual(await page.evaluate(() => window.__xss), undefined, id + ' の画面で、書かれたプログラムが動いた');
        assert.strictEqual(await page.locator('#view img, #view script, #view svg[onload], #print-root img').count(), 0, id + ' の画面に、書かれたタグが入った');
      }
      await allAnswers(page);
      assert.ok((await page.locator('#answers-body').innerText()).includes(evil), 'そのままの文字として出ていない');
    } finally {
      // あとのテストのために、元にもどす
      world.ss.name = keep.name;
      world.ss.getSheetByName('歩').rows[1][1] = keep.step;
      world.ss.getSheetByName('参加者').rows[1][3] = '';
      world.ss.getSheetByName('参加者').rows.pop();
      world.ss.getSheetByName('項目').rows.pop();
      admin('saveSettings', { values: { 'お知らせ': keep.notice, '教示文': keep.instruction } });
    }
  });
  await test('歩の名前がとても長くても、カードからはみ出さない', async () => {
    const sh = world.ss.getSheetByName('歩');
    const keep = sh.rows[1][1];
    sh.rows[1][1] = 'とてもながいなまえのえき'.repeat(12);
    await go(page, 'home');
    await page.locator('#refresh').click();
    await toast(page, /新しい内容にしました/);
    const out = await page.evaluate(() => {
      const card = document.querySelector('.steps').closest('.card').getBoundingClientRect();
      return Array.from(document.querySelectorAll('.steprow, .steprow__name, .meter')).filter(el => el.getBoundingClientRect().right > card.right + 0.5).length;
    });
    assert.strictEqual(out, 0, '歩の名前が、カードの外にはみ出している');
    await noOverflow(page, '長い歩の名前');
    for (const id of ['items', 'answers']) { await go(page, id); if (id === 'answers') await answersLoaded(page); await noOverflow(page, '長い歩の名前（' + id + '）'); }
    sh.rows[1][1] = keep;
    await page.locator('#refresh').click();
    await toast(page, /新しい内容にしました/);
  });
  await test('通信に失敗したら知らせが出て、「更新」をもう一度押せる', async () => {
    await go(page, 'home');
    world.control.runFail = 1;
    await page.locator('#refresh').click();
    await toast(page, /Google とやりとりできませんでした/);
    assert.strictEqual(await page.locator('#refresh').isDisabled(), false);
    assert.strictEqual(await page.locator('.tile').count(), 4, '前の内容が消えた');
    await page.locator('#refresh').click();
    await toast(page, /新しい内容にしました/);
  });
  await test('どの画面も、横にはみ出さない（パソコンの広さ）', async () => {
    for (const id of ['home', 'people', 'answers', 'items', 'settings']) {
      await go(page, id);
      if (id === 'answers') await answersLoaded(page);
      await noOverflow(page, id);
    }
  });
  await test('ボタンや入力欄には、すべて名前がついている', async () => {
    for (const id of ['home', 'people', 'answers', 'items', 'settings']) {
      await go(page, id);
      if (id === 'answers') { await answersLoaded(page); await rowsOf(page).nth(1).locator('.textbtn').click(); }
      const nameless = await page.evaluate(() => Array.from(document.querySelectorAll('button, a[href], input, select, textarea')).filter(el => {
        if (el.offsetParent === null) return false;
        const label = el.getAttribute('aria-label') || (el.id && document.querySelector('label[for="' + el.id + '"]') ? 'x' : '') || (el.closest('label') ? 'x' : '') || el.textContent.trim() || el.getAttribute('title') || '';
        return !label;
      }).map(el => el.outerHTML.slice(0, 120)));
      assert.deepStrictEqual(nameless, [], id);
    }
  });
  await test('開いてから時間がたつと（印が切れると）、開き直しの案内だけになる。保存していなかった設定の文章は、写しをとれる', async () => {
    await go(page, 'settings');
    await page.locator('#set-notice').fill('まだ保存していない、大事なお知らせ');
    const keep = world.props.TOKEN_SECRET;
    world.props.TOKEN_SECRET = 'changed-' + keep;          // 画面が持っている印を、使えなくする（時間切れと同じ扱いになる）
    try {
      await page.locator('#settings-save').click();
      await page.waitForSelector('.screen__title:has-text("開き直してください")');
      assert.ok(/再読み込み/.test(await page.locator('#view').innerText()));
      assert.strictEqual(await page.locator('.tile, .card').count(), 0);
      assert.strictEqual(await page.locator('.rescue textarea').inputValue(), 'まだ保存していない、大事なお知らせ', '保存していなかった文章が、消えた');
      assert.ok((await page.locator('.rescue').innerText()).includes('お知らせ'));
      assert.deepStrictEqual(await page.locator('.nav [data-view]').evaluateAll(els => els.map(e => e.disabled)), [true, true, true, true, true], '切れたあとも、メニューを押せる');
      assert.strictEqual(await page.locator('#side-site a, #side-site button').count(), 0);
      assert.strictEqual(await page.evaluate(() => document.activeElement.className), 'screen__title');
    } finally {
      world.props.TOKEN_SECRET = keep;
    }
    await page.reload();
    await page.waitForSelector('.tile');
    assert.notStrictEqual(setting('お知らせ'), 'まだ保存していない、大事なお知らせ');
  });
  await test('印が切れたときに書いていたメモも、写しをとれる', async () => {
    await go(page, 'people');
    const id = made.people[4].id;
    await page.locator('.table--people tbody tr[data-pid="' + id + '"] .memo__edit').click();
    await page.locator('#memo-input').fill('切れる直前に書いたメモ');
    const keep = world.props.TOKEN_SECRET;
    world.props.TOKEN_SECRET = 'changed-' + keep;
    try {
      await page.keyboard.press('Enter');
      await page.waitForSelector('.screen__title:has-text("開き直してください")');
      assert.strictEqual(await page.locator('.rescue textarea').inputValue(), '切れる直前に書いたメモ', '書いていたメモが、消えた');
      assert.ok((await page.locator('.rescue').innerText()).includes(id + ' のメモ'));
    } finally {
      world.props.TOKEN_SECRET = keep;
    }
    await page.reload();
    await page.waitForSelector('.tile');
    assert.strictEqual(sheetPeople().find(r => r[0] === id)[3], '');
  });
  await test('キーボードで使っているとき：ボタンを押したあとも、目印（フォーカス）がなくならない', async () => {
    const active = () => page.evaluate(() => { const el = document.activeElement; return el ? (el.id || el.getAttribute('data-fk') || el.tagName) : ''; });
    await page.locator('#refresh').focus();
    await page.keyboard.press('Enter');
    await toast(page, /新しい内容にしました/);
    assert.strictEqual(await active(), 'refresh', '「更新」のあと');
    await go(page, 'people');
    await page.locator('#pw-toggle').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.pw');
    assert.strictEqual(await active(), 'pw-toggle', '「パスワードを表示」のあと');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.pw'));
    assert.strictEqual(await active(), 'pw-toggle');
    const id = made.people[6].id;
    await page.locator('.table--people tbody tr[data-pid="' + id + '"] .btn', { hasText: '停止する' }).focus();
    await page.keyboard.press('Enter');
    await page.locator('.dialog .btn', { hasText: '停止する' }).focus();
    await page.keyboard.press('Enter');
    await toast(page, /を停止しました/);
    assert.strictEqual(await active(), 'stop:' + id, '「停止する」のあと');
    await page.keyboard.press('Enter');
    await toast(page, /を再開しました/);
    assert.strictEqual(await active(), 'stop:' + id, '「再開する」のあと');
    await allAnswers(page);
    await page.locator('#answers-next').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /^51〜/.test(document.querySelector('.pager span').textContent));
    await answersLoaded(page);
    const total = admin('answers', {}).total;
    assert.strictEqual(await active(), total > 100 ? 'answers-next' : 'answers-prev', '「次の50件」のあと');
    await go(page, 'settings');
    await page.locator('#open-toggle').focus();
    await page.keyboard.press('Enter');
    await page.locator('.dialog .btn', { hasText: '受付を止める' }).focus();
    await page.keyboard.press('Enter');
    await toast(page, /受付を止めました/);
    assert.strictEqual(await active(), 'open-toggle', '「受付を止める」のあと');
    await page.keyboard.press('Enter');
    await toast(page, /受付を再開しました/);
    assert.strictEqual(await active(), 'open-toggle');
    assert.strictEqual(setting('受付'), '受付中');
  });
  await page.context().close();

  await test('はじめの読みこみに失敗したら、もう一度ためせる', async () => {
    const p = await newPage();
    world.control.runFail = 1;
    await p.goto(base + '/exec?admin=1');
    await p.waitForSelector('.screen__title:has-text("読みこめませんでした")');
    assert.strictEqual(await p.locator('.tile').count(), 0);
    await p.locator('.screen .btn', { hasText: 'もう一度ためす' }).click();
    await p.waitForSelector('.tile');
    await p.context().close();
  });
  // 参加者の端末から、回答が1件届いたことにする
  let sent = 0;
  const sendAnswer = (person, text) => {
    const login = world.post({ action: 'login', id: person.id, password: person.pw });
    const it = items[(sent++) % items.length];
    const res = world.post({ action: 'save', token: login.token, submission: { submissionId: 'fresh-' + String(sent).padStart(6, '0'), itemId: it.id, step: it.step, type: it.type, prompt: it.prompt, status: '回答済',
      answer: text, noAudioReason: 'マイクが使えない', device: 'テスト', clientTime: new Date(Date.now() + 9 * 3600000).toISOString().replace(/\.\d+Z$/, '+09:00'), audio: [] } });
    assert.strictEqual(res.saved, true);
  };
  await test('見ているあいだは、1分ごとに新しい内容になる。キーボードの目印も、画面の位置も変わらない', async () => {
    const p = await newPage({ viewport: { width: 1440, height: 560 } });
    await p.clock.install();
    await p.goto(base + '/exec?admin=1');
    await p.waitForSelector('.tile');
    const count = () => runs().filter(r => r[1] === 'overview').length;
    const n0 = count();
    await p.clock.fastForward(40000);
    await p.waitForTimeout(200);
    assert.strictEqual(count(), n0, '1分たつ前に読みこんだ');
    sendAnswer(made.people[5], 'あたらしいこたえ1');
    const rows = overview().totals.rows;
    await p.locator('[data-fk="all:people"]').focus();
    await p.evaluate(() => window.scrollTo(0, 260));
    const y = await p.evaluate(() => window.scrollY);
    assert.ok(y > 100, '画面を送れていない');
    await p.clock.fastForward(35000);
    await p.waitForFunction(n => document.querySelectorAll('.tile')[2].textContent.indexOf('集まった回答' + n) === 0, rows);
    assert.strictEqual(count(), n0 + 1);
    assert.strictEqual(await p.evaluate(() => document.activeElement.getAttribute('data-fk')), 'all:people', '描き直したら、キーボードの目印がなくなった');
    assert.ok(Math.abs((await p.evaluate(() => window.scrollY)) - y) <= 2, '描き直したら、画面の位置がとんだ');
    assert.strictEqual(await p.evaluate(() => document.body.classList.contains('is-loading')), false);
    assert.ok((await p.locator('.card', { hasText: '直近の回答' }).locator('.list__row').first().innerText()).includes('あたらしいこたえ1'));
    // 内容が変わっていなければ、描き直さない（グラフに出した数なども、そのまま残る）
    await p.evaluate(() => { window.scrollTo(0, 0); window.__same = document.querySelector('.tile'); });
    await p.clock.fastForward(70000);
    await p.waitForTimeout(400);
    assert.strictEqual(count(), n0 + 2);
    assert.strictEqual(await p.evaluate(() => window.__same === document.querySelector('.tile')), true, '内容が同じなのに、描き直した');
    await p.context().close();
  });
  await test('回答の一覧は、勝手には入れかえない。新しい回答が届いたら知らせる', async () => {
    const p = await newPage();
    await p.clock.install();
    await p.goto(base + '/exec?admin=1');
    await p.waitForSelector('.tile');
    await go(p, 'answers');
    await answersLoaded(p);
    const top = await rowsOf(p).first().innerText();
    sendAnswer(made.people[5], 'あたらしいこたえ2');
    sendAnswer(made.people[5], 'あたらしいこたえ3');
    await p.clock.fastForward(75000);
    await p.waitForSelector('#answers-fresh');
    assert.ok(/新しい回答が 2件 届いています/.test(await p.locator('.notice--new').innerText()));
    assert.strictEqual(await rowsOf(p).first().innerText(), top, '見ている一覧が、勝手に入れかわった');
    await p.locator('#answers-fresh').click();
    await answersLoaded(p);
    assert.strictEqual(await p.locator('.notice--new').count(), 0);
    assert.ok((await rowsOf(p).first().innerText()).includes('あたらしいこたえ3'));
    await p.context().close();
  });
  await test('設定を書いているあいだは、画面を変えない。書きかけの文章は残り、表のほうで変えられた設定を古い内容にもどさない', async () => {
    const p = await newPage();
    await p.clock.install();
    await p.goto(base + '/exec?admin=1');
    await p.waitForSelector('.tile');
    const keep = { notice: setting('お知らせ'), instruction: setting('教示文') };
    await go(p, 'settings');
    const count = () => runs().filter(r => r[1] === 'overview').length;
    await p.clock.fastForward(50000);                       // 前に読みこんでから、50秒
    await p.waitForTimeout(200);
    const n1 = count();
    await p.locator('#set-notice').fill('書いているとちゅうの');
    await p.clock.fastForward(12000);                       // 1分をすぎたが、書いてから 12秒しかたっていない
    await p.waitForTimeout(300);
    assert.strictEqual(count(), n1, '書いているさいちゅうに読みこんだ');
    // 表のほうで、ほかの設定が変えられた。書く手を止めてしばらくすると（入力欄に目印があるままでも）、新しい内容になる
    assert.strictEqual(admin('saveSettings', { values: { '教示文': '表のほうで変えた教示文' } }).ok, true);
    await p.locator('#set-notice').pressSequentially('お知らせ');
    await p.evaluate(() => { const el = document.getElementById('set-notice'); el.setSelectionRange(3, 3); });
    await p.clock.fastForward(30000);
    await p.waitForFunction(() => document.getElementById('set-instruction').value === '表のほうで変えた教示文');
    assert.strictEqual(count(), n1 + 1);
    assert.strictEqual(await p.locator('#set-notice').inputValue(), '書いているとちゅうのお知らせ', '書きかけの文章が消えた');
    assert.deepStrictEqual(await p.evaluate(() => { const el = document.activeElement; return [el.id, el.selectionStart, el.selectionEnd]; }), ['set-notice', 3, 3], '描き直したら、書いている場所（カーソル）がなくなった');
    assert.strictEqual(await p.locator('#settings-save').isDisabled(), false);
    await p.locator('#settings-save').click();
    await toast(p, /設定を保存しました/);
    assert.strictEqual(setting('お知らせ'), '書いているとちゅうのお知らせ');
    assert.strictEqual(setting('教示文'), '表のほうで変えた教示文', '表のほうで変えられた設定を、古い内容にもどしてしまった');
    admin('saveSettings', { values: { 'お知らせ': keep.notice, '教示文': keep.instruction } });
    await p.context().close();
  });
  await test('リストや入力欄に目印があるだけなら（書いていなければ）、1分ごとの更新は止まらない', async () => {
    const p = await newPage();
    await p.clock.install();
    await p.goto(base + '/exec?admin=1');
    await p.waitForSelector('.tile');
    await go(p, 'people');
    await p.locator('#people-filter').selectOption('started');
    await p.locator('#people-filter').focus();
    const who = made.people[6];
    assert.strictEqual(await p.locator('.table--people tbody tr[data-pid="' + who.id + '"]').count(), 0);
    const count = () => runs().filter(r => r[1] === 'overview').length;
    const n0 = count();
    sendAnswer(who, 'はじめてのこたえ');                    // まだ回答のなかった人が、答えはじめた
    await p.clock.fastForward(75000);
    await p.waitForSelector('.table--people tbody tr[data-pid="' + who.id + '"]');
    assert.strictEqual(count(), n0 + 1);
    assert.deepStrictEqual(await p.evaluate(() => [document.activeElement.id, document.activeElement.value]), ['people-filter', 'started'], 'えらんだ条件や、目印が変わった');
    // 回答の画面：さがす欄に文字を入れたままでも、新しい回答の知らせは出る
    await go(p, 'answers');
    await answersLoaded(p);
    await p.locator('#answers-q').fill(who.id.toLowerCase());
    await p.waitForFunction(() => /全 1件/.test((document.querySelector('.pager span') || {}).textContent || ''));
    sendAnswer(who, 'ふたつめのこたえ');
    await p.clock.fastForward(75000);
    await p.waitForSelector('#answers-fresh');
    assert.strictEqual(await p.locator('#answers-q').inputValue(), who.id.toLowerCase());
    assert.strictEqual(await p.evaluate(() => document.activeElement.id), 'answers-q');
    await p.context().close();
  });
  await test('見ている端末の時計がずれていても、「今日」「きのう」は保存先の時計で決める', async () => {
    const p = await newPage();
    await p.clock.install({ time: Date.now() + 30 * 3600000 });      // 端末の時計が、30時間すすんでいる
    await p.goto(base + '/exec?admin=1');
    await p.waitForSelector('.tile');
    const o = overview();
    const day = ms => Math.floor((ms + 9 * 3600000) / 86400000);
    const d = new Date(o.recent[0].at + 9 * 3600000);
    const hm = d.getUTCHours() + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    const diff = day(o.at) - day(o.recent[0].at);
    assert.ok(diff === 0 || diff === 1, 'テストの見本の、いちばん新しい回答が古い');
    assert.strictEqual(await p.locator('.card', { hasText: '直近の回答' }).locator('.list__time').first().innerText(), (diff === 0 ? '今日 ' : 'きのう ') + hm);
    assert.ok(/今日/.test(await p.locator('.chart svg').innerHTML()));
    await p.context().close();
  });

  /* ============================================================ */
  console.log('メニューから開いた窓');
  await test('窓の大きさを画面に合わせ、同じように使える。切れたら「この窓を閉じる」が出る', async () => {
    const p = await newPage({ viewport: { width: 1180, height: 640 } });
    await p.goto(base + '/__dialog');
    await p.waitForSelector('.tile');
    const host = await p.evaluate(() => window.__host);
    assert.ok(host.width >= 720 && host.width <= 1500 && host.height >= 420 && host.height <= 940, JSON.stringify(host));
    assert.strictEqual(await p.locator('#app').getAttribute('data-mode'), 'dialog');
    for (const id of ['home', 'people', 'answers', 'items', 'settings']) {
      await go(p, id);
      if (id === 'answers') await answersLoaded(p);
      if (id === 'people') { await p.locator('#pw-toggle').click(); await p.waitForSelector('.pw'); }
      await noOverflow(p, '窓の ' + id);
      if (id === 'people') {
        const fits = await p.evaluate(() => { const w = document.querySelector('.tablewrap'); return w.scrollWidth <= w.clientWidth + 1; });
        assert.ok(fits, '参加者の表が、窓の幅に入りきらない');
        assert.strictEqual(await p.locator('.table--people').evaluate(el => el.classList.contains('is-stacked')), false, 'メニューから開いた窓で、参加者の一覧が表の形になっていない');
      }
      await shot(p, 'dialog-' + id);
    }
    const keep = world.props.TOKEN_SECRET;
    world.props.TOKEN_SECRET = 'x' + keep;
    await p.locator('#refresh').click();
    await p.waitForSelector('.screen__title:has-text("開き直してください")');
    assert.ok(/メニュー「方言調査」→「管理画面を開く」/.test(await p.locator('#view').innerText()));
    await p.locator('.screen .btn', { hasText: 'この窓を閉じる' }).click();
    assert.strictEqual(await p.evaluate(() => window.__host.closed), 1);
    world.props.TOKEN_SECRET = keep;
    await p.context().close();
  });

  console.log('スマートフォン');
  await test('下のタブで切りかえられる。横にはみ出さない。保存の帯がタブにかくれない', async () => {
    const p = await newPage({ viewport: { width: 390, height: 844 } });
    await p.goto(base + '/exec?admin=1');
    await p.waitForSelector('.tile');
    assert.strictEqual(await p.locator('.side').isVisible(), false);
    assert.strictEqual(await p.locator('.tabs').isVisible(), true);
    for (const [id, name] of [['people', '参加者'], ['answers', '回答と録音'], ['items', '項目'], ['settings', '設定'], ['home', 'ダッシュボード']]) {
      await p.locator('.tabs [data-view="' + id + '"]').click();
      assert.strictEqual(await title(p), name);
      if (id === 'answers') { await answersLoaded(p); await rowsOf(p).first().locator('.textbtn').click(); }
      if (id === 'people') { await p.locator('#pw-toggle').click(); await p.waitForSelector('.pw'); }
      await noOverflow(p, 'スマートフォンの ' + id);
      await shot(p, 'phone-' + id);
      if (id === 'settings') {
        await p.locator('#set-notice').fill('スマホから');
        const bar = await p.locator('.savebar').boundingBox(), tabs = await p.locator('.tabs').boundingBox();
        assert.ok(bar.y + bar.height <= tabs.y + 1, '保存の帯が、下のタブに重なっている');
        await p.locator('#settings-save').click();
        await toast(p, /設定を保存しました/);
        assert.strictEqual(setting('お知らせ'), 'スマホから');
      }
    }
    await p.locator('.tabs [data-view="people"]').click();
    await p.locator('#print-cards').click();
    await p.locator('.dialog .btn--primary').click();
    await p.waitForSelector('.pcard');
    await noOverflow(p, 'スマートフォンのカード');
    await p.context().close();
  });
  await test('スマートフォン：押すものは指で押しやすい大きさ。入力欄の文字は16px以上（画面が勝手に拡大されない）', async () => {
    const p = await newPage({ viewport: { width: 390, height: 844 } });
    await p.goto(base + '/exec?admin=1');
    await p.waitForSelector('.tile');
    const small = () => p.evaluate(() => Array.from(document.querySelectorAll('#view .btn, #view .playbtn, #view .textbtn, #view .seg__btn, #view .flag, #view select, #view input:not([type=checkbox]), #view textarea, .tabs__item'))
      .filter(el => el.offsetParent !== null)
      .map(el => { const r = el.getBoundingClientRect(); return { h: Math.round(r.height), font: parseFloat(getComputedStyle(el).fontSize), field: /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName), name: (el.getAttribute('aria-label') || el.textContent || el.id || '').trim().slice(0, 16) }; })
      .filter(x => x.h < 38 || (x.field && x.font < 16)));
    for (const id of ['home', 'people', 'answers', 'items', 'settings']) {
      await p.locator('.tabs [data-view="' + id + '"]').click();
      if (id === 'answers') { await answersLoaded(p); await rowsOf(p).first().locator('.c-more .textbtn').click(); }
      if (id === 'people') { await p.locator('.table--people tbody tr').first().locator('.memo__edit').click(); }
      const bad = await small();
      assert.ok(!bad.length, id + '：' + bad.map(x => '「' + x.name + '」高さ ' + x.h + 'px・文字 ' + x.font + 'px').join(' / '));
      if (id === 'people') {
        const boxes = await p.locator('.pick').evaluateAll(els => els.filter(e => e.tagName === 'INPUT' && e.offsetParent !== null).map(e => Math.round(e.getBoundingClientRect().width)));
        assert.ok(boxes.length > 1 && boxes.every(w => w >= 24), 'チェックの四角が小さい');
        // 見出しの行が出ない形（1人1枚のカード）でも、「すべてえらぶ」を使える
        assert.strictEqual(await p.locator('#pick-all').isVisible(), false);
        await p.locator('#pick-all-2').check();
        const registered = overview().participants.filter(x => x.registered).length;
        assert.strictEqual(await p.locator('#print-cards').innerText(), 'カードを印刷（' + registered + '人）');
        assert.strictEqual(await p.locator('#pick-all-2').isChecked(), true);
        await p.locator('#pick-all-2').uncheck();
        assert.strictEqual(await p.locator('#print-cards').innerText(), 'カードを印刷');
        await p.keyboard.press('Escape');
      }
    }
    await p.context().close();
  });
  await test('スマートフォン：文節ごとの回答は、表の形のままで出る。長い知らせも、画面の幅を使って出る', async () => {
    const p = await newPage({ viewport: { width: 390, height: 844 } });
    await p.goto(base + '/exec?admin=1');
    await p.waitForSelector('.tile');
    await p.locator('.tabs [data-view="answers"]').click();
    await answersLoaded(p);
    const pid = made.people[1].id;
    await p.locator('#answers-participant').selectOption(pid);
    await answersLoaded(p);
    const data = admin('answers', { filter: { participant: pid }, limit: 200 }).rows;
    const i = data.findIndex(r => r.type === '例文' && r.a1 && r.segP.split('｜').length >= 3);
    assert.ok(i >= 0 && i < 50, 'テストの見本に、文節が3つ以上ある例文の回答がない');
    assert.strictEqual(await p.locator('.table--answers').evaluate(el => el.classList.contains('is-stacked')), true);
    await rowsOf(p).nth(i).locator('.c-more .textbtn').click();
    const segs = await p.evaluate(() => {
      const t = document.querySelector('tr.detail .segs');
      const rows = Array.from(t.querySelectorAll('tr')).map(tr => Array.from(tr.children).map(c => { const r = c.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), display: getComputedStyle(c).display }; }));
      return { display: getComputedStyle(t).display, rows };
    });
    assert.strictEqual(segs.display, 'table');
    assert.strictEqual(segs.rows.length, 2);
    for (const row of segs.rows) {
      assert.ok(row.every(c => c.display === 'table-cell'), '文節のマスが、表の形でなくなっている');
      assert.ok(row.every(c => c.top === row[0].top), '文節が、横にならんでいない');
      assert.ok(row.every((c, k) => k === 0 || c.left > row[k - 1].left));
    }
    assert.deepStrictEqual(segs.rows[0].map(c => c.left), segs.rows[1].map(c => c.left), '提示と回答の文節が、たてにそろっていない');
    await noOverflow(p, 'スマートフォンの くわしい内容');
    await shot(p, 'phone-answers-detail');
    await p.locator('tr.detail .textbtn', { hasText: 'WAVを保存' }).first().click();
    await p.waitForFunction(() => { const t = document.querySelector('.toast'); return !!t && /を保存しました/.test(t.textContent); });
    const box = await p.locator('.toast').boundingBox();
    assert.ok(box.width >= 300 && box.x >= 0 && box.x + box.width <= 390, '知らせの幅がせまい、またははみ出している: ' + JSON.stringify(box));
    const tabs = await p.locator('.tabs').boundingBox();
    assert.ok(box.y + box.height <= tabs.y, '知らせが、下のタブに重なっている');
    await p.context().close();
  });

  console.log('中くらいの幅（タブレット・小さめの窓）');
  await test('どの幅でも、表の列が画面の外にかくれない（入りきらないときは、カードの形にする）', async () => {
    const p = await openAdmin({ viewport: { width: 1440, height: 800 } });
    for (const width of [1280, 1180, 1024, 900, 861, 860, 700]) {
      await p.setViewportSize({ width, height: 800 });
      await p.waitForTimeout(260);
      for (const id of ['home', 'people', 'answers', 'items', 'settings']) {
        await p.locator((width <= 860 ? '.tabs' : '.nav') + ' [data-view="' + id + '"]').click();
        if (id === 'answers') { await answersLoaded(p); await rowsOf(p).nth(1).locator('.c-more .textbtn').click(); }
        if (id === 'people') { await p.locator('#pw-toggle').click(); await p.waitForSelector('.pw'); }
        await noOverflow(p, width + 'px の ' + id);
        assert.ok(await tableFits(p), width + 'px の ' + id + '：表が横に入りきらず、列がかくれている');
        if (id === 'people') { await shot(p, 'w' + width + '-people'); await p.locator('#pw-toggle').click(); await p.waitForFunction(() => !document.querySelector('.pw')); }
        if (id === 'answers') await shot(p, 'w' + width + '-answers');
        // タブレットを横にしたくらいの幅（1024px）までは、表の形のままで見せる（参加者の一覧は、パスワードをかくしているとき）
        if (width >= 1024 && (id === 'people' || id === 'answers')) {
          assert.strictEqual(await p.locator(id === 'people' ? '.table--people' : '.table--answers').evaluate(el => el.classList.contains('is-stacked')), false, width + 'px の ' + id + '：表の形でなくなっている');
        }
      }
    }
    // 幅をもどすと、表の形にもどる
    await p.setViewportSize({ width: 1440, height: 800 });
    await p.waitForTimeout(260);
    await p.locator('.nav [data-view="people"]').click();
    assert.strictEqual(await p.locator('.table--people').evaluate(el => el.classList.contains('is-stacked')), false);
    await p.context().close();
  });

  console.log('参加者カードの印刷');
  await test('A4 の紙1枚に、2列×3段で6枚ずつ入る（スマートフォンから印刷しても同じ）。QRコードは読みとれる大きさ', async () => {
    for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const p = await newPage({ viewport: vp });
      await p.goto(base + '/exec?admin=1');
      await p.waitForSelector('.tile');
      await p.locator((vp.width <= 860 ? '.tabs' : '.nav') + ' [data-view="people"]').click();
      await p.locator('#print-cards').click();
      await p.locator('.dialog .btn--primary').click();
      await p.waitForSelector('.pcard');
      const n = await p.locator('.pcard').count();
      assert.ok(n >= 7, 'テストの見本の参加者が少ない');
      await p.emulateMedia({ media: 'print' });
      const lay = await p.evaluate(() => ({
        cards: Array.from(document.querySelectorAll('.pcard')).map(e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left), w: r.width, h: r.height, over: e.scrollHeight - e.clientHeight }; }),
        bar: getComputedStyle(document.querySelector('.print__bar')).display,
        app: getComputedStyle(document.getElementById('app')).display
      }));
      assert.strictEqual(new Set(lay.cards.map(c => c.x)).size, 2, '印刷のときに、2列になっていない（' + vp.width + 'px）');
      assert.ok(lay.cards.every(c => Math.abs(c.h - 84 * 96 / 25.4) < 1.5), 'カードの高さが 84mm でない: ' + lay.cards.map(c => Math.round(c.h)).join(','));
      assert.strictEqual(lay.bar, 'none', '印刷に、案内の帯が入る');
      assert.strictEqual(lay.app, 'none');
      const pdf = await p.pdf({ preferCSSPageSize: true, printBackground: true });
      const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      assert.strictEqual(pages, Math.ceil(n / 6), 'PDF のページ数（' + vp.width + 'px）：' + n + '枚のカードが ' + pages + 'ページになった');
      if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, 'cards-' + vp.width + '.pdf'), pdf); }
      await p.emulateMedia({ media: 'screen' });
      if (vp.width > 860) {
        // 紙の幅（190mm）で見たとき：中身がカードからあふれない。QRコードの1マスは 0.6mm 以上
        await p.setViewportSize({ width: 718, height: 900 });
        await p.emulateMedia({ media: 'print' });
        const paper = await p.evaluate(() => ({
          over: Array.from(document.querySelectorAll('.pcard')).map(e => e.scrollHeight - e.clientHeight),
          qr: document.querySelector('.pcard__qr').getBoundingClientRect().width,
          modules: parseInt(document.querySelector('.pcard__qr svg').getAttribute('viewBox').split(' ')[2], 10)
        }));
        assert.ok(paper.over.every(v => v <= 1), 'カードの中身が、わくからあふれている: ' + paper.over.join(','));
        const mm = paper.qr / paper.modules * 25.4 / 96;
        assert.ok(mm >= 0.6, 'QRコードの1マスが小さい（' + mm.toFixed(2) + 'mm）');
        await p.emulateMedia({ media: 'screen' });
      }
      await p.context().close();
    }
  });

  await test('見ている端末の時刻の設定がちがっても、日時は日本時間で出る', async () => {
    const p = await newPage({ tz: 'America/New_York' });
    await p.goto(base + '/exec?admin=1');
    await p.waitForSelector('.tile');
    const o = overview();
    const d = new Date(o.recent[0].at + 9 * 3600000);
    const hm = d.getUTCHours() + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    const first = await p.locator('.card', { hasText: '直近の回答' }).locator('.list__time').first().innerText();
    assert.ok(first.endsWith(hm), first + ' / ' + hm);
    const at = new Date(o.at + 9 * 3600000);
    assert.strictEqual(await p.locator('.head__time').innerText(), at.getUTCHours() + ':' + String(at.getUTCMinutes()).padStart(2, '0') + ' の内容');
    await p.context().close();
  });

  /* ============================================================ */
  console.log('項目：直す・足す・表から取りこむ');
  // テスト用の小さな Excel（.xlsx）を作る（zip の中に XML を入れたもの。本物の Excel と同じ形）
  const zlib = require('zlib');
  function crc32(buf) {
    let c, crc = 0xFFFFFFFF;
    for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function zip(files) {
    const parts = [], central = [];
    let offset = 0;
    for (const [name, text] of files) {
      const nameBuf = Buffer.from(name, 'utf8'), data = Buffer.from(text, 'utf8'), comp = zlib.deflateRawSync(data), crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
      parts.push(local, nameBuf, comp);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
      cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
      central.push(cd, nameBuf);
      offset += local.length + nameBuf.length + comp.length;
    }
    const cdBuf = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat(parts.concat([cdBuf, end]));
  }
  const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function tinyXlsx(sheets) {
    const colName = i => { let s = ''; i++; while (i > 0) { s = String.fromCharCode(65 + (i - 1) % 26) + s; i = Math.floor((i - 1) / 26); } return s; };
    const sheetXml = rows => '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      rows.map((r, ri) => '<row r="' + (ri + 1) + '">' + r.map((v, ci) => {
        const ref = colName(ci) + (ri + 1);
        if (v === '' || v == null) return '';
        if (typeof v === 'number') return '<c r="' + ref + '"><v>' + v + '</v></c>';
        if (typeof v === 'boolean') return '<c r="' + ref + '" t="b"><v>' + (v ? 1 : 0) + '</v></c>';
        // 「本文《ふりがな》」と書いた文字は、日本語の Excel がしまう形（ふりがなの <rPh>）にする
        const m = /^(.*)《(.*)》$/.exec(v);
        if (m) return '<c r="' + ref + '" t="inlineStr"><is><t>' + xmlEsc(m[1]) + '</t><rPh sb="0" eb="' + m[1].length + '"><t>' + xmlEsc(m[2]) + '</t></rPh><phoneticPr fontId="1"/></is></c>';
        return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
      }).join('') + '</row>').join('') + '</sheetData></worksheet>';
    const files = [
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map((s, i) => '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '</Relationships>']
    ];
    sheets.forEach((s, i) => files.push(['xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s.rows)]));
    return zip(files);
  }
  const ITEM_HEAD = ['歩', '順', '設問ID', '種別', '提示語・例文', '場面・意味・読み', '提案例文（語彙）', '文節の区切り', 'イラスト', '出す', '記述項目', '調査の狙い'];
  const itemSheet = () => world.sheetRows('項目');
  const itemRowOf = id => itemSheet().find(r => r[2] === id);
  const dialogGone = p => p.waitForFunction(() => !document.querySelector('.dialog'), null, { timeout: 15000 });
  {
    const page = await openAdmin();
    await test('項目の編集：設問を直す：いまの内容が入った窓が開く。直して保存すると、一覧と「項目」シートが変わる', async () => {
      await go(page, 'items');
      const row = page.locator('.table--items tbody tr', { hasText: 'S004' }).first();
      await row.locator('.textbtn', { hasText: '直す' }).click();
      await page.waitForSelector('.dialog');
      assert.strictEqual(await page.locator('#it-prompt').inputValue(), '雨が降っている。');
      assert.strictEqual(await page.locator('#it-segments').inputValue(), '雨が｜降っている');
      assert.strictEqual(await page.locator('#it-type').inputValue(), '例文');
      const nAns = world.sheetRows('回答').slice(1).filter(r => r[col('設問ID')] === 'S004').length;
      assert.ok(new RegExp('回答が ' + nAns + ' 件あります').test(await page.locator('.dialog .notice').innerText()), await page.locator('.dialog .notice').innerText());
      assert.strictEqual(await page.locator('#it-id').getAttribute('readonly'), '', '回答があるので設問IDは変えられないはず');
      await page.locator('#it-prompt').fill('雨が降っている？');
      await page.locator('#it-context').fill('外を見て、たずねる。');
      assert.ok(/合いません/.test(await page.locator('#it-seg-preview').innerText()) === false, '句読点のちがいでは注意を出さない');
      await page.locator('#it-segments').fill('雨が｜降っていた');
      assert.ok(/合いません/.test(await page.locator('#it-seg-preview').innerText()));
      await page.locator('#it-segments').fill('雨が｜降っている');
      await page.locator('.dialog .btn--primary').click();
      await dialogGone(page);
      await toast(page, /設問を保存しました/);
      assert.ok((await page.locator('.table--items tbody tr', { hasText: 'S004' }).first().innerText()).includes('雨が降っている？'));
      assert.strictEqual(itemRowOf('S004')[4], '雨が降っている？'); assert.strictEqual(itemRowOf('S004')[5], '外を見て、たずねる。'); assert.strictEqual(itemRowOf('S004')[7], '雨が｜降っている');
      assert.strictEqual(itemRowOf('S004')[8], 'rain umbrella', 'さわっていない欄はそのまま');
    });
    await test('項目の編集：設問を直す：空の提示語・歩のまちがいは、窓の中で知らせる（閉じない・書きこまない）', async () => {
      const row = page.locator('.table--items tbody tr', { hasText: 'S001' }).first();
      await row.locator('.textbtn', { hasText: '直す' }).click();
      await page.waitForSelector('.dialog');
      await page.locator('#it-prompt').fill('');
      await page.locator('.dialog .btn--primary').click();
      assert.ok(/提示語・例文を入れてください/.test(await page.locator('.dialog__error').innerText()));
      await page.locator('#it-prompt').fill('頭');
      await page.locator('#it-step').fill('0');
      await page.locator('.dialog .btn--primary').click();
      assert.ok(/1〜999/.test(await page.locator('.dialog__error').innerText()));
      assert.strictEqual(await page.locator('.dialog').count(), 1);
      await page.keyboard.press('Escape');
      await dialogGone(page);
      assert.strictEqual(itemRowOf('S001')[4], '頭');
    });
    await test('項目の編集：出さない：確かめてから、参加者の画面に出なくなる。「出していない設問」に移り、「出す」でもどせる', async () => {
      const row = page.locator('.table--items tbody tr', { hasText: 'S003' }).first();
      await row.locator('.textbtn', { hasText: '出さない' }).click();
      await page.waitForSelector('.dialog');
      const n3 = world.sheetRows('回答').slice(1).filter(r => r[col('設問ID')] === 'S003').length;
      assert.ok(new RegExp('回答（' + n3 + ' 件）は残ります').test(await page.locator('.dialog').innerText()), await page.locator('.dialog').innerText());
      await page.locator('.dialog .btn--danger').click();
      await dialogGone(page);
      await toast(page, /出さないようにしました/);
      await page.waitForSelector('.hiddenbox');
      assert.strictEqual(itemRowOf('S003')[9], false);
      assert.ok(!world.call('ksReadItems_').some(i => i.id === 'S003'), '参加者の画面に、まだ出ている');
      assert.ok(/出していない設問（1）/.test(await page.locator('.hiddenbox summary').innerText()));
      await page.locator('.hiddenbox summary').click();
      const hrow = page.locator('.hiddenbox tbody tr', { hasText: 'S003' });
      assert.ok((await hrow.innerText()).includes(n3 + '件'));
      await hrow.locator('.textbtn', { hasText: '出す' }).click();
      await toast(page, /出すようにしました/);
      await page.waitForFunction(() => !document.querySelector('.hiddenbox'));
      assert.strictEqual(itemRowOf('S003')[9], true);
      assert.ok(world.call('ksReadItems_').some(i => i.id === 'S003'));
    });
    await test('項目の編集：歩の名前を直す：マスの名前とアイコンが変わる', async () => {
      await page.locator('.stephead', { hasText: '2歩目' }).locator('.textbtn').click();
      await page.waitForSelector('.dialog');
      assert.strictEqual(await page.locator('#step-title').inputValue(), '桜島');
      await page.locator('#step-title').fill('桜島フェリー');
      await page.locator('#step-icon').fill('ferry');
      await page.locator('.dialog .btn--primary').click();
      await dialogGone(page);
      await toast(page, /2歩目の名前を保存しました/);
      assert.ok(/2歩目 桜島フェリー/.test(await page.locator('.stephead').nth(1).innerText()));
      assert.strictEqual(JSON.stringify(world.sheetRows('歩')[2]), JSON.stringify([2, '桜島フェリー', 'ferry']));
      // アイコンは半角の英数字だけ
      await page.locator('.stephead', { hasText: '2歩目' }).locator('.textbtn').click();
      await page.locator('#step-icon').fill('船');
      await page.locator('.dialog .btn--primary').click();
      assert.ok(/半角の英数字/.test(await page.locator('.dialog__error').innerText()));
      await page.keyboard.press('Escape');
      await dialogGone(page);
    });
    await test('項目の編集：設問を足す：新しい設問が、その歩の最後に入る', async () => {
      await page.locator('#item-add').click();
      await page.waitForSelector('.dialog');
      assert.strictEqual(await page.locator('#it-id').inputValue(), '');
      await page.locator('.dialog .btn--primary').click();
      assert.ok(/設問IDを入れてください/.test(await page.locator('.dialog__error').innerText()));
      await page.locator('#it-id').fill('S006');
      await page.locator('#it-type').selectOption('例文');
      await page.locator('#it-prompt').fill('犬が走る。');
      await page.locator('#it-segments').fill('犬が｜走る');
      await page.locator('#it-step').fill('2');
      await page.locator('#it-order').fill('');
      await page.locator('.dialog .btn--primary').click();
      await dialogGone(page);
      await toast(page, /設問「犬が走る。」を足しました/);
      const rows = await page.locator('.table--items tbody tr').allInnerTexts();
      assert.ok(/S006/.test(rows[rows.length - 1]), '最後の行に出るはず: ' + rows[rows.length - 1]);
      const r = itemRowOf('S006');
      assert.deepStrictEqual([r[0], r[1], r[3], r[4], r[7], r[9]], [2, 3, '例文', '犬が走る。', '犬が｜走る', true]);
      assert.ok(world.call('ksReadItems_').some(i => i.id === 'S006'));
    });
    await test('項目の編集：表から取りこむ（貼りつけ）：直すところがあれば取りこめない。直してから下見すると、ちがいが出て、取りこめる', async () => {
      await go(page, 'items');
      await page.locator('#item-import').click();
      await page.waitForSelector('#import-text');
      assert.ok(/表から取りこむ/.test(await page.locator('.head__title').innerText()));
      assert.strictEqual(await page.locator('.nav [aria-current="page"]').getAttribute('data-view'), 'items');
      assert.strictEqual(await page.locator('#import-check').isDisabled(), true);
      const bad = [ITEM_HEAD.join('\t'), ['3', '1', 'P001', '語彙', '鼻', '読み：はな', '', '', '', 'TRUE', '', ''].join('\t'), ['3', '2', 'P001', '例文', '"鼻が\n高い。"', '', '', '鼻が｜高い', '', 'TRUE', '', ''].join('\t')].join('\n');
      await page.locator('#import-text').fill(bad);
      assert.ok(/貼りつけた表：2 行/.test(await page.locator('#import-parsed').innerText()), await page.locator('#import-parsed').innerText());
      await page.locator('.mode', { hasText: '足す・直すだけ' }).click();
      await page.locator('#import-check').click();
      await page.waitForSelector('#plan');
      assert.ok(/取りこめません/.test(await page.locator('#plan-title').innerText()));
      assert.ok(/2 行目にもあります/.test(await page.locator('#plan').innerText()), await page.locator('#plan').innerText());
      assert.strictEqual(await page.locator('#import-apply').isDisabled(), true);
      const good = bad.replace('\t2\tP001\t', '\t2\tP002\t');
      await page.locator('#import-text').fill(good);
      await page.locator('#import-check').click();
      await page.waitForFunction(() => /このように変わります/.test((document.getElementById('plan-title') || {}).textContent || ''));
      const text = (await page.locator('#plan').innerText()).replace(/\s+/g, ' ');
      assert.ok(/新しく足す 2 件/.test(text) && /直す 0 件/.test(text) && /消す 0 件/.test(text), text.slice(0, 300));
      assert.strictEqual(await page.locator('#import-apply').isDisabled(), false);
      await page.locator('#import-apply').click();
      await page.waitForFunction(() => document.querySelector('.head__title') && document.querySelector('.head__title').textContent === '項目', null, { timeout: 20000 });
      await toast(page, /2 件を取りこみました/);
      assert.ok(itemRowOf('P001') && itemRowOf('P002'), '貼りつけた設問がシートに入っていない');
      assert.strictEqual(itemRowOf('P002')[4], '鼻が\n高い。', '「"…"」の中の改行が読めていない');
      assert.ok(itemRowOf('S001') && itemRowOf('S006'), '「足す・直すだけ」なのに、前の設問が消えた');
      assert.ok(/3歩目/.test(await page.locator('.stephead').nth(2).innerText()));
      assert.ok(world.ss.getSheets().some(s => /^項目（控え /.test(s.getName())), '控えがとられていない');
      assert.ok(/いちばん新しい控え：項目（控え /.test(await page.locator('.notice').first().innerText()));
    });
    await test('項目の編集：表から取りこむ（Excel）：「項目」と「歩」のシートを読む。ぜんぶ入れかえると、回答のある設問は「出さない」で残る', async () => {
      const items = [ITEM_HEAD,
        [1, 1, 'X001', '語彙', '木', '読み：き', '', '', 'tree', true, '', ''],
        [1, 2, 'X002', '例文', '木が見える。', '', '', '木が｜見える', '', true, '', ''],
        [2, 1, 'X003', '例文', '火が見える。《ヒガミエル》', '', '', '火が｜見える', '', true, '', ''],
        [2, 2, 'S001', '語彙', '頭', '読み：あたま', '', '', 'head', true, '', '前からある設問']];
      const steps = [['歩', 'タイトル', 'アイコン'], [1, '木の歩', 'tree'], [2, '火の歩', 'fire']];
      const buf = tinyXlsx([{ name: '歩', rows: steps }, { name: '項目', rows: items }]);
      await go(page, 'items');
      await page.locator('#item-import').click();
      await page.waitForSelector('#import-file');
      await page.setInputFiles('#import-file', { name: 'bassui.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: buf });
      await page.waitForFunction(() => /「bassui.xlsx」：4 行/.test((document.getElementById('import-parsed') || {}).textContent || ''), null, { timeout: 10000 });
      assert.ok(/歩の表：2 行/.test(await page.locator('#import-parsed').innerText()));
      assert.ok(await page.locator('.mode', { hasText: 'ぜんぶ入れかえる' }).locator('input').isChecked());
      await page.locator('#import-check').click();
      await page.waitForSelector('#plan');
      const text = (await page.locator('#plan').innerText()).replace(/\s+/g, ' ');
      assert.ok(/新しく足す 3 件/.test(text) && /直す 1 件/.test(text), text.slice(0, 400));
      assert.ok(/消す 7 件/.test(text), text.slice(0, 400));
      assert.ok(/回答のある 4 件は消さずに/.test(text), text);
      assert.ok(/1歩目「木の歩」/.test(text));
      await page.locator('#import-apply').click();
      await page.waitForSelector('.dialog');
      assert.ok(/7 件の設問が一覧から消えます/.test(await page.locator('.dialog').innerText()));
      await page.locator('.dialog .btn', { hasText: 'やめる' }).click();
      await dialogGone(page);
      assert.ok(!itemRowOf('X001'), 'やめたのに書きこまれた');
      await page.locator('#import-apply').click();
      await page.waitForSelector('.dialog');
      await page.locator('.dialog .btn--danger').click();
      await page.waitForFunction(() => document.querySelector('.head__title') && document.querySelector('.head__title').textContent === '項目', null, { timeout: 20000 });
      await toast(page, /4 件を取りこみました（回答のある 4 件は「出さない」にして残しました）/);
      const stepRows = world.sheetRows('歩').slice(1).filter(r => r.some(v => v !== ''));
      assert.strictEqual(JSON.stringify(stepRows.filter(r => r[0] === 1 || r[0] === 2)), JSON.stringify([[1, '木の歩', 'tree'], [2, '火の歩', 'fire']]));
      assert.ok(stepRows.some(r => r[0] === 3), '項目で使わなくなった歩の行も、消さずに残す');
      const shown = world.call('ksReadItems_').map(i => i.id);
      assert.strictEqual(JSON.stringify(shown), JSON.stringify(['X001', 'X002', 'X003', 'S001']));
      assert.strictEqual(itemRowOf('S001')[11], '前からある設問');
      assert.strictEqual(itemRowOf('X003')[4], '火が見える。', 'Excel のふりがな（rPh）が本文に入ってしまった');
      assert.strictEqual(itemRowOf('S002')[9], false, '回答のある S002 は出さないで残るはず');
      assert.ok(!itemRowOf('P001'), '回答のない P001 は消えるはず');
      assert.ok(/1歩目 木の歩/.test(await page.locator('.stephead').first().innerText()));
      await page.locator('.hiddenbox summary').click();
      assert.strictEqual(await page.locator('.hiddenbox tbody tr').count(), 4);
      await shot(page, 'items-after-import');
    });
    await test('項目の編集：表から取りこむ（CSV）：Excel が書き出す Shift_JIS の CSV も読める（「"…"」の中のカンマも）', async () => {
      const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'items-sjis.csv'));
      await go(page, 'items');
      await page.locator('#item-import').click();
      await page.waitForSelector('#import-file');
      await page.setInputFiles('#import-file', { name: 'items-sjis.csv', mimeType: 'text/csv', buffer: buf });
      await page.waitForFunction(() => /「items-sjis.csv」：2 行/.test((document.getElementById('import-parsed') || {}).textContent || ''), null, { timeout: 10000 });
      assert.ok(/見出し：歩、順、設問ID、種別、提示語・例文、場面・意味・読み/.test(await page.locator('#import-parsed').innerText()), await page.locator('#import-parsed').innerText());
      await page.locator('.mode', { hasText: '足す・直すだけ' }).click();
      await page.locator('#import-check').click();
      await page.waitForSelector('#plan');
      const text = (await page.locator('#plan').innerText()).replace(/\s+/g, ' ');
      assert.ok(/新しく足す 2 件/.test(text) && /消す 0 件/.test(text), text.slice(0, 300));
      await page.locator('#import-apply').click();
      await page.waitForFunction(() => document.querySelector('.head__title') && document.querySelector('.head__title').textContent === '項目', null, { timeout: 20000 });
      await toast(page, /2 件を取りこみました/);
      const r = itemRowOf('CSV02');
      assert.ok(r, 'CSV の設問が入っていない');
      assert.strictEqual(r[4], '雨が降って、畑に行けない。'); assert.strictEqual(r[5], '「行けない」と言うとき'); assert.strictEqual(r[7], '雨が｜降って｜畑に｜行けない'); assert.strictEqual(r[9], true);
      assert.strictEqual(itemRowOf('CSV01')[6], '鍬で畑を耕す。');
    });
    await test('項目の編集：下見のあとに表を直すと、古い下見は消える。小文字の設問IDは、直しても大文字にならない', async () => {
      await go(page, 'items');
      await page.locator('#item-import').click();
      await page.waitForSelector('#import-text');
      const pasted = ITEM_HEAD.join('\t') + '\n' + ['1', '8', 'kago02', '語彙', '小文字の設問', '', '', '', '', 'TRUE', '', ''].join('\t');
      await page.locator('#import-text').fill(pasted);
      await page.locator('.mode', { hasText: '足す・直すだけ' }).click();
      await page.locator('#import-check').click();
      await page.waitForSelector('#plan');
      await page.locator('#import-text').fill(pasted + '\n');
      assert.strictEqual(await page.locator('#plan').count(), 0, '表を直したのに、古い下見が残っている');
      await page.locator('#import-check').click();
      await page.waitForSelector('#plan');
      await page.locator('#import-apply').click();
      await page.waitForFunction(() => document.querySelector('.head__title') && document.querySelector('.head__title').textContent === '項目', null, { timeout: 20000 });
      await toast(page, /1 件を取りこみました/);
      assert.ok(itemRowOf('kago02'), '小文字の設問IDが、そのまま入っていない');
      // 回答のある小文字の設問：直しても「設問IDは変えられません」にならない
      const r0 = world.sheetRows('回答')[0].map(() => '');
      r0[col('送信日時')] = new Date(Date.now() - 3600000); r0[col('参加者ナンバー')] = made.people[0].id; r0[col('歩')] = 1; r0[col('設問ID')] = 'kago02'; r0[col('種別')] = '語彙';
      r0[col('提示語・例文')] = '小文字の設問'; r0[col('回答の状態')] = '回答済'; r0[col('回答（地域の言葉）')] = 'こもじ'; r0[col('送信ID')] = 'low-000001';
      answers.appendRow(r0);
      await page.locator('#refresh').click();
      await page.waitForFunction(() => { const b = document.querySelector('[data-fk="edit:kago02"]'); return !!b && !b.disabled; }, null, { timeout: 10000 });
      await page.waitForTimeout(400);
      await page.locator('[data-fk="edit:kago02"]').click();
      await page.waitForSelector('#it-prompt');
      assert.strictEqual(await page.locator('#it-id').getAttribute('readonly'), '', '回答があるので、設問IDの欄は変えられないはず');
      await page.locator('#it-context').fill('読み：こもじ');
      await page.locator('.dialog .btn--primary').click();
      await dialogGone(page);
      await toast(page, /設問を保存しました/);
      assert.strictEqual(itemRowOf('kago02')[5], '読み：こもじ');
      assert.ok(!itemRowOf('KAGO02'), '設問IDが大文字になってしまった');
      // 回答のない設問も、小文字のまま
      await page.locator('[data-fk="edit:X002"]').click();
      await page.waitForSelector('#it-id');
      await page.locator('#it-id').fill('x002b');
      await page.locator('.dialog .btn--primary').click();
      await dialogGone(page);
      await toast(page, /設問を保存しました/);
      assert.ok(itemRowOf('x002b') && !itemRowOf('X002B'), '設問IDが大文字になってしまった');
    });
    await test('項目の編集：控えからもどすと、取りこむ前の設問にもどる（もどす前の控えもとられる）', async () => {
      await go(page, 'items');
      const beforeIds = world.call('ksReadItems_').map(i => i.id).join(',');
      const stampBefore = admin('overview').backups[0];
      await page.locator('#item-import').click();
      await page.waitForSelector('#import-text');
      await page.locator('#import-text').fill(ITEM_HEAD.join('\t') + '\n' + ['1', '1', 'R001', '語彙', 'もどす前', '', '', '', '', 'TRUE', '', ''].join('\t'));
      await page.locator('.mode', { hasText: 'ぜんぶ入れかえる' }).click();
      await page.locator('#import-check').click();
      await page.waitForSelector('#plan');
      await page.locator('#import-apply').click();
      await page.waitForSelector('.dialog');
      await page.locator('.dialog .btn--danger').click();
      await page.waitForFunction(() => document.querySelector('.head__title') && document.querySelector('.head__title').textContent === '項目', null, { timeout: 20000 });
      await toast(page, /1 件を取りこみました/);
      assert.strictEqual(world.call('ksReadItems_').map(i => i.id).join(','), 'R001');
      const stampNow = admin('overview').backups[0];
      assert.notStrictEqual(stampNow, stampBefore, '取りこみで控えがとられていない');
      await page.locator('#item-restore').click();
      await page.waitForSelector('#restore-pick');
      assert.strictEqual(await page.locator('#restore-pick').inputValue(), stampNow, 'いちばん新しい控えがえらばれているはず');
      await page.locator('.dialog .btn--danger').click();
      await dialogGone(page);
      await toast(page, /にもどしました/);
      assert.strictEqual(world.call('ksReadItems_').map(i => i.id).join(','), beforeIds, 'もどっていない');
      assert.ok(!/R001/.test(await page.locator('#view').innerText()), '画面が古いまま');
      assert.ok(admin('overview').backups.length >= 2 && admin('overview').backups[0] !== stampNow, 'もどす前の控えがとられていない');
    });
    await test('項目の編集：取りこむとちゅうで時間切れになっても、貼りつけた表は画面に残る（写しをとれる）', async () => {
      await go(page, 'items');
      await page.locator('#item-import').click();
      await page.waitForSelector('#import-text');
      const pasted = ITEM_HEAD.join('\t') + '\n' + ['1', '1', 'Z001', '語彙', '石', '', '', '', '', 'TRUE', '', ''].join('\t');
      await page.locator('#import-text').fill(pasted);
      const keep = world.props.TOKEN_SECRET;
      world.props.TOKEN_SECRET = 'changed-' + keep;
      try {
        await page.locator('#import-check').click();
        await page.waitForSelector('.screen__title:has-text("開き直してください")');
        assert.strictEqual(await page.locator('#rescue-0').inputValue(), pasted);
      } finally {
        world.props.TOKEN_SECRET = keep;
      }
      await page.context().close();
    });
  }

  console.log('まだ何もないとき');
  await test('参加者も回答もないときは、次にすることの案内が出る', async () => {
    const quiet2 = console.log; console.log = () => {};
    const empty = createGasWorld(code);
    empty.call('setup');
    console.log = quiet2;
    empty.webUser = empty.OWNER;
    // 調査項目入りのプログラムでは、はじめから「サイトのURL」が入っていることがある。ここでは、空の状態で確かめる
    empty.call('ksAdminCall', empty.call('ksMakeAdminToken_'), 'saveSettings', JSON.stringify({ values: { 'サイトのURL': '' } }));
    const server2 = await startServer(empty, PORT_EMPTY);
    const p = await newPage();
    await p.goto(`http://localhost:${PORT_EMPTY}/exec?admin=1`);
    await p.waitForSelector('.tile');
    const text = await p.locator('#view').innerText();
    assert.ok(/まだ回答がありません/.test(text) && /まだ参加者がいません/.test(text), text.slice(0, 200));
    assert.strictEqual(await p.locator('.flag').count(), 0);
    assert.strictEqual(await p.locator('.chart__bar').count(), 0);
    await go(p, 'people');
    assert.ok(/「参加者を追加」を押すと/.test(await p.locator('#people-body').innerText()));
    await p.locator('#print-cards').click();
    await toast(p, /印刷する参加者がいません/);
    await go(p, 'answers');
    await answersLoaded(p);
    assert.ok(/まだ回答がありません/.test(await p.locator('#answers-body').innerText()));
    await go(p, 'items');
    assert.ok(/まだ回答がありません/.test(await p.locator('.table--items').first().innerText()));
    await go(p, 'people');
    await p.locator('.btn', { hasText: '参加者を追加' }).click();
    await p.locator('#add-count').fill('1');
    await p.locator('.dialog .btn', { hasText: 'つくる' }).click();
    await p.waitForSelector('.dialog__title:has-text("1人分を追加しました")');
    await p.locator('.dialog .btn', { hasText: 'カードを印刷' }).click();
    await p.waitForSelector('.pcard');
    assert.strictEqual(await p.locator('.pcard').count(), 1);
    assert.strictEqual(await p.locator('.pcard__qr').count(), 0, 'サイトのURLがないのに、QRコードが出た');
    assert.ok(/「設定」で「サイトのURL」を入れると/.test(await p.locator('.print__bar').innerText()));
    await p.locator('#print-close').click();

    // グラフ：回答がとても多い日があっても、目盛りの数字が切れない
    const sh = empty.ss.getSheetByName('回答');
    const head = empty.sheetRows('回答')[0];
    const c = name => head.indexOf(name);
    const its = empty.call('ksReadItems_');
    for (let i = 0; i < 1234; i++) {
      const row = head.map(() => '');
      row[c('送信日時')] = new Date(Date.now() - 1000 - i);
      row[c('参加者ナンバー')] = 'T' + (100 + (i % 30)); row[c('歩')] = its[i % its.length].step; row[c('設問ID')] = its[i % its.length].id; row[c('種別')] = its[i % its.length].type;
      row[c('提示語・例文')] = its[i % its.length].prompt; row[c('回答の状態')] = '回答済'; row[c('回答（地域の言葉）')] = 'たくさん' + i; row[c('送信ID')] = 'many-' + String(i).padStart(6, '0');
      sh.appendRow(row);
    }
    await go(p, 'home');
    await p.locator('#refresh').click();
    await toast(p, /新しい内容にしました/);
    const labels = await p.evaluate(() => {
      const svg = document.querySelector('.chart svg').getBoundingClientRect();
      return Array.from(document.querySelectorAll('.chart svg text')).map(t => { const r = t.getBoundingClientRect(); return { text: t.textContent, cut: r.left < svg.left - 0.5 || r.right > svg.right + 0.5 }; });
    });
    assert.ok(labels.some(l => /^\d{4}$/.test(l.text)), '4けたの目盛りが出ていない: ' + labels.map(l => l.text).join(' '));
    assert.deepStrictEqual(labels.filter(l => l.cut).map(l => l.text), [], '切れている文字がある');
    await noOverflow(p, '回答がとても多いときのダッシュボード');
    // この期間に回答がないとき：そのことを書く
    for (const row of sh.rows.slice(1)) row[c('送信日時')] = new Date(row[c('送信日時')].getTime() - 40 * 86400000);
    await p.locator('#refresh').click();
    await toast(p, /新しい内容にしました/);
    assert.strictEqual(await p.locator('.chart__bar').count(), 0);
    assert.strictEqual(await p.locator('.chart__none').textContent(), 'この期間には、回答がありません。');
    await p.locator('.seg__btn', { hasText: '週ごと' }).click();
    assert.ok(await p.locator('.chart__bar').count() >= 1);
    assert.strictEqual(await p.locator('.chart__none').count(), 0);
    await p.context().close();
    server2.close();
  });

  await browser.close();
  server.close();
  if (errors.length) { failed++; console.error('  NG  画面でエラーが出ていないこと\n      ' + errors.slice(0, 12).join('\n      ')); }
  else { passed++; console.log('  ok  画面でエラーが出ていないこと（外へも出ていない）'); }
  console.log(`\n${passed} 件のテストに合格` + (failed ? `、${failed} 件が失敗` : ''));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
