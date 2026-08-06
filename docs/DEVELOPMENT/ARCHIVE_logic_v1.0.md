# skinslides Intelligent Logic Implementation (Ver 1.0)

このドキュメントは、生成された軽量なメタデータ（`logic_weights.json`）を読み込み、緻密なアルゴリズムで動画を選択・待機・再生するための3つのコアファイル（`index.html`, `player.js`, `logic.js`）の実装設計コードです。  
※本コードをご自身の開発環境内の該当ファイルにコピー＆ペースト（または上書き）してご活用ください。

## 1. `index.html` (見えない第4画面の追加)
HTMLには、表示用の3つのビデオ要素に加えて、音声のみを鳴らす「非表示のPlayer 4」を追加します。

```html
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <title>skinslides - Ambient Video Player</title>
    <style>
        body {
            /* 全画面黒背景・中央揃え */
            margin: 0;
            background-color: #000;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            overflow: hidden;
        }
        .screen-container {
            display: flex;
            gap: 20px;
        }
        .screen {
            /* 動画のアスペクト比に合わせて調整してください */
            width: 320px;
            height: 568px; 
            background-color: #000;
            object-fit: contain;
        }
        /* Player 4 はDOM上に存在するが表示しない（同期と音声ハプニング専用） */
        #player-4 {
            display: none;
        }
        /* スタートボタンのオーバーレイ */
        #start-overlay {
            position: absolute;
            top: 0; left: 0;
            width: 100%; height: 100%;
            background: rgba(0,0,0,0.8);
            color: white;
            display: flex;
            justify-content: center;
            align-items: center;
            font-size: 24px;
            z-index: 100;
            cursor: pointer;
            font-family: sans-serif;
            letter-spacing: 2px;
        }
    </style>
</head>
<body>
    <!-- ブラウザの自動再生ブロックを回避するための開始ボタン -->
    <div id="start-overlay">クリックして再生開始</div>

    <!-- 可視の3画面（映像用・基本ミュート） -->
    <div class="screen-container">
        <video id="player-1" class="screen" muted playsinline></video>
        <video id="player-2" class="screen" muted playsinline></video>
        <video id="player-3" class="screen" muted playsinline></video>
    </div>
    
    <!-- 不可視の第4画面（音声のみ・ミュート解除前提） -->
    <video id="player-4" playsinline></video>

    <!-- 映像素材の場所に合わせてパスは調整してください -->
    <script>const VIDEO_BASE_PATH = "videos/";</script>
    <script src="player.js"></script>
    <script src="logic.js"></script>
</body>
</html>
```

---

## 2. `player.js` (再生と休符のPromise制御)
動画の再生と、それに続く「フィボナッチ数列に基づく待機（沈黙）時間」までを1つの `Promise` としてラップし、ロジック側で制御しやすくします。

```javascript
// player.js: 動画プレーヤーの非同期制御ラッパー

class VideoPlayer {
    constructor(elementId, isHiddenAudioOnly = false) {
        this.videoEl = document.getElementById(elementId);
        this.isHiddenAudioOnly = isHiddenAudioOnly;
        
        // 第4画面以外はミュートにする
        /* 
           ※ブラウザ仕様として、ユーザーアクション前の音声再生はブロックされます。
           第4画面（音声あり）は必ずユーザーが画面をクリックした後に発火させます。
        */
        this.videoEl.muted = !isHiddenAudioOnly; 
    }

    /**
     * 動画を再生し、再生終了と指定された待機期間（休符）が終わるまでブロックする
     * @param {string} fileName - 読み込む動画のファイル名
     * @param {number} waitDelaySec - 再生終了後、黒画面にして待つ秒数
     * @returns {Promise<void>} 映像終了＋待機完了でResolve
     */
    playSequence(fileName, waitDelaySec = 0) {
        return new Promise((resolve) => {
            // パスを設定して動画をロード
            this.videoEl.src = VIDEO_BASE_PATH + fileName;
            
            // 再生開始（エラー時は強制スキップしてシーケンスを止めない）
            this.videoEl.play().catch(e => {
                console.error(`Play error [${fileName}]:`, e);
                resolve(); 
            });

            // 動画自体の再生が完了したときに自動発火
            this.videoEl.onended = () => {
                // 可視画面ならソースを空にして「完全な黒画面（沈黙）」を作る
                if (!this.isHiddenAudioOnly) {
                    this.videoEl.src = ""; 
                }
                
                // 【余韻フェーズ】フィボナッチ待機の処理
                if (waitDelaySec > 0) {
                    setTimeout(() => {
                        resolve(); // 指定秒数待ってからシーケンス（タスク）完了
                    }, waitDelaySec * 1000);
                } else {
                    resolve(); // 待機ゼロなら即座に完了
                }
            };
        });
    }
}
```

---

## 3. `logic.js` (インテリジェント動画選択・同期アルゴリズム)
ここがコアエンジンです。軽量化された `logic_weights.json`（配列情報）を利用し、「不可視の第4画面の同期（Promise.all）」「フィボナッチを用いた決定論的休符」「前の姿勢の連続を避ける文脈的選択」をすべて統合しています。

