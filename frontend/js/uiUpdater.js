import { gameState } from './gameState.js';
import { progressDisplay } from './progressDisplay.js';
import { DICE_SYMBOLS } from './utils.js';
import { engineAdapter } from './engineAdapter.js';

class UIUpdater {
    constructor() {
        // 进度条显示时钟（只服务观感，和超时计时器互不干涉）：
        // 进新阶段归零重走，演出期间冻在原处，演完接着走
        this._barActive = false;
        this._barElapsedMs = 0;
        this._barRunSince = null;
        this._barFrozenPct = 0;
    }

    // 更新UI界面
    updateUI() {
        // 如果是观战模式，跳过某些交互相关的UI更新
        const isSpectator = window.gameInstance && window.gameInstance.multiplayerGameManager && window.gameInstance.multiplayerGameManager.isSpectator;

        this.updateDiceDisplay();
        
        if (!isSpectator) {
            this.updateChessGlow();
            this.highlightMovableChess();
            this.updateStartAreaGlow();
        } else {
            // 观战模式下清除交互性高亮，但保留可移动棋子高亮
            this.clearAllGlows();
            this.highlightMovableChess();
        }

        this.updatePlayerAvatarGlow();
        this.updateThinkingProgressBar();

        // 叠子样式按当前棋面重算：叠子被拆开后，留在原地的那颗要恢复普通外观与位置
        const animation = window.gameInstance && window.gameInstance.animation;
        if (animation && typeof animation.refreshStackStyles === 'function') {
            animation.refreshStackStyles();
        }

        // 更新进度显示
        this.updateProgressDisplay();
    }

    /**
     * 清除所有高亮和发光效果（主要用于观战模式）
     */
    clearAllGlows() {
        // 清除棋子高亮
        document.querySelectorAll('.chess-movable, .animating').forEach(el => {
            el.classList.remove('chess-movable', 'animating');
        });

        // 清除起点发光
        document.querySelectorAll('.start-area-glow').forEach(el => {
            el.classList.remove('start-area-glow');
        });
    }

