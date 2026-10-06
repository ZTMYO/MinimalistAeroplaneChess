// 游戏入口共享基类 - 承载对战页与观战页的公共初始化、通用方法与启动引导
import { gameState } from './gameState.js';
import { debugSetDice, debugFinishChess as finishAllChess } from './debugTools.js';
import { utils } from './utils.js';
import { dice } from './dice.js';
import ChessPiece from './chessPiece.js';
import { animation } from './animation.js';
import { uiUpdater } from './uiUpdater.js';
import { eventHandler } from './eventHandler.js';
import { gameInfo } from './gameInfo.js';
import { defeatCountDisplay } from './defeatCountDisplay.js';
import { progressDisplay } from './progressDisplay.js';
import { playerNameManager } from './playerNameManager.js';
import SettlementModal from './settlementModal.js';
import { botController } from './botController.js';
import { activePlayerManager } from './activePlayerManager.js';
import { audioManager } from './audioManager.js';
import { aiTakeoverManager } from './aiTakeoverManager.js';
import { multiplayerGameManager } from './multiplayerGameManager.js';
import { energyManager } from './energyManager.js';
import { energyDisplay } from './energyDisplay.js';
import { skillManager } from './skillManager.js';
import { engineAdapter } from './engineAdapter.js';

export class FlyingChessGameBase {
    constructor() {
        this.gameState = gameState;
        this.utils = utils;
        this.dice = dice;
        this.animation = animation;
        this.uiUpdater = uiUpdater;
        this.gameInfo = gameInfo;
        this.defeatCountDisplay = defeatCountDisplay;
        this.progressDisplay = progressDisplay;
        this.settlementModal = new SettlementModal();
        this.chessPiece = new ChessPiece(gameState, utils, animation, uiUpdater, dice);
        this.eventHandler = eventHandler;
        this.multiplayerGameManager = multiplayerGameManager;
        this.energyManager = energyManager;
        this.energyDisplay = energyDisplay;
        this.skillManager = skillManager;

        this.dice.animation = this.animation;
        this.dice.uiUpdater = this.uiUpdater;

        this.settlementModal.setDependencies(this.gameState, this.defeatCountDisplay, this.progressDisplay);

        this.eventHandler.setGameInstance(this);

        this.energyManager.setEnergyDisplay(this.energyDisplay);

        window.playerNameManager = playerNameManager;
        window.activePlayerManager = activePlayerManager;
        window.energyManager = this.energyManager;
        window.energyDisplay = this.energyDisplay;
        window.skillManager = this.skillManager;

        window.gameInstance = this;
    }

