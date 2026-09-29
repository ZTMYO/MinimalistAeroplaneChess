const AUDIO_ENABLED_STORAGE_KEY = 'flyingChess.audioEnabled';

// 音效管理器
class AudioManager {
    constructor() {
        this.sounds = {};
        this.isEnabled = this._readStoredEnabled();
        this.isSuspended = false;
        this.volume = 1;
        this.isLoaded = false;
        this.isMultiplayerMode = false;
        this.allPlayersAudioLoaded = false;
        this.preloadStarted = false;

        // 音效文件路径配置
        this.soundPaths = {
            rolling: 'audio/rolling.wav',
            move: 'audio/move.wav',
            fly: 'audio/fly.wav',
            beat: 'audio/beat.wav',
            shake: 'audio/shake.wav',
            gameover: 'audio/gameover.wav',
            finish: 'audio/finish.wav',
            skill: 'audio/skill.wav',
        };

        // 回调函数，用于解耦 UI
        this.onProgressCallback = null;
        this.onStatusChangeCallback = null;
    }

    /**
     * 设置进度回调
     */
    onProgress(callback) {
        this.onProgressCallback = callback;
    }

    /**
     * 设置状态变化回调
     */
    onStatusChange(callback) {
        this.onStatusChangeCallback = callback;
    }

    /**
     * 初始化游戏模式并开始预加载
     */
    initMode(isMultiplayer) {
        this.isMultiplayerMode = !!isMultiplayer;
        if (!this.preloadStarted) {
            this.preloadSounds();
        } else if (this.isLoaded) {
            this._handlePreloadComplete();
        }
    }

    /**
     * 兼容旧方法的别名
     */
    setMultiplayerMode(isMultiplayer) { this.initMode(isMultiplayer); }
    setSinglePlayerMode() { this.initMode(false); }

    /**
     * 内部状态更新通知
     */
    _notifyStatus(status, data = {}) {
        if (this.onStatusChangeCallback) {
            this.onStatusChangeCallback(status, data);
        }
    }

    /**
     * 预加载所有音效文件
     * @param {boolean} skipWaiting - 是否跳过 canplaythrough 等待（game.html 页面使用，音频已被浏览器缓存）
     */
    async preloadSounds(skipWaiting = false) {
        if (this.preloadStarted) {
            console.log(`[audioManager] preloadSounds 跳过（已在加载中），页面: ${window.location.pathname}`);
            return;
        }
        this.preloadStarted = true;
        if (this.onProgressCallback) this.onProgressCallback(0);

        if (skipWaiting) {
            Object.entries(this.soundPaths).forEach(([key, path]) => {
                const audio = new Audio(path);
                audio.preload = 'auto';
                audio.volume = this.volume;
                this.sounds[key] = audio;
                audio.load();
            });
            this.isLoaded = true;
            console.log(`[audioManager] 预加载完成（跳过等待）`);
            this._handlePreloadComplete();
            return;
        }

        try {
            const totalSounds = Object.keys(this.soundPaths).length;
            let loadedCount = 0;

            const updateProgress = () => {
                loadedCount++;
                const percentage = Math.floor((loadedCount / totalSounds) * 100);
                if (this.onProgressCallback) this.onProgressCallback(percentage);
            };

            const loadPromises = Object.entries(this.soundPaths).map(([key, path]) => {
                return new Promise((resolve) => {
                    const audio = new Audio(path);
                    audio.preload = 'auto';
                    audio.volume = this.volume;

                    audio.addEventListener('canplaythrough', () => {
                        this.sounds[key] = audio;
                        updateProgress();
                        resolve();
                    }, { once: true });

                    audio.addEventListener('error', (e) => {
                        console.warn(`音效 ${key} 加载失败:`, e);
                        updateProgress();
                        resolve();
                    }, { once: true });

                    audio.load();
                });
            });

            await Promise.all(loadPromises);
            this.isLoaded = true;
            console.log(`[audioManager] 预加载完成`);
            this._handlePreloadComplete();
        } catch (error) {
            this.isLoaded = true;
            this._notifyStatus('ready'); // 失败也继续，避免阻塞
        }
    }