    // 更新骰子显示
    // diceOwner：骰子点数归属的玩家编号，用于决定骰子颜色。
    // 权威快照落地时回合可能已经推进，必须显式传入掷骰者，否则会染成下一个玩家的颜色。
    updateDiceDisplay(forceDiceValue = null, diceOwner = null) {
        const diceDisplay = document.getElementById('diceDisplay');
        const pauseIndicator = document.getElementById('pauseIndicator');
        if (!diceDisplay) return;

        // 定义比普通骰子优先级更高、共用中心位置的UI元素ID及其描述
        // （遥控骰子的选点面板不在其中：面板开在骰子下方，骰子留在原位正常演动画）
        const highPriorityUIElements = [
            { id: 'loadingIndicator', name: '加载提示' },
            { id: 'chatInputArea', name: '聊天输入框' },
            { id: 'polyhedralDiceDisplay', name: '多面骰子' },
            { id: 'teleportIcon', name: '传送门图标' },
            { id: 'mysteryBoxIcon', name: '盲盒图标' }
        ];

        // 检查是否有高优先级UI正在显示，如果有则隐藏普通骰子并跳过更新
        for (const ui of highPriorityUIElements) {
            const element = document.getElementById(ui.id);
            if (element && window.getComputedStyle(element).display !== 'none') {
                // console.log(`${ui.name}正在显示，跳过原骰子显示更新`);
                diceDisplay.style.display = 'none';
                return;
            }
        }

        // 检查游戏是否处于暂停状态
        if (gameState && gameState.getIsPaused() && pauseIndicator && window.getComputedStyle(pauseIndicator).display !== 'none') {
            // 如果游戏已暂停，确保骰子隐藏，不进行更新
            diceDisplay.style.display = 'none';
            return;
        }

        // 确保骰子在非暂停/非聊天状态下可见
        if (diceDisplay.style.display === 'none') {
            diceDisplay.style.display = 'flex';
        }

        // 如果骰子正在闪烁动画中，且不是强制更新，不要打断动画
        if (diceDisplay.classList.contains('dice-flashing') && forceDiceValue === null) {
            return;
        }

        // 震动期间别按快照终态重绘骰面：抖动是瞬时表现，重绘会把它打断（颜色由定格那一步定好）
        if (diceDisplay.classList.contains('dice-shake') && forceDiceValue === null) {
            return;
        }

        // 三次 6 惩罚演出期间：骰子保持那一刻的「6 + 警告红」，由事件回放挂好，这里不参与
        if (gameState.getThreeSixesPenaltyActive?.() && forceDiceValue === null) {
            return;
        }

      const { diceValue: stateDiceValue, currentPlayer, gamePhase, isRolling } = gameState;
        let diceValue = forceDiceValue !== null ? forceDiceValue : stateDiceValue;

        // 多面骰子的 7-12 没有对应骰面，交给数字牌表现，避免出现 undefined
        if (diceValue > DICE_SYMBOLS.length) {
            diceValue = 0;
        }

        // 回合已经流转到下一家（或快照已把骰子清空）时，旧点数不能再留在骰面上，
        if (diceValue > 0 && forceDiceValue === null) {
            const isStaleRoll = gamePhase === 'rolling' && !isRolling && !gameState.getCanReroll();
            if (isStaleRoll) {
                diceValue = 0;
            }
        }

        // 先检查是否有震动效果和已有的重要样式，再清除样式类
        const hasShakeClass = diceDisplay.classList.contains('dice-shake');
        const hasPenaltyWarningClass = diceDisplay.classList.contains('dice-penalty-warning');
        const hasRemoteDiceClass = diceDisplay.classList.contains('remote-dice');

        // 清除所有样式类，但保留基础类
        diceDisplay.className = 'dice-icon';

        // 保留震动效果
        if (hasShakeClass) {
            diceDisplay.classList.add('dice-shake');
        }

        if (hasPenaltyWarningClass) {
            diceDisplay.classList.add('dice-penalty-warning');
        }


        // 保留遥控骰子特效（暂停/恢复时不会被擦除）
        if (hasRemoteDiceClass) {
            diceDisplay.classList.add('remote-dice');
        }

        if (diceValue > 0) {
            const newContent = DICE_SYMBOLS[diceValue - 1];
            diceDisplay.textContent = newContent;
            
            // 联机模式下各端视角不同，骰子应染成「掷骰者」的颜色并发光。
            // 掷骰者由调用方显式给出；缺省时退回当前回合玩家。
            diceDisplay.className = diceDisplay.className.replace(/player-\d+/g, '');
            diceDisplay.classList.add('dice-icon', 'rolled', `player-${diceOwner ?? currentPlayer}`);
            diceDisplay.classList.remove('dice-penalty-warning', 'dice-third-penalty', 'dice-flashing');

            
            // 显示点数时应该发光
            diceDisplay.classList.add('dice-glowing');
        } else {
            // 重置为未投掷状态（青色只属于遥控骰子这一手，手里还攥着道具时也要保持）
            diceDisplay.textContent = '⚀';
            diceDisplay.classList.add('not-rolled');
            if (!gameState.isRemoteDice) {
                diceDisplay.classList.remove('remote-dice');
            }

            // 添加发光效果（当轮到当前玩家且可以掷骰子时）
            // 在未掷出时，只要是rolling阶段就应该发光提示投掷
            if (gamePhase === 'rolling' && !isRolling) {
                diceDisplay.classList.add('dice-glowing');
            } else {
                diceDisplay.classList.remove('dice-glowing');
            }

            // 连出两个 6 之后、准备第三次投掷：就是这一组类（现成的警告红），全桌都看得到。
            // 警告红只属于这一种状态，不满足就明确摘掉——上面那套「保留已有样式」的逻辑
            // 会让它一直挂下去，无子可动抖动时就成了「红着抖」
            if (gamePhase === 'rolling' && !isRolling &&
                gameState.getConsecutiveSixes() === 2 && !gameState.isHappyMode()) {
                diceDisplay.className = 'dice-icon dice-penalty-warning not-rolled dice-glowing';
            } else {
                diceDisplay.classList.remove('dice-penalty-warning', 'dice-third-penalty');
            }
        }

        // 更新骰子禁用状态
        this.updateDiceDisabledState();
    }

