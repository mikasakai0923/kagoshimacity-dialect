#!/usr/bin/env node
/*
 * 開発用：録音の「声と、まわりの音の差」の見積もり（js/recorder.js の analyzeNoise）のテスト。
 *   node tools/test-recorder.js
 *
 * 声に似せた音（音節のかたまり＋短い切れ目）と雑音を、大きさを決めてまぜ、
 * 見積もりが本当の差に近いか、注意が出るべきときに出るかを確かめます。
 * 本物の声・本物のスマートフォンでの確認のかわりにはなりません。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// recorder.js を、ブラウザなしで読みこむ（計算の部分だけを使う）
const win = { KS: { h: function () {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'recorder.js'), 'utf8'), { window: win, document: {}, navigator: {} });
const rec = win.KS.rec;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  NG  ' + name + '\n      ' + (e && e.stack || e)); process.exitCode = 1; }
}

/* ---------- 音を作る道具 ---------- */
let seed = 20261012;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
function gauss() { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); }
const lin = d => Math.pow(10, d / 20);
function rms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); }

// 声に似せた音：音節（母音のかたまり）を並べ、あいだに短い切れ目を入れる。大きさは「母音の大きさ」が 1 になるようにそろえる
function speechLike(syllables, rate) {
  const parts = [];
  for (let k = 0; k < syllables; k++) {
    const len = Math.round(rate * (0.11 + 0.08 * rnd())), f0 = 110 + 60 * rnd();
    const syl = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / rate, env = Math.min(1, i / (0.015 * rate), (len - i) / (0.03 * rate));
      syl[i] = env * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(2 * Math.PI * 2 * f0 * t) + 0.3 * Math.sin(2 * Math.PI * 5 * f0 * t)) / 1.25;
    }
    parts.push(syl);
    if (k < syllables - 1) parts.push(new Float32Array(Math.round(rate * (0.03 + 0.05 * rnd()))));     // 子音の閉鎖のような切れ目
  }
  const n = parts.reduce((a, p) => a + p.length, 0), out = new Float32Array(n);
  let off = 0; parts.forEach(p => { out.set(p, off); off += p.length; });
  const g = 1 / (rms(parts[0]) * 1.15);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}
