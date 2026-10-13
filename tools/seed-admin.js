/*
 * 開発用：管理画面の確認のために、まねサーバー（tools/mock-gas.js）の中に、それらしい参加者と回答を入れる。
 * 回答は、参加者の画面と同じ道すじ（ログイン → 保存）で入れるので、表の形や録音のファイルも本番と同じになります。
 *
 *   const seed = require('./seed-admin');
 *   const made = seed(world, { now: Date.now() });      // → { people: [{ id, pw }], rows: 入れた回答の数 }
 *
 * 中身は機械的に作った仮のものです（本物の回答ではありません）。
 */

// 声に似せた音（0.22秒の音と0.18秒の切れ目のくり返し）の WAV を作る。amp は声の大きさ、noise はまわりの音の大きさ
function speechWav(seconds, amp, noise, rate) {
  rate = rate || 16000;
  const n = Math.round(seconds * rate), period = Math.round(rate * 0.4), on = Math.round(rate * 0.22);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  let seed = 11;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < n; i++) {
    const k = i % period;
    const env = k < on ? Math.min(1, k / 160, (on - k) / 320) : 0;
    const v = env * amp * Math.sin(i * 2 * Math.PI * 220 / rate) + (rnd() + rnd() + rnd() + rnd() - 2) * 1.732 * noise;
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2);
  }
  return b;
}

// 参加者ごとの筋書き：share は答える設問の割合、days は何日前から何日前までに答えたか、amp は声の大きさ（小さいのは iPhone など）
const PLAN = [
  { share: 1, days: [11, 2], amp: 0.03, snr: [33, 41] },
  { share: 1, days: [9, 1], amp: 0.25, snr: [28, 38] },
  { share: 0.7, days: [8, 0], amp: 0.03, snr: [30, 40] },
  { share: 0.3, days: [5, 0], amp: 0.2, snr: [21, 25], noisy: true },
  { share: 0.16, days: [3, 0], amp: 0.03, snr: [31, 39], noMic: true },
  { share: 0.07, days: [0, 0], amp: 0.03, snr: [34, 40] },
  { share: 0 },
  { share: 0, stopped: true, memo: '10/20 に登録の予定' }
];