    // 更新骰子禁用状态
    updateDiceDisabledState() {
        const diceDisplay = document.getElementById('diceDisplay');
        if (diceDisplay) {
            const gamePhase = gameState.getGamePhase();
            const isRolling = gameState.getIsRolling();
            const currentPlayer = gameState.getCurrentPlayer();
            const isOnlineMultiplayer = gameState.getIsOnlineMultiplayer();

            // 当前玩家是不是机器人在替（联机看名单，单机看本地机器人标记）
            import('./aiPlayers.js').then(({ isAiDriven }) => {
                const manager = window.gameInstance && window.gameInstance.multiplayerGameManager;
                const isBot = manager && manager.isOnlineMode
                    ? isAiDriven(currentPlayer, manager)
                    : Boolean(gameState.isBotPlayer(currentPlayer) || gameState.getIsAITakeover());

                // 在多人游戏中，检查当前玩家是否是本地玩家或房主代替AI托管玩家操作
                let isCurrentPlayerLocal = true;
                let isHostControllingAITakeover = false;
                if (isOnlineMultiplayer && window.gameInstance && window.gameInstance.multiplayerGameManager) {
                    const localPlayerId = window.gameInstance.multiplayerGameManager.getCurrentPlayerId();
                    const localPlayerNumber = window.gameInstance.multiplayerGameManager.getPlayerNumberByPlayerId(localPlayerId);
                    isCurrentPlayerLocal = (currentPlayer === localPlayerNumber);

                    // 检查当前玩家是否被AI托管且当前客户端是房主
                    const currentPlayerId = window.gameInstance.multiplayerGameManager.getPlayerIdByPlayerNumber(currentPlayer);
                    const currentPlayerData = window.gameInstance.multiplayerGameManager.players.get(currentPlayerId);
                    const isCurrentPlayerAITakeover = window.gameInstance.multiplayerGameManager.aiTakeoverPlayers?.has(currentPlayerId) ||
                        currentPlayerData?.isAITakeover || false;
                    const isHost = window.gameInstance.multiplayerGameManager.isHost;
                    isHostControllingAITakeover = isCurrentPlayerAITakeover && isHost && !isCurrentPlayerLocal;
                }

                // 只有轮到当前玩家且不是bot且游戏阶段为rolling且不在掷骰中且（是本地玩家或房主代替AI托管玩家操作）时，骰子才可用
                const canControl = isCurrentPlayerLocal || isHostControllingAITakeover;
                const shouldDisable = gamePhase !== 'rolling' || isRolling || isBot || !canControl;

                // 不再进行状态恢复逻辑，避免覆盖正确的骰子显示

                if (shouldDisable) {
                    diceDisplay.classList.add('disabled');
                } else {
                    diceDisplay.classList.remove('disabled');
                }

                // 强制触发UI更新事件，确保其他组件也能响应权限变化
                const event = new CustomEvent('dicePermissionChanged', {
                    detail: { canRoll: !shouldDisable, currentPlayer, isCurrentPlayerLocal, isHostControllingAITakeover }
                });
                document.dispatchEvent(event);
            });
        }
    }

    // 更新棋子发光效果
    updateChessGlow() {
        // 移除所有棋子的选中效果
        document.querySelectorAll('.chess-selected').forEach(element => {
            element.classList.remove('chess-selected');
        });

        const selectedChess = gameState.getSelectedChess();
        if (selectedChess) {
            const { player, chessIndex } = selectedChess;
            const playerChess = gameState.getPlayerChess();
            const chess = playerChess[player][chessIndex];
            if (chess && chess.element) {
                chess.element.classList.add('chess-selected');
            }
        }
    }

    // 更新玩家头像发光效果
    updatePlayerAvatarGlow() {
        // 移除所有玩家头像的发光效果
        const allAvatars = document.querySelectorAll('.player-avatar');
        allAvatars.forEach(avatar => {
            avatar.classList.remove('player-avatar-active');
        });

        // 为当前玩家的头像添加发光效果
        // 只有在游戏进行中且不是游戏结束状态才显示发光效果
        const currentPlayer = gameState.getCurrentPlayer();
        const winner = gameState.getWinner();
        const gamePhase = gameState.getGamePhase();

        if (!winner && (gamePhase === 'rolling' || gamePhase === 'selecting' || gamePhase === 'waiting')) {
            const currentPlayerAvatars = document.querySelectorAll(`.player-${currentPlayer}-avatar`);
            currentPlayerAvatars.forEach(avatar => {
                avatar.classList.add('player-avatar-active');
            });
        }
    }

