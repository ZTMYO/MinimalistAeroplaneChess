// 对战页入口 - 初始化单机/本地多人/联机对战并处理对应的URL参数
import { gameState } from './gameState.js';
import { dice } from './dice.js';
import { uiUpdater } from './uiUpdater.js';
import { eventHandler } from './eventHandler.js';
import { gameInfo } from './gameInfo.js';
import { botController } from './botController.js';
import { activePlayerManager } from './activePlayerManager.js';
import { audioManager } from './audioManager.js';
import { aiTakeoverManager } from './aiTakeoverManager.js';
import { playerNameManager } from './playerNameManager.js';
import { lightningManager } from './lightningManager.js';
import { engineAdapter } from './engineAdapter.js';
import { FlyingChessGameBase, createGameRuntime } from './gameBase.js';

class FlyingChessGame extends FlyingChessGameBase {
    constructor() {
        super();

        this.lightningManager = lightningManager;

        // 联机模式需要从全局访问托管管理器
        window.aiTakeoverManager = aiTakeoverManager;

        // 音频文件已被首页浏览器缓存，尽早开始预加载
        audioManager.preloadSounds(true);
        this.setupAudioManagerUI();

        this.initializeGame();
    }

    /**
     * 设置音频管理器的 UI 回调
     */
    setupAudioManagerUI() {
        const loadingIndicator = document.getElementById('loadingIndicator');
        const loadingText = loadingIndicator?.querySelector('.loading-text');
        const thinkingProgressContainer = document.getElementById('thinkingProgressContainer');
        const diceDisplay = document.getElementById('diceDisplay');

        if (loadingIndicator) loadingIndicator.style.display = 'flex';
        // 清掉可能残留的内联 display，让进度条可见性回到 CSS 的 .active 控制
        if (thinkingProgressContainer) {
            thinkingProgressContainer.style.removeProperty('display');
            thinkingProgressContainer.classList.remove('active');
        }

        // 只有在非暂停且非显示聊天时才隐藏骰子
        const isPaused = gameState.getIsPaused();
        const chatInputArea = document.getElementById('chatInputArea');
        if (!isPaused && diceDisplay && !(chatInputArea && chatInputArea.style.display === 'flex')) {
            diceDisplay.style.display = 'none';
        }

        const chatBtn = document.getElementById('chatBtn');
        const skillBtn = document.getElementById('skillBtn');
        const lightningBtn = document.getElementById('lightningBtn');
        if (chatBtn) chatBtn.style.display = 'none';
        if (skillBtn) skillBtn.style.display = 'none';
        if (lightningBtn) lightningBtn.style.display = 'none';

        audioManager.onProgress((percentage) => {
            if (loadingText) loadingText.textContent = `正在加载... ${percentage}%`;
        });

        audioManager.onStatusChange((status) => {
            if (status === 'waiting_others') {
                if (loadingText) loadingText.textContent = '等待其他玩家加载...';
            } else if (status === 'ready') {
                this.hideLoadingUI();
            }
        });

        // 如果音频已提前加载完成，直接隐藏加载UI
        if (audioManager.isLoaded) {
            this.hideLoadingUI();
        }
    }

    /**
     * 隐藏加载 UI 并恢复游戏控件
     */
    hideLoadingUI() {
        const loadingIndicator = document.getElementById('loadingIndicator');
        if (loadingIndicator) loadingIndicator.style.display = 'none';

        // 刷新后按持久化的开关状态恢复按钮文案
        audioManager.updateToggleButtonUI();

        // 只有在未暂停时才恢复 UI
        if (gameState.getIsPaused()) return;

        const diceDisplay = document.getElementById('diceDisplay');
        const thinkingProgressContainer = document.getElementById('thinkingProgressContainer');

        if (this.uiUpdater && typeof this.uiUpdater.updateDiceDisplay === 'function') {
            this.uiUpdater.updateDiceDisplay();
        } else if (diceDisplay) {
            const chatInputArea = document.getElementById('chatInputArea');
            if (!(chatInputArea && window.getComputedStyle(chatInputArea).display !== 'none')) {
                diceDisplay.style.display = 'flex';
            }
        }

        // 进度条可见性统一交给渲染器（基于计时器），不要写内联 display，
        // 否则会盖过 CSS 的 .active 隐藏规则，导致上一家颜色残留
        this.uiUpdater?._renderThinkingProgressBar?.();

        this.initializeControlButtonsVisibility();
        this.skillManager.updateButtonVisibility();
        aiTakeoverManager.updateControlButtons();
        aiTakeoverManager.updateToggleButton();
    }

