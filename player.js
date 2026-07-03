window.freezeFramesPool = {};
window.videoPausePer = 100; // デフォルトで100%発生
window.videosMuted = false;  // 動画の音声をデフォルトでON（ミュート解除）
window.videoGainVolume = 1.0; // 動画の音量ゲイン（初期値 1.0）
window.VIDEO_CACHE_BUST = "?v=2"; // キャッシュ破棄用クエリ（音付き・コントラスト修正動画反映用）

// pauseTime.xml からフリーズフレーム情報をロードして秒数に変換
window.loadFreezeFrames = async function() {
    try {
        const res = await fetch("pauseTime.xml");
        const text = await res.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, "text/xml");
        const movieNode = xmlDoc.getElementsByTagName("MOVIE")[0];
        if (!movieNode) {
            console.warn("[player] MOVIE tag not found in pauseTime.xml");
            return;
        }
        
        const children = movieNode.children;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const tagName = child.tagName.toLowerCase(); // 例: "s05.mov"
            const match = tagName.match(/s(\d+)\.mov/);
            if (match) {
                const videoNumStr = match[1];
                const videoKey = `${videoNumStr}.mov`;
                
                const pauseNodes = child.getElementsByTagName("PAUSE");
                const pauseTimes = [];
                for (let j = 0; j < pauseNodes.length; j++) {
                    const frameNum = parseInt(pauseNodes[j].textContent, 10);
                    if (frameNum > 0) {
                        pauseTimes.push(frameNum / 30.0); // 30fpsとしてフレーム番号を秒数に変換
                    }
                }
                if (pauseTimes.length > 0) {
                    window.freezeFramesPool[videoKey] = pauseTimes;
                }
            }
        }
        console.log(`[player] Loaded freeze frames for ${Object.keys(window.freezeFramesPool).length} videos.`);
    } catch (e) {
        console.warn("[player] Failed to load pauseTime.xml. Freeze frames will be disabled.", e);
    }
};

window.videoFiles = [
    "01.mov", "02.mov", "03.mov", "04.mov", "05.mov", "06.mov", "07.mov", "08.mov", 
    "09.mov", "10.mov", "11.mov", "12.mov", "13.mov", "14.mov", "15.mov", "16.mov", 
    "17.mov", "18.mov"
];

window.videoBlobCache = {}; // filename -> blob URL / direct URL fallback

window.preloadAllVideos = async function(basePath, onProgress) {
    let loadedCount = 0;
    const totalCount = window.videoFiles.length;
    
    const promises = window.videoFiles.map(async (file) => {
        let finalFileName = file;
        const match = file.match(/(\d+)\.(mov|mp4)/i);
        if (match) {
            finalFileName = `${match[1]}-Sss720p.mp4`;
        }
        const url = basePath + finalFileName + (window.VIDEO_CACHE_BUST || "");
        
        try {
            const res = await fetch(url, { mode: 'cors' });
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            const blob = await res.blob();
            const blobUrl = URL.createObjectURL(blob);
            window.videoBlobCache[file] = blobUrl;
            loadedCount++;
            if (onProgress) onProgress(loadedCount, totalCount);
        } catch (e) {
            console.warn(`[player] Failed to preload video blob for ${file}:`, e);
            // CORS等のエラー時は直接URLで再生するフォールバック
            window.videoBlobCache[file] = url;
            loadedCount++;
            if (onProgress) onProgress(loadedCount, totalCount);
        }
    });
    
    await Promise.all(promises);
    console.log(`[player] Preloaded ${Object.keys(window.videoBlobCache).length} video blobs.`);
};