    // 更新起始区域发光效果
    updateStartAreaGlow() {
        // 移除所有起始区域的发光效果
        for (let i = 1; i <= 4; i++) {
            const startArea = document.getElementById(`player${i}-start`);
            if (startArea) {
                startArea.classList.remove('start-area-active');
            }
        }

        // 如果当前玩家可以出棋，为其起始区域添加发光效果
        const gamePhase = gameState.getGamePhase();
        const currentPlayer = gameState.getCurrentPlayer();
        const diceValue = gameState.getDiceValue();

        if (gamePhase === 'selecting' && diceValue === 6) {
            const startArea = document.getElementById(`player${currentPlayer}-start`);
            if (startArea) {
                startArea.classList.add('start-area-active');
            }
        }
    }








    // 高亮可移动的棋子
    highlightMovableChess() {
        const currentPlayer = gameState.getCurrentPlayer();
        const diceValue = gameState.getDiceValue();
        const playerChess = gameState.getPlayerChess();

        // 获取当前选中的棋子元素（如果有）
        const selectedChess = gameState.getSelectedChess();
        const selectedElement = selectedChess ? playerChess[selectedChess.player][selectedChess.chessIndex].element : null;

        // 移除所有高亮，但保留当前正在移动的棋子的高亮
        document.querySelectorAll('.chess-movable').forEach(element => {
            if (element !== selectedElement) {
                element.classList.remove('chess-movable');
            }
        });

        // 传送门待选子：能传的是轨道上自己的棋子（起始区和已到终点的传不了），
        // 用的是和普通可移动棋子同一套高亮
        const teleportMode = Boolean(window.gameInstance && window.gameInstance.isTeleportMode);

        // 其余情况只有在选择棋子阶段（selecting）才显示高亮提示
        if (!teleportMode && gameState.getGamePhase() !== 'selecting') {
            return;
        }

        // 为可移动的棋子添加高亮
        playerChess[currentPlayer].forEach((chess, index) => {
            const highlightable = teleportMode
                ? chess.position !== -1 && !chess.finished
                : this.canChessMove(currentPlayer, index, diceValue);
            if (highlightable && chess.element) {
                chess.element.classList.add('chess-movable');
            }
        });
    }

    // 检查棋子是否可以移动：可动规则由共享引擎给出，前端不再自己判一遍
    canChessMove(player, chessIndex, diceValue) {
        return engineAdapter.movableFor(diceValue, player).includes(chessIndex);
    }

    // 更新思考时间进度条（由 updateUI 调用，是唯一的渲染入口）
    updateThinkingProgressBar() {
        this._renderThinkingProgressBar();
    }

    /**
     * 唯一的进度条渲染函数。进度条始终可见。
     * 宽度来自显示时钟（见 _progressClockPercent）：进新阶段归零重走，演出期间冻住不回零。
     * 颜色由计时器归属玩家决定，动画期间锁定本次出手的一家，不提前串色。
     */
    _renderThinkingProgressBar() {
        const container = document.getElementById('thinkingProgressContainer');
        const bar = document.getElementById('thinkingProgressBar');
        if (!container || !bar) return;

        // 暂停时整段隐藏，不参与渲染
        if (gameState.getIsPaused()) {
            container.classList.remove('active');
            return;
        }

        // 动画期间锁定为「本次掷骰者」，动画结束清除后回落到计时器/当前回合玩家
        const displayOwner = gameState.getThinkingProgressDisplayOwner?.();
        const owner = displayOwner ?? gameState.getThinkingProgressOwner() ?? gameState.getCurrentPlayer();
        if (owner === null || owner === undefined) {
            container.classList.remove('active');
            return;
        }

        container.className = `thinking-progress-container active player-${owner}`;
        const pct = this._barHeld ? this._barFrozenPct : this._progressClockPercent();
        bar.style.width = `${pct * 100}%`;
    }

    /** 本阶段已经走了多少（0-1）；时钟没开就一直是 0 */
    _progressClockPercent() {
        if (!this._barActive) return 0;
        const total = Number(gameState.THINKING_TIME) || 20000;
        const elapsed = this._barElapsedMs + (this._barRunSince ? Date.now() - this._barRunSince : 0);
        return Math.min(1, elapsed / total);
    }

