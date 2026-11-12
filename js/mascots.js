/* 案内役（キャラクター）の絵。参加者のサイトと管理画面の両方で使う（管理画面には tools/build-gas.js が写す）
 * すべてこのサイト用に描いたSVG。どの案内役も、同じ大きさ（viewBox 0 0 122 132）・同じ線の太さで、
 * 「wave（手をふる）」「listen（聞いている）」「cheer（ばんざい）」の3つのポーズがある。 */
(function (root) {
  'use strict';
  var INK = '#1D2B53';
  var S = 'stroke="' + INK + '" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"';

  // 案内役の一覧。「設定」シートの「案内役」には label を書く
  var INFO = {
    daikon: { label: '桜島大根', name: 'デコンちゃん', about: '桜島大根の案内役。葉っぱの帽子が目じるし（鹿児島らしさが出ます）' },
    maru:   { label: 'まる', name: 'まるちゃん', about: 'まんまるの案内役。どの地域でも使える、いちばんシンプルな姿' },
    happa:  { label: 'はっぱ', name: 'はっぱちゃん', about: 'ことばの「葉」の案内役。すこし風にゆれます' },
    kuro:   { label: '黒いフレンチブルドッグ', name: 'くろちゃん', about: '黒いフレンチブルドッグの案内役。耳がよく聞こえます' },
    shiro:  { label: '白いフレンチブルドッグ', name: 'しろちゃん', about: '白いフレンチブルドッグの案内役。くろちゃんのきょうだい' }
  };
  var LIST = ['daikon', 'maru', 'happa', 'kuro', 'shiro'];

  /* ---------- 共通の部品 ---------- */
  // 手：線の先に丸。x1,y1 → x2,y2
  function hand(cls, x1, y1, x2, y2, fill) {
    return '<g class="mascot__arm mascot__arm--' + cls + '"><path d="M' + x1 + ' ' + y1 + 'L' + x2 + ' ' + y2 + '" fill="none" ' + S + '/>' +
      '<circle cx="' + x2 + '" cy="' + y2 + '" r="4.500" fill="' + (fill || '#fff') + '" ' + S + '/></g>';
  }
  // 聞いているときの音の波（右上）
  function sound(x, y) {
    return '<g class="mascot__sound" fill="none" stroke="#2AA9C9" stroke-width="3.500" stroke-linecap="round">' +
      '<path d="M' + x + ' ' + y + 'q5 8 0 16"/><path d="M' + (x + 6) + ' ' + (y - 7) + 'q9 15 0 30"/></g>';
  }
  function eyes(pose, lx, rx, y) {
    if (pose === 'cheer') return '<path d="M' + (lx - 5) + ' ' + (y + 1) + 'q5-6 10 0M' + (rx - 5) + ' ' + (y + 1) + 'q5-6 10 0" fill="none" ' + S + '/>';
    return '<circle cx="' + lx + '" cy="' + y + '" r="3.800" fill="' + INK + '"/><circle cx="' + rx + '" cy="' + y + '" r="3.800" fill="' + INK + '"/>';
  }
  function mouth(pose, x, y) {
    if (pose === 'cheer') return '<path d="M' + (x - 8) + ' ' + y + 'h16q-1 10-8 10t-8-10z" fill="#FF7A8C" ' + S + '/>';
    if (pose === 'listen') return '<path d="M' + (x - 5) + ' ' + (y + 1) + 'q5 4 10 0" fill="none" ' + S + '/>';
    return '<path d="M' + (x - 7) + ' ' + y + 'q7 7 14 0" fill="none" ' + S + '/>';
  }
  function cheeks(lx, rx, y) {
    return '<ellipse cx="' + lx + '" cy="' + y + '" rx="5.500" ry="3.200" fill="#FF9FB2"/><ellipse cx="' + rx + '" cy="' + y + '" rx="5.500" ry="3.200" fill="#FF9FB2"/>';
  }
  function feet(y, fill) {
    return '<ellipse cx="46" cy="' + y + '" rx="9" ry="5" fill="' + fill + '" ' + S + '/><ellipse cx="74" cy="' + y + '" rx="9" ry="5" fill="' + fill + '" ' + S + '/>';
  }
  function wrap(kind, pose, inner) {
    return '<svg class="mascot mascot--' + kind + ' mascot--' + pose + '" viewBox="0 0 122 132" aria-hidden="true" focusable="false">' + inner + '</svg>';
  }

  /* ---------- 桜島大根（デコンちゃん） ---------- */
  function daikon(pose) {
    var arms, extra = '';
    if (pose === 'cheer') arms = hand('l', 23, 76, 8, 56) + hand('r', 97, 76, 112, 56);
    else if (pose === 'listen') {
      arms = hand('l', 22, 86, 9, 97) +
        '<g class="mascot__arm mascot__arm--r"><path d="M96 74l9-11" fill="none" ' + S + '/><path d="M101 66q8-8 9 3" fill="#fff" ' + S + '/></g>' + sound(112, 50);
    } else arms = hand('l', 22, 86, 9, 97) + hand('r', 98, 78, 112, 59);
    return wrap('daikon', pose,
      '<g class="mascot__leaves">' +
        '<path d="M57 47C42 41 31 27 30 12c14 2 24 17 28 33z" fill="#3FB173" ' + S + '/>' +
        '<path d="M63 47c15-6 26-20 27-35-14 2-24 17-28 33z" fill="#3FB173" ' + S + '/>' +
        '<path d="M60 47C50 33 52 12 60 4c8 8 10 29 0 43z" fill="#62C98B" ' + S + '/>' +
      '</g>' +
      '<path d="M53 111c2 8 5 15 8 18 2-4 4-10 6-18z" fill="#fff" ' + S + '/>' +
      arms +
      '<ellipse cx="60" cy="80" rx="42" ry="36" fill="#fff" ' + S + '/>' +
      '<path d="M91 91c-6 13-21 20-38 19" fill="none" stroke="#DCE8F0" stroke-width="5" stroke-linecap="round"/>' +
      cheeks(37, 83, 88) + eyes(pose, 47, 73, 77) + mouth(pose, 60, 86) +
      feet(119, '#FF9A2E') + extra);
  }

  /* ---------- まる（まるちゃん） ---------- */
  function maru(pose) {
    var arms;
    if (pose === 'cheer') arms = hand('l', 24, 72, 9, 52, '#FFC98B') + hand('r', 96, 72, 111, 52, '#FFC98B');
    else if (pose === 'listen') {
      arms = hand('l', 23, 84, 9, 96, '#FFC98B') +
        '<g class="mascot__arm mascot__arm--r"><path d="M95 72l9-11" fill="none" ' + S + '/><path d="M100 64q8-8 9 3" fill="#FFC98B" ' + S + '/></g>' + sound(112, 48);
    } else arms = hand('l', 23, 84, 9, 96, '#FFC98B') + hand('r', 97, 76, 111, 57, '#FFC98B');
    return wrap('maru', pose,
      // あたまの毛（ひとすじ）
      '<path class="mascot__tuft" d="M60 40c-2-10 4-18 12-20-4 4-5 10-3 16" fill="none" ' + S + '/>' +
      arms +
      '<circle cx="60" cy="80" r="40" fill="#FFC98B" ' + S + '/>' +
      '<path d="M88 97c-6 12-19 18-34 17" fill="none" stroke="#F2A86B" stroke-width="5" stroke-linecap="round"/>' +
      '<ellipse cx="44" cy="58" rx="8" ry="4.500" fill="#fff" fill-opacity=".55"/>' +
      cheeks(38, 82, 88) + eyes(pose, 47, 73, 77) + mouth(pose, 60, 86) +
      feet(119, '#FFC98B'));
  }

  /* ---------- はっぱ（はっぱちゃん） ---------- */
  function happa(pose) {
    var arms;
    if (pose === 'cheer') arms = hand('l', 26, 74, 10, 54, '#62C98B') + hand('r', 94, 74, 110, 54, '#62C98B');
    else if (pose === 'listen') {
      arms = hand('l', 25, 86, 10, 97, '#62C98B') +
        '<g class="mascot__arm mascot__arm--r"><path d="M93 74l9-11" fill="none" ' + S + '/><path d="M98 66q8-8 9 3" fill="#62C98B" ' + S + '/></g>' + sound(111, 50);
    } else arms = hand('l', 25, 86, 10, 97, '#62C98B') + hand('r', 95, 78, 110, 58, '#62C98B');
    return wrap('happa', pose,
      // 葉の軸（うしろ）
      '<path d="M60 114c0 8 1 13 3 17" fill="none" ' + S + '/>' +
      arms +
      // 葉の形：上がとがり、下がすぼまる
      '<path d="M60 8C84 22 104 50 100 80c-3 22-20 36-40 36S23 102 20 80C16 50 36 22 60 8z" fill="#62C98B" ' + S + '/>' +
      '<path d="M60 14v100" fill="none" stroke="#3FB173" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M60 40c-10 4-18 12-24 22M60 40c10 4 18 12 24 22M60 62c-9 4-16 10-21 18M60 62c9 4 16 10 21 18" fill="none" stroke="#3FB173" stroke-width="2.500" stroke-linecap="round"/>' +
      '<path d="M94 92c-6 10-18 18-32 18" fill="none" stroke="#3FB173" stroke-width="5" stroke-linecap="round" stroke-opacity=".6"/>' +
      '<ellipse cx="45" cy="86" rx="21" ry="15" fill="#62C98B"/>' +     // 顔のうしろは、葉脈を見せない
      '<ellipse cx="75" cy="86" rx="21" ry="15" fill="#62C98B"/>' +
      cheeks(39, 81, 92) + eyes(pose, 48, 72, 81) + mouth(pose, 60, 90) +
      feet(121, '#62C98B'));
  }

  /* ---------- フレンチブルドッグ（くろちゃん・しろちゃん） ---------- */
  function frebull(kind, pose) {
    var black = kind === 'kuro';
    var body = black ? '#4A4C60' : '#FFFFFF';
    var shade = black ? '#363848' : '#DCE8F0';
    var inner = '#FF9FB2';
    var arms, ears;
    if (pose === 'cheer') arms = hand('l', 30, 96, 12, 76, body) + hand('r', 90, 96, 108, 76, body);
    else if (pose === 'listen') {
      arms = hand('l', 30, 100, 14, 112, body) +
        '<g class="mascot__arm mascot__arm--r"><path d="M89 98l11-20" fill="none" ' + S + '/><path d="M98 72q8-8 9 3" fill="' + body + '" ' + S + '/></g>' + sound(112, 44);
    } else arms = hand('l', 30, 100, 14, 112, body) + hand('r', 90, 100, 108, 84, body);
    // 立った大きな耳（こうもりの羽のような、フレンチブルドッグの耳）。聞いているときは右の耳が少しかたむく
    var earL = '<path d="M27 46C14 36 12 14 24 6c14-8 28 8 28 28z" fill="' + body + '" ' + S + '/>' +
               '<path d="M31 40c-9-8-9-24-2-29 9-4 17 7 18 21z" fill="' + inner + '"/>';
    var earR = '<path d="M93 46c13-10 15-32 3-40-14-8-28 8-28 28z" fill="' + body + '" ' + S + '/>' +
               '<path d="M89 40c9-8 9-24 2-29-9-4-17 7-18 21z" fill="' + inner + '"/>';
    ears = earL + (pose === 'listen' ? '<g class="mascot__ear" transform="rotate(12 80 44)">' + earR + '</g>' : earR);
    return wrap(kind, pose,
      // からだ（うしろ）
      '<ellipse cx="60" cy="108" rx="34" ry="22" fill="' + body + '" ' + S + '/>' +
      (black ? '<path d="M50 96c6 6 14 6 20 0-2 10-8 16-10 20-2-4-8-10-10-20z" fill="#fff"/>' : '<path d="M88 112c-4 8-14 12-28 12" fill="none" stroke="' + shade + '" stroke-width="5" stroke-linecap="round"/>') +
      arms +
      ears +
      // あたま
      '<circle cx="60" cy="66" r="36" fill="' + body + '" ' + S + '/>' +
      '<path d="M92 76c-5 12-18 20-32 20" fill="none" stroke="' + shade + '" stroke-width="5" stroke-linecap="round"/>' +
      // ひたいのしわ
      '<path d="M50 44q10-5 20 0M52 36q8-4 16 0" fill="none" stroke="' + (black ? '#2E3040' : '#C9D6E0') + '" stroke-width="2.500" stroke-linecap="round"/>' +
      // 口もと（マズル）
      '<ellipse cx="60" cy="84" rx="19" ry="13" fill="' + (black ? '#5C5E74' : '#F4F7FA') + '" ' + S + '/>' +
      '<path d="M52 74a8 5.500 0 0 1 16 0q0 6-8 6t-8-6z" fill="' + INK + '"/>' +
      (pose === 'cheer' ? '<path d="M54 87h12q0 9-6 9t-6-9z" fill="#FF7A8C" ' + S + '/>' : '<path d="M60 80v5M50 86q5 6 10-1 5 7 10 1" fill="none" ' + S + '/>') +
      // 目（白い部分があるので、黒いからだでもよく見える）
      (pose === 'cheer'
        ? '<path d="M38 61q6-7 12 0M72 61q6-7 12 0" fill="none" stroke="' + (black ? '#fff' : INK) + '" stroke-width="3.500" stroke-linecap="round"/>'
        : '<circle cx="44" cy="62" r="6.500" fill="#fff" ' + S + '/><circle cx="76" cy="62" r="6.500" fill="#fff" ' + S + '/>' +
          '<circle cx="45" cy="63" r="3.200" fill="' + INK + '"/><circle cx="77" cy="63" r="3.200" fill="' + INK + '"/>') +
      cheeks(32, 88, 76) +
      feet(126, body));
  }

  function draw(kind, pose) {
    pose = pose === 'cheer' || pose === 'listen' ? pose : 'wave';
    if (kind === 'maru') return maru(pose);
    if (kind === 'happa') return happa(pose);
    if (kind === 'kuro' || kind === 'shiro') return frebull(kind, pose);
    return daikon(pose);
  }
  // 「設定」シートに書かれた名前（桜島大根 など）から、案内役の id を引く。知らない名前は桜島大根
  function byLabel(label) {
    var t = String(label == null ? '' : label).trim();
    for (var i = 0; i < LIST.length; i++) if (INFO[LIST[i]].label === t || LIST[i] === t) return LIST[i];
    return 'daikon';
  }

  root.KS_MASCOTS = { list: LIST, info: INFO, draw: draw, byLabel: byLabel, INK: INK };
})(typeof window !== 'undefined' ? window : this);