    // 检查是否有棋子不在初始位置
    hasNonInitialChessPositions(playerChess) {
        if (!playerChess) return false;

        for (const color in playerChess) {
            const chesses = playerChess[color];
            if (Array.isArray(chesses)) {
                for (const chess of chesses) {
                    if (chess.position !== -1 || chess.finished === true) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    // 根据玩家颜色自动旋转棋盘
    autoRotateBoard(playerColor) {
        // 目标是将当前玩家放在左下角 (3号位的位置)
        // 棋盘默认顺序 (顺时针，从左下角开始): 紫色(3) -> 蓝色(4) -> 粉色(1) -> 黄色(2)
        let rotations = 0;
        switch (Number(playerColor)) {
            case 3: rotations = 0; break;
            case 4: rotations = 3; break;
            case 1: rotations = 2; break;
            case 2: rotations = 1; break;
        }

        // 无论如何都要调用一次，确保赋予正确的初始 class
        uiUpdater.rotateBoard(rotations);
    }

    // 更新页面标题
    updatePageTitle(gameConfig) {
        let titleText = '极简飞行棋';

        try {
            if (gameConfig.mode === 'local_multiplayer') {
                const playerCount = gameConfig.players?.length || gameConfig.playerCount || 4;
                const pieceCount = gameConfig.pieceCount || 4;
                const skillMode = gameConfig.skillMode === true;
                const happyMode = gameConfig.happyMode === true;
                let modeText = skillMode ? '道具模式' : '标准模式';
                if (happyMode) modeText += '·欢乐';
                titleText = `本地多人-${playerCount}人${pieceCount}棋子-${modeText}`;
            } else if (gameConfig.mode === 'online_multiplayer') {
                const playerCount = gameConfig.playerCount || 4;
                const pieceCount = gameConfig.pieceCount || 4;
                const skillMode = gameConfig.skillMode === true;
                const happyMode = gameConfig.happyMode === true;
                let modeText = skillMode ? '道具模式' : '标准模式';
                if (happyMode) modeText += '·欢乐';
                titleText = `在线多人-${playerCount}人${pieceCount}棋子-${modeText}`;
            } else {
                const playerCount = gameConfig.bots
                    ? 1 + gameConfig.bots.length
                    : (gameConfig.playerCount || 4);
                const pieceCount = gameConfig.pieceCount || 4;
                const skillMode = gameConfig.skillMode === true;
                const happyMode = gameConfig.happyMode === true;
                let modeText = skillMode ? '道具模式' : '标准模式';
                if (happyMode) modeText += '·欢乐';
                titleText = `人机对战-${playerCount}人${pieceCount}棋子-${modeText}`;
            }

            document.title = titleText;
        } catch (error) {
            console.error('更新页面标题失败:', error);
            document.title = '极简飞行棋';
        }
    }

    // 更新玩家名称显示
    updatePlayerName(playerNumber, customName) {
        if (customName) {
            playerNameManager.setPlayerName(playerNumber, customName);
        }

        const playerNameElements = document.querySelectorAll(`.player-${playerNumber}-info .player-name`);
        playerNameElements.forEach(element => {
            element.textContent = customName;
        });

        // 更新其他玩家为Bot名称
        for (let i = 1; i <= 4; i++) {
            if (i !== playerNumber) {
                const botNameElements = document.querySelectorAll(`.player-${i}-info .player-name`);
                const botName = playerNameManager.getPlayerName(i);
                botNameElements.forEach(element => {
                    element.textContent = botName;
                });
            }
        }
    }

    // 更新玩家表情显示
    async updatePlayerEmoji(playerNumber, emojiKey) {
        try {
            const { emojis } = await import('../assets/emojis.js');

            if (emojis[emojiKey]) {
                const emojiElements = document.querySelectorAll(`#player-${playerNumber}-emoji`);
                emojiElements.forEach(element => {
                    element.innerHTML = emojis[emojiKey].svg;
                });

                const mobileEmojiElements = document.querySelectorAll(`#player-${playerNumber}-emoji-mobile`);
                mobileEmojiElements.forEach(element => {
                    element.innerHTML = emojis[emojiKey].svg;
                });
            }
        } catch (error) {
            console.error('加载表情失败:', error);
        }
    }

    // 为机器人玩家设置表情
    async setupBotEmojis(humanPlayerNumber, humanPlayerEmoji = null, activeBotNumbers = null) {
        try {
            await import('../assets/emojis.js');

            const botsToSetup = activeBotNumbers || [1, 2, 3, 4].filter(i => i !== humanPlayerNumber);

            for (const i of botsToSetup) {
                if (i !== humanPlayerNumber) {
                    // 简单/困难AI统一使用bot表情
                    this.updatePlayerEmoji(i, 'bot');
                }
            }
        } catch (error) {
            console.error('设置机器人表情失败:', error);
        }
    }

    // 设置棋子元素
    setupChessElements() {
        try {
            const playerChess = gameState.getPlayerChess();
            const pieceCount = gameState.pieceCount;

            for (let player = 1; player <= 4; player++) {
                const chessElements = document.querySelectorAll(`#board-svg use[href="#chess"].player-${player}`);
                for (let i = 0; i < pieceCount; i++) {
                    if (chessElements[i]) {
                        playerChess[player][i].element = chessElements[i];
                        // 设置初始位置，跳过同步（游戏初始化不需要同步）
                        animation.moveChessToStart(player, i, null, true);
                    }
                }

                for (let i = pieceCount; i < chessElements.length; i++) {
                    if (chessElements[i]) {
                        chessElements[i].style.display = 'none';
                    }
                }
            }
        } catch (error) {
            console.error('设置棋子元素失败:', error);
        }
    }

    // 重置游戏
    async resetGame() {
        try {
            audioManager.suspend();
            console.log('重置游戏...');

            uiUpdater.stopThinkingProgressBar();

            // 优先从sessionStorage读取配置，其次回退到URL参数
            let humanPlayer = 1;
            let playerName = '玩家';
            let activeBots = [];

            const gameConfigStr = sessionStorage.getItem('gameConfig');
            if (gameConfigStr) {
                try {
                    const gameConfig = JSON.parse(gameConfigStr);
                    if (gameConfig.mode === 'local_multiplayer') {
                        if (gameConfig.players && gameConfig.players.length > 0) {
                            humanPlayer = gameConfig.players[0].id;
                            playerName = gameConfig.players[0].name;
                        }
                    } else {
                        humanPlayer = gameConfig.humanPlayer || 1;
                        playerName = gameConfig.humanUsername || '玩家';
                        activeBots = gameConfig.bots || [];
                    }
                    console.log(`从sessionStorage获取人类玩家信息：玩家${humanPlayer}`);
                } catch (error) {
                    console.error('解析sessionStorage游戏配置失败:', error);
                }
            } else {
                const urlParams = new URLSearchParams(window.location.search);
                const playerColor = urlParams.get('playerColor');
                const urlPlayerName = urlParams.get('playerName');
                const urlActiveBots = urlParams.get('activeBots');

                if (playerColor) {
                    humanPlayer = parseInt(playerColor);
                }
                if (urlPlayerName) {
                    playerName = urlPlayerName;
                }
                if (urlActiveBots) {
                    activeBots = urlActiveBots.split(',').map(Number);
                }
                console.log(`从URL参数获取人类玩家信息：玩家${humanPlayer}`);
            }

            await gameState.resetGame();

            eventHandler.updatePauseButtonText();

            this.resetChessPositions();

            gameState.setGamePhase('waiting');

            gameState.setCurrentPlayer(humanPlayer);
            activePlayerManager.setCurrentActivePlayer(humanPlayer);
            console.log(`重置游戏，设置当前玩家为人类玩家：${humanPlayer}`);

            if (activeBots.length > 0) {
                playerNameManager.setupPlayersWithActiveBots(humanPlayer, playerName, activeBots);
                this.updatePlayerName(humanPlayer, playerName);
                gameState.setBotPlayers(activeBots);
                console.log(`重置后重新设置玩家名称：玩家${humanPlayer} -> ${playerName}`);
            }

            // 单机/人机重开一局同样要把棋面交回共享引擎，
            // 否则引擎状态停在上一局，走棋会退回已废弃的前端旧规则
            if (!gameState.getIsOnlineMultiplayer()) {
                engineAdapter.reset({
                    players: activePlayerManager.getActivePlayers(),
                    piecesPerPlayer: gameState.pieceCount,
                    happy: gameState.isHappyMode(),
                    skillMode: gameState.isSkillModeEnabled(),
                    startEnergy: gameState.getInitialEnergy(),
                    currentPlayer: gameState.getCurrentPlayer()
                });
                gameState.engineDriven = true;
                energyManager.syncFromState(engineAdapter.state ? engineAdapter.state.energy : {});
            }

            uiUpdater.updateUI();

            gameInfo.clearMessages();

            // 联机模式下只有房主发送游戏开始消息，避免重复显示
            if (!this.multiplayerGameManager || !this.multiplayerGameManager.isOnlineMode || this.multiplayerGameManager.isHostPlayer()) {
                const currentPlayer = gameState.getCurrentPlayer();
                gameInfo.addGameStart(currentPlayer);
            }

            this.defeatCountDisplay.resetAllDefeatCounts();
            this.progressDisplay.resetAllProgress();

            this.handleGameStart();

            if (gameConfigStr) {
                try {
                    const gameConfig = JSON.parse(gameConfigStr);
                    this.updatePageTitle(gameConfig);
                } catch (error) {
                    console.error('更新页面标题失败:', error);
                }
            }

            console.log('游戏重置完成');
            audioManager.resume();
            gameState.hidePauseIndicator();
        } catch (error) {
            console.error('重置游戏失败:', error);
        }
    }

    // 重置棋子位置
    resetChessPositions() {
        try {
            const pieceCount = gameState.pieceCount;
            for (let player = 1; player <= 4; player++) {
                for (let i = 0; i < pieceCount; i++) {
                    // 将所有棋子移动到起始位置，跳过同步（游戏初始化不需要同步）
                    animation.moveChessToStart(player, i, null, true);
                }
            }
        } catch (error) {
            console.error('重置棋子位置失败:', error);
        }
    }

    // 开始游戏（从waiting状态转换到rolling状态）
    startGame() {
        try {
            const gamePhase = gameState.getGamePhase();
            if (gamePhase === 'waiting') {
                gameState.setGamePhase('rolling');
                uiUpdater.updateUI();
                console.log('游戏开始');
            }
        } catch (error) {
            console.error('开始游戏失败:', error);
        }
    }

    // 暂停游戏。force：重连恢复时本地阶段可能还停在 waiting，
    // 也要按服务端的暂停态落到 paused，否则恢复会把阶段还原成 waiting
    pauseGame({ force = false } = {}) {
        try {
            const gamePhase = gameState.getGamePhase();
            const canPause = force
                ? gamePhase !== 'finished'
                : (gamePhase !== 'finished' && gamePhase !== 'waiting');
            if (canPause) {
                gameState.setGamePhase('paused');
                uiUpdater.updateUI();
            }
        } catch (error) {
            console.error('暂停游戏失败:', error);
        }
    }

    // 恢复游戏
    resumeGame() {
        const playablePhases = ['rolling', 'selecting', 'moving'];
        try {
            const gamePhase = gameState.getGamePhase();

            // 恢复到暂停前的阶段；阶段不是 paused 时也不能整段跳过
            //（刷新回来的客户端会停在 waiting：骰子不可用、进度条不走）
            if (gamePhase === 'paused') {
                const phaseBeforePause = gameState.gamePhaseBeforePause;
                gameState.setGamePhase(playablePhases.includes(phaseBeforePause) ? phaseBeforePause : 'rolling');
            } else if (!playablePhases.includes(gamePhase)) {
                gameState.setGamePhase('rolling');
            }

            uiUpdater.updateUI();

            // 重新启动思考计时器和进度条
            if (playablePhases.includes(gameState.getGamePhase())) {
                if (window.uiUpdater && typeof window.uiUpdater.resumeThinkingProgressBar === 'function') {
                    window.uiUpdater.resumeThinkingProgressBar(() => {
                        console.log(`玩家${gameState.getCurrentPlayer()}思考时间到，自动切换到下一个玩家`);
                        if (this.dice && typeof this.dice.handleThinkingTimeoutWrapper === 'function') {
                            this.dice.handleThinkingTimeoutWrapper();
                        }
                    });
                } else if (window.uiUpdater && typeof window.uiUpdater.startThinkingProgressBar === 'function') {
                    window.uiUpdater.startThinkingProgressBar(() => {
                        console.log(`玩家${gameState.getCurrentPlayer()}思考时间到，自动切换到下一个玩家`);
                        if (this.dice && typeof this.dice.handleThinkingTimeoutWrapper === 'function') {
                            this.dice.handleThinkingTimeoutWrapper();
                        }
                    });
                }
            }
        } catch (error) {
            console.error('恢复游戏失败:', error);
        }
    }

    // 调试方法：移动棋子
    debugMoveChess() {
        try {
            chessPiece.debugMoveChess();
        } catch (error) {
            console.error('调试移动棋子失败:', error);
        }
    }

    // 调试方法：完成棋子
    debugFinishChess() {
        finishAllChess();
    }

    // 调试方法：掷指定点数的骰子（控制台入口，实际逻辑在 debugTools）
    async debugRollDice(value) {
        await debugSetDice(value);
    }

    // 销毁游戏实例
    async destroy() {
        try {
            eventHandler.removeEventListeners();
            await gameState.resetGame();
            console.log('游戏实例已销毁');
        } catch (error) {
            console.error('销毁游戏实例失败:', error);
        }
    }


    // 处理游戏开始时的bot逻辑
    handleGameStart() {
        try {
            const gamePhase = gameState.getGamePhase();
            const isOnlineMultiplayer = gameState.getIsOnlineMultiplayer();
            if (isOnlineMultiplayer) {
                return;
            }

            if (botController.isCurrentPlayerBot()) {
                // 延迟一小段时间让UI完全初始化
                setTimeout(() => {
                    botController.handleBotTurn();
                    uiUpdater.updateUI();
                }, 500);
            } else {
                if (gamePhase === 'waiting') {
                    gameState.setGamePhase('rolling');
                    uiUpdater.updateUI();
                }
            }
        } catch (error) {
            console.error('处理游戏开始时的bot逻辑失败:', error);
        }
    }
}

// 生成入口运行时：封装 gameInstance 生命周期与全局引导函数
export function createGameRuntime(GameClass) {
    let gameInstance = null;

    function initializeGame() {
        try {
            window.audioManager = audioManager;
            window.aiTakeoverManager = aiTakeoverManager;

            if (gameInstance) {
                gameInstance.destroy();
            }

            gameInstance = new GameClass();

            window.main = gameInstance;
            window.eventHandler = gameInstance.eventHandler;

            window.gameState = gameState;
            window.uiUpdater = uiUpdater;
            window.gameInfo = gameInfo;
            window.botController = botController;

            // 只有在非联机模式下才设置为单机模式
            if (window.audioManager && !gameState.getIsOnlineMultiplayer()) {
                window.audioManager.setSinglePlayerMode();
            }

            return gameInstance;
        } catch (error) {
            console.error('初始化游戏失败:', error);
            return null;
        }
    }

    function updatePageTitle() {
        if (gameInstance) {
            const gameConfigStr = sessionStorage.getItem('gameConfig');
            if (gameConfigStr) {
                try {
                    const gameConfig = JSON.parse(gameConfigStr);
                    gameInstance.updatePageTitle(gameConfig);
                } catch (error) {
                    console.error('更新页面标题失败:', error);
                    document.title = '极简飞行棋';
                }
            } else {
                document.title = '极简飞行棋';
            }
        }
    }

    // 渲染房间号区域，返回URL中的房间号
    function setupRoomCodeDisplay() {
        const urlParams = new URLSearchParams(window.location.search);
        const roomCode = urlParams.get('room');

        const controlTitle = document.querySelector('.control-title');
        const roomCodeDisplay = document.getElementById('gameRoomCodeDisplay');
        const roomCodeElement = document.getElementById('gameRoomCode');
        const roomCodeDisplayColumn = document.getElementById('gameRoomCodeDisplayColumn');
        const roomCodeElementColumn = document.getElementById('gameRoomCodeColumn');

        if (roomCode) {
            if (roomCodeDisplay && roomCodeElement) {
                roomCodeElement.textContent = roomCode;
            }
            if (roomCodeDisplayColumn && roomCodeElementColumn) {
                roomCodeElementColumn.textContent = roomCode;
            }
            if (controlTitle) {
                controlTitle.style.display = 'block';
            }
        } else {
            if (controlTitle) {
                controlTitle.style.display = 'none';
            }
            if (roomCodeDisplayColumn) {
                roomCodeDisplayColumn.style.display = 'none';
            }
        }

        return roomCode;
    }

    return { initializeGame, updatePageTitle, setupRoomCodeDisplay };
}

window.toggleDebugPanel = function() {
    const debugSection = document.querySelector('.debug-section');
    if (debugSection && debugSection.classList.contains('is-enabled')) {
        debugSection.classList.toggle('show-debug');
    }
};

// 注册全局 getter，在控制台输入 debug 回车即可启用/停用调试功能
Object.defineProperty(window, 'debug', {
    get: function() {
        const debugSection = document.querySelector('.debug-section');
        if (debugSection) {
            const isEnabled = debugSection.classList.toggle('is-enabled');
            if (!isEnabled) {
                debugSection.classList.remove('show-debug');
            }
            return `调试功能已${isEnabled ? '启用 (可点击左侧把手展开面板)' : '停用'}`;
        }
        return '未找到调试面板元素';
    },
    configurable: true
});
