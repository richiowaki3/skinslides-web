class VideoPlayer {
    constructor(elementId, isHiddenAudioOnly = false) {
        this.videoEl = document.getElementById(elementId);
        this.isHiddenAudioOnly = isHiddenAudioOnly;
        
        // 第4画面（音声専門）以外はミュートにしておく
        this.videoEl.muted = !isHiddenAudioOnly; 
    }

    playSequence(fileName, waitDelaySec = 0) {
        return new Promise((resolve) => {
            // 動画ファイルをアサイン
            this.videoEl.src = VIDEO_BASE_PATH + fileName;
            
            // 再生開始
            this.videoEl.play().catch(e => {
                console.error(`再生エラー [${fileName}]: 動画が見つからないかパスが違います。`, e);
                // 失敗した場合はエラーを出して即座に終了扱い（シーケンスを止めないため）
                resolve(); 
            });

            // 動画が自身で最後まで再生しきったタイミング
            this.videoEl.onended = () => {
                if (!this.isHiddenAudioOnly) {
                    this.videoEl.src = ""; // 物理的に黒画面にして沈黙を生む
                }
                
                // --- フィボナッチ待機（余韻フェーズ） ---
                if (waitDelaySec > 0) {
                    setTimeout(() => resolve(), waitDelaySec * 1000);
                } else {
                    resolve();
                }
            };
        });
    }
}