```javascript
// logic.js: skinslides Intelligent Sequence Logic

// logic_weights.json の配列インデックス定義
// [0: fname, 1: duration, 2: posture, 3: direction, 4: weight, 5: time, 6: space, 7: hardness]
const IDX = { FNAME: 0, DUR: 1, POS: 2, DIR: 3, WEIGHT: 4, TIME: 5, SPACE: 6, HARD: 7 };

// フィボナッチ数列（待機時間ジェネレーター: 1秒〜最大21秒のブランク）
const FIBONACCI = [1, 2, 3, 5, 8, 13, 21];

let metadataPool = [];
let players = [];
let previousSelections = [null, null, null, null]; // 各画面に直前割り当てられた動画情報
let cycleCount = 0;

// アプリの初期化とデータロード（ユーザーのクリックで発火）
async function initSkinslides() {
    // 1. DOMからスタート用オーバーレイを消す
    document.getElementById('start-overlay').style.display = 'none';

    // 2. プレイヤーインスタンス生成 (インデックス3の player-4 は音声専用)
    players = [
        new VideoPlayer("player-1"),
        new VideoPlayer("player-2"),
        new VideoPlayer("player-3"),
        new VideoPlayer("player-4", true) 
    ];

    // 3. メタデータ（重み付けベクトル配列）の取得
    try {
        const res = await fetch('logic_weights.json');
        metadataPool = await res.json();
        console.log(`Loaded ${metadataPool.length} video logic weights.`);
        
        // メインシーケンス開始（無限ループへ）
        runGlobalSequence();
    } catch (e) {
        console.error("Failed to load logic_weights.json. JSONのパスを確認してください。", e);
    }
}

/**
 * ベクトルと過去の文脈に基づき、最適な動画を選択する
 * @param {number} playerIndex - 0:Player1 ~ 3:Player4
 * @returns {Array} 選択された1行の動画データ配列
 */
function selectIntelligentVideo(playerIndex) {
    const prev = previousSelections[playerIndex];
    let candidates = [...metadataPool];

    // 【実装要件2】純粋なランダムを排除したインテリジェント・セレクト
    if (prev) {
        // [ルールA] 直前の動画と同じ「姿勢(posture)」が連続しないようにフィルタリング
        const prevPosture = prev[IDX.POS];
        let filtered = candidates.filter(v => v[IDX.POS] !== prevPosture);
        
        // [ルールB] 前の動作が重かった(Hardness>5)場合、空間が広がる(Space)動画を優先して繋ぐ
        const prevHardness = prev[IDX.HARD];
        if (prevHardness > 5) {
            // Space（広がり）スコアが高い順にソートし、上位30%の強烈な動画にのみ絞る
            filtered.sort((a, b) => b[IDX.SPACE] - a[IDX.SPACE]);
            filtered = filtered.slice(0, Math.max(1, Math.floor(filtered.length * 0.3)));
        }

        // 候補が極端に少なすぎる（5以下）場合は、安全のためフィルタリングを緩める
        if (filtered.length > 5) {
            candidates = filtered;
        }
    }

    // 絞り込まれた文脈的候補の中から確定
    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    
    // 状態を記憶して次のサイクルの文脈に活かす
    previousSelections[playerIndex] = selected;
    return selected;
}

/**
 * 4画面の同期・待機サイクルを無限に回すメインループ
 */
async function runGlobalSequence() {
    while (true) {
        cycleCount++;
        console.log(`\n--- Starting Sequence Cycle ${cycleCount} ---`);

        // 4画面分の非同期タスク(Promise)を格納する箱
        let syncTasks = [];

        for (let i = 0; i < 4; i++) {
            const videoData = selectIntelligentVideo(i);
            const fileName = videoData[IDX.FNAME];
            const weightScore = videoData[IDX.WEIGHT];   // 重さ・激しさ (0-9)
            const hardnessScore = videoData[IDX.HARD];   // 接地の多さ (0-9)

            // 【実装要件3】フィボナッチ数列を用いたハプニング時間の制御
            // ここでは「Weight（激しさ）」のスコアをフィボナッチのインデックスに変換。
            // 激しい動画（Weightが高い）ほど、再生終了後の「余韻・ブランク」を長く取る。
            // 最大値(=9)を与えても数列の長さを超えないように Math.min でクリップ。
            const fibIndex = Math.min(weightScore, FIBONACCI.length - 1);
            const pauseDelays = FIBONACCI[fibIndex]; // これにより 1秒, 2秒, 3秒, 5秒.. などの決定論的待機が生まれる

            console.log(`[Player ${i+1}] Chosen: ${fileName} | Weight: ${weightScore} -> Wait: ${pauseDelays}s`);

            // タスク発火（再生＋待機が終わるまでResolveされないPromise）
            const playTask = players[i].playSequence(fileName, pauseDelays);
            syncTasks.push(playTask);
        }

        // 【実装要件1】不可視の第4画面と同期・ハプニングロジック
        // 4つすべてのプレイヤー（音声含む）の「映像再生」および「フィボナッチ余韻」が
        // 完全に終わるまで、この行で処理が一時停止(await)する。
        // これにより、早く終わった画面は長い沈黙（黒画面）となり、空間に意図的な間やフリーズが生じる。
        await Promise.all(syncTasks);

        console.log(`--- Sequence Cycle ${cycleCount} Finished. All players synced. ---`);
    }
}

// ユーザーアクション（クリック）をイベントリスナーに登録
// （1回目のクリックでのみ発火するよう { once: true } を指定）
document.getElementById('start-overlay').addEventListener('click', initSkinslides, { once: true });
```
