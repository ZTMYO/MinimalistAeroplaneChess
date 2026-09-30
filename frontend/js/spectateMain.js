// 观战页入口 - 只读接入房间，禁用一切交互并跟随服务器快照
import { gameState } from './gameState.js';
import { eventHandler } from './eventHandler.js';
import { uiUpdater } from './uiUpdater.js';
import { audioManager } from './audioManager.js';
import { WebSocketClient } from './websocketClient.js';
import { FlyingChessGameBase, createGameRuntime } from './gameBase.js';
import { resetTitlesViews } from './titlesGallery.js';
import './theme.js';

class FlyingChessGame extends FlyingChessGameBase {
    constructor() {
        super();
        this.initializeGame();
    }

    // 初始化游戏
    initializeGame() {
        try {
            // 按持久化的开关状态恢复按钮文案
            audioManager.updateToggleButtonUI();

            // 1. 重置游戏状态（在处理URL参数之前）
            gameState.resetGameState();

            // 禁用所有的控制功能，进入纯观战模式
            this.disableAllControls();

            // 2. 设置棋子元素
            this.setupChessElements();

            // 3. 设置事件监听器
            eventHandler.setGameInstance(this);
            eventHandler.setupEventListeners();

            this.setupSpectateButtons();

            // 4. 处理URL参数，建立连接
            this.handleUrlParameters();

            // 5. 解决浏览器自动播放限制
            this.setupAudioAutoPlayFix();

        } catch (error) {
            console.error('游戏初始化失败:', error);
        }
    }

    /**
     * 解决浏览器对自动播放音频的限制
     * 观战模式下玩家可能没有交互，导致没有声音
     */
    setupAudioAutoPlayFix() {
        const fixAudio = () => {
            // 用户首次交互时播放静音片段来解锁音频上下文
            if (audioManager.isLoaded) {
                audioManager.playMoveSound();
            }
            console.log('用户交互检测到，激活观战模式音效');
            document.removeEventListener('click', fixAudio);
            document.removeEventListener('touchstart', fixAudio);
        };

        document.addEventListener('click', fixAudio);
        document.addEventListener('touchstart', fixAudio);

        // 如果页面刷新后有加载遮罩，点击遮罩也可以激活音频
        const loadingIndicator = document.getElementById('loadingIndicator');
        if (loadingIndicator) {
            loadingIndicator.addEventListener('click', fixAudio);
        }
    }

    disableAllControls() {
        // 隐藏技能入口；聊天与表情保留，观战者可以发言
        const skillBtn = document.getElementById('skillBtn');
        if (skillBtn) skillBtn.style.display = 'none';
        // 设置所有按钮的disabled状态（保留游戏规则、音效开关、结算弹框按钮可点击）
        document.querySelectorAll('button').forEach(btn => {
            if (btn.id !== 'returnHome' && btn.id !== 'panelSwitchBtn' && btn.id !== 'showRules' && btn.id !== 'toggleAudio' && btn.id !== 'rules-close' && btn.id !== 'settlement-close' && btn.id !== 'new-game-btn' && btn.id !== 'data-analysis-btn') {
                btn.disabled = true;
            }
        });

        // 移除棋盘交互事件（观战只读的第二道封锁）
        if (this.eventHandler) {
            this.eventHandler.setupChessEvents = function() {};
            this.eventHandler.rebindChessEvents = function() {};
            // 骰子是 div，不归 button.disabled 管，且点击/键盘两条路径都会走到这里；
            // 观战不参与出手，直接把入口摘掉，免得看着能点
            this.eventHandler.handleDiceClick = function() {};
        }
        const diceDisplay = document.getElementById('diceDisplay');
        if (diceDisplay) {
            diceDisplay.style.pointerEvents = 'none';
            diceDisplay.style.cursor = 'default';
        }
    }

    /**
     * 观战页面专用按钮绑定
     * 直接绑定游戏规则和音效开关，避免依赖 eventHandler 的 import 方式
     */
    setupSpectateButtons() {
        // 游戏规则按钮
        const showRulesBtn = document.getElementById('showRules');
        if (showRulesBtn) {
            showRulesBtn.addEventListener('click', () => {
                const rulesModal = document.getElementById('rules-modal');
                if (rulesModal) {
                    resetTitlesViews();
                    rulesModal.style.display = 'flex';
                }
            });
        }

        // 规则模态框关闭按钮
        const rulesCloseBtn = document.getElementById('rules-close');
        if (rulesCloseBtn) {
            rulesCloseBtn.addEventListener('click', () => {
                const rulesModal = document.getElementById('rules-modal');
                if (rulesModal) rulesModal.style.display = 'none';
            });
        }

        // 点击模态框背景关闭
        const rulesModal = document.getElementById('rules-modal');
        if (rulesModal) {
            rulesModal.addEventListener('click', (e) => {
                if (e.target === rulesModal) {
                    rulesModal.style.display = 'none';
                }
            });
        }

        // 音效开关按钮
        const toggleAudioBtn = document.getElementById('toggleAudio');
        if (toggleAudioBtn) {
            toggleAudioBtn.addEventListener('click', () => {
                const nextEnabled = !audioManager.isEnabled;
                audioManager.setEnabled(nextEnabled);
                if (nextEnabled) {
                    audioManager.playMoveSound();
                }
            });
        }
    }


    // 处理URL参数
    handleUrlParameters() {
        const urlParams = new URLSearchParams(window.location.search);
        const roomCode = urlParams.get('room');
        if (roomCode) {
            // 确保 window.WebSocketClient 可用
            if (typeof window !== 'undefined' && !window.WebSocketClient) {
                window.WebSocketClient = WebSocketClient;
            }

            const spectateData = {
                // 观战是整页跳转进来的，window.wsClient 不存在，必须现建一个：
                // 连接地址由 WebSocketClient 按当前页面推导，直接取 window 会拿到空串，
                // new WebSocket('') 会抛错，观战者根本连不上，棋面永远停在基地。
                wsClient: window.wsClient || new WebSocketClient(),
                roomCode: roomCode,
                isSpectator: true,
                pieceCount: 4, // 默认值，连接后由服务器更新
                skillMode: false
            };

            gameState.setIsOnlineMultiplayer(true);

            if (this.gameInfo && this.gameInfo.updatePanelSwitchButtonVisibility) {
                this.gameInfo.updatePanelSwitchButtonVisibility();
            }

            const config = {
                mode: 'online_multiplayer',
                playerCount: 4,
                pieceCount: 4,
                skillMode: false
            };
            this.updatePageTitle(config);

            // 确保audioManager已暴露到全局（联机模式需要）
            if (!window.audioManager) {
                window.audioManager = audioManager;
            }

            this.multiplayerGameManager.init(spectateData, this);

            // 观战模式固定视角
            uiUpdater.rotateBoard(0);
        }
    }
}

const runtime = createGameRuntime(FlyingChessGame);

export const initializeGame = runtime.initializeGame;
export const updatePageTitle = runtime.updatePageTitle;

document.addEventListener('DOMContentLoaded', () => {
    runtime.setupRoomCodeDisplay();
    runtime.initializeGame();
});

export { FlyingChessGame };
