/**
 * 多人游戏通讯管理器 —— 对局内的 WebSocket 连接与消息同步。
 *
 * 这里只该做两件事：把服务端消息翻译成对棋面/界面的动作，以及把玩家的意图发上去。
 * 具体规则不在这里：棋面由快照驱动（去重见 snapshotGate.js，补帧与追赶见 _drainSnapshots），
 * 事件表现交给 enginePlayback，AI 出手由服务端负责（backend/botDriver.cjs），身份判断读 aiPlayers.js。
 * 新加逻辑前先想想它是否属于上面某一块，别让这个文件继续长。
 */

import { reconnectManager } from './reconnectManager.js';
import { activePlayerManager } from './activePlayerManager.js';
import { playerIdManager } from './playerIdManager.js';
import { engineAdapter } from './engineAdapter.js';
import { enginePlayback } from './enginePlayback.js';
import { createState, apply, makeRng } from '../../shared/engine.mjs';
import { decodeArchive } from '../../shared/replayCodec.mjs';
import { SnapshotGate } from './snapshotGate.js';
import { isAiDriven, isTakeoverPlayer } from './aiPlayers.js';
import { energyManager } from './energyManager.js';
import { DICE_SYMBOLS } from './utils.js';
import { gameState } from './gameState.js';
import { uiUpdater } from './uiUpdater.js';
import { gameInfo } from './gameInfo.js';

// 会驱动棋子位移动画的事件，用于在动画开播时统一进度条起点
const MOVE_EVENT_TYPES = new Set(['launch', 'walk', 'jump', 'fly', 'finish', 'beat', 'collide', 'reset', 'teleport']);

// 快照自愈心跳：服务端每次状态变更都会广播，这里只做低频兜底，捕捉极偶发的丢帧
const SNAPSHOT_SELF_HEAL_INTERVAL_MS = 25000;
const SNAPSHOT_RETRY_LIMIT = 3;

// 联机连接保活：手机切网、系统休眠都会留下「socket 还在、其实已死」的半开连接，
// 靠 ping/pong 才能发现，否则玩家会一直以为自己在房间里却收不到任何消息。
const WS_PING_INTERVAL_MS = 15000;

// 服务端已经没有这局/这间房（重启、被清理）：重连与自愈都救不回来，直接回主页
const SCENE_GONE_ERRORS = ['游戏会话不存在', '房间不存在'];

class MultiplayerGameManager {
    constructor() {
        this.wsClient = null;
        this.isHost = false;
        this.gameSessionId = null;
        this.playerId = null;
        this.players = new Map();
        this.aiTakeoverPlayers = new Set(); // 记录处于AI托管状态的玩家ID
        this.defeatedChessPositionCache = new Map(); // key: player-chessIndex，值: { x, y, timestamp }

        this.disableReconnect = false;
        this.gameInstance = null;
        this.isConnected = false;
        this.isOnlineMode = false; // 初始化为false，在init时设置为true
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 3000;

        // 仅当“游戏内WebSocket确实断开过”才视为需要重连UI
        this._didDisconnectOnce = false;

        // 跟踪玩家连接状态，避免重复处理断开和重连事件
        this._playerConnectionStatus = new Map(); // playerId -> isConnected

        this._pendingUIRefresh = null; // 骰子闪烁期间被推迟的 UI 刷新
        this._localRollIssued = false; // 本机是否已自行发起并播放了本次投掷动画
        this._localMoveEvents = null; // 本机抢先演过的那一手走子的事件（等快照回来比对）
        this._localMovePlayback = null; // 那一手的动画还在演时，快照落地要等它收尾

        this._snapshotGate = new SnapshotGate(); // 快照水位：去重旧帧、换会话归零
        this._snapshotRetryCount = 0; // 快照应用连续失败次数
        this._catchUpMode = false; // 应用期间又收到新帧 → 本地落后，后续帧定格追赶
        this._serverThinkingWindow = null; // 已经采纳过的服务端思考窗起点，换了就是新阶段
        this._snapshotSelfHealStarted = false;
        this._visibilityHandler = null;
        this._snapshotHeartbeat = null;

        this._wsHeartbeat = null;
        this._wsAlive = true; // 上一轮心跳是否收到 pong，false 表示连接已半死
    }

    /**
     * 标记本机已发起投掷动画。
     * 用于区分「自己摇的骰子」与「别处同步来的骰子」：
     * 后者点数虽归属本机，本地却没有动画在播，快照到达时需要补播闪烁。
     */
    markLocalRollIssued() {
        this._localRollIssued = true;
    }

    /**
     * 标记本机已抢先用本地引擎演过一手走子（联机，见 chessPiece.playMovePreview）。
     * 快照回来时按事件逐字比对：对上了就只落权威位置，不再重演一遍。
     */
    markLocalMoveIssued(events, playback = null) {
        this._localMoveEvents = Array.isArray(events) ? events : null;
        this._localMovePlayback = playback || null;
    }

    stopDiceFlashing() {
        // 停止骰子闪烁动画（如果正在进行）
        if (this.currentFlashInterval) {
            clearInterval(this.currentFlashInterval);
            this.currentFlashInterval = null;
        }
        if (this._diceFlashSafetyTimer) {
            clearTimeout(this._diceFlashSafetyTimer);
            this._diceFlashSafetyTimer = null;
        }
        const diceDisplay = document.getElementById('diceDisplay');
        if (diceDisplay) {
            diceDisplay.classList.remove('dice-waiting', 'dice-flashing');

        }
    }

    _mergePlayerIntoMap(player) {
        if (!player?.id) return;
        const existing = this.players.get(player.id) || {};
        
        this.players.set(player.id, { ...existing, ...player });

        // 玩家列表是表情的唯一来源，每次合并都顺手贴回头像，
        // 免得换人/重连/改表情后头像空着
        if (player.color && player.emoji) {
            window.gameInstance?.updatePlayerEmoji?.(player.color, player.emoji);
        }
    }

    _mergePlayersFromPayload(data) {
        if (!data) return;

        if (data.player) {
            this._mergePlayerIntoMap(data.player);
        }
        
        if (data.players && Array.isArray(data.players)) {
            for (const p of data.players) {
                this._mergePlayerIntoMap(p);
            }
        }

        if (data.room?.players && Array.isArray(data.room.players)) {
            for (const p of data.room.players) {
                this._mergePlayerIntoMap(p);
            }
        }

        if (data.gameSession?.players && Array.isArray(data.gameSession.players)) {
            for (const p of data.gameSession.players) {
                this._mergePlayerIntoMap(p);
            }
        }

        // 更新 activePlayerManager
        this._updateActivePlayers();
    }

    _updateActivePlayers() {
        const activePlayers = [];
        for (const [, player] of this.players) {
            if (player.color) {
                activePlayers.push(player.color);
            }
        }
        if (activePlayers.length > 0) {
            activePlayers.sort((a, b) => a - b);
            activePlayerManager.setActivePlayers(activePlayers);
        }
    }

    _safeUpdateUI() {
        // 本地掷骰动画进行中：整个 UI 刷新都要让路，否则 updateUI 内部的
        // updateDiceDisplay 会把 dice-flashing 摘掉，闪烁就没了
        const diceDisplay = document.getElementById('diceDisplay');
        if (diceDisplay && diceDisplay.classList.contains('dice-flashing')) {
            // 直接丢弃会让这次快照带来的可移动高亮、回合信息整段失效。
            // 掷骰者本地没有其他补刷点（远端玩家在应用快照前就已停闪，故不受影响），
            // 于是表现为「只有自己看不到自己的可移动高亮」。这里等闪烁收尾后重放一次。
            if (this._pendingUIRefresh) clearTimeout(this._pendingUIRefresh);
            this._pendingUIRefresh = setTimeout(() => {
                this._pendingUIRefresh = null;
                this._safeUpdateUI();
            }, 150);
            return;
        }
        // 骰子外观完全由快照投影后的 gameState 推导，不再沿用历史掷骰者，
        // 否则回合已推进时会把骰子染成上家的点数与颜色
        try {
            uiUpdater?.updateUI?.();
        } catch (e) {
            // ignore
        }
    }

    /**
     * 播放骰子摇动动画。本地掷骰与远端同步共用，保证所有玩家看到的骰子节奏一致。
     * 传入 owner 时给骰面标上掷骰者的玩家类：亮色下闪烁仍是中性色，暗色下按玩家配色走。
     */
    startDiceFlashing(owner = null) {
        const diceDisplay = document.getElementById('diceDisplay');
        if (!diceDisplay) return;
        this.stopDiceFlashing();
        diceDisplay.className = diceDisplay.className.replace(/player-\d+/g, '');
        diceDisplay.classList.remove('dice-waiting', 'dice-glowing', 'not-rolled', 'rolled', 'dice-flashing');
        if (owner !== null && owner !== undefined) {
            diceDisplay.classList.add(`player-${owner}`);
        }
        void diceDisplay.offsetWidth; // 强制重排
        diceDisplay.classList.add('dice-flashing');
        this.rollStartTime = Date.now();
        this.currentFlashInterval = setInterval(() => {
            diceDisplay.textContent = DICE_SYMBOLS[Math.floor(Math.random() * 6)];
        }, 100);
    }

    cacheDefeatedChessPosition(player, chessIndex) {
        const chess = this.gameInstance?.gameState?.playerChess?.[player]?.[chessIndex];
        const element = chess?.element;
        if (!element || typeof element.getBoundingClientRect !== 'function') {
            return;
        }

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return;
        }