class VideoPlayer {
    constructor(elementId, isHiddenAudioOnly = false) {
        this.elementId = elementId;
        this.isHiddenAudioOnly = isHiddenAudioOnly;
        this.mediaEl = document.getElementById(elementId);
        
        if (this.mediaEl && !isHiddenAudioOnly) {
            // Web Audio API でのゲイン増幅（CORS制限対策。VIDEO_CACHE_BUST と併用することでキャッシュ競合を回避）
            this.mediaEl.crossOrigin = "anonymous";
            
            // CORSエラー監視: 万が一R2のCORS設定不足でブロックされた場合は、動画を表示させるためにDOM要素をクローンして通常再生へフォールバック
            this.mediaEl.addEventListener('error', (e) => {
                const err = this.mediaEl.error;
                if (err && (err.code === 4 || err.code === 3) && this.mediaEl.crossOrigin === "anonymous") {
                    this.handleCorsError();
                }
            });
        }

        // 音声専用プレイヤーは常にミュート解除、動画プレイヤーは window.videosMuted に従う
        if (this.mediaEl) {
            this.mediaEl.muted = isHiddenAudioOnly ? false : window.videosMuted; 
        }
        
        // 状態管理用
        this.isLocked = false;
        this.activeResolve = null;
        this.timeUpdateHandler = null;
        this.fadeInterval = null;
        this.fadeTimeout = null;
        
        // フリーズフレーム用
        this.freezeAnimationId = null;
        this.freezeTimeout = null;
        this.freezeTimes = null;
        this.triggeredFreezes = null;

        // 連続トリガー防止ロック用
        this.lockTimeout = null;

        // 分析モニター用の状態変数
        this.currentVideoData = null;
        this.currentRotationAngle = 90;
        this.currentFlowDir = 1;

        // Web Audio API関連
        this.audioCtx = null;
        this.source = null;
        this.gainNode = null;
        this.useWebAudio = !isHiddenAudioOnly; // 動画プレイヤーはWeb Audioを使用（エラー時はfalseへ）
    }

    // 互換性維持のためのダミーメソッド（DOMを破棄せず、Web Audio Contextを初期化するのみ）
    initializePool(basePath) {
        if (this.isHiddenAudioOnly) return;
        this.initAudioContext();
        console.log(`[player] Initialized single media element with Web Audio for screen ${this.elementId}.`);
    }

    // ミュート状態を動的に変更
    setMute(isMuted) {
        if (this.mediaEl) {
            this.mediaEl.muted = isMuted;
        }
    }

    // ゲインボリュームを動的に変更 (Web Audio API or HTML5 fallback)
    setGain(value) {
        if (this.isHiddenAudioOnly || !this.mediaEl) return;
        if (this.useWebAudio && this.gainNode) {
            this.gainNode.gain.setValueAtTime(value, this.audioCtx.currentTime);
        } else {
            // Web Audio無効時はHTML5標準ボリューム（最大1.0）
            this.mediaEl.volume = Math.min(1.0, value);
        }
    }

    // CORSエラー時の安全なフォールバック処理 (DOM要素をクローンして再生成)
    handleCorsError() {
        if (!this.useWebAudio) return;
        this.useWebAudio = false;

        const screenNum = this.elementId.split('-').pop();
        console.warn(`[player] CORS error detected on Screen ${screenNum}. Re-creating element to fallback to standard volume...`);
        if (window.addDecisionLog) {
            window.addDecisionLog(`Screen ${screenNum}: CORS block from server. Re-creating video element to bypass block. Gain boost disabled (clamped to 1.0x).`, 'warning');
        }

        const oldEl = this.mediaEl;
        const newEl = oldEl.cloneNode(true);
        newEl.removeAttribute("crossorigin"); // CORS要求を解除

        // 再度エラーイベントハンドラを登録（CORS以外のロードエラー検知用）
        newEl.addEventListener('error', (e) => {
            console.error(`[player] Screen ${screenNum} fallback element load error:`, newEl.error);
        });

        oldEl.parentNode.replaceChild(newEl, oldEl);
        this.mediaEl = newEl;

        // Web Audio接続を無効化
        this.audioCtx = null;
        this.source = null;
        this.gainNode = null;

        // 再ロード
        const currentSrc = oldEl.src;
        this.mediaEl.src = currentSrc;
        this.mediaEl.load();
        
        // 再生再開（再生中だった場合）
        if (oldEl.className.includes("playing")) {
            this.mediaEl.play().catch(err => {
                console.error(`[player] Screen ${screenNum} fallback play failed:`, err);
            });
        }
    }