    // 初始化游戏
    initializeGame() {
        try {
            audioManager.updateToggleButtonUI();

            // 1. 重置游戏状态（在处理URL参数之前）
            gameState.resetGameState();

            // 2. 处理URL参数（如果有的话）
            this.handleUrlParameters();

            // 2.5 单机模式：交由共享规则引擎持权威棋面
            if (!sessionStorage.getItem('multiplayerGameData')) {
                engineAdapter.reset({
                    players: activePlayerManager.getActivePlayers(),
                    piecesPerPlayer: gameState.pieceCount,
                    happy: gameState.isHappyMode(),
                    skillMode: gameState.isSkillModeEnabled(),
                    currentPlayer: gameState.currentPlayer
                });
                gameState.engineDriven = true;
            }

            // 3. 设置棋子元素
            this.setupChessElements();

            // 4. 设置事件监听器
            eventHandler.setGameInstance(this);
            eventHandler.setupEventListeners();

            // 5. 设置dice的eventHandler引用
            dice.setEventHandler(eventHandler);

            // 6. 设置初始游戏阶段为waiting，让bot能够正确启动
            gameState.setState('gamePhase', 'waiting');

            // 7. 更新UI
            uiUpdater.updateUI();

            // 8. 添加游戏开始信息（在URL参数处理和玩家名称设置之后）
            const isOnlineModeStrStr = sessionStorage.getItem('multiplayerGameData');
            const isOnlineMode = !!isOnlineModeStrStr;
            const isWaiting = gameState.getGamePhase() === 'waiting';

            if (!isOnlineMode && isWaiting) {
                // 本地多人或人机模式，直接发送游戏开始消息
                gameInfo.addGameStart(gameState.getCurrentPlayer());
            } else if (isOnlineMode) {
                console.log('[初始化] 联机模式跳过发送游戏开始消息，等待全员加载完毕由网络管理器触发');
            } else {
                console.log('[初始化] 跳过发送游戏开始消息, 原因:', { phase: gameState.getGamePhase() });
            }

            // 9. 初始化bot控制器并处理游戏开始
            botController.setEnabled(true);
            this.handleGameStart();

            // 10. 记录游戏开始时间
            gameState.recordGameStartTime();

            // 10.5 设置游戏正式开始状态（单机/本地多人直接开始）
            if (!isOnlineMode) {
                gameState.setGameOfficiallyStarted(true);
            }

            // 11. 初始化AI托管按钮状态
            aiTakeoverManager.initializeButton();
            eventHandler.updatePauseButtonText();

            // 12. 初始化聊天和闪电按钮显示状态
            this.initializeControlButtonsVisibility();

            // 13. 初始化积分系统（仅在道具模式下）
            this.energyManager.init();
            // 始终初始化道具管理器（用于控制道具按钮的显示/隐藏）
            this.skillManager.init();
            if (this.energyManager.isSkillModeEnabled()) {
                this.energyDisplay.init();
            }

            // 14. 初始化最后应用视角旋转（在UI全部创建完成后）
            if (this.localPlayerColor) {
                this.autoRotateBoard(this.localPlayerColor);
            } else {
                // 本地多人模式没有 localPlayerColor，强制0度旋转以应用正确的UI类名
                uiUpdater.rotateBoard(0);
            }

            console.log('飞行棋游戏初始化完成');
        } catch (error) {
            console.error('游戏初始化失败:', error);
        }
    }

    /**
     * 初始化控制区域按钮（聊天、闪电模式等）的显示状态
     */
    initializeControlButtonsVisibility() {
        const chatBtn = document.getElementById('chatBtn');
        const lightningBtn = document.getElementById('lightningBtn');
        const isOnlineMultiplayer = gameState.getIsOnlineMultiplayer();

        const loadingIndicator = document.getElementById('loadingIndicator');
        const isLoading = loadingIndicator && loadingIndicator.style.display === 'flex';

        // 聊天按钮：只有在线多人模式且非加载状态下才显示
        if (chatBtn) {
            if (isOnlineMultiplayer && !isLoading) {
                chatBtn.style.display = 'block';
            } else {
                chatBtn.style.display = 'none';
            }
        }

        // 闪电模式按钮：只在人机模式（非本地多人且非在线多人）下显示
        if (lightningBtn) {
            const shouldShowLightning = lightningManager.shouldShowButton(gameState);
            if (shouldShowLightning && !isLoading) {
                lightningManager.init();
                lightningBtn.style.display = 'block';
                lightningManager.updateUI();
            } else {
                lightningBtn.style.display = 'none';
            }
        }
    }