    /** 进入新阶段：归零，从 0 慢慢走 */
    resetProgressClock() {
        this._barActive = true;
        this._barElapsedMs = 0;
        this._barRunSince = Date.now();
        this._barFrozenPct = 0;
    }

    _clearProgressClock() {
        this._barActive = false;
        this._barElapsedMs = 0;
        this._barRunSince = null;
        this._barFrozenPct = 0;
    }

    /**
     * 显示一个静止的空进度条（0%），颜色为指定玩家。
     * 用于开局首位玩家尚未操作、AI 回合等不启动回合计时器的场景。
     */
    showIdleThinkingProgressBar(playerNumber) {
        const container = document.getElementById('thinkingProgressContainer');
        const bar = document.getElementById('thinkingProgressBar');
        if (!container || !bar) return;
        if (gameState.getIsPaused()) {
            container.classList.remove('active');
            return;
        }
        const owner = playerNumber ?? gameState.getCurrentPlayer();
        if (owner === null || owner === undefined) return;
        // 静止空条：把显示时钟停掉，免得下次刷新又被时钟的旧进度顶起来
        this._clearProgressClock();
        container.className = `thinking-progress-container active player-${owner}`;
        bar.style.width = '0%';
    }

    // 启动思考时间进度条动画
    startThinkingProgressBar(onTimeout) {
        this._barHeld = false;
        // 只有在联机模式下才启动思考时间倒计时（用于处理玩家掉线或长时间不操作）
        // 单机模式（包括人机对战和本地多人）都不需要自动超时的倒计时
        if (!gameState.getIsOnlineMultiplayer()) {
            return;
        }

        // 暂停期间不启动计时，跑完会触发超时接管
        if (gameState.getIsPaused()) {
            return;
        }

        const container = document.getElementById('thinkingProgressContainer');
        if (!container) return;

        // 新阶段：显示时钟归零重走（演出耗掉的时间不算进本阶段）
        this.resetProgressClock();

        // 先把计时器跑起来，它同时锁定了颜色归属玩家
        gameState.startThinkingTimer(onTimeout);

        // 启动进度条更新循环（循环内会持续刷新宽度）
        this.updateProgressBarLoop();

        // 计时器就绪后再渲染，颜色即当前玩家
        this._renderThinkingProgressBar();

        // 如果是在线多人模式，同步进度条状态
        if (gameState.isOnlineMultiplayer && window.gameInstance && window.gameInstance.multiplayerGameManager) {
            // 检查是否应该跳过进度条启动（防止死循环）
            if (!gameState._skipProgressBarStart) {
                // 只有当前玩家是本地玩家时才同步进度条启动
                const localPlayerNumber = window.gameInstance.multiplayerGameManager.getPlayerNumberByPlayerId(window.gameInstance.multiplayerGameManager.playerId);
                if (gameState.getThinkingProgressOwner() === localPlayerNumber) {
                    window.gameInstance.multiplayerGameManager.syncProgressBarStart(localPlayerNumber);
                }
            }
        }
    }

    // 恢复思考时间进度条动画
    resumeThinkingProgressBar(onTimeout) {
        // 只有在联机模式下才启动思考时间倒计时
        if (!gameState.getIsOnlineMultiplayer()) {
            return;
        }

        // 暂停期间不恢复计时，超时接管会因此触发
        if (gameState.getIsPaused()) {
            return;
        }

        // 暂停的这段时间不算进本阶段：显示时钟从冻结处接着走
        if (this._barActive && !this._barRunSince) {
            this._barRunSince = Date.now();
        }

        // 恢复游戏状态中的计时器；若此前根本没有计时（如暂停期间刷新），退化为重新开始计时
        if (gameState.thinkingStartTime) {
            gameState.resumeThinkingTimer(onTimeout);
        } else {
            gameState.startThinkingTimer(onTimeout);
        }

        // 启动进度条更新循环
        this.updateProgressBarLoop();

        // 按新的计时器归属渲染
        this._renderThinkingProgressBar();
    }

    // 暂停思考时间进度条
    pauseThinkingProgressBar() {
        // 暂停即硬冻结：显示时钟停在原处，恢复后接着走
        if (this._barRunSince) {
            this._barElapsedMs += Date.now() - this._barRunSince;
            this._barRunSince = null;
        }

        // 暂停游戏状态中的计时器，不要完全清除
        gameState.pauseThinkingTimer();

        // 停止进度条更新循环
        this._stopProgressBarLoop();

        const container = document.getElementById('thinkingProgressContainer');
        if (container) {
            container.classList.remove('active');
        }
    }