        const cacheKey = `${player}-${chessIndex}`;
        this.defeatedChessPositionCache.set(cacheKey, {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            timestamp: Date.now()
        });
    }

    consumeDefeatedChessPosition(player, chessIndex) {
        const cacheKey = `${player}-${chessIndex}`;
        const cachedPosition = this.defeatedChessPositionCache.get(cacheKey);
        if (!cachedPosition) {
            return null;
        }

        this.defeatedChessPositionCache.delete(cacheKey);

        // 只使用很短时间内的缓存，避免旧坐标污染后续动画
        if (Date.now() - cachedPosition.timestamp > 3000) {
            return null;
        }

        return {
            x: cachedPosition.x,
            y: cachedPosition.y
        };
    }

    /**
     * 初始化多人游戏管理器
     */
    async init(multiplayerGameData, gameInstance) {
        this.gameInstance = gameInstance;
        this.isSpectator = multiplayerGameData.isSpectator || false;
        // 每次进入联机初始化前清理状态，避免跨局残留导致AI误判
        this.players.clear();
        this.aiTakeoverPlayers.clear();
        this._localRollIssued = false;
        this._localMoveEvents = null;
        this._localMovePlayback = null;
        // 新一局重新开始计数 seq，水位必须清零，否则新会话快照会被旧水位挡掉
        this._snapshotGate.reset();
        this._snapshotRetryCount = 0;
        this._catchUpMode = false;
        this._serverThinkingWindow = null;
        
        // sessionStorage 只存了 playerId / serverUrl，缺失时各自兜底即可，
        // 不必再 new 一个从不 connect 的 WebSocketClient
        const clientInfo = multiplayerGameData.wsClient || {};
        this.playerId = clientInfo.playerId || playerIdManager.getPlayerId();
        this.serverUrl = clientInfo.serverUrl || '';
        this.isOnlineMode = true; // 设置为联机模式
        // 联机模式不置 engineDriven：该标志代表「本地引擎持权威」，仅单机/人机使用。
        // 联机的走子必须走 sendIntent 交给服务端裁决，否则本地推进回合而服务端不知情。
        this.hasPrintedGameStart = false; // 跟踪是否已经打印过游戏开始消息
        this.isFreshStart = !multiplayerGameData.isReconnecting; // 标记是否为全新正常开局
        // 每次页面加载只拉一次历史，避免普通断线重连时把面板里已有的消息再叠一遍
        this._historyRequested = false;

        // 无论是否观战，都确保 audioManager 处于正确模式
        if (window.audioManager) {
            window.audioManager.setMultiplayerMode(true);
        }

        // 观战模式特殊处理
        if (this.isSpectator) {
            console.log('以观战模式初始化...');
            this.roomCode = multiplayerGameData.roomCode;
            try {
                await this.connectToServer(this.serverUrl);
                this.rejoinGameSession();
            } catch (e) {
                console.error('观战连接失败', e);
            }
            return;
        }

        // 玩家路径统一开启快照自愈：回到前台、重连、周期兜底都会主动对齐一次棋面
        this.startSnapshotSelfHeal();

        // 检查是否是重连模式
        if (multiplayerGameData.isReconnecting) {
            console.log('检测到重连模式，等待游戏初始化完成...');
            this.isReconnecting = true;
            this.gameSessionId = multiplayerGameData.gameSessionId; // 使用gameSessionId而不是roomCode

            // 保存游戏会话ID到重连管理器
            reconnectManager.updateGameSessionId(this.gameSessionId);

            // 初始化音频加载状态跟踪（重连时也需要）
            this.audioLoadedPlayers = new Set();
            // 只计算真实玩家数量（排除AI），因为AI不需要加载音频
            this.totalPlayers = multiplayerGameData.players ? multiplayerGameData.players.filter(p => !p.isAI).length : 0;
            this.gameInitialized = false;

            // 初始化玩家数据（重连时也需要）
            for (const player of multiplayerGameData.players) {
                this.players.set(player.id, {
                    id: player.id,
                    color: player.color,
                    nickname: player.nickname,
                    emoji: player.emoji,
                    isAI: player.isAI,
                    isAITakeover: player.isAITakeover || false
                });
                
                // 如果断线前已经是AI托管，恢复状态
                if (player.isAITakeover || (player.isAI && this.gameInstance && !this.gameInstance.gameState.isBotPlayer(player.color))) {
                    this.aiTakeoverPlayers.add(player.id);
                }
            }
            this._syncBotFlagsFromRoster(multiplayerGameData.players);

            // 更新 activePlayers
            this._updateActivePlayers();

            // 等待游戏完全初始化后再连接服务器
            await this.waitForGameInitialization();

            // 重新绑定棋子DOM元素（重连时可能需要重新绑定）
            this.rebindChessElements();

            // 建立WebSocket连接
            await this.connectToServer(this.serverUrl);

            // 重新加入游戏会话而不是等待roomJoined消息
            this.rejoinGameSession();
            return;
        }

        // 正常的游戏初始化流程
        this.isHost = multiplayerGameData.isHost;
        this.gameSessionId = multiplayerGameData.gameSessionId; // 使用gameSessionId替代roomCode

        // 保存游戏会话ID到重连管理器，用于断线重连
        reconnectManager.updateGameSessionId(this.gameSessionId);

        // 初始化音频加载状态跟踪
        this.audioLoadedPlayers = new Set(); // 已加载音频的玩家
        // 只计算真实玩家数量（排除AI），因为AI不需要加载音频
        this.totalPlayers = multiplayerGameData.players.filter(p => !p.isAI).length;
        this.gameInitialized = false; // 游戏是否已完成初始化

        // 初始化玩家数据 - 使用玩家ID作为键，而不是数字
        for (const player of multiplayerGameData.players) {
            // 确保使用字符串ID作为键，保持与服务器数据一致
            this.players.set(player.id, {
                id: player.id,
                color: player.color,
                nickname: player.nickname,
                emoji: player.emoji,
                isAI: player.isAI,
                isAITakeover: player.isAITakeover || false
            });
            
            // 如果断线前已经是AI托管，恢复状态
            if (player.isAITakeover || (player.isAI && this.gameInstance && !this.gameInstance.gameState.isBotPlayer(player.color))) {
                this.aiTakeoverPlayers.add(player.id);
            }
        }

        // 更新 activePlayers
        this._updateActivePlayers();

        // 建立WebSocket连接
        await this.connectToServer(this.serverUrl);

        // 重新加入游戏会话
        this.rejoinGameSession();
    }

    // 重新绑定棋子DOM元素
    rebindChessElements() {
        if (!window.gameState || !window.gameState.playerChess) {
            console.error('gameState或playerChess未初始化');
            return;
        }

        const pieceCount = window.gameState.pieceCount || 4;
        let totalBoundElements = 0;

        // 获取激活玩家列表
        const activePlayers = activePlayerManager.getActivePlayers();

        for (let player = 1; player <= 4; player++) {
            const isActive = activePlayers.includes(player);
            const chessElements = document.querySelectorAll(`#board-svg use[href="#chess"].player-${player}`);

            if (!isActive) {
                // 不参与的玩家：隐藏所有棋子
                chessElements.forEach(element => {
                    element.style.display = 'none';
                });
                continue;
            }

            if (!window.gameState.playerChess[player]) continue;

            // 有效棋子绑定：已有引用的保留，没有的按DOM索引匹配
            for (let chessIndex = 0; chessIndex < pieceCount; chessIndex++) {
                const chess = window.gameState.playerChess[player][chessIndex];
                if (!chess) continue;

                if (chess.element && chess.element.parentNode) {
                    totalBoundElements++;
                } else if (chessIndex < chessElements.length && chessElements[chessIndex]) {
                    chess.element = chessElements[chessIndex];
                    totalBoundElements++;
                } else {
                    console.error(`找不到玩家${player}棋子${chessIndex}的DOM元素`);
                }
            }

            // 显示/隐藏：不依赖DOM顺序，根据element引用判断
            const validElements = new Set();
            for (let chessIndex = 0; chessIndex < pieceCount; chessIndex++) {
                const chess = window.gameState.playerChess[player][chessIndex];
                if (chess && chess.element) {
                    validElements.add(chess.element);
                }
            }
            for (let i = 0; i < chessElements.length; i++) {
                if (validElements.has(chessElements[i])) {
                    chessElements[i].style.display = '';
                } else {
                    chessElements[i].style.display = 'none';
                }
            }
        }

        console.log(`[rebindChessElements] 重新绑定了 ${totalBoundElements} 个棋子元素`);
    }

    /**
     * 通知音频加载完成
     */
    notifyAudioLoaded() {
        if (this.isSpectator) return;
        console.log('[音频] 本地音频预加载完成');
        
        // 如果不在联机模式，直接返回
        if (!this.isOnlineMode) {
            return;
        }

        // 如果WebSocket未连接，加入待发送队列
        if (!this.isConnected) {
            if (!this.pendingMessages) {
                this.pendingMessages = [];
            }
            this.pendingMessages.push({
                type: 'audioLoaded',
                data: {
                    playerId: this.playerId,
                    timestamp: Date.now()
                }
            });
            return;
        }
        this.sendMessage('audioLoaded', {
            playerId: this.playerId,
            timestamp: Date.now()
        });
    }

    /**
     * 处理音频加载完成消息
     */
    handleAudioLoaded(data) {
        if (!this.audioLoadedPlayers) {
            this.audioLoadedPlayers = new Set();
        }
        this.audioLoadedPlayers.add(data.playerId);

        const isLocalLoaded = window.audioManager && window.audioManager.isLoaded;
        const isAllLoaded = window.audioManager && window.audioManager.allPlayersAudioLoaded;

        // 只要本地加载完了且全员还没就位，就显示进度
        if (window.audioManager && isLocalLoaded && !isAllLoaded && this.totalPlayers > 0) {
            if (typeof window.audioManager.updateLoadingText === 'function') {
                window.audioManager.updateLoadingText(`等待其他玩家加载... ${this.audioLoadedPlayers.size}/${this.totalPlayers}`);
            }
        }
    }

    /**
     * 处理所有玩家音频加载完成
     */
    handleAllAudioLoaded(data) {
        if (this.isSpectator) {
            this.gameInitialized = true;
            if (this.gameInstance && this.gameInstance.gameState) {
                this.gameInstance.gameState.setGameOfficiallyStarted(true);
            }
            if (window.audioManager) {
                window.audioManager.onAllPlayersAudioLoaded();
            }
            return;
        }
        console.log('[音频] 收到全员加载完成信号 (allAudioLoaded):', data);
        
        // 标记游戏已完成初始化
        this.gameInitialized = true;
        
        // 全员加载后解禁暂停按钮，但托管按钮需等待首发玩家操作
        if (this.gameInstance && this.gameInstance.gameState) {
            
            // 主动触发一次按钮状态更新
            if (window.aiTakeoverManager && typeof window.aiTakeoverManager.updateToggleButton === 'function') {
                window.aiTakeoverManager.updateToggleButton();
            }
            if (window.eventHandler && typeof window.eventHandler.updatePauseButtonText === 'function') {
                window.eventHandler.updatePauseButtonText();
            }
        }

        // 通知audioManager所有玩家音频已加载完成
        if (window.audioManager) {
            window.audioManager.onAllPlayersAudioLoaded();
        }

        // 全员加载完成后，发送游戏开始信息
        if (this.gameInstance && this.gameInstance.gameInfo) {
            // 只在首次全新正常开局（非重连、非刷新）且尚未发送过提示时显示
            if (this.isFreshStart && !this.hasPrintedGameStart) {
                const currentPlayer = this.gameInstance.gameState.getCurrentPlayer();
                // 所有人都会收到allAudioLoaded信号并在本地输出，因此设置skipSync=true避免互相广播导致重复
                this.gameInstance.gameInfo.addGameStart(currentPlayer, true);
                this.hasPrintedGameStart = true;
            }
        }

        // 重连/刷新触发的 allAudioLoaded（isResync=true）不触发任何游戏操作。
        // AI操作由权威快照落地后的回调驱动。
        if (data.isResync) {
            return;
        }

        // 检查当前玩家是否为AI，如果是则触发AI操作
        if (this.gameInstance && this.gameInstance.gameState) {
            // 如果当前游戏处于暂停状态，不要触发任何进度条或AI操作
            if (this.gameInstance.gameState.getIsPaused()) {
                return;
            }
            const currentPlayer = this.gameInstance.gameState.getCurrentPlayer();
            // AI 与托管玩家的出手都在服务端（botDriver），客户端只把「等待中」的阶段扶正
            const isBotPlayer = this.gameInstance.gameState.isBotPlayer(currentPlayer);
            if (!isBotPlayer && this.gameInstance.gameState.getGamePhase() === 'waiting') {
                this.gameInstance.gameState.setGamePhase('rolling');
                if (window.uiUpdater) {
                    window.uiUpdater.updateUI();
                }
            }
        }
    }

    /**
     * 等待游戏完全初始化
     */
    async waitForGameInitialization() {
        return new Promise((resolve) => {
            const checkInitialization = () => {
                if (window.gameState && window.uiUpdater && window.gameInfo) {
                    console.log('游戏初始化完成');
                    resolve();
                } else {
                    console.log('等待游戏初始化...', {
                        gameState: !!window.gameState,
                        uiUpdater: !!window.uiUpdater,
                        gameInfo: !!window.gameInfo
                    });
                    setTimeout(checkInitialization, 100);
                }
            };
            checkInitialization();
        });
    }

    /**
     * 连接到服务器
     */
    async connectToServer(serverUrl) {
        return new Promise((resolve, reject) => {
            this.stopWsHeartbeat();
            try {
                // 旧连接的回调必须先摘掉：它会往新 socket（还在 CONNECTING）上发消息，直接抛错
                const previous = this.wsClient;
                if (previous) {
                    previous.onopen = previous.onmessage = previous.onclose = previous.onerror = null;
                    try {
                        previous.close();
                    } catch (e) {
                        // ignore
                    }
                }

                const socket = new WebSocket(serverUrl);
                this.wsClient = socket;

                socket.onopen = () => {
                    if (this.wsClient !== socket) return;
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.startWsHeartbeat();
                    // 一上来就把前后台状态报给服务端：一进后台的页面不该被服务端等着演完
                    this.reportVisibility();
                    // 发送待发送的消息队列
                    this.processPendingMessages();

                    resolve();
                };

                socket.onmessage = (event) => {
                    if (this.wsClient !== socket) return;
                    try {
                        const data = JSON.parse(event.data);
                        // pong 只是保活回执，不进业务分发，免得刷一堆未知消息告警
                        if (data && data.type === 'pong') {
                            this._wsAlive = true;
                            return;
                        }
                        this.handleMessage(data);
                    } catch (error) {
                        console.error('解析WebSocket消息失败:', error);
                    }
                };

                socket.onclose = () => {
                    if (this.wsClient !== socket) return;
                    console.log('游戏内WebSocket连接已关闭');
                    this.isConnected = false;
                    this.stopWsHeartbeat();
                    if (!this.disableReconnect) {
                        this._didDisconnectOnce = true;
                        this.attemptReconnect();
                    }
                };

                socket.onerror = (error) => {
                    if (this.wsClient !== socket) return;
                    console.error('游戏内WebSocket连接错误:', error);
                    this.isConnected = false;
                    this.stopWsHeartbeat();
                    reject(error);
                };

            } catch (error) {
                console.error('创建WebSocket连接失败:', error);
                reject(error);
            }
        });
    }

    /**
     * 心跳只用一个定时器：每轮先检查上一轮是否收到 pong，没有就认定连接已死并主动关闭，
     * 交给 onclose 走重连。这样即使浏览器把后台定时器节流到一分钟一次也不会误判，
     * 而且避免了额外的超时定时器被节流后误杀健康连接。
     */
    startWsHeartbeat() {
        this.stopWsHeartbeat();
        this._wsAlive = true;
        this._wsHeartbeat = setInterval(() => {
            const socket = this.wsClient;
            if (!socket || socket.readyState !== WebSocket.OPEN) return;

            if (!this._wsAlive) {
                console.warn('[心跳] 未收到 pong，判定连接已断开');
                try {
                    socket.close(4000, 'heartbeat timeout');
                } catch (e) {
                    // ignore
                }
                return;
            }

            this._wsAlive = false;
            try {
                socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
            } catch (e) {
                // 发送失败则等下一轮判定，这里不重复处理
            }
        }, WS_PING_INTERVAL_MS);
    }

    stopWsHeartbeat() {
        if (this._wsHeartbeat) {
            clearInterval(this._wsHeartbeat);
            this._wsHeartbeat = null;
        }
        this._wsAlive = true;
    }

    /**
     * 重新加入游戏会话
     */
    rejoinGameSession() {
        if (this.isSpectator) {
            if (this.isConnected && this.roomCode) {
                this.sendMessage('spectate_room', {
                    roomCode: this.roomCode,
                    // 观战页没有昵称输入，沿用大厅里保存过的那个，供聊天显示
                    nickname: playerIdManager.getSavedNickname() || ''
                });
            }
            return;
        }
        if (this.isConnected && this.gameSessionId && this.playerId) {
            this.sendMessage('rejoinGameSession', {
                gameSessionId: this.gameSessionId,
                playerId: this.playerId,
                needsHistory: !this._historyRequested
            });
            this._historyRequested = true;
        } else {
            console.warn('重新加入游戏会话失败 - 缺少必要信息:', {
                isConnected: this.isConnected,
                gameSessionId: this.gameSessionId,
                playerId: this.playerId
            });
        }
    }

    /**
     * 尝试重新连接
     */
    async attemptReconnect() {
        if (this.disableReconnect) {
            return;
        }
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('达到最大重连次数，停止重连');
            this.showConnectionError('连接已断开，请刷新页面重试');
            return;
        }

        this.reconnectAttempts++;

        try {
            await this.connectToServer(this.serverUrl);
            if (this.isConnected) {
                this.reconnectAttempts = 0;
                this.rejoinGameSession(); // 重新加入游戏会话
                // 断线期间服务端可能已推进多步，重连后立即对齐一次权威棋面
                this.requestSnapshot('重连成功', { force: true });
            }
        } catch (error) {
            console.error('重新连接失败:', error);
            setTimeout(() => {
                this.attemptReconnect();
            }, this.reconnectDelay);
        }
    }

    /**
     * 发送消息
     */
    sendMessage(type, data = {}) {
        if (this.isSpectator && !['spectate_room', 'rejoinRoom', 'audioLoaded', 'chatMessage'].includes(type)) {
            console.warn('[sendMessage] 观战模式，跳过消息发送:', type);
            return;
        }
        // 握手未完成时 send 会抛 InvalidStateError
        if (this.isConnected && this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            const message = {
                type,
                playerId: this.playerId,
                gameSessionId: this.gameSessionId, // 使用gameSessionId替代roomCode
                ...data
            };

            this.wsClient.send(JSON.stringify(message));
        } else {
            console.warn('WebSocket未连接，无法发送消息:', type, data);
        }
    }

    /**
     * 观战历史补偿：称号统计是本地按事件累加出来的，中途进来看不到之前拿的称号。
     * 服务端的档案里只有「种子 + 逐手动作」，取回来本地重算事件，静默喂给回放层补上。
     */
    async rebuildSpectateTitles(sessionId) {
        if (!sessionId) return;
        try {
            const response = await fetch(`/api/replay/${encodeURIComponent(sessionId)}`);
            if (!response.ok) return;
            const archive = decodeArchive(await response.json());
            if (!Array.isArray(archive.actions) || !archive.actions.length) return;

            const rng = makeRng(archive.seed);
            let state = createState({
                players: archive.colors,
                piecesPerPlayer: archive.pieceCount || 4,
                happy: Boolean(archive.happy),
                skillMode: Boolean(archive.skillMode),
                startEnergy: Number(archive.startEnergy) || 0
            });
            // 补跑的是历史：称号只补进战报，别当成刚拿到的弹一遍（静默窗口里结算）
            for (let index = 0; index < archive.actions.length; index += 1) {
                try {
                    const out = apply(state, archive.actions[index].p, archive.actions[index].a, rng);
                    state = out.state;
                    await enginePlayback.replay(out.events);
                } catch (error) {
                    console.warn('[观战] 历史补跑在第 ' + (index + 1) + ' 手停住:', error.message);
                    break;
                }
            }
        } catch (error) {
            console.warn('[观战] 历史补跑失败:', error.message);
        }
    }

    /**
     * 处理接收到的消息
     */
    handleMessage(data) {
        // 如果是观战加入成功
        if (data.type === 'spectateJoined') {
            // 如果服务器标记为重连（玩家观战自己的游戏），跳转到游戏页面
            if (data.isReconnect) {
                console.log('[重连] 检测到观战转重连，回到房间列表页');
                window.location.href = '/';
                return;
            }

            console.log('加入观战成功:', data);
            
            this.isSpectator = true;
            this.players.clear();
            this.aiTakeoverPlayers.clear();
            
            let activePlayers = [];
            
            // 优先使用 gameSession.players（包含所有真实玩家和AI玩家）
            const playersList = (data.gameSession && data.gameSession.players) ? data.gameSession.players : (data.room && data.room.players ? data.room.players : []);
            
            if (playersList.length > 0) {
                for (const player of playersList) {
                    this.players.set(player.id, {
                        id: player.id,
                        color: player.color,
                        nickname: player.nickname,
                        emoji: player.emoji,
                        isAI: player.isAI || false,
                        isAITakeover: player.isAITakeover || false
                    });
                    
                    if (player.isAITakeover || player.isAI) {
                        this.aiTakeoverPlayers.add(player.id);
                    }
                    
                    if (player.color) {
                        activePlayers.push(player.color);
                        // 更新昵称和AI托管状态显示
                        this.updatePlayerNicknameDisplay(player.id, player.nickname);
                        this.updatePlayerAITakeoverDisplay(player.id, player.isAITakeover);
                        
                        // 更新表情显示
                        if (player.emoji && window.gameInstance && window.gameInstance.updatePlayerEmoji) {
                            window.gameInstance.updatePlayerEmoji(player.color, player.emoji);
                        }
                    }
                }
            }
            
            // 初始化音频加载状态跟踪，确保后续 handleAudioLoaded 能正常工作
            this.audioLoadedPlayers = new Set();
            this.totalPlayers = activePlayers.length;
            this.gameInitialized = true;
            
            // 检查是否是道具模式，如果是则初始化积分管理器
            const isSkillMode = data.room && data.room.settings && data.room.settings.skillMode === true;
            if (isSkillMode) {
                // 更新sessionStorage，让积分管理器能读取到正确的配置
                const configStr = sessionStorage.getItem('gameConfig');
                let config = configStr ? JSON.parse(configStr) : { mode: 'online_multiplayer' };
                config.skillMode = true;
                config.pieceCount = data.room.settings.pieceCount || 4;
                sessionStorage.setItem('gameConfig', JSON.stringify(config));
                
                // 重新初始化积分系统和道具管理器
                if (window.energyManager) {
                    window.energyManager.init();
                }
                if (window.skillManager) {
                    window.skillManager.init();
                }
                if (this.gameInstance && this.gameInstance.energyDisplay) {
                    this.gameInstance.energyDisplay.init();
                }
                
                // 更新页面标题
                if (this.gameInstance && typeof this.gameInstance.updatePageTitle === 'function') {
                    this.gameInstance.updatePageTitle(config);
                }
            }

            if (activePlayers.length > 0) {
                activePlayers.sort((a, b) => a - b);
                activePlayerManager.setActivePlayers(activePlayers);
            }
            
            if (data.gameData) {
                this.gameSessionId = data.gameSessionId || (data.room && data.room.gameSessionId);
                this.restoreAuxState(data.gameData);
                // 中途进来观战：称号统计只在本地按事件累加，得把这一局补跑一遍才有
                this.rebuildSpectateTitles(this.gameSessionId);
                
                // 确保触发全员就绪逻辑，让观战可以解除等待遮罩
                if (window.audioManager) {
                    window.audioManager.onAllPlayersAudioLoaded();
                }
            }
            return;
        }

        // 如果是重连模式且收到roomJoined消息，完成初始化
        if (this.isReconnecting && data.type === 'roomJoined') {
            console.log('重连成功，收到房间信息:', data.room);
            this.handleReconnectRoomJoined(data);
            return;
        }

        switch (data.type) {
            case 'connected':
                // 处理连接确认消息，通常不需要特殊处理
                break;
            case 'teleportIcon':
                this.handleTeleportIcon(data);
                break;
            case 'playerTurnChange':
                this.handlePlayerTurnChange(data);
                break;
            case 'aiTakeoverChange':
                this.handleAITakeoverChange(data);
                break;
            case 'audioEnabledChange':
                this.handleAudioEnabledChange(data);
                break;
            case 'nicknameChange':
                this.handleNicknameChange(data);
                break;
            case 'gameEnd':
                this.handleGameEnd(data);
                break;
            case 'forceSettlement':
                this.handleForceSettlement(data);
                break;
            case 'progressBarStart':
                this.handleProgressBarStart(data);
                break;
            case 'gamePause':
                this.handleGamePaused(data);
                break;
            case 'gamePaused':
                this.handleGamePaused(data);
                break;
            case 'gameResume':
                this.handleGameResumed(data);
                break;
            case 'gameResumed':
                this.handleGameResumed(data);
                break;
            case 'playerLeft':
                this.handlePlayerLeft(data);
                break;
            case 'hostTransferred':
                this.handleHostTransferred(data);
                break;
            case 'gameInfo':
                this.handleGameInfo(data);
                break;
            case 'gameInfoHistory':
                this.applyGameInfoHistory(data);
                break;
            case 'gameSessionConnected':
                this.handleGameSessionConnected(data);
                break;
            case 'audioLoaded':
                this.handleAudioLoaded(data);
                break;
            case 'allAudioLoaded':
                this.handleAllAudioLoaded(data);
                break;
            case 'diceReset':
                this.handleDiceReset(data);
                break;
            case 'error':
                this.handleError(data);
                break;
            case 'chatMessage':
                // 调用eventHandler的showChatMessage方法显示消息
                // 传递服务器提供的playerName而不是依赖本地playerNameManager
                if (window.eventHandler) {
                    window.eventHandler.showChatMessage(data.message, data.playerNumber, data.playerName, data.isSystemMessage, data.isSpectatorMessage);
                } else {
                    console.warn('eventHandler 不存在，无法显示聊天消息');
                }

                // 同时添加到游戏信息
                if (window.gameInfo) {
                    window.gameInfo.addChatMessage(data.playerNumber, data.message, data.playerName, true, data.isSpectatorMessage);
                }
                break;
            case 'playerDisconnected':
                this.handlePlayerDisconnected(data);
                break;
            case 'playerReconnected':
                this.handlePlayerReconnected(data);
                break;
            case 'playerUpdated':
                this._mergePlayersFromPayload(data);
                this._safeUpdateUI();
                break;
            case 'playerJoined':
                this._mergePlayersFromPayload(data);
                this._safeUpdateUI();
                break;
            case 'gameAutoPaused':
                this.handleGameAutoPaused(data);
                break;
            case 'roomDestroying':
                this.handleRoomDestroying(data);
                break;
            case 'hostChanged':
                this.handleHostChanged(data);
                break;
            case 'gameSnapshot':
                this.handleGameSnapshot(data);
                break;
            case 'intentRejected':
                this.handleIntentRejected(data);
                break;
            default:
                console.warn('未知的游戏消息类型:', data.type);
        }
    }

    /**
     * 发送动作意图。联机模式下前端只表达「想做什么」，点数与合法性由服务端裁决。
     */
    sendIntent(intent) {
        this.sendMessage('intent', { intent });
    }

    /** 多面骰子掷出后亮出数字牌（滚轮动画版），收牌时机由 skillManager 把关 */
    _showPolyhedralDiceForRoll(diceValue) {
        if (!diceValue || diceValue < 1) return;
        const skillManager = this.gameInstance && this.gameInstance.skillManager;
        if (skillManager && typeof skillManager.showPolyhedralDice === 'function') {
            skillManager.showPolyhedralDice(diceValue);
        }
        this.gameInstance?.uiUpdater?.updateDiceDisplay?.(diceValue, this.gameInstance?.gameState?.currentPlayer);
    }

    /** 把快照里的道具状态交给 skillManager 渲染；data 传 null 表示按缓存重画 */
    _renderItemState(gs, data) {
        const skillManager = this.gameInstance && this.gameInstance.skillManager;
        if (!skillManager) return;
        if (!data) {
            skillManager.refreshItemVisuals();
            return;
        }

        const currentPlayer = gs.getCurrentPlayer();
        skillManager.renderItemState({
            pendingItem: data.pendingItem || null,
            diceItem: engineAdapter.ready ? engineAdapter.state.diceItem : false,
            diceValue: gs.getDiceValue(),
            currentPlayer,
            localTurn: this.isLocalPlayerTurn(currentPlayer)
        });
    }

    /** 本机这位人类玩家是不是当前回合的玩家（离线：非机器人回合即自己） */
    isLocalPlayerTurn(currentPlayer) {
        if (!this.isOnlineMode) return !gameState.isBotPlayer(currentPlayer);
        return currentPlayer === this.getPlayerNumberByPlayerId(this.playerId);
    }


    /**
     * 服务端权威快照：联机模式下棋面的唯一来源。
     * 去重与换会话归零的规则在 SnapshotGate 里；动画与投影串行执行，避免相互覆盖。
     */
    handleGameSnapshot(data) {
        if (!data || !data.playerChess) return;

        if (!this._snapshotGate.accept(data)) return;
        if (data.gameSessionId) this.gameSessionId = this._snapshotGate.sessionId;

        // 这一帧到的时候，队列里是否已经压着一帧（压上了才算真落后）
        const queuedAlready = Boolean(this._pendingSnapshot);
        this._pendingSnapshot = data;
        if (this._snapshotDraining) {
            // 只晚到一帧：照样排队等它演完，动画一帧都不丢（AI/托管那一掷的骰子闪烁
            // 就是这么被丢掉的）。连着一帧演不完又来一帧，才说明真追不上，后面定格追赶
            if (queuedAlready) this._catchUpMode = true;
            return;
        }
        this._drainSnapshots();
    }

    /**
     * 按序落地快照，但落后时不再逐帧补动画。
     * 每帧动画要花好几秒（逐格 190ms），服务端推进快过客户端补动画时，
     * 逐帧排队会让棋面越拖越远、动画连成一串，观感就是「AI 没有停顿、整局在快进」，
     * 而且结算读的是落后的本地棋面，冠军完成度会不到 100%。追平前只落棋面与战报，不演。
     */
    async _drainSnapshots() {
        this._snapshotDraining = true;
        try {
            while (this._pendingSnapshot) {
                const next = this._pendingSnapshot;
                this._pendingSnapshot = null;
                const skipAnimation = this._catchUpMode;
                this._catchUpMode = false;
                await this._applyGameSnapshot(next, { skipAnimation });
                this._snapshotRetryCount = 0;
            }
        } catch (error) {
            console.warn('[快照应用失败]', error);
            this._scheduleSnapshotRetry();
        } finally {
            this._snapshotDraining = false;
        }
    }

    /**
     * 本机是否已经把上一帧快照演完（结算弹框要等这一步）
     */
    isRenderSettled() {
        return !this._snapshotDraining && !this._pendingSnapshot;
    }

    /**
     * 主动向服务端要一份全量快照。
     * force=true 时这次到达的快照会绕过水位校验强制落地，用于回到前台/重连等需要确定性对齐的场景。
     */
    requestSnapshot(reason = '', { force = false } = {}) {
        if (this.isSpectator || !this.isConnected || !this.wsClient) return;
        if (force) {
            this._snapshotGate.forceNext();
        }
        this.sendMessage('snapshotRequest', {});
        // 周期兜底是常态，不值得每次报一声；掉帧、落后这类异常才留个痕迹
        if (reason && reason !== '周期兜底') console.log('[快照自愈] 请求全量快照:', reason);
    }

    /**
     * 快照应用失败后的补偿：强制重拉同一帧，避免单帧异常导致该帧终态永久丢失。
     */
    _scheduleSnapshotRetry() {
        if (this.isSpectator || !this.isConnected) return;
        if (this._snapshotRetryCount >= SNAPSHOT_RETRY_LIMIT) return;
        this._snapshotRetryCount += 1;
        const delay = 600 * this._snapshotRetryCount;
        setTimeout(() => this.requestSnapshot('快照应用失败重试', { force: true }), delay);
    }

    /**
     * 暂停期间服务端状态是冻结的，拉快照只会换回同一帧，
     * 心跳与回前台对齐都跳过，免得暂停时日志一直刷「请求全量快照」
     */
    _isFrozenByPause() {
        const gs = gameState;
        return Boolean(gs && typeof gs.getIsPaused === 'function' && gs.getIsPaused());
    }

    /** 把本机前后台状态报给服务端：服务端不等后台客户端演完，整桌才不会被它拖慢 */
    reportVisibility() {
        if (!this.isConnected || typeof document === 'undefined') return;
        this.sendMessage('visibilityChange', { hidden: document.visibilityState !== 'visible' });
    }

    startSnapshotSelfHeal() {
        if (this._snapshotSelfHealStarted) return;
        this._snapshotSelfHealStarted = true;

        if (typeof document !== 'undefined') {
            this._visibilityHandler = () => {
                // 前后台都要告诉服务端：后台页面的定时器被节流、动画要拖很久，
                // 服务端据此把这台从「等演完」的名单里摘出去，别让整桌陪它慢
                this.reportVisibility();
                if (document.visibilityState !== 'visible') return;
                if (this._isFrozenByPause()) return;
                // 后台期间浏览器会节流定时器与渲染，回前台主动对齐，避免画面停在旧帧
                this.requestSnapshot('页面回到前台', { force: true });
            };
            document.addEventListener('visibilitychange', this._visibilityHandler);
        }

        this._snapshotHeartbeat = setInterval(() => {
            if (this._isFrozenByPause()) return;
            this.requestSnapshot('周期兜底');
        }, SNAPSHOT_SELF_HEAL_INTERVAL_MS);
    }

    stopSnapshotSelfHeal() {
        this._snapshotSelfHealStarted = false;
        if (this._visibilityHandler && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._visibilityHandler);
            this._visibilityHandler = null;
        }
        if (this._snapshotHeartbeat) {
            clearInterval(this._snapshotHeartbeat);
            this._snapshotHeartbeat = null;
        }
    }

    async _applyGameSnapshot(data, { skipAnimation = false } = {}) {
        const gs = gameState;
        if (!gs) return;

        if (typeof gs.setIsOnlineMultiplayer === 'function') {
            gs.setIsOnlineMultiplayer(true);
        }
        // 快照落地前的回合归属与阶段，用于判断这一批事件是否推进到了新阶段
        const previousPlayer = typeof gs.getCurrentPlayer === 'function' ? gs.getCurrentPlayer() : null;
        const previousPhase = typeof gs.getGamePhase === 'function' ? gs.getGamePhase() : null;

        // 先按事件流播放动画，再落到权威终态，避免棋子瞬移
        const events = Array.isArray(data.events) ? data.events : [];
        // 本机刚抢先用本地引擎演过、并且和服务端这一批逐字一致：动画、战报、统计都记过了，
        // 这里只落权威位置，重演会让棋子先倒退再走一遍
        const localMoveEvents = this._localMoveEvents;
        const isOwnPreview = Boolean(localMoveEvents && events.length
            && JSON.stringify(localMoveEvents) === JSON.stringify(events));
        // 预演过却对不上（本地状态落后、服务端另判）：按权威棋面整体重摆，免得棋子停在错的位置
        const stalePreview = Boolean(localMoveEvents) && !isOwnPreview;
        const ownPreviewPlayback = isOwnPreview ? this._localMovePlayback : null;
        this._localMoveEvents = null;
        this._localMovePlayback = null;
        // 本批事件里最后一次掷骰，供骰子上色与抖动使用
        const rolledDice = [...events].reverse().find((event) => event.type === 'dice');
        // 实时路径的掷骰战报在这里记；静默回放自己会记一份，两边都记就会多出一条「摇到了 N 点」
        // 道具骰的点数并进道具那一条，不再单独出一行
        if (!skipAnimation && !isOwnPreview) {
            for (const event of events) {
                if (event.type === 'dice' && !event.item) {
                    gameInfo.addDiceRoll(event.player, event.value, true);
                }
            }
        }

        // 骰子动画必须先于走棋：闪烁（灰色）→ 定格结果（此刻才上掷骰者的颜色）→ 走棋 → 抖动。
        // 定格必须发生在事件回放之前，三次六的「退回起点」才会出现在点数显示之后。
        const diceDisplay = document.getElementById('diceDisplay');
        let shakeRequest = null;
        // 多面骰子的 7-12 没有对应骰面，表现换成滚轮数字牌
        const isPolyhedralRoll = Boolean(rolledDice && rolledDice.item === 'polyhedral-dice');
        // 连出两个 6 之后的这一掷：整段动画骰子保持纯红（重绘也不被本色顶掉）
        if (rolledDice && rolledDice.value > 0 && skipAnimation) {
            // 追赶中的过渡帧：直接把骰面定格在点数上，不播闪烁与抖动
            this._localRollIssued = false;
            uiUpdater?.pinDiceResult?.(rolledDice.value, rolledDice.player);
            uiUpdater?.updateDiceDisplay?.(rolledDice.value, rolledDice.player);
        } else if (rolledDice && rolledDice.value > 0 && isPolyhedralRoll) {
            this._localRollIssued = false;
            this._showPolyhedralDiceForRoll(rolledDice.value);
        } else if (rolledDice && rolledDice.value > 0) {
            // 判断是否补播闪烁的依据是「本机有没有自己播过这段动画」，而不是点数归谁：
            // 别的机器（服务端或他人）掷出的骰子，点数属于本机时本地也没有动画在播，
            // 只按归属判断会跳过补播，表现为点数直接出现、看不到闪烁。
            const isRemoteDiceRoll = rolledDice.item === 'remote-dice';
            const rollStillPlaying = diceDisplay && diceDisplay.classList.contains('dice-flashing');
            const startedLocally = this._localRollIssued;
            this._localRollIssued = false;
            // 别处掷出的骰子：本地补播一次闪烁，让各端看到同一段节奏
            if (!isRemoteDiceRoll && !startedLocally && !rollStillPlaying) {
                this.startDiceFlashing(rolledDice.player);
                // 服务端只发结算后的快照，没有「开始掷骰」的广播，
                // 补播闪烁时必须一并补上投掷音效，否则只有掷骰者自己听得到
                window.audioManager?.playRollingSound?.();
            }
            await this._waitDiceRollSettled();
            this.stopDiceFlashing();
            this.rollStartTime = null;
            if (isRemoteDiceRoll) {
                gs.isRemoteDice = true;
                diceDisplay?.classList.add('remote-dice');
            }
            // 这一手演完到快照落地之间，骰面钉在这个点数上：中间任何一次 UI 重绘
            // 都会按还没更新的 gameState 画成默认灰骰，看着像先闪出个灰 1 再变结果
            uiUpdater?.pinDiceResult?.(rolledDice.value, rolledDice.player);
            uiUpdater?.updateDiceDisplay?.(rolledDice.value, rolledDice.player);
        }

        if (events.length > 0) {
            // 走子/掷骰即将开播：各端统一把这一手正在走的进度条「冻住」（保留进度、不回 0），
            // 颜色落回出手的那一家，否则带动画的一端已停表、别的端还在跑，两端不同步
            // 只要这一段有演出（掷骰闪烁也算）：进度条暂停在原处，演完进新阶段再重置
            if (events.length) {
                uiUpdater?.holdThinkingProgressBar?.();
            }
            if (isOwnPreview) {
                // 本机那一手还在演：等它演完再收尾，别让后面的 UI 收尾打断这段动画
                if (ownPreviewPlayback) await ownPreviewPlayback.catch(() => {});
            } else if (skipAnimation) {
                // 追赶中的过渡帧：只把事件翻成战报，棋面与积分都交给下面的快照投影
                await enginePlayback.replay(events);
            } else {
                shakeRequest = await enginePlayback.play(events);
            }
        }

        engineAdapter.applySnapshot(data);
        engineAdapter.projectTo(gs);
        // 权威状态已落地：骰面重新由它推导（该换家就换家、该清就清）
        uiUpdater?.releaseDiceResult?.();

        // 道具的进行中状态不在棋面里，统一按快照渲染（该亮的亮、该收的收）
        this._renderItemState(gs, data);
        // 积分同样以快照为准：本地的加减只负责演出，账本永远跟着权威值走
        // 快照说这是道具局就以它为准，本地那套配置缺了也不该让整局积分停在 0
        if (data.skillMode && !energyManager.isSkillModeEnabled()) {
            energyManager.enableSkillMode();
            this.gameInstance?.energyDisplay?.init?.();
            this.gameInstance?.skillManager?.init?.();
        }
        energyManager.applySnapshot(data.energy);

        // 完成度历史由服务端权威记录，客户端直接采用，避免各端各算一遍再互相同步
        if (Array.isArray(data.progressHistory)) {
            gs.progressHistory = data.progressHistory;
        }
        if (typeof data.round === 'number' && data.round > (gs.currentRound || 0)) {
            gs.currentRound = data.round;
        }

        // 不把服务端的窗口写进本地显示：进度条由本机按「阶段」自己跑（进新阶段才重置）。
        // 服务端那扇窗口仍由服务端用于超时裁决，前端只做展示，否则演出期间会被拉回去/向后走

        // 称号统计从事件流里记；「连投 6」由 gameState 按玩家自己累计，跨回合不断
        for (const event of events) {
            if (event.type !== 'dice') continue;
            if (typeof gs.recordDiceRollForTitle === 'function') {
                // 道具骰子不参与普通骰子的称号统计
                gs.recordDiceRollForTitle(event.player, Boolean(event.item), event.value);
            }
            // 点数统计：联机下点数由服务端产出，只能从事件流里记（道具骰子点数可超过 6，不计入）
            const stats = gs.diceStatistics && gs.diceStatistics[event.player];
            if (!event.item && stats && stats[event.value] !== undefined) {
                stats[event.value] += 1;
            }
        }
        enginePlayback.announceLiveTitles();

        if (typeof gs.setSelectedChess === 'function') gs.setSelectedChess(null);
        if (typeof gs.setCanReroll === 'function') gs.setCanReroll(false);
        if (typeof gs.setChessMoving === 'function') gs.setChessMoving(false);
        gs.isRolling = false;

        // 没有事件流说明这是一次「纯恢复」快照（首次进入 / 刷新重连），
        // 棋子 DOM 还停在初始位置，必须按恢复出的坐标重新落位，否则棋盘看起来被重置了；
        // 追赶中跳过了动画的过渡帧同理，直接落到快照坐标上
        if (events.length === 0 || skipAnimation || stalePreview) {
            this._renderAllChess(gs);
        }

        activePlayerManager.setCurrentActivePlayer(data.currentPlayer);

        // 动画期间进度条锁定为本次掷骰者，避免快照已推进到下家时进度条提前变色
        if (rolledDice && rolledDice.value > 0) {
            gs.setThinkingProgressDisplayOwner?.(rolledDice.player);
        }

        this._safeUpdateUI();

        // 抖动紧接在闪烁定格之后：闪烁结束立刻定格结果并抖动，不额外停顿。
        // 抖动期间不改颜色，演完才切换回合
        // 六面骰用骰面定格点数；多面骰的 7-12 无面可定格，但数字牌本身可以抖
        if (shakeRequest && shakeRequest.value > DICE_SYMBOLS.length && shakeRequest.item !== 'polyhedral-dice') {
            shakeRequest = null;
        }
        if (shakeRequest) {
            await this._waitDiceRollSettled();
            this.stopDiceFlashing();
            this.rollStartTime = null;
            if (shakeRequest.item !== 'polyhedral-dice') {
                uiUpdater?.updateDiceDisplay?.(shakeRequest.value, shakeRequest.player);
            }
            await enginePlayback.playDiceShake(shakeRequest);
            // 抖动只是瞬时表现，静止外观仍由快照终态决定（无子可动时骰子应回到准备态）
            uiUpdater?.updateDiceDisplay?.();
        }

        // 这一帧是否把对局推进到了新阶段：换人、换阶段，或服务端换了思考窗
        // （服务端只在阶段边界换窗：换人 / 连投 6 重掷 / 买道具）
        const serverWindow = typeof data.thinkingStartTime === 'number' && data.thinkingStartTime > 0
            ? data.thinkingStartTime
            : null;
        const windowChanged = serverWindow !== null && serverWindow !== this._serverThinkingWindow;
        const phaseChanged = windowChanged
            || previousPlayer !== gs.getCurrentPlayer()
            || data.gamePhase !== previousPhase;
        if (windowChanged) {
            // 本地超时窗口跟上服务端这一扇（进度条本身由显示时钟自己走，不采信服务端时间戳）
            this._serverThinkingWindow = serverWindow;
            gs.thinkingStartTime = serverWindow;
            gs.pausedThinkingTime = data.pausedThinkingMs || 0;
        }
        // 动画结束，释放展示归属，进度条回落到下家
        gs.clearThinkingProgressDisplayOwner?.();

        // 这一帧到此真的演完了：告诉服务端，AI 的下一手等各端都演完再出
        if (this.isOnlineMode && typeof data.seq === 'number') {
            this.sendMessage('animationDone', { seq: data.seq, hidden: document.visibilityState !== 'visible' });
        }

        if (!phaseChanged) {
            // 同一阶段的补帧（周期兜底、纯恢复）：接着走，进度不清零
            uiUpdater?.releaseThinkingProgressBar?.();
        }

        this._finishSnapshotApply(data, Boolean(shakeRequest), phaseChanged);
    }

    /** 等待本地掷骰动画播完（骰子仍在闪烁时按剩余时长等待） */
    _waitDiceRollSettled() {
        const diceDisplay = document.getElementById('diceDisplay');
        if (!diceDisplay || !diceDisplay.classList.contains('dice-flashing')) {
            return Promise.resolve();
        }
        const elapsed = this.rollStartTime ? Date.now() - this.rollStartTime : 0;
        const wait = Math.max(0, 500 - elapsed);
        return new Promise((resolve) => setTimeout(resolve, wait));
    }

    /**
     * 快照落地后的收尾：结算、回合倒计时与 AI 驱动。
     * 进度条延后到骰子动画（含抖动）播完再重启，否则抖动期间进度条会先染成下一家的颜色。
     */
    _finishSnapshotApply(data, deferProgressBar = false, phaseChanged = true) {
        if (data.gamePhase === 'ended' || data.gamePhase === 'finished') {
            this._notifyGameEnded(data);
            return;
        }
        this._syncOfficiallyStartedFromSnapshot(data);
        if (deferProgressBar) {
            setTimeout(() => {
                this._startTurnProgressBar(data.currentPlayer, data.gamePhase, phaseChanged);
            }, 0);
        } else {
            this._startTurnProgressBar(data.currentPlayer, data.gamePhase, phaseChanged);
        }
        // 停顿只由 botController 内部控制，这里直接触发，避免延迟叠加
    }

    /**
     * 刷新或重连后本地的"已开局"标志会重置为 false，而服务端只把它当作初始值下发、
     * 之后不再维护，于是 _startTurnProgressBar 会把当前玩家当成尚未操作的首发玩家，
     * 只把进度条置 0% 而不启动计时器与刷新循环，表现为进度条卡在 0 不动。
     * 这里依据权威快照推断对局是否已经推进，并补回该标志。
     */
    _syncOfficiallyStartedFromSnapshot(snapshot) {
        const gs = gameState;
        if (!gs || typeof gs.setGameOfficiallyStarted !== 'function' || gs.getGameOfficiallyStarted()) {
            return;
        }

        if ((snapshot.diceValue || 0) > 0 ||
            (snapshot.round || 0) > 0 ||
            (snapshot.consecutiveSixes || 0) > 0 ||
            (Array.isArray(snapshot.progressHistory) && snapshot.progressHistory.length > 0)) {
            gs.setGameOfficiallyStarted(true);
            return;
        }

        const playerChess = snapshot.playerChess;
        if (!playerChess) return;
        for (const color of Object.keys(playerChess)) {
            const chesses = playerChess[color];
            if (Array.isArray(chesses) && chesses.some((chess) => chess && (chess.position !== -1 || chess.finished))) {
                gs.setGameOfficiallyStarted(true);
                return;
            }
        }
    }

    /**
     * 按 gameState 中已恢复的坐标重新摆放所有棋子。
     * projectTo 只写数据不动 DOM，刷新重连时必须显式落位，否则棋盘停在初始布局。
     */
    _renderAllChess(gs) {
        const animation = this.gameInstance?.animation;
        if (!animation || typeof animation.updateChessPosition !== 'function') return;
        const pieceCount = gs.pieceCount || 4;
        for (let player = 1; player <= 4; player++) {
            for (let i = 0; i < pieceCount; i++) {
                if (!gs.playerChess[player] || !gs.playerChess[player][i]) continue;
                animation.updateChessPosition(player, i, null, false);
            }
        }
    }

    /**
     * 回合由权威快照推进后重启思考进度条。
     * 房主或当前玩家本人持有超时回调，其余客户端只驱动进度条展示。
     */
    _startTurnProgressBar(playerNumber, gamePhase, phaseChanged = true) {
        const gs = gameState;
        const ui = this.gameInstance?.uiUpdater;

        // 同一阶段的补帧：只推进度条，不动计时器与颜色归属。
        // 停一次再起一次会「缩回 0 又弹回原位」，正是周期兜底快照的抖动来源
        if (!phaseChanged) return;

        // 本机遥控骰子正在选点：等待归面板自己的计时器，周期快照不能顶掉它
        if (document.getElementById('diceSelectionPanel')) {
            return;
        }

        // 无论后续走哪条分支，先无条件清掉上一轮的计时器与渲染循环。
        // AI 回合没有人类回合那样的交接点，若不在这里清理，上一个玩家/AI
        // 的计时器会一直挂着（颜色归属不变），看起来就是「两个 AI 共用进度条」。
        ui?.stopThinkingProgressBar?.();

        if (gamePhase !== 'rolling' && gamePhase !== 'selecting') return;
        if (!gs || typeof gs.getIsOnlineMultiplayer !== 'function' || !gs.getIsOnlineMultiplayer()) return;
        if (typeof gs.getIsPaused === 'function' && gs.getIsPaused()) return;

        const playerId = this.getPlayerIdByPlayerNumber(playerNumber);
        // 判据与服务端同源：机器人「和」被托管玩家都由服务端出手，
        // 这里若只看 isAI，托管回合会走人类那条路（本地开计时），进度条就会和服务端窗口打架
        const isAI = isAiDriven(playerNumber, this);
        const isLocalPlayer = playerNumber === this.getPlayerNumberByPlayerId(this.playerId);

        // 开局首位操作前不计时，只露一根静止空条；观战也要走这条，否则它会看到条自己往前走
        if (!isAI && typeof gs.getGameOfficiallyStarted === 'function' && !gs.getGameOfficiallyStarted()) {
            ui?.showIdleThinkingProgressBar?.(playerNumber);
            return;
        }

        if (this.isSpectator) {
            // 观战也走同一条开场：归零、起计时、跑循环，只是没有超时回调
            ui?.startThinkingProgressBar?.(null);
            return;
        }

        // AI 回合同样走（不挂超时回调，节奏归服务端掌握）
        if (isAI) {
            ui?.startThinkingProgressBar?.(null);
            return;
        }

        // 回合开始一律本地重开一段（服务端窗口不参与显示）
        ui?.startThinkingProgressBar?.(null);
        ui?._renderThinkingProgressBar?.(playerNumber);
    }

    /**
     * 服务端拒绝了本次意图：撤销本地的乐观表现，回到权威棋面。
     */
    handleIntentRejected(data) {
        console.warn('[意图被拒]', data.reason, data.intent);
        const gs = gameState;
        if (!gs) return;

        // 投掷意图被拒后不会再有对应的骰子事件，标记必须清掉，
        // 否则会抑制住下一位玩家掷骰时的闪烁补播
        this._localRollIssued = false;
        if (engineAdapter.ready) {
            engineAdapter.projectTo(gs);
        }
        gs.isRolling = false;
        if (typeof gs.setSelectedChess === 'function') gs.setSelectedChess(null);
        if (typeof gs.setCanReroll === 'function') gs.setCanReroll(false);
        // 选点意图被拒时激活态还在服务端，面板要能重新开出来给玩家再选
        this.gameInstance?.skillManager?.resetRemoteDiceSelection?.();
        this._renderItemState(gs);
        this._safeUpdateUI();
    }

    /**
     * 对局结束时由房主（或获胜方）上报一次，服务端再广播结算数据给所有人。
     */
    _notifyGameEnded(snapshot) {
        if (this._gameEndReported) return;
        if (snapshot.winner === null || snapshot.winner === undefined) return;
        this._gameEndReported = true;

        // 对局已结束，会话随后会在服务端销毁；停掉快照兜底巡检，
        // 否则它还会一直发请求、换回一串「玩家不在任何游戏会话中」
        this.stopSnapshotSelfHeal();
        // 结算读的是本地棋面：先把最后一帧权威快照拉回来，避免冠军完成度显示不到 100%
        this.requestSnapshot('对局结束', { force: true });

        const myColor = this.getPlayerNumberByPlayerId(this.playerId);
        if (this.isHost || myColor === snapshot.winner) {
            this.syncGameEnd(snapshot.winner);
            // 上报方收到的是自己发的 gameEnd，handleGameEnd 会跳过弹框，
            // 不在这里本地补一次房主（或获胜方）就看不到结算弹框。
            // 延迟与广播到其他客户端的一致；同样等本地棋面追平再弹，保证名次与完成度是终局数据
            const showWhenCaughtUp = (attempt = 0) => {
                if (!this.isRenderSettled() && attempt < 20) {
                    return setTimeout(() => showWhenCaughtUp(attempt + 1), 150);
                }
                this.gameInstance?.settlementModal?.show(snapshot.winner);
            };
            setTimeout(() => showWhenCaughtUp(), 1000);
        }
    }

    /**
     * 处理重连时的roomJoined消息
     */
    handleReconnectRoomJoined(data) {
        console.log('处理重连的roomJoined消息:', data);

        // 设置基本信息
        this.isHost = data.room.players.find(p => p.id === this.playerId)?.isHost || false;
        this.gameSessionId = data.gameData?.gameSessionId;
        this.isReconnecting = false;

        // 更新暂停和结算按钮UI
        if (window.gameInstance && window.gameInstance.eventHandler) {
            window.gameInstance.eventHandler.updatePauseButtonText();
        }

        // 保存游戏会话ID到重连管理器
        if (this.gameSessionId) {
            reconnectManager.updateGameSessionId(this.gameSessionId);
        }

        // 初始化音频加载状态跟踪
        this.audioLoadedPlayers = new Set();
        this.totalPlayers = data.room.players.length;
        this.gameInitialized = false;

        // 设置audioManager为联机模式
        if (window.audioManager) {
            window.audioManager.setMultiplayerMode(true);
        }

        // 初始化玩家数据并恢复AI托管状态
        this.players.clear();
        this.aiTakeoverPlayers.clear(); // 清空AI托管列表
        this._syncBotFlagsFromRoster(data.room.players);

        for (const player of data.room.players) {
            this.players.set(player.id, {
                id: player.id,
                color: player.color,
                nickname: player.nickname,
                emoji: player.emoji,
                isAI: player.isAI || false, // 使用服务器返回的isAI标志，可能是真正的人机，也可能是断线转托管的
                isAITakeover: player.isAITakeover || false // 恢复AI托管状态
            });

            // 如果玩家处于AI托管状态（包括被服务器转为AI的情况），加入AI托管列表
            if (player.isAITakeover || (player.isAI && !this.gameInstance?.gameState?.isBotPlayer(player.color))) {
                this.aiTakeoverPlayers.add(player.id);
                console.log(`恢复AI托管状态: 玩家${player.id}处于AI托管中`);

                // 设置AI托管使用简单难度
                const playerNumber = player.color;
                if (playerNumber && window.botController) {
                    window.botController.botDifficulties[playerNumber] = 'easy';
                    console.log(`设置AI托管玩家${playerNumber}为简单难度`);
                }

                // 更新AI托管显示（对所有客户端，包括房主）
                setTimeout(() => {
                    this.updatePlayerAITakeoverDisplay(player.id, true);
                }, 200);

                // 如果是当前玩家，且不是观战模式，恢复本地AI托管状态
                // 暂停期间不恢复托管 UI，避免覆盖暂停遮罩
                if (player.id === this.playerId && !this.isSpectator && !data.gameData?.isPaused) {
                    console.log('当前玩家处于AI托管状态，恢复本地UI');
                    // 异步恢复本地AI托管状态
                    setTimeout(async () => {
                        const { aiTakeoverManager } = await import('./aiTakeoverManager.js');
                        if (!aiTakeoverManager.isActive) {
                            // 直接设置状态，不触发同步
                            aiTakeoverManager.isActive = true;
                            // 确保使用window.gameState以避免undefined错误
                            if (window.gameState && typeof window.gameState.setAITakeover === 'function') {
                                window.gameState.setAITakeover(true);
                            }
                            aiTakeoverManager.updateToggleButton();
                            aiTakeoverManager.updateControlButtons();
                            // 恢复昵称标记（如果需要）
                            aiTakeoverManager.modifyHumanPlayerNames();
                            console.log('本地AI托管状态已恢复');
                        }
                    }, 100);
                }
            }
        }

        // 如果有游戏数据，先补辅助状态；棋面与骰子由随后的 gameSnapshot 权威恢复
        if (data.gameData) {
            this.restoreAuxState(data.gameData);
        }

        // 重新加入游戏会话（会触发服务端再次发送 gameSessionConnected，进一步恢复状态）
        this.rejoinGameSession();

        // 延迟一帧刷新骰子和棋子高亮显示，确保状态正确
        setTimeout(() => {
            if (uiUpdater) {
                const dv = gameState ? gameState.getDiceValue() : 0;
                uiUpdater.updateDiceDisplay(dv);
                if (gameState && gameState.getGamePhase() === 'selecting') {
                    uiUpdater.highlightMovableChess();
                }
            }
        }, 50);
    }

    /**
     * 恢复权威快照未包含的辅助状态（道具积分、当前回合数、完成度历史）
     * 棋面、骰子、阶段由 gameSnapshot 统一恢复，此处不重复处理
     */
    restoreAuxState(gameData) {
        if (!gameData) return;

        gameState.setIsOnlineMultiplayer(true);

        if (gameData.thinkingStartTime) {
            gameState.thinkingStartTime = gameData.thinkingStartTime;
            gameState.pausedThinkingTime = gameData.pausedTotalMs || 0;
        }

        if (Array.isArray(gameData.progressHistory) && gameData.progressHistory.length > 0) {
            gameState.progressHistory = gameData.progressHistory;
        }
        if (typeof gameData.currentRound === 'number') {
            gameState.currentRound = Math.max(gameData.currentRound, gameState.currentRound || 0);
        }

        // 暂停状态必须一并恢复，否则刷新后本地会以为没人暂停而继续接受操作
        if (gameData.isPaused) {
            const phaseBeforePause = gameData.gamePhaseBeforePause;
            gameState.setIsPaused(true);
            // setIsPaused 会把刚加载的本地阶段记成暂停前阶段，必须在它之后再写回
            // 服务端记的阶段，否则恢复时还原成 waiting，骰子不可用、进度条也不走
            if (phaseBeforePause) {
                gameState.gamePhaseBeforePause = phaseBeforePause;
            }
            this.gameInstance?.pauseGame?.({ force: true });
        }

        this.rebindChessElements();
    }

    /**
     * 告诉其他客户端「有人开了传送门」，让图标与音效立刻跟上。
     * 只负责点亮：收起一律等权威快照把 pendingItem 清掉（回合交出去的那一刻）
     */
    syncTeleportIcon() {
        this.sendMessage('teleportIcon', {
            timestamp: Date.now()
        });
    }

    
    /**
     * 同步音效开关到服务端（联机时以服务端为恢复来源）
     */
    syncAudioEnabled(enabled) {
        if (this.isSpectator || !this.isOnlineMode || !this.isConnected) return;
        this.sendMessage('audioEnabledChange', {
            playerId: this.playerId,
            enabled: !!enabled,
            timestamp: Date.now()
        });
    }


    /**
     * 处理传送门图标显示同步
     */
    handleTeleportIcon(data) {
        if (String(data.playerId) === String(this.playerId)) return; // 忽略自己的消息

        // 使用次数不在这里累计：传送门真正落地时事件流会统一记一次，
        // 只激活不传送（点骰子取消）不该算作一次传送

        // 只点亮，不负责收起：收起交回给快照，避免和权威状态互相打架
        this.gameInstance?.skillManager?.showTeleportIcon();
    }

    
    
    
    


    /**
     * 处理玩家回合变化
     */
    handlePlayerTurnChange(data) {
        // 检查data.newPlayer是否存在
        if (data.newPlayer !== undefined && data.newPlayer !== null) {
            // 清除传送门模式（如果存在）
            if (window.gameInstance) {
                window.gameInstance.isTeleportMode = false;
            }

            // 恢复骰子显示（清除传送门图标和遥控骰子特效）
            if (this.gameInstance && this.gameInstance.skillManager) {
                this.gameInstance.skillManager.restoreDiceIcon();
            }

            // 清除遥控骰子特效
            const diceDisplay = document.getElementById('diceDisplay');
            if (diceDisplay) {
                diceDisplay.classList.remove('remote-dice');
            }

            // 更新游戏状态
            if (this.gameInstance && this.gameInstance.gameState) {
                this.gameInstance.gameState.setCurrentPlayer(data.newPlayer);
                this.gameInstance.gameState.setGamePhase('rolling');
                this.gameInstance.gameState.setDiceValue(0);
                this.gameInstance.gameState.setSelectedChess(null);
                this.gameInstance.gameState.setConsecutiveSixes(0);
                this.gameInstance.gameState.setCanReroll(false);
                this.gameInstance.gameState.setThreeSixesPenaltyActive(false); // 确保清除三次6惩罚标志

                // 同步activePlayerManager的当前玩家状态
                activePlayerManager.setCurrentActivePlayer(data.newPlayer);

                // 更新UI（包括骰子权限状态）
                if (this.gameInstance.uiUpdater) {
                    // 先停止旧的进度条（无论是谁的回合）
                    if (this.gameInstance.uiUpdater.stopThinkingProgressBar) {
                        this.gameInstance.uiUpdater.stopThinkingProgressBar();
                    }

                    this.gameInstance.uiUpdater.updateUI();

                    // 检查新玩家是否是AI电脑玩家
                    const playerIdForProgressBar = this.getPlayerIdByPlayerNumber(data.newPlayer);
                    const isNewPlayerAI = this.players.get(playerIdForProgressBar)?.isAI || false;
                    const isNewPlayerAITakeover = isTakeoverPlayer(playerIdForProgressBar, this);

                    // 观战模式也启动倒计时，但没有超时回调
                    // AI 回合不启动超时计时器（时长由 AI 自身决定），进度条以该 AI 的静止空条显示
                    if (this.isSpectator) {
                        if (!isNewPlayerAI) {
                            this.gameInstance.uiUpdater?.startThinkingProgressBar?.(null);
                        } else {
                            this.gameInstance.uiUpdater?.showIdleThinkingProgressBar?.(data.newPlayer);
                        }
                    } else if (!isNewPlayerAI) {
                        // 启动新玩家的思考时间计时器（掷骰子阶段）
                        // 条件：
                        // 1. 当前玩家是本地玩家
                        // 2. 当前客户端是房主（替非本地玩家维护进度条与超时）
                        const localPlayerNumber = this.getPlayerNumberByPlayerId(this.playerId);
                        const shouldStartProgressBar = (data.newPlayer === localPlayerNumber) ||
                            this.isHost;

                        if (shouldStartProgressBar) {
                            // 如果游戏尚未正式开始，且当前是人类玩家回合，则不启动超时计时器（允许无限等待直到首发玩家操作）
                            if (this.gameInstance && this.gameInstance.gameState && !this.gameInstance.gameState.getGameOfficiallyStarted()) {
                                console.log('[开局] 游戏尚未正式开始，且为人类玩家回合，不启动超时计时器');
                                this.gameInstance.uiUpdater?.showIdleThinkingProgressBar?.(data.newPlayer);
                                return;
                            }

                            this.gameInstance.uiUpdater.startThinkingProgressBar(() => {
                                console.log(`[超时] 玩家${data.newPlayer}思考超时`);
                                if (this.gameInstance && this.gameInstance.dice && this.gameInstance.dice.handleThinkingTimeoutWrapper) {
                                    this.gameInstance.dice.handleThinkingTimeoutWrapper();
                                }
                            });
                        } else {
                            // 非房主且非本地玩家：只跑进度条展示，超时归服务端
                            this.gameInstance.uiUpdater?.startThinkingProgressBar?.(null);
                        }
                    } else {
                        // AI 回合：同上，按服务端窗口续上计时
                        this.gameInstance.uiUpdater?.startThinkingProgressBar?.(null);
                    }
                }

            }
        } else {
            console.error('playerTurnChange消息中缺少newPlayer属性:', data);
            // 发送错误消息给服务器
            this.sendMessage('error', {
                message: 'playerTurnChange消息中缺少newPlayer属性'
            });
        }
    }

    /**
     * 同步游戏结束和结算
     */
    syncGameEnd(winnerPlayer) {
        // 收集称号相关统计数据，发送到服务器供所有客户端共享（确保所有玩家看到同一套称号）
        const titleStats = this._collectTitleStats();
        this.sendMessage('gameEnd', {
            winnerPlayer: winnerPlayer,
            titleStats: titleStats,
            timestamp: Date.now()
        });
    }

    /**
     * 收集称号计算需要的所有统计数据的快照
     * 用于 gameEnd / forceSettlement 时同步给所有客户端，确保称号计算结果一致
     */
    _collectTitleStats() {
        if (!this.gameInstance?.gameState) return null;
        const gs = this.gameInstance.gameState;
        
        return {
            // titleStats 中的对象数据
            consecutiveOnes: { ...gs.titleStats.consecutiveOnes },
            consecutiveNoTakeoff: { ...gs.titleStats.consecutiveNoTakeoff },
            maxConsecutiveOnes: { ...gs.titleStats.maxConsecutiveOnes },
            maxConsecutiveNoTakeoff: { ...gs.titleStats.maxConsecutiveNoTakeoff },
            maxConsecutiveSixes: { ...gs.titleStats.maxConsecutiveSixes },
            firstFinishedPlayer: gs.titleStats.firstFinishedPlayer,
            firstBeaterPlayer: gs.titleStats.firstBeaterPlayer,
            maxBeatsInMove: { ...gs.titleStats.maxBeatsInMove },
            maxCollideInMove: { ...gs.titleStats.maxCollideInMove },
            bounceSteps: { ...gs.titleStats.bounceSteps },
            // 道具模式称号数据
            maxTeleportDistance: { ...gs.titleStats.maxTeleportDistance },
            maxMoveDistance: { ...gs.titleStats.maxMoveDistance },
            mysteryBoxMax: { ...gs.titleStats.mysteryBoxMax },
            mysteryBoxMin: { ...gs.titleStats.mysteryBoxMin },
            polyhedralMax: { ...gs.titleStats.polyhedralMax },
            polyhedralMin: { ...gs.titleStats.polyhedralMin },
            skillUseCount: { ...gs.titleStats.skillUseCount },
            // 总前进距离
            totalDistance: { ...gs.totalDistance },
            // 道具统计数据（结算面板显示）
            totalEnergyGained: { ...gs.totalEnergyGained },
            skillUsage: gs.skillUsage ? {
                1: { ...gs.skillUsage[1] },
                2: { ...gs.skillUsage[2] },
                3: { ...gs.skillUsage[3] },
                4: { ...gs.skillUsage[4] }
            } : undefined,
            // 骰子统计
            diceStatistics: gs.diceStatistics ? {
                1: { ...gs.diceStatistics[1] },
                2: { ...gs.diceStatistics[2] },
                3: { ...gs.diceStatistics[3] },
                4: { ...gs.diceStatistics[4] }
            } : undefined,
            // 击败统计
            defeatCounts: gs.defeatCounts ? {
                1: { ...gs.defeatCounts[1] },
                2: { ...gs.defeatCounts[2] },
                3: { ...gs.defeatCounts[3] },
                4: { ...gs.defeatCounts[4] }
            } : undefined
        };
    }

    /**
     * 将服务器广播的称号统计数据应用到本地 gameState
     */
    _applyTitleStats(titleStats) {
        if (!titleStats || !this.gameInstance?.gameState) return;
        const gs = this.gameInstance.gameState;
        
        if (titleStats.consecutiveOnes) gs.titleStats.consecutiveOnes = titleStats.consecutiveOnes;
        if (titleStats.consecutiveNoTakeoff) gs.titleStats.consecutiveNoTakeoff = titleStats.consecutiveNoTakeoff;
        if (titleStats.maxConsecutiveOnes) gs.titleStats.maxConsecutiveOnes = titleStats.maxConsecutiveOnes;
        if (titleStats.maxConsecutiveNoTakeoff) gs.titleStats.maxConsecutiveNoTakeoff = titleStats.maxConsecutiveNoTakeoff;
        if (titleStats.maxConsecutiveSixes) gs.titleStats.maxConsecutiveSixes = titleStats.maxConsecutiveSixes;
        if (titleStats.firstFinishedPlayer !== undefined) gs.titleStats.firstFinishedPlayer = titleStats.firstFinishedPlayer;
        if (titleStats.firstBeaterPlayer !== undefined) gs.titleStats.firstBeaterPlayer = titleStats.firstBeaterPlayer;
        if (titleStats.maxBeatsInMove) gs.titleStats.maxBeatsInMove = titleStats.maxBeatsInMove;
        if (titleStats.maxCollideInMove) gs.titleStats.maxCollideInMove = titleStats.maxCollideInMove;
        if (titleStats.bounceSteps) gs.titleStats.bounceSteps = titleStats.bounceSteps;
        if (titleStats.maxTeleportDistance) gs.titleStats.maxTeleportDistance = titleStats.maxTeleportDistance;
        if (titleStats.maxMoveDistance) gs.titleStats.maxMoveDistance = titleStats.maxMoveDistance;
        if (titleStats.mysteryBoxMax) gs.titleStats.mysteryBoxMax = titleStats.mysteryBoxMax;
        if (titleStats.mysteryBoxMin) gs.titleStats.mysteryBoxMin = titleStats.mysteryBoxMin;
        if (titleStats.polyhedralMax) gs.titleStats.polyhedralMax = titleStats.polyhedralMax;
        if (titleStats.polyhedralMin) gs.titleStats.polyhedralMin = titleStats.polyhedralMin;
        if (titleStats.skillUseCount) gs.titleStats.skillUseCount = titleStats.skillUseCount;
        if (titleStats.totalEnergyGained) gs.totalEnergyGained = titleStats.totalEnergyGained;
        if (titleStats.skillUsage) gs.skillUsage = titleStats.skillUsage;
        if (titleStats.totalDistance) gs.totalDistance = titleStats.totalDistance;
        if (titleStats.diceStatistics) gs.diceStatistics = titleStats.diceStatistics;
        if (titleStats.defeatCounts) gs.defeatCounts = titleStats.defeatCounts;
    }

    /**
     * 同步强制结算
     */
    syncForceSettlement(rankings) {
        const titleStats = this._collectTitleStats();
        this.sendMessage('forceSettlement', {
            rankings: rankings,
            titleStats: titleStats,
            timestamp: Date.now()
        });
    }

    
    /**
     * 处理游戏结束同步
     */
    handleGameEnd(data) {
        // 自己发送的消息也需要处理（用于同步服务器权威数据，如progressHistory/gameStartTime等），
        // 但要避免重复弹出结算模态框。
        const isSelfMessage = String(data.playerId) === String(this.playerId);

        console.log(`处理游戏结束同步: 玩家${data.winnerPlayer}获胜`);

        if (this.gameInstance) {
            // 使用服务器权威的游戏开始时间，避免断线/重连/中途退出导致本地起点被重置
            try {
                if (data.gameStartTime) {
                    if (this.gameInstance.gameState) {
                        this.gameInstance.gameState.gameStartTime = data.gameStartTime;
                    }
                    if (window.gameState) {
                        window.gameState.gameStartTime = data.gameStartTime;
                    }
                }
            } catch (e) {
                // ignore
            }

            // 同步服务器权威的完成度历史（用于结算折线图）
            try {
                if (Array.isArray(data.progressHistory)) {
                    if (this.gameInstance.gameState) {
                        this.gameInstance.gameState.progressHistory = data.progressHistory;
                    }
                    if (window.gameState) {
                        window.gameState.progressHistory = data.progressHistory;
                    }
                }
                if (typeof data.currentRound === 'number') {
                    if (this.gameInstance.gameState) {
                        this.gameInstance.gameState.currentRound = data.currentRound;
                    }
                    if (window.gameState) {
                        window.gameState.currentRound = data.currentRound;
                    }
                }
            } catch (e) {
                // ignore
            }

            // 结束时也进入暂停态，确保所有客户端UI一致（显示暂停遮罩、隐藏骰子等）
            try {
                if (this.gameInstance.gameState && typeof this.gameInstance.gameState.setIsPaused === 'function') {
                    this.gameInstance.gameState.setIsPaused(true);
                } else if (window.gameState && typeof window.gameState.setIsPaused === 'function') {
                    window.gameState.setIsPaused(true);
                }
            } catch (e) {
                // ignore
            }

            try {
                if (typeof this.gameInstance.pauseGame === 'function') {
                    this.gameInstance.pauseGame();
                }
            } catch (e) {
                // ignore
            }

            // 设置游戏状态
            this.gameInstance.gameState.winner = data.winnerPlayer;
            this.gameInstance.gameState.gamePhase = 'finished';

            // 应用服务器广播的称号统计数据，确保所有客户端称号计算一致
            try {
                if (data.titleStats) {
                    this._applyTitleStats(data.titleStats);
                    if (window.gameState) {
                        const ts = data.titleStats;
                        window.gameState.titleStats = ts;
                        // titleStats 子字段
                        if (ts.maxTeleportDistance) window.gameState.titleStats.maxTeleportDistance = ts.maxTeleportDistance;
                        if (ts.mysteryBoxMax) window.gameState.titleStats.mysteryBoxMax = ts.mysteryBoxMax;
                        if (ts.mysteryBoxMin) window.gameState.titleStats.mysteryBoxMin = ts.mysteryBoxMin;
                        if (ts.polyhedralMax) window.gameState.titleStats.polyhedralMax = ts.polyhedralMax;
                        if (ts.polyhedralMin) window.gameState.titleStats.polyhedralMin = ts.polyhedralMin;
                        if (ts.skillUseCount) window.gameState.titleStats.skillUseCount = ts.skillUseCount;
                        // 其他统计
                        if (ts.totalDistance) window.gameState.totalDistance = ts.totalDistance;
                        if (ts.totalEnergyGained) window.gameState.totalEnergyGained = ts.totalEnergyGained;
                        if (ts.skillUsage) window.gameState.skillUsage = ts.skillUsage;
                        if (ts.diceStatistics) window.gameState.diceStatistics = ts.diceStatistics;
                        if (ts.defeatCounts) window.gameState.defeatCounts = ts.defeatCounts;
                    }
                }
            } catch (e) {
                // ignore
            }

            // 记录游戏结束时间
            try {
                if (data.timestamp) {
                    this.gameInstance.gameState.gameEndTime = data.timestamp;
                    if (window.gameState) {
                        window.gameState.gameEndTime = data.timestamp;
                    }
                } else {
                    this.gameInstance.gameState.recordGameEndTime();
                }
            } catch (e) {
                // ignore
            }

            // 结算用的是本地棋面，可能还压在快照队列里没追上（表现为冠军完成度不到 100%）。
            // 先把最后一帧权威快照强制拉回来，等本地棋面追平再弹结算
            this.requestSnapshot('对局结束', { force: true });
            const showWhenCaughtUp = (attempt = 0) => {
                if (!this.isRenderSettled() && attempt < 20) {
                    return setTimeout(() => showWhenCaughtUp(attempt + 1), 150);
                }
                if (isSelfMessage && !this.isSpectator) {
                    return;
                }
                this.gameInstance?.settlementModal?.show(data.winnerPlayer);
            };
            setTimeout(() => showWhenCaughtUp(), 1000); // 延迟1秒显示，让玩家看到胜利信息
        }
    }

    /**
     * 处理强制结算同步
     */
    handleForceSettlement(data) {
        // 自己发送的消息也需要处理（用于同步服务器权威数据，如progressHistory/gameStartTime等），
        // 但要避免重复弹出结算模态框。
        const isSelfMessage = String(data.playerId) === String(this.playerId);

        console.log(`处理强制结算同步:`, data.rankings);

        if (this.gameInstance) {
            // 使用服务器权威的游戏开始时间，避免断线/重连/中途退出导致本地起点被重置
            try {
                if (data.gameStartTime) {
                    if (this.gameInstance.gameState) {
                        this.gameInstance.gameState.gameStartTime = data.gameStartTime;
                    }
                    if (window.gameState) {
                        window.gameState.gameStartTime = data.gameStartTime;
                    }
                }
            } catch (e) {
                // ignore
            }

            // 同步服务器权威的完成度历史（用于结算折线图）
            try {
                if (Array.isArray(data.progressHistory)) {
                    if (this.gameInstance.gameState) {
                        this.gameInstance.gameState.progressHistory = data.progressHistory;
                    }
                    if (window.gameState) {
                        window.gameState.progressHistory = data.progressHistory;
                    }
                }
                if (typeof data.currentRound === 'number') {
                    if (this.gameInstance.gameState) {
                        this.gameInstance.gameState.currentRound = data.currentRound;
                    }
                    if (window.gameState) {
                        window.gameState.currentRound = data.currentRound;
                    }
                }
            } catch (e) {
                // ignore
            }

            // 强制结算等同于暂停并结束：非房主也需要显示暂停遮罩
            try {
                if (this.gameInstance.gameState && typeof this.gameInstance.gameState.setIsPaused === 'function') {
                    this.gameInstance.gameState.setIsPaused(true);
                } else if (window.gameState && typeof window.gameState.setIsPaused === 'function') {
                    window.gameState.setIsPaused(true);
                }
            } catch (e) {
                // ignore
            }

            try {
                if (typeof this.gameInstance.pauseGame === 'function') {
                    this.gameInstance.pauseGame();
                }
            } catch (e) {
                // ignore
            }

            // 设置游戏状态为结束
            this.gameInstance.gameState.setState('gamePhase', 'finished');

            // 记录结束时间（用于结算耗时显示）
            try {
                if (data.timestamp) {
                    this.gameInstance.gameState.gameEndTime = data.timestamp;
                    if (window.gameState) {
                        window.gameState.gameEndTime = data.timestamp;
                    }
                } else if (typeof this.gameInstance.gameState.recordGameEndTime === 'function') {
                    this.gameInstance.gameState.recordGameEndTime();
                }
            } catch (e) {
                // ignore
            }

            // 应用服务器广播的称号统计数据
            try {
                if (data.titleStats) {
                    this._applyTitleStats(data.titleStats);
                    if (window.gameState) {
                        const ts = data.titleStats;
                        window.gameState.titleStats = ts;
                        if (ts.maxTeleportDistance) window.gameState.titleStats.maxTeleportDistance = ts.maxTeleportDistance;
                        if (ts.mysteryBoxMax) window.gameState.titleStats.mysteryBoxMax = ts.mysteryBoxMax;
                        if (ts.mysteryBoxMin) window.gameState.titleStats.mysteryBoxMin = ts.mysteryBoxMin;
                        if (ts.polyhedralMax) window.gameState.titleStats.polyhedralMax = ts.polyhedralMax;
                        if (ts.polyhedralMin) window.gameState.titleStats.polyhedralMin = ts.polyhedralMin;
                        if (ts.skillUseCount) window.gameState.titleStats.skillUseCount = ts.skillUseCount;
                        if (ts.totalDistance) window.gameState.totalDistance = ts.totalDistance;
                        if (ts.totalEnergyGained) window.gameState.totalEnergyGained = ts.totalEnergyGained;
                        if (ts.skillUsage) window.gameState.skillUsage = ts.skillUsage;
                        if (ts.diceStatistics) window.gameState.diceStatistics = ts.diceStatistics;
                        if (ts.defeatCounts) window.gameState.defeatCounts = ts.defeatCounts;
                    }
                }
            } catch (e) {
                // ignore
            }

            // 显示结算模态框，传入排名信息
            if ((!isSelfMessage || this.isSpectator) && this.gameInstance.settlementModal) {
                this.gameInstance.settlementModal.showWithRankings(data.rankings);
            }
        }
    }

    /**
     * 同步进度条开始
     */
    syncProgressBarStart(playerId) {
        this.sendMessage('progressBarStart', {
            timestamp: Date.now()
        });
    }

    /**
     * 处理进度条开始同步：只是让各端把进度条画出来。
     * 窗口起点不采信这条消息（谁都能发），一律用快照带下来的服务端窗口
     */
    handleProgressBarStart(data) {
        const ui = this.gameInstance && this.gameInstance.uiUpdater;
        if (!ui) return;
        ui.updateProgressBarLoop();
        ui._renderThinkingProgressBar();
    }


    /**
     * 同步游戏暂停
     */
    syncGamePause() {
        if (this.isHost) {
            const messageData = {
                type: 'gamePause',
                timestamp: Date.now()
            };

            // 只发送gamePause消息，不需要重复发送gameInfo
            this.sendMessage('gamePause', messageData);
        }
    }

    /**
     * 处理游戏暂停
     */
    handleGamePaused(data) {
        if (this.gameInstance) {
            // 调用gameState的setIsPaused方法来触发完整的暂停UI逻辑
            if (this.gameInstance.gameState) {
                this.gameInstance.gameState.setIsPaused(true);
            } else if (window.gameState) {
                window.gameState.setIsPaused(true);
            }
            // 同时调用gameInstance的pauseGame方法来设置游戏阶段
            this.gameInstance.pauseGame();
            // 道具界面（传送门图标/数字牌/选点面板）统一按暂停态收起并登记恢复
            this._renderItemState(gameState);
        }
    }

    /**
     * 同步游戏恢复
     */
    syncGameResume() {
        if (this.isHost) {
            const messageData = {
                type: 'gameResume',
                timestamp: Date.now()
            };

            // 只发送gameResume消息，不需要重复发送gameInfo
            this.sendMessage('gameResume', messageData);
        }
    }

    /**
     * 处理玩家离开
     */
    handlePlayerLeft(data) {
        console.log(`玩家${data.playerId}离开了游戏`);

        // 在删除玩家数据之前，先获取玩家编号（用于后续处理）
        const playerNumber = this.getPlayerNumberByPlayerId(data.playerId);

        // 只有还没开打时才真正摘人（大厅里让出座位）；
        // 对局进行中与已经结束都保留：前者要交给 AI 托管，
        // 后者结算与数据分析得按整局名单出表，离场的人不能被抹掉
        const gamePhase = this.gameInstance?.gameState?.getGamePhase();
        const notStarted = !gamePhase || gamePhase === 'waiting';

        if (notStarted) {
            try {
                if (playerNumber) {
                    const activePlayers = activePlayerManager.getActivePlayers();
                    const newActivePlayers = activePlayers.filter(p => p !== playerNumber);
                    if (newActivePlayers.length !== activePlayers.length) {
                        activePlayerManager.setActivePlayers(newActivePlayers);
                    }
                }
            } catch (e) {
                // ignore
            }
            if (this.players) this.players.delete(data.playerId);
            if (this.aiTakeoverPlayers) this.aiTakeoverPlayers.delete(data.playerId);
        } else {
            console.log(`对局已开始（${gamePhase}），保留离线玩家 ${data.playerId} 的数据`);
        }
    }

    /**
     * 处理房主权限转移
     */
    handleHostTransferred(data) {
        const wasHost = this.isHost;
        this.isHost = (data.newHostId === this.playerId);

        // 更新暂停按钮UI
        if (window.gameInstance && window.gameInstance.eventHandler) {
            window.gameInstance.eventHandler.updatePauseButtonText();
        }

        // AI 与托管玩家的出手在服务端（botDriver），新房主不需要替谁操作
        if (window.gameInfo) {
            window.gameInfo.addChatMessage(null, `${data.newHostNickname} 成为了新房主`, null, true);
        }
    }

    /**
     * 处理错误
     */
    handleError(data) {
        console.error('游戏错误:', data.message);

        // 结算弹框显示期间，游戏会话可能被清理，不打扰用户
        const settlementModal = document.getElementById('settlement-modal');
        if (settlementModal && settlementModal.classList.contains('show')) {
            return;
        }

        // 服务端已经没有这一局了：继续自愈只会反复报错，收摊回主页
        if (SCENE_GONE_ERRORS.some((text) => data.message && data.message.includes(text))) {
            this.abortToHome('对局已不存在，即将返回主页');
            return;
        }

        this.showError(data.message);
    }

    /**
     * 显示连接错误
     */
    showConnectionError() {
        this.abortToHome('与服务器的连接已断开，即将返回主页');
    }

    /**
     * 会话已不存在（重连超限、被服务端清理）：停掉自愈、心跳与重连，提示后回主页
     */
    abortToHome(message) {
        if (this._abortedToHome) return;
        this._abortedToHome = true;

        this.disableReconnect = true;
        this.stopSnapshotSelfHeal();
        this.stopWsHeartbeat();
        this.showError(message);

        setTimeout(() => {
            window.location.replace('/');
        }, 2000);
    }

    /**
     * 显示错误信息
     */
    showError(message) {
        // 创建错误提示
        const errorDiv = document.createElement('div');
        errorDiv.className = 'multiplayer-error';
        errorDiv.textContent = message;

        document.body.appendChild(errorDiv);

        // 3秒后自动移除
        setTimeout(() => {
            if (errorDiv.parentNode) {
                errorDiv.parentNode.removeChild(errorDiv);
            }
        }, 3000);
    }

    /**
     * 处理待发送的消息队列
     */
    processPendingMessages() {
        if (this.pendingMessages && this.pendingMessages.length > 0) {
            for (const message of this.pendingMessages) {
                this.sendMessage(message.type, message.data);
            }

            // 清空待发送队列
            this.pendingMessages = [];
        }
    }

    /**
     * 检查是否为房主
     */
    isHostPlayer() {
        return this.isHost;
    }

    /**
     * 同步游戏信息
     */
    syncGameInfo(messageData) {

        if (!this.isOnlineMode) {
            console.log('❌ 不在联机模式');
            return;
        }

        if (!this.isConnected) {
            console.log('WebSocket连接未就绪，将消息加入待发送队列');
            // 将消息加入待发送队列，等连接建立后发送
            if (!this.pendingMessages) {
                this.pendingMessages = [];
            }
            this.pendingMessages.push({
                type: 'gameInfo',
                data: {
                    messageData: messageData,
                    playerId: this.playerId,
                    timestamp: Date.now()
                }
            });
            return;
        }

        this.sendMessage('gameInfo', {
            messageData: messageData,
            playerId: this.playerId,
            timestamp: Date.now()
        });
    }

    /**
     * 处理游戏信息同步
     */
    handleGameInfo(data) {
        // 如果是自己发送的消息，跳过处理，避免重复显示
        if (String(data.playerId) === String(this.playerId)) {
            return;
        }

        if (!this.gameInstance) {
            console.log('❌ gameInstance 不存在');
            return;
        }

        try {
            // 导入gameInfo模块并显示消息
            import('./gameInfo.js').then(module => {
                const gameInfo = module.gameInfo;

                if (gameInfo && gameInfo.infoContainer) {
                    // 使用skipSync=true参数调用addMessage，避免再次触发同步
                    gameInfo.addMessage(data.messageData, true);
                } else {
                    console.log('❌ gameInfo 或 infoContainer 不可用');
                }
            }).catch(error => {
                console.error('❌ 导入 gameInfo 模块失败:', error);
            });
        } catch (error) {
            console.error('❌ 处理游戏信息同步失败:', error);
        }
    }

    /**
     * 刷新后重建右侧面板：战报由服务端留存的整局事件流静默回放，聊天直接补回。
     * 与实时路径共用同一套事件翻译，天然不会出现重复。
     */
    async applyGameInfoHistory(data) {
        if (!data) return;
        if (!gameInfo.infoContainer) return;

        const events = Array.isArray(data.events) ? data.events : [];
        const chatList = Array.isArray(data.chat) ? data.chat : [];

        try {
            if (events.length) {
                for (const batch of events) {
                    const list = Array.isArray(batch) ? batch : [batch];
                    if (list.length) await enginePlayback.replay(list);
                }
            }
            if (chatList.length) {
                chatList.forEach(item => {
                    if (!item) return;
                    gameInfo.addMessage({
                        type: 'chat_message',
                        // 观战者没有席位编号，判别要看 isSpectatorMessage，否则会被当成系统消息
                        player: (item.isSystemMessage || item.isSpectatorMessage) ? null : item.playerNumber,
                        data: {
                            message: item.message,
                            playerName: item.playerName ?? null,
                            isSpectatorMessage: !!item.isSpectatorMessage
                        }
                    }, true, true);
                });
            }
        } catch (error) {
            console.error('❌ 回放游戏信息历史失败:', error);
        }
    }

    /**
     * 获取当前玩家ID
     */
    getCurrentPlayerId() {
        return this.playerId;
    }

    /**
     * 处理游戏会话连接消息
     */
    /** 用服务端名单校正「谁是机器人」：两边不一致时 botController 会静默不出手 */
    _syncBotFlagsFromRoster(roster) {
        const bots = (roster || []).filter((player) => player && player.isAI);
        if (!bots.length) return;

        gameState.setBotPlayers(bots.map((bot) => bot.color ?? bot.id));
        if (window.botController) {
            if (!window.botController.isEnabled) window.botController.setEnabled(true);
            const difficulties = {};
            for (const bot of bots) difficulties[bot.color ?? bot.id] = bot.difficulty || 'easy';
            window.botController.setBotDifficulties?.(difficulties);
        }
    }

    handleGameSessionConnected(data) {
        const isRealReconnect = !!(this.isReconnecting || this._didDisconnectOnce);

        // 同步已加载音频的玩家列表
        if (data.audioLoadedPlayers && Array.isArray(data.audioLoadedPlayers)) {
            data.audioLoadedPlayers.forEach(id => this.audioLoadedPlayers.add(id));
            const loadedCount = this.audioLoadedPlayers.size;
            
            // 如果发现服务器上所有人已经加载好了
            if (loadedCount >= this.totalPlayers && this.totalPlayers > 0) {
                if (window.audioManager) {
                    window.audioManager.allPlayersAudioLoaded = true;
                    // 如果本地音频也已加载完毕，主动触发 ready 状态
                    // 避免已触发过 waiting_others 但等待状态无法清除的问题
                    if (window.audioManager.isLoaded) {
                        window.audioManager._notifyStatus('ready');
                    }
                }
            }

            const isLocalLoaded = window.audioManager && window.audioManager.isLoaded;
            if (window.audioManager && isLocalLoaded && !window.audioManager.allPlayersAudioLoaded && this.totalPlayers > 0) {
                window.audioManager.updateLoadingText(`等待其他玩家加载... ${loadedCount}/${this.totalPlayers}`);
            }
        }
        
        // 确保游戏状态知道我们处于在线多人模式
        if (window.gameState && typeof window.gameState.setIsOnlineMultiplayer === 'function') {
            window.gameState.setIsOnlineMultiplayer(true);
        }
        
        try {
            // 更新游戏会话信息
            if (data.gameSessionId) {
                this.gameSessionId = data.gameSessionId;
            }

            // 更新玩家信息并恢复AI托管状态
            if (data.gameSession && data.gameSession.players) {
                // 重新计算真实玩家总数，确保与服务器逻辑一致
                const realPlayers = data.gameSession.players.filter(p => !p.isAI);
                this.totalPlayers = realPlayers.length;

                // 清空现有玩家信息和AI托管列表
                this.players.clear();
                this.aiTakeoverPlayers.clear();

                // 恢复本机音效开关：服务端有记录则以服务端为准，否则上报本地偏好
                if (window.audioManager && !this.isSpectator) {
                    const localPlayer = data.gameSession.players.find(p => String(p.id) === String(this.playerId));
                    if (localPlayer && typeof localPlayer.audioEnabled === 'boolean') {
                        window.audioManager.setEnabled(localPlayer.audioEnabled);
                    } else {
                        this.syncAudioEnabled(window.audioManager.isEnabled);
                    }
                }

                // 添加新的玩家信息
                for (const player of data.gameSession.players) {
                    this.players.set(player.id, {
                        id: player.id,
                        nickname: player.nickname,
                        color: player.color,
                        emoji: player.emoji,
                        isAI: player.isAI,
                        isAITakeover: player.isAITakeover || false // 恢复AI托管状态
                    });

                    // 如果玩家处于AI托管状态，加入AI托管列表（仅限真实玩家，不包括AI电脑玩家）
                    if (player.isAITakeover && !player.isAI) {
                        this.aiTakeoverPlayers.add(player.id);
                        console.log(`恢复AI托管状态: 玩家${player.id}处于AI托管中`);

                        // 设置AI托管使用简单难度
                        const playerNumber = player.color;
                        if (playerNumber && window.botController) {
                            window.botController.botDifficulties[playerNumber] = 'easy';
                            console.log(`设置AI托管玩家${playerNumber}为简单难度`);
                        }

                        // 更新AI托管显示（对所有客户端，包括房主）
                        setTimeout(() => {
                            this.updatePlayerAITakeoverDisplay(player.id, true);
                        }, 200);

                        // 如果是当前本地玩家，且游戏没有处于暂停状态，恢复本地AI托管状态
                        if (player.id === this.playerId && !data.gameData?.isPaused) {
                            // 异步恢复本地AI托管状态
                            setTimeout(async () => {
                                const { aiTakeoverManager } = await import('./aiTakeoverManager.js');
                                if (!aiTakeoverManager.isActive) {
                                    // 直接设置状态，不触发同步
                                    aiTakeoverManager.isActive = true;
                                    // 确保使用window.gameState以避免undefined错误
                                    if (window.gameState && typeof window.gameState.setAITakeover === 'function') {
                                        window.gameState.setAITakeover(true);
                                    }
                                    aiTakeoverManager.updateToggleButton();
                                    aiTakeoverManager.updateControlButtons();
                                    // 恢复昵称标记（如果需要）
                                    aiTakeoverManager.modifyHumanPlayerNames();

                                    // 启用botController以支持AI托管
                                    if (window.botController && !window.botController.isEnabled) {
                                        window.botController.setEnabled(true);
                                    }
                                }
                            }, 100);
                        } else if (player.id === this.playerId && data.gameData?.isPaused) {
                            console.log('游戏处于暂停状态，当前玩家暂不恢复本地托管UI，以防止影响暂停UI');
                        }
                    }
                }


                // 名单到手就校正一次「谁是机器人」：缺了这一步，那台机器上的 AI 会静默不出手
                this._syncBotFlagsFromRoster(data.gameSession.players);

                // 更新游戏中的玩家名称显示
                this.updateGamePlayerNames(data.gameSession.players);

                // 重连/刷新回来时把头像也贴回去（观战路径一直这么做，玩家路径漏了）
                for (const player of data.gameSession.players) {
                    if (player.color && player.emoji) {
                        window.gameInstance?.updatePlayerEmoji?.(player.color, player.emoji);
                    }
                }

                // 更新房主状态（重连时需要）
                const myPlayerData = data.gameSession.players.find(p => p.id === this.playerId);
                const wasHost = this.isHost;
                this.isHost = myPlayerData?.isHost || false;
                
                // 无论房主状态是否改变，只要连接/重连成功就更新一次暂停和结算按钮UI
                if (window.eventHandler) {
                    window.eventHandler.updatePauseButtonText();
                } else if (window.gameInstance && window.gameInstance.eventHandler) {
                    window.gameInstance.eventHandler.updatePauseButtonText();
                }

                if (isRealReconnect) {
                    console.log(`[重连] 更新房主状态: ${wasHost} -> ${this.isHost}`);
                }

                // 房主状态变化时，同步托管显示
                if (wasHost !== this.isHost) {
                    // 更新暂停和结算按钮UI
                    if (window.gameInstance && window.gameInstance.eventHandler) {
                        window.gameInstance.eventHandler.updatePauseButtonText();
                    }
                    
                    // 房主身份变化只影响「谁能暂停/结束」这类权限：AI 与托管出手在服务端
                    if (!this.isHost && gameState && gameState.thinkingTimer) {
                        // 不再是房主，清掉替别人挂着的超时回调
                        const currentPlayer = gameState.getCurrentPlayer();
                        const localPlayerNumber = this.getPlayerNumberByPlayerId(this.playerId);
                        if (currentPlayer !== localPlayerNumber) {
                            clearTimeout(gameState.thinkingTimer);
                            gameState.thinkingTimer = null;
                        }
                    }
                }

                // 初始化activePlayerManager
                const activePlayers = data.gameSession.players
                    .map(p => p.color)
                    .sort((a, b) => a - b);
                if (isRealReconnect) {
                    console.log('[重连] 初始化activePlayerManager:', activePlayers);
                }
                activePlayerManager.setActivePlayers(activePlayers);
            }

            // 恢复游戏状态数据（包括棋子位置）
            // 只要有gameData，无论是否是重连都应该恢复！
            if (data.gameSession && data.gameSession.gameData) {
                const gameData = data.gameSession.gameData;
                
                // 重连时的加载遮罩处理
                // 如果本地音频已经加载好了，且服务器同步过来的名单显示全员已就位
                const isAllAudioLoadedOnServer = this.audioLoadedPlayers.size >= this.totalPlayers;
                if (isRealReconnect && window.audioManager) {
                    if (window.audioManager.isLoaded && isAllAudioLoadedOnServer) {
                        console.log('[重连] 本地和服务器均显示加载完成，通知音频就绪');
                        window.audioManager.onAllPlayersAudioLoaded();
                    } else if (window.audioManager.isLoaded && !isAllAudioLoadedOnServer) {
                        console.log('[重连] 本地已加载但服务器未就绪，仍强制标记音频就绪避免阻塞进度条');
                        window.audioManager.allPlayersAudioLoaded = true;
                    } else if (!window.audioManager.isLoaded) {
                        console.log('[重连] 本地音频尚未加载完成，仍强制标记音频就绪避免阻塞进度条');
                        window.audioManager.allPlayersAudioLoaded = true;
                    }
                }

                console.log('[游戏状态同步] 收到gameData:', gameData);

                // 检查是否需要恢复：有当前玩家或有棋子不在初始位置
                const needsRestore = gameData.currentPlayer !== null ||
                    this.hasNonInitialChessPositions(gameData.playerChess);

                // 对局已有推进痕迹说明这是刷新/重连而非全新开局，别再冒出一条"游戏开始"
                if ((gameData.currentRound || 0) > 0 ||
                    (gameData.diceValue || 0) > 0 ||
                    this.hasNonInitialChessPositions(gameData.playerChess)) {
                    this.hasPrintedGameStart = true;
                }
                
                // 服务端权威会话接管后，棋面/骰子/阶段一律以随后的 gameSnapshot 为准，
                // 此处只补快照不包含的辅助状态（积分、思考进度时间），避免两套恢复逻辑互相覆盖
                if (this.isSpectator || needsRestore) {
                    console.log('[游戏状态同步] 恢复辅助状态，等待权威快照');
                    this.restoreAuxState(gameData);
                } else {
                    console.log('[游戏状态同步] 跳过恢复，条件不满足');
                }
            } else {
                if (isRealReconnect) {
                    console.log('[重连] 没有gameData，跳过恢复');
                }
            }

            // 如果游戏实例存在，通知游戏实例更新状态
            if (this.gameInstance && typeof this.gameInstance.updateMultiplayerState === 'function') {
                this.gameInstance.updateMultiplayerState({
                    players: data.gameSession.players,
                    gameSessionId: data.gameSessionId
                });
            }

            // 重连完成后的最终UI刷新：确保骰子和棋子高亮状态正确
            // 使用 setTimeout 延迟到 AI 操作（如果有）之后执行
            setTimeout(() => {
                if (uiUpdater) {
                    const dv = gameState ? gameState.getDiceValue() : 0;
                    uiUpdater.updateDiceDisplay(dv);
                    // 如果在 selecting 阶段，高亮可移动棋子
                    if (gameState && gameState.getGamePhase() === 'selecting') {
                        uiUpdater.highlightMovableChess();
                    }
                }
                // 刷新 AI 托管按钮状态（此时音频可能已加载完成）
                if (window.aiTakeoverManager && typeof window.aiTakeoverManager.updateToggleButton === 'function') {
                    window.aiTakeoverManager.updateToggleButton();
                }
            }, 100);

        } catch (error) {
            console.error('处理游戏会话连接消息失败:', error);
        }
    }

    /**
     * 检查是否有棋子不在初始位置
     */
    hasNonInitialChessPositions(playerChess) {
        if (!playerChess) return false;

        for (const color in playerChess) {
            const chesses = playerChess[color];
            if (Array.isArray(chesses)) {
                for (const chess of chesses) {
                    // 如果棋子位置不是-1（起始区域）或者已完成，说明游戏已经开始
                    if (chess.position !== -1 || chess.finished === true) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * 更新游戏中的玩家名称显示
     */
    updateGamePlayerNames(players) {
        try {
            players.forEach(player => {
                const playerId = player.color || player.id;
                const playerName = player.nickname || `玩家${playerId}`;

                // 更新playerNameManager中的名称
                if (window.playerNameManager) {
                    window.playerNameManager.setPlayerName(playerId, playerName);
                }

                // 更新UI中的玩家名称显示
                const playerNameElements = document.querySelectorAll(`.player-${playerId}-info .player-name`);
                playerNameElements.forEach(element => {
                    element.textContent = playerName;
                });
            });
        } catch (error) {
            console.error('更新游戏玩家名称失败:', error);
        }
    }

    /**
     * 处理服务端下发的音效开关变化（仅作用于本机玩家）
     */
    handleAudioEnabledChange(data) {
        if (String(data.playerId) !== String(this.playerId)) return;
        if (window.audioManager) {
            window.audioManager.setEnabled(data.enabled);
        }
    }

    /**
     * 处理AI托管状态变化
     */
    async handleAITakeoverChange(data) {
        try {
            console.log('收到AI托管状态变化:', {
                ...data,
                isHost: this.isHost,
                当前aiTakeoverPlayers: Array.from(this.aiTakeoverPlayers)
            });

            // 检查当前状态是否与目标状态一致，避免重复处理
            const currentState = this.aiTakeoverPlayers.has(data.playerId);
            if (currentState === data.isActive) {
                console.log(`AI托管状态无需更新，当前状态: ${currentState}, 目标状态: ${data.isActive}`);
                return;
            }

            // 更新AI托管状态记录
            if (data.isActive) {
                this.aiTakeoverPlayers.add(data.playerId);
                console.log(`玩家${data.playerId}加入AI托管列表`, {
                    aiTakeoverPlayers: Array.from(this.aiTakeoverPlayers),
                    isHost: this.isHost
                });

                // 更新 players Map 中的 isAITakeover 状态
                const playerData = this.players.get(data.playerId);
                if (playerData) {
                    playerData.isAITakeover = true;
                    console.log(`已更新玩家${data.playerId}的isAITakeover状态为true`);
                }

                // 设置AI托管使用简单难度
                const playerNumber = this.getPlayerNumberByPlayerId(data.playerId);
                if (playerNumber && window.botController) {
                    window.botController.botDifficulties[playerNumber] = 'easy';
                    console.log(`AI托管：设置玩家${playerNumber}为简单难度`);
                }
            } else {
                this.aiTakeoverPlayers.delete(data.playerId);
                console.log(`玩家${data.playerId}退出AI托管列表`, {
                    aiTakeoverPlayers: Array.from(this.aiTakeoverPlayers),
                    isHost: this.isHost
                });

                // 更新 players Map 中的 isAITakeover 状态
                const playerData = this.players.get(data.playerId);
                if (playerData) {
                    playerData.isAITakeover = false;
                    console.log(`已更新玩家${data.playerId}的isAITakeover状态为false`);
                }

                // 移除AI托管难度设置
                const playerNumber = this.getPlayerNumberByPlayerId(data.playerId);
                if (playerNumber && window.botController) {
                    delete window.botController.botDifficulties[playerNumber];
                    console.log(`AI托管：移除玩家${playerNumber}的难度设置`);
                }
            }

            // 更新AI托管显示状态
            const localPlayerId = this.getCurrentPlayerId();
            if (data.playerId !== localPlayerId) {
                this.updatePlayerAITakeoverDisplay(data.playerId, data.isActive);
            } else {
                // 本地玩家的托管状态也需要更新（用于自动托管）
                this.updatePlayerAITakeoverDisplay(data.playerId, data.isActive);
            }

            // 如果是被托管的玩家本身，更新其本地UI（按钮状态、网页标题等）
            if (String(data.playerId) === String(this.playerId)) {
                if (window.aiTakeoverManager && typeof window.aiTakeoverManager.applyRemoteTakeoverState === 'function') {
                    window.aiTakeoverManager.applyRemoteTakeoverState(data.isActive);
                }
            }

            // 如果是自动托管，添加系统消息提示
            if (data.auto && window.gameInfo) {
                const player = this.getPlayerByPlayerId(data.playerId);
                const playerName = player?.nickname || '玩家';
                
                // 确定是离线托管还是超时托管
                const isTimeout = data.reason === 'thinking_timeout';
                const reasonText = isTimeout ? '思考时间到' : '离线';

                if (data.isActive) {
                    // 自动开启AI托管
                    window.gameInfo.addChatMessage(null, `${playerName} ${reasonText}，已自动开启AI托管`, null, true);
                    console.log(`${playerName} ${reasonText}，自动开启AI托管`);
                } else {
                    // 关闭自动托管
                    const resumeText = isTimeout ? '恢复操作' : '重连';
                    window.gameInfo.addChatMessage(null, `${playerName} ${resumeText}，已关闭自动托管`, null, true);
                    console.log(`${playerName} ${resumeText}，关闭自动托管`);
                }
            }

        } catch (error) {
            console.error('处理AI托管状态变化失败:', error);
        }
    }

    /**
     * 处理昵称变化
     */
    async handleNicknameChange(data) {
        try {
            console.log('收到昵称变化:', data);
            console.log('当前本地玩家ID:', this.getCurrentPlayerId());

            // 更新玩家昵称显示
            const localPlayerId = this.getCurrentPlayerId();
            if (data.playerId !== localPlayerId) {
                this.updatePlayerNicknameDisplay(data.playerId, data.nickname);
            } else {
                // 本地玩家也需要更新显示，确保UI同步
                this.updatePlayerNicknameDisplay(data.playerId, data.nickname);
            }
        } catch (error) {
            console.error('处理昵称变化失败:', error);
        }
    }

    /**
     * 更新玩家昵称显示
     */
    updatePlayerNicknameDisplay(playerId, nickname) {
        try {
            const playerNumber = this.getPlayerNumberByPlayerId(playerId);
            console.log(`[联机] 更新昵称显示 - playerId: ${playerId}, playerNumber: ${playerNumber}, nickname: ${nickname}`);

            if (playerNumber !== null) {
                // 更新 playerNameManager 中的数据
                if (window.playerNameManager) {
                    window.playerNameManager.setPlayerName(playerNumber, nickname);
                    console.log(`[联机] 已更新 playerNameManager: 玩家${playerNumber} -> ${nickname}`);
                }

                // 更新所有相关的昵称显示元素（包括电脑端和手机端）
                const playerNameElements = document.querySelectorAll(`.player-${playerNumber}-info .player-name`);

                playerNameElements.forEach((element, index) => {
                    element.textContent = nickname;
                });

                // 额外确保移动端元素也被更新（防止选择器遗漏）
                const mobileTopElement = document.querySelector(`.players-top .player-${playerNumber}-info .player-name`);
                if (mobileTopElement) {
                    mobileTopElement.textContent = nickname;
                }

                const mobileBottomElement = document.querySelector(`.players-bottom .player-${playerNumber}-info .player-name`);
                if (mobileBottomElement) {
                    mobileBottomElement.textContent = nickname;
                }

                // 确保桌面端元素也被更新
                const desktopElement = document.querySelector(`.players-info .player-${playerNumber}-info .player-name`);
                if (desktopElement) {
                    desktopElement.textContent = nickname;
                }
            }
        } catch (error) {
            console.error('更新玩家昵称显示失败:', error);
        }
    }

    /**
     * 更新玩家AI托管显示状态
     */
    updatePlayerAITakeoverDisplay(playerId, isActive) {
        try {
            // 只更新指定玩家的AI托管状态，不影响其他玩家
            const playerNumber = this.getPlayerNumberByPlayerId(playerId);

            if (playerNumber !== null) {
                // 查找所有相关的玩家名称元素（桌面端和手机端）
                // 使用类名选择器，确保选中正确的玩家（不受DOM顺序影响）
                const selectors = [
                    `.players-info .player-${playerNumber}-info .player-name`,  // 桌面端
                    `.players-top .player-${playerNumber}-info .player-name`,  // 手机端顶部
                    `.players-bottom .player-${playerNumber}-info .player-name`  // 手机端底部
                ];

                let updated = false;
                let found = false;
                selectors.forEach((selector) => {
                    const elements = document.querySelectorAll(selector);
                    elements.forEach(element => {
                        found = true;
                        const currentName = element.textContent;

                        if (isActive && !currentName.includes('【Bot】')) {
                            // 添加AI标记
                            element.textContent = currentName + '【Bot】';
                            updated = true;
                        } else if (!isActive && currentName.includes('【Bot】')) {
                            // 移除AI标记
                            element.textContent = currentName.replace('【Bot】', '');
                            updated = true;
                        }
                    });
                });

                if (!updated) {
                    // 名称已是目标状态时本来就无需改动；只有元素还没渲染出来才值得排一次重试
                    if (!this._aiTakeoverUiRetryTimers) {
                        this._aiTakeoverUiRetryTimers = new Map();
                    }

                    // 目标状态已经过期（例如托管刚被关掉）就丢弃这次界面更新
                    const currentState = this.aiTakeoverPlayers.has(playerId);
                    if (currentState !== isActive) {
                        console.log(`[AI托管] 丢弃过期的界面更新：目标 ${isActive}，当前 ${currentState}`);
                        return;
                    }

                    if (this._aiTakeoverUiRetryTimers.has(playerNumber)) {
                        return; // 已有重试在排队
                    }
                    if (!found) {
                        console.log(`[AI托管] 暂未找到玩家${playerNumber}的名称元素，稍后重试一次`);
                    }

                    const timer = setTimeout(() => {
                        try {
                            this._aiTakeoverUiRetryTimers.delete(playerNumber);
                            // 重试前再次检查状态一致性
                            const latestState = this.aiTakeoverPlayers.has(playerId);
                            if (latestState === isActive) {
                                this.updatePlayerAITakeoverDisplay(playerId, isActive);
                            } else {
                                console.log(`[AI托管] 重试时状态已变化，放弃这次界面更新：目标 ${isActive}，当前 ${latestState}`);
                            }
                        } catch (e) {
                            // ignore
                        }
                    }, 120);
                    this._aiTakeoverUiRetryTimers.set(playerNumber, timer);
                }
            } else {
                console.warn(`无法找到playerId ${playerId} 对应的玩家编号`);
            }
        } catch (error) {
            console.error('更新玩家AI托管显示状态失败:', error);
        }
    }

    /**
     * 根据playerId获取玩家编号
     */
    getPlayerNumberByPlayerId(playerId) {
        // 如果查询的是自己作为观战者的ID，不用打印警告直接返回null
        if (this.isSpectator && playerId === this.playerId) {
            return null;
        }

        // 减少日志输出，避免控制台刷屏
        for (const [id, player] of this.players) {
            if (id === playerId) {
                return player.color;
            }
        }

        // 如果在重连过程中找不到玩家，先返回null，避免频繁警告
        if (!this.gameInitialized && !this.isSpectator) {
            return null;
        }

        console.warn(`无法找到玩家 ${playerId} 的编号`);
        return null;
    }

    /**
     * 根据玩家编号获取玩家ID（与getPlayerNumberByPlayerId相反）
     */
    getPlayerIdByPlayerNumber(playerNumber) {
        for (const [id, player] of this.players) {
            if (player.color === playerNumber) {
                return id;
            }
        }
        return null;
    }

    /**
     * 根据playerId获取玩家对象
     */
    getPlayerByPlayerId(playerId) {
        if (this.isSpectator && playerId === this.playerId) {
            return null;
        }
        return this.players.get(playerId);
    }

    /**
     * 同步骰子重置
     */
    syncDiceReset() {
        if (!this.isOnlineMode || !this.isConnected) {
            return;
        }

        this.sendMessage('diceReset', {
            timestamp: Date.now()
        });
    }

    /**
     * 处理骰子重置同步
     */
    handleDiceReset(data) {
        // 忽略自己发送的消息
        if (String(data.playerId) === String(this.playerId)) {
            return;
        }

        // 停止骰子闪烁动画
        if (this.currentFlashInterval) {
            clearInterval(this.currentFlashInterval);
            this.currentFlashInterval = null;
        }

        const diceDisplay = document.getElementById('diceDisplay');
        if (diceDisplay) {
            diceDisplay.classList.remove('dice-flashing', 'dice-waiting');
        }

        if (this.gameInstance && this.gameInstance.uiUpdater) {
            this.gameInstance.uiUpdater.updateDiceDisplay(0);
        }
    }


    /**
     * 处理玩家断开连接消息
     */
    handlePlayerDisconnected(data) {
        console.log('玩家断开连接:', data);

        // 检查断线玩家是否开启了AI托管，如果是则关闭
        const playerId = data.playerId;
        const playerData = this.players.get(playerId);

        // 只处理真实玩家的AI托管（AI电脑玩家不应该有AI托管状态）
        if (playerData && playerData.isAI) {
            console.log(`玩家${playerId}是AI电脑玩家，跳过AI托管处理`);
            return;
        }

        // 检查玩家是否已经标记为断开连接，避免重复处理
        const currentStatus = this._playerConnectionStatus.get(playerId);
        if (currentStatus === false) {
            console.log(`玩家${playerId}已经标记为断开连接，跳过重复处理`);
            return;
        }

        // 更新玩家连接状态为断开
        this._playerConnectionStatus.set(playerId, false);

        // 注意：断线不应改变“AI托管开关”本身。
        // 玩家离线时，如果其AI托管此前已开启，应继续保持开启状态，
        // 否则会出现【Bot】标记被移除但本地仍处于托管（遮罩/按钮状态未变）的不同步问题。

        // 注意：服务器端已经发送了chatMessage系统消息，这里不需要重复显示
        // 只需要更新激活玩家列表
        const player = data.players?.find(p => p.id === playerId);
        if (player) {

            // 检查断线玩家是否是当前玩家
            const currentPlayer = this.gameInstance?.gameState?.getCurrentPlayer();
            if (player.color === currentPlayer) {
                console.log(`当前玩家${player.color}断线，检查是否需要接管处理`);

                // 如果当前客户端是房主，接管处理
                if (this.isHost) {
                    // 如果游戏尚未正式开始，不要启动超时接管。
                    // 此时服务器应该已经触发了首发权转移。
                    if (this.gameInstance && this.gameInstance.gameState && !this.gameInstance.gameState.getGameOfficiallyStarted()) {
                        console.log('[断线] 游戏尚未正式开始，房主跳过接管逻辑，等待服务器首发权转移');
                        return;
                    }

                    console.log(`房主接管断线玩家${player.color}的超时等待处理`);
                    // 获取当前进度条的剩余时间
                    const remainingTime = gameState.getRemainingThinkingTime();
                    console.log(`剩余思考时间: ${remainingTime}ms`);

                    if (remainingTime > 0) {
                        // 设置超时回调，等待自然结束，不提前接管
                        if (gameState.thinkingTimer) {
                            clearTimeout(gameState.thinkingTimer);
                        }
                        gameState._thinkingTimerContext = {
                            startTime: gameState.thinkingStartTime,
                            player: gameState.currentPlayer,
                            phase: gameState.gamePhase
                        };
                        gameState.thinkingTimer = setTimeout(() => {
                            if (this.gameInstance?.dice?.handleThinkingTimeoutWrapper) {
                                this.gameInstance.dice.handleThinkingTimeoutWrapper();
                            }
                        }, remainingTime);
                    } else {
                        // 时间已用完，立即触发超时
                        if (this.gameInstance?.dice?.handleThinkingTimeoutWrapper) {
                            this.gameInstance.dice.handleThinkingTimeoutWrapper();
                        }
                    }
                }
            }
        }
    }

    /**
     * 处理玩家重连消息
     */
    handlePlayerReconnected(data) {
        // 检查玩家是否已经标记为连接，避免重复处理
        const playerId = data.playerId;
        const currentStatus = this._playerConnectionStatus.get(playerId);
        if (currentStatus === true) {
            return;
        }

        // 更新玩家连接状态为连接
        this._playerConnectionStatus.set(playerId, true);

        // 更新本地的房主状态（从服务器数据中获取）
        if (data.players) {
            const myPlayerData = data.players.find(p => p.id === this.playerId);
            const wasHost = this.isHost;
            this.isHost = myPlayerData?.isHost || false;

            if (wasHost !== this.isHost) {
                console.log(`[玩家重连] 房主状态变化: ${wasHost} -> ${this.isHost}`);
                
                // 无论房主是否变化，只要收到玩家重连消息就同步一次暂停和结算按钮状态
                if (window.eventHandler) {
                    window.eventHandler.updatePauseButtonText();
                } else if (window.gameInstance && window.gameInstance.eventHandler) {
                    window.gameInstance.eventHandler.updatePauseButtonText();
                }

                // 如果不再是房主，清除AI托管的超时回调（除非是自己的回合）
                if (!this.isHost && wasHost) {
                    // 更新暂停和结算按钮UI
                    if (window.gameInstance && window.gameInstance.eventHandler) {
                        window.gameInstance.eventHandler.updatePauseButtonText();
                    }
                    
                    const currentPlayer = gameState?.getCurrentPlayer();
                    const localPlayerNumber = this.getPlayerNumberByPlayerId(this.playerId);
                    if (currentPlayer !== localPlayerNumber && gameState?.thinkingTimer) {
                        console.log('[玩家重连] 不再是房主，清除非本地玩家的超时回调');
                        clearTimeout(gameState.thinkingTimer);
                        gameState.thinkingTimer = null;
                    }
                }
            }
        }

        // 更新玩家信息
        if (data.players) {
            for (const player of data.players) {
                const existingPlayer = this.players.get(player.id);
                if (existingPlayer) {
                    existingPlayer.isConnected = player.isConnected;
                    existingPlayer.isHost = player.isHost;
                    existingPlayer.isAI = player.isAI;
                }
            }
        }

        // 更新激活玩家列表
        const player = data.players?.find(p => p.id === data.playerId);
        if (player) {
            // 将重连玩家添加回激活玩家列表
            if (player.color) {
                const activePlayers = activePlayerManager.getActivePlayers();
                if (!activePlayers.includes(player.color)) {
                    // 按color排序插入
                    const newActivePlayers = [...activePlayers, player.color].sort((a, b) => a - b);
                    console.log(`玩家${player.color}重连，更新激活玩家列表: [${newActivePlayers.join(', ')}]`);
                    activePlayerManager.setActivePlayers(newActivePlayers);
                }
            }
        }

        // 自己重连：如果本地仍处于AI托管，主动向服务器重新同步一次。
        // 否则其他客户端只会看到昵称【Bot】（本地渲染）而收不到托管状态，导致操作权限/标记不同步。
        if (String(data.playerId) === String(this.playerId)) {
            try {
                const localTakeoverActive = !!(window.gameState && typeof window.gameState.getIsAITakeover === 'function' && window.gameState.getIsAITakeover());
                if (localTakeoverActive && this.isConnected) {
                    this.sendMessage('aiTakeoverChange', {
                        playerId: this.playerId,
                        isActive: true,
                        timestamp: Date.now(),
                        reason: 'reconnect_resync'
                    });
                }
            } catch (e) {
                // ignore
            }
        }
    }

    /**
     * 处理游戏自动暂停消息
     */
    handleGameAutoPaused(data) {
        console.log('游戏已自动暂停:', data);
    }

    /**
     * 处理游戏恢复消息
     */
    handleGameResumed(data) {
        // 所有客户端（包括重连者和非重连者）都需要同步恢复游戏状态并显示消息
        if (this.gameInstance) {
            // 调用gameState的setIsPaused方法来触发完整的恢复UI逻辑
            if (this.gameInstance.gameState) {
                this.gameInstance.gameState.setIsPaused(false);
            } else if (window.gameState) {
                window.gameState.setIsPaused(false);
            }
            // 同时调用gameInstance的resumeGame方法来设置游戏阶段和重启进度条
            if (this.gameInstance.resumeGame) {
                this.gameInstance.resumeGame();
            }
            // 暂停期间道具界面被统一收起过，这里按同一份权威状态重画（刷新回来的 DOM 是空的）
            this._renderItemState(gameState);
            // 更新按钮文本
            if (window.eventHandler) {
                window.eventHandler.updatePauseButtonText();
            }
            // 所有客户端都添加游戏恢复消息（不同步到服务器，避免重复）
            if (window.gameInfo) {
                window.gameInfo.addGameResume(true); // skipSync=true
            }
        }
    }

    /**
     * 处理房间即将销毁消息
     */
    handleRoomDestroying(data) {
        console.log('房间即将销毁:', data);
        // 5秒后返回主页
        setTimeout(() => {
            alert('房间已被销毁，即将返回主页');
            window.location.replace('/');
        }, 5000);
    }

    /**
     * 处理房主变更消息
     */
    handleHostChanged(data) {
        this.isHost = data.newHostId === this.playerId;

        // 更新暂停按钮UI
        if (window.gameInstance && window.gameInstance.eventHandler) {
            window.gameInstance.eventHandler.updatePauseButtonText();
        }

        // 显示系统消息（AI/托管的出手在服务端，新房主不需要接管什么）
        if (window.gameInfo) {
            if (this.isHost) {
                window.gameInfo.addChatMessage(null, `你已成为新房主`, null, true);
            } else {
                window.gameInfo.addChatMessage(null, `${data.newHostNickname} 成为新房主`, null, true);
            }
        }
    }

    /**
     * 销毁管理器
     */
    destroy() {
        this.disableReconnect = true;
        this.gameSessionId = null;
        this.stopSnapshotSelfHeal();
        this.stopWsHeartbeat();
        this._snapshotGate.reset();
        this._snapshotRetryCount = 0;
        this._catchUpMode = false;
        this._serverThinkingWindow = null;
        // 不重置 reconnectManager，保留 roomCode 和 gameSessionId 以便玩家从房间列表重连
        if (this.wsClient) {
            this.wsClient.close();
            this.wsClient = null;
        }
        this.isConnected = false;
        this.players.clear();
        this.gameInstance = null;
    }
}

// 创建全局实例
const multiplayerGameManager = new MultiplayerGameManager();
window.multiplayerGameManager = multiplayerGameManager;
export { multiplayerGameManager, MultiplayerGameManager };