module.exports = function seed(world, opt) {
  opt = opt || {};
  const now = opt.now || Date.now();
  const plan = opt.plan || PLAN;
  const answerFor = opt.answerFor || (item => {
    const segs = item.segments.length ? item.segments.map((s, i) => 'こたえ' + (i + 1)) : [];
    return { answer: segs.length ? segs.join('') : 'こたえ', segAnswer: segs.join('｜'), exampleAnswer: item.example ? 'れいぶんのこたえ' : '' };
  });
  let r = 20261012;
  const rnd = () => { r = (r * 1664525 + 1013904223) >>> 0; return r / 4294967296; };
  const pick = (a, b) => a + (b - a) * rnd();
  const plain = s => String(s).replace(/《[^》]*》/g, '');

  const before = world.sheetRows('参加者').length - 1;
  world.call('addParticipants', plan.length);
  const people = world.sheetRows('参加者').slice(1 + before).map(row => ({ id: row[0], pw: row[1] }));
  const items = world.call('ksReadItems_');
  const sheet = world.ss.getSheetByName('回答');
  const peopleSheet = world.ss.getSheetByName('参加者');
  const wavs = {};
  const wavOf = (sec, amp, noise) => {
    const key = sec + '/' + amp + '/' + noise;
    if (!wavs[key]) wavs[key] = speechWav(sec, amp, noise).toString('base64');
    return wavs[key];
  };
  let n = 0;

  people.forEach((person, pi) => {
    const p = plan[pi];
    const rowNo = before + pi + 2;
    peopleSheet.rows[rowNo - 1][4] = new Date(now - (14 - pi) * 86400000);
    if (p.memo) peopleSheet.rows[rowNo - 1][3] = p.memo;
    if (!p.share) {
      if (p.stopped) peopleSheet.rows[rowNo - 1][2] = '停止';
      return;
    }
    const login = world.post({ action: 'login', id: person.id, password: person.pw });
    if (!login.ok) throw new Error('seed: ログインできません ' + JSON.stringify(login));
    const count = Math.max(1, Math.round(items.length * p.share));
    // 1歩ぶんを、ある日のひとまとまりの時間に答えたことにする（days[0] 日前から days[1] 日前までに散らす）
    const mine = items.slice(0, count);
    const stepNos = mine.map(it => it.step).filter((v, i, a) => a.indexOf(v) === i);
    const today0 = Math.floor((now + 9 * 3600000) / 86400000) * 86400000 - 9 * 3600000;      // 日本時間の今日の 0:00
    const times = {};
    let lastAt = 0;
    stepNos.forEach((no, si) => {
      const list = mine.filter(it => it.step === no);
      const ago = Math.round(p.days[0] + (p.days[1] - p.days[0]) * (stepNos.length === 1 ? 1 : si / (stepNos.length - 1)));
      let t = today0 - ago * 86400000 + pick(9, 20.5) * 3600000;
      t = Math.max(lastAt + 600000, Math.min(t, now - list.length * 120000 - 90000));
      list.forEach(it => { times[it.id] = Math.round(t); t += pick(40, 110) * 1000; });
      lastAt = t;
    });
    for (let i = 0; i < count; i++) {
      const item = items[i];
      const at = Math.min(times[item.id], now - 1000 * (count - i));
      // 録音なし・「知らない」などの回答が、設問の数が少ないときでも、かならず少しは入るようにする
      const noMic = !!p.noMic && i % 3 === 0;
      const dice = rnd();
      const fixed = pi === 1 && i === 1 ? '知らない' : (pi === 2 && i === 3 ? '使わない' : (pi === 0 && i === 4 ? '思い出せない' : ''));
      const status = noMic ? '回答済' : (fixed || (dice < 0.04 ? '知らない' : (dice < 0.07 ? '使わない' : (dice < 0.085 ? '思い出せない' : '回答済'))));
      const a = status === '回答済' ? answerFor(item) : { answer: '', segAnswer: '', exampleAnswer: '' };
      const sec = Math.round(pick(1.2, 2.6) * 5) / 5;
      const snr = Math.round((p.noisy && i % 4 !== 3 ? pick(11, 18.5) : pick(p.snr[0], p.snr[1])) * 10) / 10;      // noisy の人は、4回に3回は目安（20）より小さい
      const noise = p.noisy ? 0.02 : 0.0004;
      const audio = [];
      if (status === '回答済' && !noMic) {
        audio.push({ slot: 'main', b64: wavOf(sec, p.amp, noise), sampleRate: 16000, durationSec: sec, peak: p.amp, snrDb: snr, noiseDb: Math.round((20 * Math.log10(p.amp) - snr) * 10) / 10,
                     echoCancellation: false, noiseSuppression: false, autoGainControl: false });
        if (item.type === '語彙' && item.example) audio.push({ slot: 'example', b64: wavOf(2, p.amp, noise), sampleRate: 16000, durationSec: 2, peak: p.amp, snrDb: snr + 1, noiseDb: -70 });
      }
      n++;
      const t = new Date(at + 9 * 3600000).toISOString().replace(/\.\d+Z$/, '+09:00');
      const sub = {
        submissionId: 'seed' + String(n).padStart(6, '0'), itemId: item.id, step: item.step, type: item.type, prompt: plain(item.prompt), status,
        answer: a.answer, segPrompt: item.type === '例文' ? (item.segments.length ? item.segments : [item.prompt]).map(plain).join('｜') : '', segAnswer: a.segAnswer || '',
        exampleAnswer: a.exampleAnswer || '', note: status === '回答済' && i % 11 === 4 ? '年上の人は、べつの言い方をします' : '',
        noAudioReason: noMic ? 'マイクが使えない' : '', elapsedSec: Math.round(pick(18, 70)),
        device: pi % 2 ? 'Android 14 / Chrome 129' : 'iPhone / iOS 18.7 / Safari', clientTime: t, app: '0.3.3', audio
      };
      const res = world.post({ action: 'save', token: login.token, submission: sub });
      if (!res.ok || !res.saved) throw new Error('seed: 保存できません ' + JSON.stringify(res));
      sheet.rows[sheet.rows.length - 1][0] = new Date(at);      // 「送信日時」を、筋書きの日時にする
    }
    if (p.stopped) peopleSheet.rows[rowNo - 1][2] = '停止';
    peopleSheet.rows[rowNo - 1][5] = new Date(Math.max(now - p.days[1] * 86400000 - 7200000, lastAt - 3600000));
  });
  return { people, rows: n };
};
module.exports.speechWav = speechWav;