    // 停止思考时间进度条
    stopThinkingProgressBar() {
        this._barHeld = false;
        // 完全清除游戏状态中的计时器（同时解锁颜色归属）
        gameState.clearThinkingTimer();
        // 显示时钟也归零：本阶段结束，等下一次开场重新起
        this._clearProgressClock();

        // 停止进度条更新循环
        this._stopProgressBarLoop();

        // 进度条始终可见：停掉计时器后回到「当前回合玩家的静止空条」
        this._renderThinkingProgressBar();
    }

    // 进度条更新循环
    /**
     * 演出（掷骰/走子/道具动画）期间：进度条停在原处——显示时钟冻结 + 停渲染循环，
     * 这样既不归零、也不被别的渲染调用拉走。演出结束由 release/reset 接手。
     */
    holdThinkingProgressBar() {
        this._barHeld = true;
        if (this._barRunSince) {
            this._barElapsedMs += Date.now() - this._barRunSince;
            this._barRunSince = null;
        }
        this._barFrozenPct = this._progressClockPercent();
        if (this.progressUpdateInterval) {
            clearInterval(this.progressUpdateInterval);
            this.progressUpdateInterval = null;
        }
        gameState.pauseThinkingTimer?.();
    }

    /** 演出结束、还在同一阶段：松开时钟接着走（不清零） */
    releaseThinkingProgressBar() {
        this._barHeld = false;
        if (this._barActive && !this._barRunSince) {
            this._barRunSince = Date.now();
        }
        gameState.resumeThinkingTimer?.(null);
        this.updateProgressBarLoop();
    }

    updateProgressBarLoop() {
        // 清除之前的循环
        if (this.progressUpdateInterval) {
            clearInterval(this.progressUpdateInterval);
        }

        // 每100ms更新一次进度条
        this.progressUpdateInterval = setInterval(() => {
            // 如果游戏暂停，或者正在加载中，跳过本轮更新
            const isLoading = window.audioManager && !window.audioManager.allPlayersAudioLoaded;
            const isPaused = gameState.getIsPaused();
            if (isPaused || isLoading) {
                return;
            }

            // 演出期间的「暂停」不算结束：保住进度，别在这儿归零
            if (this._barHeld) {
                return;
            }

            // 不在思考阶段（结算、回合交接）就收工，渲染交给下一次快照
            const phase = gameState.getGamePhase?.();
            if (phase !== 'rolling' && phase !== 'selecting') {
                this._stopProgressBarLoop();
                return;
            }

            this._renderThinkingProgressBar();
        }, 100);
    }

    _stopProgressBarLoop() {
        if (this.progressUpdateInterval) {
            clearInterval(this.progressUpdateInterval);
            this.progressUpdateInterval = null;
        }
    }

    // 更新进度显示
    updateProgressDisplay() {
        try {
            progressDisplay.updateAllProgress(gameState);
        } catch (error) {
            console.error('更新进度显示失败:', error);
        }
    }