    // 处理URL参数
    handleUrlParameters() {
        // 优先处理新的游戏配置（本地多人或AI模式），有则清除旧的联机数据
        const checkGameConfigStr = sessionStorage.getItem('gameConfig');
        if (checkGameConfigStr) {
            try {
                const checkGameConfig = JSON.parse(checkGameConfigStr);
                if (checkGameConfig.mode === 'local_multiplayer' ||
                    checkGameConfig.humanPlayer !== undefined) {
                    sessionStorage.removeItem('multiplayerGameData');
                }
            } catch (error) {
                console.error('预检查游戏配置失败:', error);
            }
        }

        // 然后检查多人游戏数据（联机模式）
        const multiplayerGameDataStr = sessionStorage.getItem('multiplayerGameData');
        if (multiplayerGameDataStr) {
            try {
                const multiplayerGameData = JSON.parse(multiplayerGameDataStr);

                if (!window.audioManager) {
                    window.audioManager = audioManager;
                }

                const multiplayerConfig = {
                    mode: 'online_multiplayer',
                    playerCount: multiplayerGameData.players ? multiplayerGameData.players.length : 2,
                    pieceCount: multiplayerGameData.pieceCount || 4,
                    skillMode: multiplayerGameData.skillMode || false,
                    happyMode: multiplayerGameData.happyMode || false
                };
                this.updatePageTitle(multiplayerConfig);

                if (multiplayerGameData.pieceCount) {
                    gameState.initializePlayerChess(multiplayerGameData.pieceCount);
                }

                if (multiplayerGameData.happyMode !== undefined) {
                    gameState.setHappyMode(multiplayerGameData.happyMode);
                }

                gameState.setIsOnlineMultiplayer(true);

                if (this.gameInfo && this.gameInfo.updatePanelSwitchButtonVisibility) {
                    this.gameInfo.updatePanelSwitchButtonVisibility();
                }

                // 分离真实玩家和AI玩家
                const aiPlayers = multiplayerGameData.players.filter(p => p.isAI);

                // 构建激活玩家列表（包括真实玩家和AI玩家）
                const activePlayers = multiplayerGameData.players.map(p => p.color || p.id).sort((a, b) => a - b);
                activePlayerManager.setActivePlayers(activePlayers);

                for (const player of multiplayerGameData.players) {
                    const playerId = player.color || player.id;
                    this.updatePlayerName(playerId, player.nickname || `玩家${playerId}`);
                    if (player.emoji) {
                        this.updatePlayerEmoji(playerId, player.emoji);
                    }
                }

                // 联机模式下使用统一的起始玩家
                if (multiplayerGameData.currentPlayer) {
                    const currentPlayerId = multiplayerGameData.currentPlayer.color || multiplayerGameData.currentPlayer.id;
                    gameState.setCurrentPlayer(currentPlayerId);
                    activePlayerManager.setCurrentActivePlayer(currentPlayerId);
                } else {
                    const firstPlayer = activePlayers[0];
                    gameState.setCurrentPlayer(firstPlayer);
                    activePlayerManager.setCurrentActivePlayer(firstPlayer);
                }

                if (aiPlayers.length > 0) {
                    botController.setEnabled(true);

                    const aiPlayerIds = aiPlayers.map(ai => ai.color || ai.id);
                    gameState.setBotPlayers(aiPlayerIds);

                    const botDifficulties = {};
                    aiPlayers.forEach(ai => {
                        botDifficulties[ai.color || ai.id] = ai.difficulty || 'easy';
                    });
                    botController.setBotDifficulties(botDifficulties);
                } else {
                    botController.setEnabled(false);
                }

                this.multiplayerGameManager.init(multiplayerGameData, this);

                // 记录需要旋转的视角颜色，推迟到初始化结尾执行
                this.localPlayerColor = this.multiplayerGameManager.getPlayerNumberByPlayerId(this.multiplayerGameManager.playerId);

                return;
            } catch (error) {
                console.error('解析多人游戏数据失败:', error);
            }
        }

        // 其次从sessionStorage获取游戏配置
        const gameConfigStr = sessionStorage.getItem('gameConfig');
        if (gameConfigStr) {
            try {
                const gameConfig = JSON.parse(gameConfigStr);
                console.log('从sessionStorage加载游戏配置:', gameConfig);

                // 记录需要旋转的视角颜色，推迟到初始化结尾执行
                if (gameConfig.mode !== 'local_multiplayer') {
                    // 人机模式下真实玩家在1号位，颜色在 humanPlayer 中
                    this.localPlayerColor = gameConfig.humanPlayer || 1;
                }

                this.updatePageTitle(gameConfig);

                if (gameConfig.pieceCount) {
                    gameState.initializePlayerChess(gameConfig.pieceCount);
                }

                if (gameConfig.happyMode !== undefined) {
                    gameState.setHappyMode(gameConfig.happyMode);
                }

                // 处理本地多人模式
                if (gameConfig.mode === 'local_multiplayer') {
                    sessionStorage.removeItem('multiplayerGameData');

                    gameState.setIsLocalMultiplayer(true);
                    gameState.setIsOnlineMultiplayer(false);

                    // 清除之前联机模式的会话数据，避免错误的重连尝试
                    if (window.reconnectManager) {
                        window.reconnectManager.clearPlayerIdentity();
                    }

                    if (window.audioManager) {
                        window.audioManager.setSinglePlayerMode();
                    }

                    if (this.gameInfo && this.gameInfo.updatePanelSwitchButtonVisibility) {
                        this.gameInfo.updatePanelSwitchButtonVisibility();
                    }

                    const activePlayers = gameConfig.players.map(p => p.id).sort((a, b) => a - b);
                    activePlayerManager.setActivePlayers(activePlayers);

                    for (const player of gameConfig.players) {
                        this.updatePlayerName(player.id, player.name);
                        if (player.emoji && player.emoji.key) {
                            this.updatePlayerEmoji(player.id, player.emoji.key);
                        }
                    }

                    // 颜色最小的玩家为起始玩家（activePlayers已排序）
                    const firstPlayer = activePlayers[0];
                    gameState.setCurrentPlayer(firstPlayer);
                    activePlayerManager.setCurrentActivePlayer(firstPlayer);

                    // 处理本地多人中的AI玩家（可选）
                    const aiPlayers = (gameConfig.players || []).filter(p => p && p.isAI === true);
                    if (aiPlayers.length > 0) {
                        const aiPlayerIds = aiPlayers.map(p => p.id);
                        gameState.setBotPlayers(aiPlayerIds);

                        const botDifficulties = {};
                        aiPlayerIds.forEach(id => {
                            botDifficulties[id] = (gameConfig.botDifficulties && gameConfig.botDifficulties[id]) || 'easy';
                        });
                        botController.setBotDifficulties(botDifficulties);
                        botController.setEnabled(true);

                        this.setupBotEmojis(firstPlayer, null, aiPlayerIds);
                    } else {
                        botController.setEnabled(false);
                    }

                    return;
                }

                // 处理AI模式（原有逻辑）
                const humanPlayer = gameConfig.humanPlayer;
                const bots = gameConfig.bots || [];

                sessionStorage.removeItem('multiplayerGameData');

                // AI模式是单机模式，清除之前联机模式的会话数据
                if (window.reconnectManager) {
                    window.reconnectManager.clearPlayerIdentity();
                }
                gameState.setIsOnlineMultiplayer(false);

                if (window.audioManager) {
                    window.audioManager.setSinglePlayerMode();
                }

                const activePlayers = [humanPlayer, ...bots].filter(p => p).sort((a, b) => a - b);
                activePlayerManager.setActivePlayers(activePlayers);

                playerNameManager.setupPlayersWithActiveBots(
                    humanPlayer,
                    gameConfig.humanUsername || '玩家',
                    bots,
                    gameConfig.botDifficulties || {}
                );

                this.updatePlayerName(humanPlayer, gameConfig.humanUsername || '玩家');

                // 游戏总是由人类玩家开始
                gameState.setCurrentPlayer(humanPlayer);
                activePlayerManager.setCurrentActivePlayer(humanPlayer);

                if (gameConfig.humanEmoji) {
                    this.updatePlayerEmoji(humanPlayer, gameConfig.humanEmoji);
                }

                this.setupBotEmojis(humanPlayer, gameConfig.humanEmoji, bots);

                if (gameConfig.botDifficulties) {
                    botController.setBotDifficulties(gameConfig.botDifficulties);
                }

                gameState.setBotPlayers(bots);

                botController.setEnabled(true);

                return;
            } catch (error) {
                console.error('解析游戏配置失败:', error);
            }
        }

        // 没有sessionStorage配置时回退到URL参数（向后兼容）
        const urlParams = new URLSearchParams(window.location.search);
        const playerColor = urlParams.get('playerColor');
        const playerName = urlParams.get('playerName');
        const playerEmoji = urlParams.get('playerEmoji');
        const activeBots = urlParams.get('activeBots');
        const pieceCount = urlParams.get('pieceCount');

        if (pieceCount) {
            const parsedPieceCount = parseInt(pieceCount);
            if (!isNaN(parsedPieceCount) && parsedPieceCount >= 1 && parsedPieceCount <= 4) {
                gameState.initializePlayerChess(parsedPieceCount);
            } else {
                console.warn(`无效的棋子个数参数：${pieceCount}，使用默认值4`);
            }
        }

        if (playerColor && playerName) {
            const selectedPlayer = parseInt(playerColor);
            const activeBotNumbers = activeBots ? activeBots.split(',').map(num => parseInt(num.trim())).filter(num => !isNaN(num)) : [];
            const allActivePlayers = [selectedPlayer, ...activeBotNumbers].filter((value, index, self) => self.indexOf(value) === index).sort((a, b) => a - b);
            activePlayerManager.setActivePlayers(allActivePlayers);

            playerNameManager.setupPlayersWithActiveBots(selectedPlayer, playerName, activeBotNumbers);
            this.updatePlayerName(selectedPlayer, playerName);

            // 游戏总是由人类玩家开始
            gameState.setCurrentPlayer(selectedPlayer);
            activePlayerManager.setCurrentActivePlayer(selectedPlayer);

            if (playerEmoji) {
                this.updatePlayerEmoji(selectedPlayer, playerEmoji);
            }

            this.setupBotEmojis(selectedPlayer, playerEmoji, activeBotNumbers);

            gameState.setBotPlayers(activeBotNumbers);

            const urlGameConfig = {
                mode: 'ai_battle',
                bots: activeBotNumbers,
                pieceCount: parseInt(pieceCount) || 4
            };
            this.updatePageTitle(urlGameConfig);
        } else {
            console.log('没有找到有效的URL参数，使用默认设置');
            // 默认所有其他玩家都是AI
            playerNameManager.initFromUrlParams();
            this.setupBotEmojis(1);

            const defaultGameConfig = {
                mode: 'ai_battle',
                bots: [2, 3, 4],
                pieceCount: 4
            };
            this.updatePageTitle(defaultGameConfig);
        }
    }
}

const runtime = createGameRuntime(FlyingChessGame);

export const initializeGame = runtime.initializeGame;
export const updatePageTitle = runtime.updatePageTitle;

document.addEventListener('DOMContentLoaded', () => {
    const roomCode = runtime.setupRoomCodeDisplay();

    if (roomCode) {
        // 校验联机会话，无效则重定向回主页
        const multiplayerGameDataStr = sessionStorage.getItem('multiplayerGameData');
        let isValidSession = false;

        if (multiplayerGameDataStr) {
            try {
                const multiplayerGameData = JSON.parse(multiplayerGameDataStr);
                isValidSession = multiplayerGameData.gameSessionId ||
                    (multiplayerGameData.roomCode && multiplayerGameData.roomCode === roomCode);
            } catch (error) {
                console.error('解析multiplayerGameData失败:', error);
                isValidSession = false;
            }
        }

        if (!isValidSession && !window.location.pathname.includes('spectate')) {
            console.log('检测到无效的房间会话，重定向回主页');
            setTimeout(() => {
                window.location.replace('/');
            }, 1000);
            return;
        }
    }

    runtime.initializeGame();
});

export { FlyingChessGame };
