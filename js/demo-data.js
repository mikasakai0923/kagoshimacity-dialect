/* かごしま ことばさんぽ — お試しモード用の見本データ（実際の調査項目ではありません） */
(function () {
  'use strict';
  var KS = window.KS = window.KS || {};

  KS.DEMO = {
    settings: {
      instruction: 'あなたの自然な方言（小学校のころの同級生など、親しい人と話す時のことば）で何というか教えてください。',
      wordQuestion: '「{語}」のことをなんといいますか？',
      sentenceQuestion: '「{文}」をなんといいますか？',
      notice: '',
      maxRecordSec: 30
    },
    steps: [
      { no: 1, title: '鹿児島中央駅', icon: 'station', count: 3 },
      { no: 2, title: '桜島', icon: 'volcano', count: 2 }
    ],
    items: [
      { id: 'S001', type: '語彙', step: 1, order: 1, prompt: '頭', context: '読み：あたま', example: '', segments: [], art: 'head' },
      { id: 'S002', type: '例文', step: 1, order: 2, prompt: '頭が痛い。', context: '', example: '', segments: ['頭が', '痛い'], art: 'head' },
      { id: 'S003', type: '語彙', step: 1, order: 3, prompt: '目', context: '読み：め', example: '目が大きい。', segments: [], art: 'eye' },
      { id: 'S004', type: '例文', step: 2, order: 1, prompt: '雨が降っている。', context: '外を見て知らせる。', example: '', segments: ['雨が', '降っている'], art: 'rain umbrella' },
      { id: 'S005', type: '例文', step: 2, order: 2, prompt: '猫が魚を食べた。', context: '', example: '', segments: ['猫が', '魚を', '食べた'], art: 'cat fish' }
    ]
  };
})();
