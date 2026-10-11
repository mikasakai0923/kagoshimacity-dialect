/* かごしま ことばさんぽ — 絵（すべてこのサイト用に描いたSVG） */
(function () {
  'use strict';
  var KS = window.KS = window.KS || {};
  var INK = '#1D2B53';

  /* ---------- 小さな記号 ---------- */
  function icon(inner, filled) {
    return '<svg class="icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" ' +
      (filled ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"') +
      '>' + inner + '</svg>';
  }
  var CLOUD = 'M7 18.500a4.500 4.500 0 0 1-.600-8.960A6 6 0 0 1 18 10.600a4 4 0 0 1-.500 7.900z';
  KS.icons = {
    mic: icon('<path d="M12 3a3 3 0 0 0-3 3v5.500a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M5.500 11.500a6.500 6.500 0 0 0 13 0M12 18v3M8.500 21h7"/>'),
    stop: icon('<rect x="6.500" y="6.500" width="11" height="11" rx="2.200"/>', true),
    play: icon('<path d="M8.300 5.200a1 1 0 0 1 1.500-.900l10 6.800a1 1 0 0 1 0 1.700l-10 6.800a1 1 0 0 1-1.500-.800z"/>', true),
    pause: icon('<rect x="6.500" y="5.500" width="4" height="13" rx="1.300"/><rect x="13.500" y="5.500" width="4" height="13" rx="1.300"/>', true),
    redo: icon('<path d="M4.500 12a7.500 7.500 0 1 0 2.300-5.400"/><path d="M4.500 4.500v4.800h4.800"/>'),
    check: icon('<path d="M5 12.800l4.600 4.600L19 7.600"/>'),
    lock: icon('<rect x="5.500" y="10.500" width="13" height="9.500" rx="2.500"/><path d="M8.500 10.500V8a3.500 3.500 0 0 1 7 0v2.500"/>'),
    close: icon('<path d="M6.500 6.500l11 11M17.500 6.500l-11 11"/>'),
    menu: icon('<path d="M4.500 7h15M4.500 12h15M4.500 17h15"/>'),
    back: icon('<path d="M14.500 5.500L8 12l6.500 6.500"/>'),
    cloudOk: icon('<path d="' + CLOUD + '"/><path d="M9.300 13.400l2 2 3.600-3.800"/>'),
    cloudUp: icon('<path d="' + CLOUD + '"/><path d="M12 16.200v-5M9.700 13.200L12 10.900l2.300 2.300"/>'),
    cloudOff: icon('<path d="' + CLOUD + '"/><path d="M10 12.200l4 4M14 12.200l-4 4"/>'),
    warn: icon('<path d="M12 4.500l8.500 14.500h-17z"/><path d="M12 10v4M12 16.800v.200"/>'),
    help: icon('<circle cx="12" cy="12" r="8.500"/><path d="M9.600 9.600a2.500 2.500 0 1 1 3.700 2.200c-.800.500-1.300 1-1.300 1.900M12 16.700v.200"/>'),
    logout: icon('<path d="M10 4.500H6.500a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H10M14.500 8l4 4-4 4M18.500 12H9.500"/>'),
    arrow: icon('<path d="M4.500 12h14M13 6.500l5.500 5.500-5.500 5.500"/>'),
    pencil: icon('<path d="M4.500 19.500l1-4.200L16.300 4.500a1.800 1.800 0 0 1 2.600 0l.600.600a1.800 1.800 0 0 1 0 2.600L8.700 18.500z"/>'),
    ear: icon('<path d="M7 9.500a5 5 0 0 1 10 0c0 3-2.500 3.700-3.200 5.800-.500 1.600-1.300 3.200-3.300 3.200A2.500 2.500 0 0 1 8 16"/><path d="M10 10a2 2 0 0 1 4 0c0 1.200-1.500 1.500-1.800 2.800"/>')
  };

  /* ---------- 案内役（桜島大根） ---------- */
  KS.art = {};
  KS.art.daikon = function (pose) {
    pose = pose || 'wave';
    var s = 'stroke="' + INK + '" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"';
    var arms, face;
    if (pose === 'cheer') {
      arms = '<g class="daikon__arm daikon__arm--l"><path d="M23 76L9 58" fill="none" ' + s + '/><circle cx="8" cy="56" r="4.500" fill="#fff" ' + s + '/></g>' +
             '<g class="daikon__arm daikon__arm--r"><path d="M97 76l14-18" fill="none" ' + s + '/><circle cx="112" cy="56" r="4.500" fill="#fff" ' + s + '/></g>';
      face = '<path d="M42 78q5-6 10 0M68 78q5-6 10 0" fill="none" ' + s + '/>' +
             '<path d="M52 85h16q-1 10-8 10t-8-10z" fill="#FF7A8C" ' + s + '/>';
    } else if (pose === 'listen') {
      arms = '<g class="daikon__arm daikon__arm--l"><path d="M22 86L10 96" fill="none" ' + s + '/><circle cx="9" cy="97" r="4.500" fill="#fff" ' + s + '/></g>' +
             '<g class="daikon__arm daikon__arm--r"><path d="M96 74l9-11" fill="none" ' + s + '/><path d="M101 66q8-8 9 3" fill="#fff" ' + s + '/></g>' +
             '<g class="daikon__sound" fill="none" stroke="#2AA9C9" stroke-width="3.500" stroke-linecap="round"><path d="M112 50q5 8 0 16"/><path d="M118 43q9 15 0 30"/></g>';
      face = '<circle cx="47" cy="77" r="3.800" fill="' + INK + '"/><circle cx="73" cy="77" r="3.800" fill="' + INK + '"/>' +
             '<path d="M55 87q5 4 10 0" fill="none" ' + s + '/>';
    } else {
      arms = '<g class="daikon__arm daikon__arm--l"><path d="M22 86L10 96" fill="none" ' + s + '/><circle cx="9" cy="97" r="4.500" fill="#fff" ' + s + '/></g>' +
             '<g class="daikon__arm daikon__arm--r"><path d="M98 78l13-17" fill="none" ' + s + '/><circle cx="112" cy="59" r="4.500" fill="#fff" ' + s + '/></g>';
      face = '<circle cx="47" cy="77" r="3.800" fill="' + INK + '"/><circle cx="73" cy="77" r="3.800" fill="' + INK + '"/>' +
             '<path d="M53 86q7 7 14 0" fill="none" ' + s + '/>';
    }
    return '<svg class="daikon daikon--' + pose + '" viewBox="0 0 122 132" aria-hidden="true" focusable="false">' +
      '<g class="daikon__leaves">' +
        '<path d="M57 47C42 41 31 27 30 12c14 2 24 17 28 33z" fill="#3FB173" ' + s + '/>' +
        '<path d="M63 47c15-6 26-20 27-35-14 2-24 17-28 33z" fill="#3FB173" ' + s + '/>' +
        '<path d="M60 47C50 33 52 12 60 4c8 8 10 29 0 43z" fill="#62C98B" ' + s + '/>' +
      '</g>' +
      '<path d="M53 111c2 8 5 15 8 18 2-4 4-10 6-18z" fill="#fff" ' + s + '/>' +
      arms +
      '<ellipse cx="60" cy="80" rx="42" ry="36" fill="#fff" ' + s + '/>' +
      '<path d="M91 91c-6 13-21 20-38 19" fill="none" stroke="#DCE8F0" stroke-width="5" stroke-linecap="round"/>' +
      '<ellipse cx="37" cy="88" rx="5.500" ry="3.200" fill="#FF9FB2"/><ellipse cx="83" cy="88" rx="5.500" ry="3.200" fill="#FF9FB2"/>' +
      face +
      '<ellipse cx="46" cy="119" rx="9" ry="5" fill="#FF9A2E" ' + s + '/>' +
      '<ellipse cx="74" cy="119" rx="9" ry="5" fill="#FF9A2E" ' + s + '/>' +
    '</svg>';
  };

  /* ---------- 桜島。けむりの数＝歩いた歩数 ---------- */
  // puffs: 見せるけむりの数, total: 全部の歩数, fresh: 今ふえたけむり（動かす）
  function puffPoints(total) {
    total = Math.max(1, Math.min(total, 10));
    var pts = [];
    for (var i = 0; i < total; i++) {
      var t = i / (Math.max(total, 6) - 1);       // 歩数が少ないときは、火口の近くにまとめる
      // 火口から右上へのぼり、風に流されていく曲線
      var x = 226 + 104 * t + 6 * Math.sin(t * 3.1);
      var y = 46 - 34 * Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.62) + 26 * t * t;
      var r = 10 + 7 * Math.sin((0.15 + t * 0.85) * Math.PI * 0.8);
      pts.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, r: Math.round(r * 10) / 10 });
    }
    return pts;
  }
  var clipSeq = 0;
  var MOUNTAIN = 'M22 138 68 104c22-17 38-36 58-49 12-8 24-8 33 1 7 7 13 8 22-1 10-10 23-13 34-6 9 6 13 16 22 27l33 30c18 15 38 26 60 32z';
  function sakurajimaBody() {
    var s = 'stroke="' + INK + '" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"';
    var id = 'ks-mt-' + (++clipSeq);
    return '' +
      '<clipPath id="' + id + '"><path d="' + MOUNTAIN + '"/></clipPath>' +
      '<path d="' + MOUNTAIN + '" fill="#8C8079"/>' +
      '<g clip-path="url(#' + id + ')">' +
        '<path d="M0 140V118c36-12 74-14 112-8s78 12 118 4 76-6 110 8v18z" fill="#5FB07F"/>' +
        '<path d="M126 55c-4 14-13 26-22 37M159 56c2 12-3 24-8 36M181 55c5 12 12 22 12 36M215 49c2 13 10 24 19 34" fill="none" stroke="#B5ABA4" stroke-width="3" stroke-linecap="round"/>' +
      '</g>' +
      '<path d="' + MOUNTAIN + '" fill="none" ' + s + '/>';
  }
  function puffsSvg(puffs, total, fresh) {
    var pts = puffPoints(total), out = '';
    for (var i = pts.length - 1; i >= 0; i--) {
      var p = pts[i], on = i < puffs;
      out += '<circle class="puff' + (on ? ' puff--on' : '') + (on && fresh && i === puffs - 1 ? ' puff--new' : '') + '" cx="' + p.x + '" cy="' + p.y + '" r="' + p.r + '" ' +
        (on ? 'fill="#fff" stroke="' + INK + '" stroke-width="3.500"' : 'fill="#fff" fill-opacity=".55" stroke="#9FB4C4" stroke-width="2.500" stroke-dasharray="3 5" stroke-linecap="round"') + '/>';
    }
    return out;
  }
  function seaSvg(y, w) {
    return '<path d="M0 ' + y + 'h' + w + 'v60H0z" fill="#2AA9C9"/>' +
      '<path d="M0 ' + y + 'h' + w + '" stroke="' + INK + '" stroke-width="3.500"/>' +
      '<path d="M26 ' + (y + 14) + 'q8-6 16 0t16 0M' + (w * 0.42) + ' ' + (y + 20) + 'q8-6 16 0t16 0M' + (w * 0.74) + ' ' + (y + 12) + 'q8-6 16 0t16 0" fill="none" stroke="#BDE6F1" stroke-width="3" stroke-linecap="round"/>';
  }
  KS.art.sakurajima = function (puffs, total, fresh) {
    return '<svg class="sakurajima" viewBox="0 0 372 170" aria-hidden="true" focusable="false">' +
      puffsSvg(puffs, total, fresh) + sakurajimaBody() + seaSvg(138, 372) + '</svg>';
  };

  /* ---------- 紹介ページの絵 ---------- */
  KS.art.hero = function () {
    var s = 'stroke="' + INK + '" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"';
    function tile(x, y, fill, rot) {
      return '<g transform="translate(' + x + ' ' + y + ') rotate(' + rot + ')"><rect x="-23" y="-17" width="46" height="34" rx="10" fill="' + INK + '"/>' +
        '<rect x="-23" y="-22" width="46" height="34" rx="10" fill="' + fill + '" ' + s + '/></g>';
    }
    var daikon = KS.art.daikon('wave').replace('<svg class="daikon daikon--wave" viewBox="0 0 122 132"', '<svg x="196" y="170" width="92" height="100" viewBox="0 0 122 132"');
    return '<svg class="hero-art" viewBox="0 0 390 300" role="img" aria-label="すごろくの道を歩いて桜島へ向かう、桜島大根の案内役">' +
      '<circle cx="54" cy="52" r="24" fill="#FFD84D" ' + s + '/>' +
      '<path d="M96 96a13 13 0 0 1 2-26 18 18 0 0 1 34-2 14 14 0 0 1 4 28z" fill="#fff" ' + s + '/>' +
      '<g transform="translate(9 18)">' + puffsSvg(6, 6, false) + sakurajimaBody() + '</g>' +
      '<path d="M0 156h390v60H0z" fill="#2AA9C9"/><path d="M0 156h390" ' + s + '/>' +
      '<path d="M30 172q8-6 16 0t16 0M150 180q8-6 16 0t16 0M300 170q8-6 16 0t16 0" fill="none" stroke="#BDE6F1" stroke-width="3" stroke-linecap="round"/>' +
      // フェリー
      '<g transform="translate(96 150)"><path d="M0 12h74l-8 16H8z" fill="#fff" ' + s + '/><path d="M14 12V0h40v12" fill="#fff" ' + s + '/><path d="M22 6h6M34 6h6M46 6h1" ' + s + '/><path d="M5 19h66" stroke="#FF9A2E" stroke-width="4"/></g>' +
      // 手前の岸と、すごろくの道
      '<path d="M0 206c60-14 120-8 190-4s140-10 200-2v100H0z" fill="#CFEFD9"/>' +
      '<path d="M0 206c60-14 120-8 190-4s140-10 200-2" fill="none" ' + s + '/>' +
      '<path d="M36 268C96 236 150 282 208 252s98-6 150-26" fill="none" stroke="#fff" stroke-width="15" stroke-linecap="round"/>' +
      '<path d="M36 268C96 236 150 282 208 252s98-6 150-26" fill="none" stroke="' + INK + '" stroke-width="3" stroke-dasharray="2 12" stroke-linecap="round"/>' +
      tile(52, 262, '#37B679', -8) + tile(132, 262, '#37B679', 6) + tile(326, 236, '#C9CEDA', -6) + tile(242, 250, '#FF9A2E', -4) +
      daikon +
    '</svg>';
  };

  /* ---------- 歩のマスに押す「済」のしるし ---------- */
  KS.art.stamp = '<svg viewBox="0 0 40 40" aria-hidden="true" focusable="false"><circle cx="20" cy="20" r="16" fill="#fff" stroke="' + INK + '" stroke-width="3.500"/><path d="M12 20.500l5.500 5.500L28.500 14.500" fill="none" stroke="#37B679" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* ---------- ふりだしの旗・あがりの旗 ---------- */
  KS.art.flag = function (fill) {
    return '<svg viewBox="0 0 40 44" aria-hidden="true" focusable="false"><path d="M10 6v34" stroke="' + INK + '" stroke-width="4" stroke-linecap="round"/>' +
      '<path d="M10 7c8-5 12 4 22-1v15c-10 5-14-4-22 1z" fill="' + fill + '" stroke="' + INK + '" stroke-width="3.500" stroke-linejoin="round"/></svg>';
  };
})();