function noiseOf(type, n) {
  const y = new Float32Array(n);
  if (type === 'white') { for (let i = 0; i < n; i++) y[i] = gauss(); }
  else { let lp = 0; for (let i = 0; i < n; i++) { lp = 0.97 * lp + 0.03 * gauss(); y[i] = lp * 6 + 0.2 * gauss(); } }   // 低い音の多い雑音（換気扇など）
  const g = 1 / rms(y);
  for (let i = 0; i < n; i++) y[i] *= g;
  return y;
}
// 録音を組み立てる。o: { syllables, speechDb, lead, trail, selfDb, noise, noiseDb, tap, pop, zeros, rate }
function build(o) {
  const rate = o.rate || 48000;
  const sp = o.syllables ? speechLike(o.syllables, rate) : new Float32Array(0);
  const lead = Math.round((o.lead === undefined ? 0.3 : o.lead) * rate), trail = Math.round((o.trail === undefined ? 0.4 : o.trail) * rate);
  const n = lead + sp.length + trail, y = new Float32Array(n);
  const gs = lin(o.speechDb === undefined ? -20 : o.speechDb);
  for (let i = 0; i < sp.length; i++) y[lead + i] = sp[i] * gs;
  const self = noiseOf('white', n), g0 = lin(o.selfDb === undefined ? -65 : o.selfDb);      // 機器そのものの雑音
  for (let i = 0; i < n; i++) y[i] += self[i] * g0;
  if (o.noise) { const nz = noiseOf(o.noise, n), g1 = lin(o.noiseDb); for (let i = 0; i < n; i++) y[i] += nz[i] * g1; }
  if (o.tap) { const at = n - Math.round(0.08 * rate); for (let i = 0; i < 0.012 * rate; i++) y[at + i] += o.tap * Math.exp(-i / (0.003 * rate)) * (rnd() * 2 - 1); }
  if (o.pop) { for (let i = 0; i < 0.01 * rate; i++) y[i] += o.pop * Math.exp(-i / (0.002 * rate)) * (rnd() * 2 - 1); }
  if (o.zeros) { for (let i = 0; i < o.zeros * rate; i++) y[i] = 0; }
  for (let i = 0; i < n; i++) y[i] = Math.max(-1, Math.min(1, y[i]));
  return { samples: y, rate };
}
// 本物と同じように、かたまり（chunk）に分けて渡す
function analyze(r, chunkSize) {
  const chunks = [], size = chunkSize || 4096;
  for (let i = 0; i < r.samples.length; i += size) chunks.push(r.samples.subarray(i, Math.min(i + size, r.samples.length)));
  return rec.analyzeNoise(chunks, r.samples.length, r.rate);
}
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what || ''} ${a} が ${b}±${tol} に入っていない`);

console.log('静かな部屋');
test('静かな部屋の録音は、差が大きく出て、注意は出ない', () => {
  for (const syl of [1, 2, 5, 12]) {
    const e = analyze(build({ syllables: syl }));
    near(e.snrDb, 45, 4, syl + '音節');
    assert.strictEqual(rec.isNoisy(e), false);
  }
});
test('話す前後の間が短くても（前0.1秒・後0.15秒）、声をまわりの音と取りちがえない', () => {
  for (const syl of [1, 3, 8, 20]) {
    const e = analyze(build({ syllables: syl, lead: 0.1, trail: 0.15 }));
    assert.ok(e.snrDb > 35, syl + '音節: ' + e.snrDb);
  }
});
test('長い間のなかの短い語でも、注意は出ない', () => {
  const e = analyze(build({ syllables: 1, lead: 3, trail: 2 }));
  near(e.snrDb, 45, 4);
});

console.log('うるさい部屋');
test('鳴りつづける雑音は、見積もりが本当の差に近く、差が15dB以下なら注意が出る', () => {
  for (const type of ['white', 'fan']) for (const truth of [5, 10, 15]) {
    const e = analyze(build({ syllables: 5, noise: type, noiseDb: -20 - truth, selfDb: -80 }));
    near(e.snrDb, truth, 3.5, type + ' 本当の差' + truth);
    assert.strictEqual(rec.isNoisy(e), true, type + ' ' + truth + ' → ' + e.snrDb);
  }
});
test('差が25dB以上あれば、注意は出ない', () => {
  for (const type of ['white', 'fan']) for (const truth of [25, 30, 40]) {
    const e = analyze(build({ syllables: 5, noise: type, noiseDb: -20 - truth, selfDb: -80 }));
    near(e.snrDb, truth, 3.5, type + ' 本当の差' + truth);
    assert.strictEqual(rec.isNoisy(e), false, type + ' ' + truth + ' → ' + e.snrDb);
  }
});
test('まわりの音の大きさ（noiseDb）も、ほぼ正しく出る', () => {
  const e = analyze(build({ syllables: 5, noise: 'fan', noiseDb: -38, selfDb: -80 }));
  near(e.noiseDb, -38, 3);
});

console.log('ボタンにふれる音・録りはじめの乱れ');
test('終わりのタップ音、はじめのポップ音、はじめの無音があっても、見積もりはほとんど変わらない', () => {
  for (const env of [{}, { noise: 'fan', noiseDb: -35, selfDb: -80 }]) {
    const base = analyze(build(Object.assign({ syllables: 4 }, env))).snrDb;
    for (const extra of [{ tap: 0.9 }, { pop: 0.8 }, { zeros: 0.2 }, { tap: 0.9, pop: 0.8, zeros: 0.1 }]) {
      const e = analyze(build(Object.assign({ syllables: 4 }, env, extra)));
      near(e.snrDb, base, 3, JSON.stringify(extra));
    }
  }
});

console.log('音がとぎれたところ（まったくの無音）');
test('とちゅうに、まったくの無音の区切りが少しあっても、静かな部屋とは見なさない（数字が大きくなりすぎない）', () => {
  const r = build({ syllables: 5, noise: 'white', noiseDb: -32, selfDb: -80 });
  const base = analyze(r).snrDb;
  for (const at of [0.5, 0.9]) { const from = Math.round(at * r.samples.length); for (let i = 0; i < 0.07 * r.rate; i++) r.samples[from + i] = 0; }
  const e = analyze(r);
  near(e.snrDb, base, 2);
  assert.strictEqual(rec.isNoisy(e), true);
});
test('話していないあいだが、いつもまったくの無音になる端末では、差を出さない（注意も出さない）', () => {
  const r = build({ syllables: 6, selfDb: -200, lead: 0.4, trail: 0.5 });      // 機器の雑音がゼロ＝端末が音を消している
  const e = analyze(r);
  assert.strictEqual(e.snrDb, undefined); assert.strictEqual(e.noiseDb, undefined);
  assert.ok(e.speechDb > -30);
  assert.strictEqual(rec.isNoisy(e), false);
});

console.log('声がないとき・短すぎるとき');
test('音のない録音・ほとんど音のない録音では、差を出さない（注意も出さない）', () => {
  assert.strictEqual(analyze({ samples: new Float32Array(48000), rate: 48000 }), null);        // まったくの無音
  const e = analyze(build({ syllables: 0, lead: 1, trail: 1, selfDb: -80 }));                 // ごく小さな雑音だけ
  assert.strictEqual(e.snrDb, undefined);
  assert.strictEqual(rec.isNoisy(e), false);
});
test('うるさい部屋で何も話さなかった録音は、差が小さく出る', () => {
  const e = analyze(build({ syllables: 0, lead: 1, trail: 1, noise: 'fan', noiseDb: -35 }));
  assert.ok(e.snrDb < 10, String(e.snrDb));
});
test('0.3秒より短いと見積もらない', () => {
  assert.strictEqual(analyze({ samples: new Float32Array(Math.round(48000 * 0.25)).fill(0.1), rate: 48000 }), null);
  assert.ok(analyze(build({ syllables: 1, lead: 0.1, trail: 0.15 })));
});

console.log('録音中のメーター・再生のときの音量');
test('メーター：音量の小さい端末（ふつうの声で最大の3%くらい）でも、半分ほど光る。静かなときは光らない', () => {
  assert.strictEqual(rec.meterBars(0, 7), 0);
  assert.strictEqual(rec.meterBars(0.0003, 7), 0);       // iPhone の静かな部屋
  assert.ok(rec.meterBars(0.03, 7) >= 3 && rec.meterBars(0.03, 7) <= 5);
  assert.ok(rec.meterBars(0.01, 7) >= 1);
  assert.strictEqual(rec.meterBars(0.3, 7), 7);
  assert.strictEqual(rec.meterBars(1, 7), 7);
  let prev = 0;
  for (const l of [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1]) { const n = rec.meterBars(l, 7); assert.ok(n >= prev, '大きい音ほど多く光るはず'); prev = n; }
});
test('再生のときの倍率：小さく録れた声は大きくし、十分大きい声は変えない。上げすぎない', () => {
  near(20 * Math.log10(rec.playbackGain({ speechDb: -45.2, peak: 0.027 })), 25.2, 0.1);
  assert.strictEqual(rec.playbackGain({ speechDb: -15, peak: 0.5 }), 1);
  assert.strictEqual(rec.playbackGain({ speechDb: -20, peak: 0.3 }), 1);
  near(20 * Math.log10(rec.playbackGain({ speechDb: -65, peak: 0.004 })), 36, 0.01);      // 上限
  near(rec.playbackGain({ peak: 0.02 }), 25, 0.01);                                        // 声の大きさがわからないとき
  assert.strictEqual(rec.playbackGain({ peak: 0.9 }), 1);
  assert.strictEqual(rec.playbackGain({}), 1);
  assert.strictEqual(rec.playbackGain(null), 1);
});
test('再生用の写し：音だけが大きくなり、長さや形式は変わらない。もとの録音は変わらない。大きすぎるところは上限でおさえる', () => {
  const n = 1000, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  for (let i = 0; i < 44; i++) dv.setUint8(i, i + 1);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(900 * Math.sin(i / 7)), true);
  dv.setInt16(44 + 10, 30000, true); dv.setInt16(44 + 12, -30000, true);                    // ボタンにふれる音のような、大きい山
  const before = Buffer.from(buf).toString('hex');
  const out = rec.amplifyWav(buf, 18), ov = new DataView(out);
  assert.strictEqual(Buffer.from(buf).toString('hex'), before, 'もとの録音が変わった');
  assert.strictEqual(out.byteLength, buf.byteLength);
  for (let i = 0; i < 44; i++) assert.strictEqual(ov.getUint8(i), i + 1, '見出しが変わった');
  assert.strictEqual(ov.getInt16(44 + 10, true), 32767); assert.strictEqual(ov.getInt16(44 + 12, true), -32768);
  for (const i of [0, 3, 50, 999]) assert.strictEqual(ov.getInt16(44 + i * 2, true), Math.max(-32768, Math.min(32767, Math.round(dv.getInt16(44 + i * 2, true) * 18))));
});

console.log('そのほか');
test('サンプリング周波数や、音の届き方（かたまりの大きさ）がちがっても、同じ結果になる', () => {
  for (const rate of [16000, 24000, 44100, 48000]) {
    const quiet = analyze(build({ syllables: 5, rate })), noisy = analyze(build({ syllables: 5, rate, noise: 'white', noiseDb: -32, selfDb: -80 }));
    near(quiet.snrDb, 45, 4, rate + 'Hz 静か'); near(noisy.snrDb, 12, 3.5, rate + 'Hz うるさい');
  }
  const r = build({ syllables: 6, noise: 'white', noiseDb: -40 });
  const a = analyze(r, 128), b = analyze(r, 4096), c = analyze(r, 2048);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(c)));
});
test('注意の目安：ふだんは20dB。0 なら出さない。数字でない目安は、ふだんの目安として扱う', () => {
  const v = { snrDb: 18 };
  assert.strictEqual(rec.NOISY_SNR_DB, 20);
  assert.strictEqual(rec.isNoisy(v), true);
  assert.strictEqual(rec.isNoisy(v, 20), true);
  assert.strictEqual(rec.isNoisy(v, 15), false);
  assert.strictEqual(rec.isNoisy(v, 0), false);
  assert.strictEqual(rec.isNoisy(v, undefined), true);
  assert.strictEqual(rec.isNoisy(v, '30'), true);
  assert.strictEqual(rec.isNoisy(v, NaN), true);
  assert.strictEqual(rec.isNoisy({ snrDb: 25 }, 30), true);
  assert.strictEqual(rec.isNoisy({ snrDb: 20 }), false);
  assert.strictEqual(rec.isNoisy({}), false);
  assert.strictEqual(rec.isNoisy(null), false);
});

console.log(`\n${passed} 件のテストに合格` + (process.exitCode ? '（失敗あり）' : ''));