    // Web Audio Context の遅延初期化
    initAudioContext() {
        if (this.isHiddenAudioOnly || !this.useWebAudio || !this.mediaEl) return;
        if (this.gainNode) {
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                this.audioCtx.resume();
            }
            return;
        }

        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;

            this.audioCtx = new AudioContextClass();
            this.source = this.audioCtx.createMediaElementSource(this.mediaEl);
            this.gainNode = this.audioCtx.createGain();

            this.source.connect(this.gainNode);
            this.gainNode.connect(this.audioCtx.destination);

            // グローバル音量ゲインを適用
            const currentGain = window.videoGainVolume !== undefined ? window.videoGainVolume : 1.0;
            this.gainNode.gain.setValueAtTime(currentGain, this.audioCtx.currentTime);
            console.log(`[player] Web Audio Gain initialized for ${this.mediaEl.id} with gain ${currentGain}`);
        } catch (e) {
            console.warn(`[player] Web Audio Gain init failed for ${this.mediaEl.id}:`, e);
            this.useWebAudio = false;
        }
    }

    // 従来のオーディオ再生用メソッド
    playSequence(fileName, waitDelaySec = 0) {
        this.stop();
        if (!this.mediaEl) return Promise.resolve();

        return new Promise((resolve) => {
            this.activeResolve = resolve;
            
            let finalFileName = fileName;
            if (!this.isHiddenAudioOnly) {
                const match = fileName.match(/(\d+)\.(mov|mp4)/i);
                if (match) {
                    finalFileName = `${match[1]}-Sss720p.mp4`;
                }
            }
            
            const basePath = this.isHiddenAudioOnly ? AUDIO_BASE_PATH : VIDEO_BASE_PATH;
            const blobUrl = window.videoBlobCache[fileName] || (basePath + finalFileName + (window.VIDEO_CACHE_BUST || ""));
            
            this.mediaEl.src = blobUrl;
            this.mediaEl.volume = Math.min(1.0, window.videoGainVolume !== undefined ? window.videoGainVolume : 1.0);
            this.initAudioContext();
            
            this.mediaEl.play().then(() => {
                if (!this.isHiddenAudioOnly) {
                    this.mediaEl.classList.add("playing");
                    this.mediaEl.style.opacity = 1;
                    this.startFreezeMonitor(fileName);
                }
            }).catch(e => {
                console.error(`再生エラー [${fileName}]:`, e);
                resolve(); 
            });

            this.mediaEl.onended = () => {
                if (!this.isHiddenAudioOnly) {
                    this.mediaEl.classList.remove("playing");
                    this.mediaEl.src = "";
                }
                
                if (waitDelaySec > 0) {
                    this.fadeTimeout = setTimeout(() => resolve(), waitDelaySec * 1000);
                } else {
                    resolve();
                }
            };
        });
    }

    // レベル 1: 静かで変化が少ない（最後のフレームでフリーズして待機）
    playLevel1(fileName) {
        this.stop();
        if (!this.mediaEl) return Promise.resolve();

        return new Promise((resolve) => {
            this.activeResolve = resolve;
            
            let finalFileName = fileName;
            const match = fileName.match(/(\d+)\.(mov|mp4)/i);
            if (match) {
                finalFileName = `${match[1]}-Sss720p.mp4`;
            }
            
            const basePath = VIDEO_BASE_PATH;
            const blobUrl = window.videoBlobCache[fileName] || (basePath + finalFileName + (window.VIDEO_CACHE_BUST || ""));
            
            this.mediaEl.src = blobUrl;
            this.mediaEl.volume = Math.min(1.0, window.videoGainVolume !== undefined ? window.videoGainVolume : 1.0);
            this.mediaEl.style.opacity = 1;
            this.mediaEl.classList.add("playing");
            this.initAudioContext();
            
            this.mediaEl.play().then(() => {
                this.startFreezeMonitor(fileName);
            }).catch(e => {
                console.error(`L1再生エラー [${fileName}]:`, e);
                resolve();
            });

            this.timeUpdateHandler = () => {
                if (this.mediaEl.duration && this.mediaEl.currentTime >= this.mediaEl.duration - 0.1) {
                    this.mediaEl.pause();
                    this.mediaEl.removeEventListener('timeupdate', this.timeUpdateHandler);
                    this.timeUpdateHandler = null;
                    resolve();
                }
            };
            this.mediaEl.addEventListener('timeupdate', this.timeUpdateHandler);
        });
    }

    // レベル 2: やや動きがある（最初のフレームでフリーズ＆フェードイン、再生、最後のフレームでフリーズ＆フェードアウト）
    playLevel2(fileName, fadeTimeSec) {
        this.stop();
        if (!this.mediaEl) return Promise.resolve();

        return new Promise((resolve) => {
            this.activeResolve = resolve;
            
            let finalFileName = fileName;
            const match = fileName.match(/(\d+)\.(mov|mp4)/i);
            if (match) {
                finalFileName = `${match[1]}-Sss720p.mp4`;
            }
            
            const basePath = VIDEO_BASE_PATH;
            const blobUrl = window.videoBlobCache[fileName] || (basePath + finalFileName + (window.VIDEO_CACHE_BUST || ""));
            
            this.mediaEl.src = blobUrl;
            this.mediaEl.volume = Math.min(1.0, window.videoGainVolume !== undefined ? window.videoGainVolume : 1.0);
            this.mediaEl.style.opacity = 0;
            this.mediaEl.classList.add("playing");
            
            // 最初のフレームをロードして一時停止
            this.mediaEl.currentTime = 0;
            this.mediaEl.pause();
            
            const onCanPlay = () => {
                this.mediaEl.removeEventListener('canplay', onCanPlay);
                this.mediaEl.removeEventListener('error', onError);
                
                // フェードイン処理開始
                let opacity = 0;
                const intervalMs = 30;
                const step = 1 / (fadeTimeSec * 1000 / intervalMs);
                
                this.fadeInterval = setInterval(() => {
                    opacity += step;
                    if (opacity >= 1) {
                        opacity = 1;
                        clearInterval(this.fadeInterval);
                        this.fadeInterval = null;
                        
                        // フェードイン完了後に再生開始
                        this.initAudioContext();
                        this.mediaEl.play().then(() => {
                            this.startFreezeMonitor(fileName);
                        }).catch(e => {
                            console.error(`L2再生エラー [${fileName}]:`, e);
                            resolve();
                        });
                        
                        // 終了検知フェードアウト監視
                        this.timeUpdateHandler = () => {
                            if (this.mediaEl.duration && this.mediaEl.currentTime >= this.mediaEl.duration - 0.1) {
                                this.mediaEl.pause(); // 最後のフレームでフリーズ
                                this.mediaEl.removeEventListener('timeupdate', this.timeUpdateHandler);
                                this.timeUpdateHandler = null;
                                
                                // フェードアウト処理開始
                                let outOpacity = 1;
                                this.fadeInterval = setInterval(() => {
                                    outOpacity -= step;
                                    if (outOpacity <= 0) {
                                        outOpacity = 0;
                                        clearInterval(this.fadeInterval);
                                        this.fadeInterval = null;
                                        
                                        // 完全に終了
                                        this.stop();
                                    } else {
                                        this.mediaEl.style.opacity = outOpacity;
                                    }
                                }, intervalMs);
                            }
                        };
                        this.mediaEl.addEventListener('timeupdate', this.timeUpdateHandler);
                    } else {
                        this.mediaEl.style.opacity = opacity;
                    }
                }, intervalMs);
            };
            
            const onError = (e) => {
                console.error(`L2ロードエラー: ${fileName}`, e);
                this.mediaEl.removeEventListener('canplay', onCanPlay);
                this.mediaEl.removeEventListener('error', onError);
                resolve();
            };
            
            this.mediaEl.addEventListener('canplay', onCanPlay);
            this.mediaEl.addEventListener('error', onError);
            this.mediaEl.load();
        });
    }

    // レベル 3: 変化が一貫してある（即カットイン、上書きロック、最後まで再生）
    playLevel3(fileName) {
        this.stop();
        this.isLocked = true;
        if (!this.mediaEl) return Promise.resolve();

        return new Promise((resolve) => {
            this.activeResolve = resolve;
            
            let finalFileName = fileName;
            const match = fileName.match(/(\d+)\.(mov|mp4)/i);
            if (match) {
                finalFileName = `${match[1]}-Sss720p.mp4`;
            }
            
            const basePath = VIDEO_BASE_PATH;
            const blobUrl = window.videoBlobCache[fileName] || (basePath + finalFileName + (window.VIDEO_CACHE_BUST || ""));
            
            this.mediaEl.src = blobUrl;
            this.mediaEl.volume = Math.min(1.0, window.videoGainVolume !== undefined ? window.videoGainVolume : 1.0);
            this.mediaEl.style.opacity = 1;
            this.mediaEl.classList.add("playing");
            this.initAudioContext();
            
            this.mediaEl.play().then(() => {
                this.startFreezeMonitor(fileName);
            }).catch(e => {
                console.error(`L3再生エラー [${fileName}]:`, e);
                this.isLocked = false;
                resolve();
            });

            this.mediaEl.onended = () => {
                this.isLocked = false;
                this.stop();
            };
        });
    }

    // レベル 4: 激しい（即カットイン、上書き可能、最後まで再生）
    playLevel4(fileName) {
        this.stop();
        // 連続フラッシュ・チャタリング防止のため、最低1.2秒間は上書きロックをかける
        this.isLocked = true;
        this.lockTimeout = setTimeout(() => {
            this.isLocked = false;
            this.lockTimeout = null;
        }, 1200);

        if (!this.mediaEl) return Promise.resolve();

        return new Promise((resolve) => {
            this.activeResolve = resolve;
            
            let finalFileName = fileName;
            const match = fileName.match(/(\d+)\.(mov|mp4)/i);
            if (match) {
                finalFileName = `${match[1]}-Sss720p.mp4`;
            }
            
            const basePath = VIDEO_BASE_PATH;
            const blobUrl = window.videoBlobCache[fileName] || (basePath + finalFileName + (window.VIDEO_CACHE_BUST || ""));
            
            this.mediaEl.src = blobUrl;
            this.mediaEl.volume = Math.min(1.0, window.videoGainVolume !== undefined ? window.videoGainVolume : 1.0);
            this.mediaEl.style.opacity = 1;
            this.mediaEl.classList.add("playing");
            this.initAudioContext();
            
            this.mediaEl.play().then(() => {
                this.startFreezeMonitor(fileName);
            }).catch(e => {
                console.error(`L4再生エラー [${fileName}]:`, e);
                resolve();
            });

            this.mediaEl.onended = () => {
                this.stop();
            };
        });
    }

    // 高精度フリーズフレーム監視ループ
    startFreezeMonitor(fileName) {
        this.stopFreezeMonitor();
        if (this.isHiddenAudioOnly || !this.mediaEl) return;

        const freezeTimes = window.freezeFramesPool ? (window.freezeFramesPool[fileName] || []) : [];
        if (freezeTimes.length === 0) return;

        this.freezeTimes = freezeTimes;
        this.triggeredFreezes = new Array(freezeTimes.length).fill(false);

        const checkFreeze = () => {
            if (!this.mediaEl) return;
            if (this.mediaEl.paused || this.mediaEl.ended) {
                // フリーズによる一時停止中でない場合は、再生再開を待つためにループのみ継続
                if (!this.freezeTimeout) {
                    this.freezeAnimationId = requestAnimationFrame(checkFreeze);
                    return;
                }
            }

            const cf = this.mediaEl.currentTime;
            for (let i = 0; i < this.freezeTimes.length; i++) {
                if (!this.triggeredFreezes[i]) {
                    const pt = this.freezeTimes[i];
                    
                    // 指定フレームの前後0.03秒〜0.1秒の範囲で検知
                    if (cf >= pt - 0.03 && cf <= pt + 0.1) {
                        this.triggeredFreezes[i] = true;

                        const prob = window.videoPausePer !== undefined ? window.videoPausePer : 100;
                        if (Math.random() * 100 < prob) {
                            this.mediaEl.pause();

                            // 一時停止するフレーム数: rand() % 136 + 15
                            const pauseFrames = Math.floor(Math.random() * 136) + 15;
                            const pauseSec = pauseFrames / 30.0; // 30fps換算

                            console.log(`[player] Freeze triggered at ${cf.toFixed(2)}s (target ${pt.toFixed(2)}s). Pausing for ${pauseSec.toFixed(2)}s (${pauseFrames} frames).`);

                            if (window.addDecisionLog) {
                                const screenNum = this.elementId.split('-').pop();
                                window.addDecisionLog(`Screen ${screenNum}: Freeze frame triggered at ${cf.toFixed(2)}s (target ${pt.toFixed(2)}s). Pausing for ${pauseSec.toFixed(2)}s (${pauseFrames} frames).`, 'warning');
                            }

                            this.freezeTimeout = setTimeout(() => {
                                this.freezeTimeout = null;
                                if (this.mediaEl && !this.isHiddenAudioOnly && !this.mediaEl.ended) {
                                    this.mediaEl.play().catch(e => {});
                                }
                            }, pauseSec * 1000);
                        }
                    }
                }
            }

            this.freezeAnimationId = requestAnimationFrame(checkFreeze);
        };

        this.freezeAnimationId = requestAnimationFrame(checkFreeze);
    }

    stopFreezeMonitor() {
        if (this.freezeAnimationId) {
            cancelAnimationFrame(this.freezeAnimationId);
            this.freezeAnimationId = null;
        }
        if (this.freezeTimeout) {
            clearTimeout(this.freezeTimeout);
            this.freezeTimeout = null;
        }
        this.freezeTimes = null;
        this.triggeredFreezes = null;
    }

    // プレイヤー状態の完全クリーンアップ
    stop() {
        if (this.activeResolve) {
            this.activeResolve();
            this.activeResolve = null;
        }
        if (this.fadeInterval) {
            clearInterval(this.fadeInterval);
            this.fadeInterval = null;
        }
        if (this.fadeTimeout) {
            clearTimeout(this.fadeTimeout);
            this.fadeTimeout = null;
        }
        if (this.lockTimeout) {
            clearTimeout(this.lockTimeout);
            this.lockTimeout = null;
        }
        
        this.stopFreezeMonitor();
        
        if (this.mediaEl) {
            if (this.timeUpdateHandler) {
                this.mediaEl.removeEventListener('timeupdate', this.timeUpdateHandler);
                this.timeUpdateHandler = null;
            }
            this.mediaEl.pause();
            if (!this.isHiddenAudioOnly) {
                this.mediaEl.classList.remove("playing");
                this.mediaEl.style.opacity = 0;
            }
        }
        
        this.isLocked = false;
    }
}