    /**
     * 处理所有玩家音频加载完成
     */
    onAllPlayersAudioLoaded() {
        console.log('[音频] 所有玩家音频加载完成');
        this.allPlayersAudioLoaded = true;
        this._notifyStatus('ready');
    }

    updateLoadingText(text) {
        const loadingText = document.getElementById('loadingIndicator')?.querySelector('.loading-text');
        if (loadingText) {
            loadingText.textContent = text;
        }
    }

    /**
     * 处理预加载完成后的就绪逻辑
     */
    _handlePreloadComplete() {
        if (this.isMultiplayerMode && window.multiplayerGameManager) {
            if (this.allPlayersAudioLoaded) {
                this._notifyStatus('ready');
            } else {
                this._notifyStatus('waiting_others');
            }
            window.multiplayerGameManager.notifyAudioLoaded();
        } else if (this.onStatusChangeCallback && !window.multiplayerGameManager) {
            this._notifyStatus('ready');
        }
    }

    /**
     * 播放指定音效
     */
    playSound(soundName, volume = null) {
        if (!this.isEnabled || this.isSuspended || !this.isLoaded) return;

        const sound = this.sounds[soundName];
        if (!sound) {
            console.warn(`音效 ${soundName} 不存在`);
            return;
        }

        try {
            const audioClone = sound.cloneNode();
            audioClone.volume = volume !== null ? volume : this.volume;
            const playPromise = audioClone.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    if (error.name === 'NotAllowedError') return;
                    console.warn(`播放音效 ${soundName} 失败:`, error);
                });
            }
        } catch (error) {
            console.warn(`播放音效 ${soundName} 出错:`, error);
        }
    }

    // 便捷播放方法
    playRollingSound() { this.playSound('rolling'); }
    playMoveSound() { this.playSound('move'); }
    playFlySound() { this.playSound('fly'); }
    playBeatSound() { this.playSound('beat'); }
    playShakeSound() { this.playSound('shake'); }
    playGameOverSound() { this.playSound('gameover'); }
    playFinishSound() { this.playSound('finish'); }
    playSkillSound() { this.playSound('skill'); }


    stopAllSounds() {
        Object.values(this.sounds).forEach(sound => {
            if (sound && !sound.paused) {
                sound.pause();
                sound.currentTime = 0;
            }
        });
    }



    /**
     * 设置音效开关：落盘到本地作为兜底，联机时由调用方另外同步到服务端
     */
    setEnabled(enabled) {
        const next = !!enabled;
        const changed = this.isEnabled !== next;
        this.isEnabled = next;
        if (changed && !next) {
            this.stopAllSounds();
        }
        this._persistEnabled();
        this.updateToggleButtonUI();
    }

    /**
     * 临时静音（如重开一局的过渡阶段），不改变用户的开关偏好
     */
    suspend() {
        this.isSuspended = true;
        this.stopAllSounds();
    }

    resume() {
        this.isSuspended = false;
    }

    updateToggleButtonUI() {
        const toggleBtn = document.getElementById('toggleAudio');
        if (toggleBtn) {
            toggleBtn.textContent = this.isEnabled ? '关闭音效' : '开启音效';
        }
    }

    _readStoredEnabled() {
        try {
            const stored = localStorage.getItem(AUDIO_ENABLED_STORAGE_KEY);
            if (stored === 'true') return true;
            if (stored === 'false') return false;
        } catch (error) {
            console.warn('读取音效开关失败:', error);
        }
        return true;
    }

    _persistEnabled() {
        try {
            localStorage.setItem(AUDIO_ENABLED_STORAGE_KEY, String(this.isEnabled));
        } catch (error) {
            console.warn('保存音效开关失败:', error);
        }
    }
}

export const audioManager = new AudioManager();
export default AudioManager;