    // 旋转棋盘和UI (初始化时调用)
    rotateBoard(rotations = 1) {
        window.boardRotationTotal = 90 * rotations;
        window.boardRotation = window.boardRotationTotal % 360;
        const boardSvg = document.getElementById('board-svg');
        if (boardSvg) {
            boardSvg.style.transition = 'none';
            boardSvg.style.transform = `rotate(${window.boardRotationTotal}deg)`;
            boardSvg.offsetHeight;
        }
        this.updateDesktopPlayerPositions(window.boardRotation);
        this.updateMobilePlayerPositions(window.boardRotation);
        
        // 旋转棋盘后，更新所有棋子的旋转角度和阴影方向，使其保持正向
        if (window.gameInstance && window.gameInstance.animation) {
            const pieceCount = gameState.pieceCount || 4;
            for (let player = 1; player <= 4; player++) {
                for (let i = 0; i < pieceCount; i++) {
                    const chess = gameState.playerChess[player][i];
                    if (chess) {
                        // 无论是否完成，都调用 updateChessPosition 来重新计算 transform 和 shadow
                        // updateChessPosition 内部会根据 chess.finished 决定调用哪个方法
                        window.gameInstance.animation.updateChessPosition(player, i, null, false);
                    }
                }
            }
        }
    }
    updateDesktopPlayerPositions(rotation) {
        const playersInfo = document.querySelector('.players-info');
        if (!playersInfo) return;

        const players = {
            1: playersInfo.querySelector('.player-1-info'),
            2: playersInfo.querySelector('.player-2-info'),
            3: playersInfo.querySelector('.player-3-info'),
            4: playersInfo.querySelector('.player-4-info')
        };

        if (!players[1] || !players[2] || !players[3] || !players[4]) return;

        let layout;
        switch (rotation) {
            case 0:
                layout = { tr: 1, br: 2, bl: 3, tl: 4 };
                break;
            case 90:
                layout = { tr: 4, br: 1, bl: 2, tl: 3 };
                break;
            case 180:
                layout = { tr: 3, br: 4, bl: 1, tl: 2 };
                break;
            case 270:
                layout = { tr: 2, br: 3, bl: 4, tl: 1 };
                break;
            default:
                layout = { tr: 1, br: 2, bl: 3, tl: 4 };
                break;
        }

        const applyPositionAndFormat = (playerNum, position) => {
            const el = players[playerNum];
            
            // 清除可能残留的内联样式，让 CSS 完全接管
            el.style.top = '';
            el.style.bottom = '';
            el.style.left = '';
            el.style.right = '';

            // 移除旧的位置 class
            el.classList.remove('pos-tr', 'pos-br', 'pos-bl', 'pos-tl');
            
            // 添加新的位置 class，由 CSS 的 order 属性自动处理内部排版
            el.classList.add(`pos-${position}`);
        };

        applyPositionAndFormat(layout.tr, 'tr');
        applyPositionAndFormat(layout.br, 'br');
        applyPositionAndFormat(layout.bl, 'bl');
        applyPositionAndFormat(layout.tl, 'tl');
    }

    // 更新移动端玩家信息位置
    updateMobilePlayerPositions(rotation) {
        const topContainer = document.querySelector('.players-top');
        const bottomContainer = document.querySelector('.players-bottom');
        if (!topContainer || !bottomContainer) return;

        const players = {
            1: document.querySelector('.players-top .player-1-info') || document.querySelector('.players-bottom .player-1-info'),
            2: document.querySelector('.players-top .player-2-info') || document.querySelector('.players-bottom .player-2-info'),
            3: document.querySelector('.players-top .player-3-info') || document.querySelector('.players-bottom .player-3-info'),
            4: document.querySelector('.players-top .player-4-info') || document.querySelector('.players-bottom .player-4-info')
        };

        if (!players[1] || !players[2] || !players[3] || !players[4]) return;

        let layout;
        switch (rotation) {
            case 0:
                layout = { top: [4, 1], bottom: [3, 2] };
                break;
            case 90:
                layout = { top: [3, 4], bottom: [2, 1] };
                break;
            case 180:
                layout = { top: [2, 3], bottom: [1, 4] };
                break;
            case 270:
                layout = { top: [1, 2], bottom: [4, 3] };
                break;
            default:
                layout = { top: [4, 1], bottom: [3, 2] };
                break;
        }

        // 辅助函数：只添加对应的类，不修改内部 DOM，依靠 CSS flex order 排序
        const formatPlayerInfo = (playerEl, side) => {
            playerEl.classList.remove('mobile-left', 'mobile-right');
            playerEl.classList.add(`mobile-${side}`);
        };

        formatPlayerInfo(players[layout.top[0]], 'left');
        topContainer.appendChild(players[layout.top[0]]);

        formatPlayerInfo(players[layout.top[1]], 'right');
        topContainer.appendChild(players[layout.top[1]]);

        formatPlayerInfo(players[layout.bottom[0]], 'left');
        bottomContainer.appendChild(players[layout.bottom[0]]);

        formatPlayerInfo(players[layout.bottom[1]], 'right');
        bottomContainer.appendChild(players[layout.bottom[1]]);
    }
}

// 创建并导出UI更新器实例
export const uiUpdater = new UIUpdater();

// 同时保持默认导出以兼容其他用法
export default UIUpdater;