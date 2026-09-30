import { gameInfo } from './gameInfo.js';
import { botController } from './botController.js';
import { engineAdapter } from './engineAdapter.js';
import { debugMoveChess, debugFinishChess as finishAllChess } from './debugTools.js';
import { enginePlayback } from './enginePlayback.js';

class ChessPiece {
    constructor(gameState, utils, animation, uiUpdater, dice) {
        this.gameState = gameState;
        this.utils = utils;
        this.animation = animation;
        this.uiUpdater = uiUpdater;
        this.dice = dice;

        // 添加防抖相关属性
        this.isProcessingClick = false; // 是否正在处理点击事件
        this.clickTimeout = null; // 点击超时定时器

        // 添加唯一时间戳机制，用于判断棋子叠放顺序
        this.landTimestamp = 0;
        
        // 用于收集本次移动中被 beat 的棋子
        this._currentMoveBeatenChesses = [];
    }

    /**
     * 生成唯一的最后落位位置标识（位置 * 1000 + 时间戳）
     * 用于确保后到达的棋子显示在最上层
     * @param {number} position - 棋子位置
     * @returns {number} 唯一的标识值
     */
    generateUniqueLastLandPos(position) {
        this.landTimestamp++;
        // 使用位置和递增时间戳组合成唯一值，时间戳越大表示越晚到达
        return position * 1000 + this.landTimestamp;
    }

    /**
     * 处理棋子点击事件
     */
    onChessClick(player, chessIndex, event) {
        // 防抖检查：如果正在处理点击事件，直接返回
        if (this.isProcessingClick) {
            return;
        }

        // 检查是否是传送门模式（最优先检查，避免其他逻辑干扰）
        if (window.gameInstance && window.gameInstance.isTeleportMode) {
            const chess = this.gameState.playerChess[player][chessIndex];

            // 检查是否是当前玩家的棋子
            if (player !== this.gameState.currentPlayer) {
                return;
            }

            // 检查棋子是否已完成
            if (chess.finished) {
                import('./skillManager.js').then(module => {
                    if (module.skillManager) {
                        module.skillManager.showNotification('已完成的棋子无法传送！');
                    }
                });
                return;
            }

            // 可选性由 handleTeleportMove 自行裁决（基地棋子会给出提示，
            // 无可用空位则退出传送门）。这里不能用引擎的「可动集合」判断：
            // 传送门模式下点数被置为标记值 999，会误把基地棋子判成不可选而静默退出，
            // 玩家看不到任何反馈，传送门图标就一直留在骰子位置上。
            this.handleTeleportMove(player, chessIndex);
            return;
        }

        // 基本游戏状态检查
        if (this.gameState.gamePhase !== 'selecting' || this.gameState.winner) return;

        // 检查是否是当前玩家的棋子
        if (player !== this.gameState.currentPlayer) {
            console.log(`玩家${player}的棋子被点击，但当前玩家是${this.gameState.currentPlayer}，忽略点击`);
            return;
        }

        const chess = this.gameState.playerChess[player][chessIndex];

        // 能不能选这枚棋子由引擎裁决（当前点数下的可动集合）
        if (!engineAdapter.movableFor(this.gameState.diceValue, player).includes(chessIndex)) {
            return;
        }

        // 设置防抖标志，防止重复点击
        this.isProcessingClick = true;

        // 设置超时清除防抖标志（防止异常情况下标志永远不被清除）
        this.clickTimeout = setTimeout(() => {
            this.isProcessingClick = false;
        }, 3000); // 3秒超时

        // 只有在棋子可以移动时才停止思考时间计时器
        this.uiUpdater.holdThinkingProgressBar?.();

        this.gameState.selectedChess = { player, chessIndex };

        // 选中棋子后，立即将游戏阶段设为 moving，防止 updateUI 逻辑干扰
        this.gameState.gamePhase = 'moving';

        // 立即手动触发一次非选中棋子的清理，确保视觉反馈即时
        document.querySelectorAll('.chess-movable').forEach(element => {
            if (element !== chess.element) {
                element.classList.remove('chess-movable');
            }
        });

        this.moveSelectedChess();
    }

    /**
     * 清除传送门格子高亮
     */
    clearTeleportHighlights() {
        const svg = document.getElementById('board-svg');
        if (!svg) return;
        svg.querySelectorAll('.teleport-grid-highlight').forEach(el => {
            el.classList.remove('teleport-grid-highlight');
        });
    }

    /**
     * 处理传送门道具的棋子移动
     * @param {number} player - 玩家编号
     * @param {number} chessIndex - 棋子索引
     */
    async handleTeleportMove(player, chessIndex) {
        try {
            const chess = this.gameState.playerChess[player][chessIndex];

            // 棋子必须在轨道上才能传送（不能传送起始区域的棋子）
            if (chess.position === -1) {
                import('./skillManager.js').then(module => {
                    if (module.skillManager) {
                        module.skillManager.showNotification('起始区域的棋子无法传送！请选择轨道上的棋子');
                    }
                });
                return;
            }

            // 联机模式：只报传哪颗棋子，落点与回合推进交给服务端裁决
            if (this.gameState.isOnlineMultiplayer &&
                window.gameInstance && window.gameInstance.multiplayerGameManager) {
                this.exitTeleportMode();
                this.gameState.setChessMoving(true);
                window.gameInstance.multiplayerGameManager.sendIntent({
                    type: 'teleport',
                    chessIndex
                });
                return;
            }

            // 单机模式：落点与回合推进交给共享引擎裁决（战报与距离由事件流统一记录）
            this.exitTeleportMode();

            await this.handleEngineTeleport(player, chessIndex);
        } catch (error) {
            console.error('[传送门] 处理传送时出错:', error);
            // 清除格子高亮
            this.clearTeleportHighlights();
            this.exitTeleportMode({ notifyServer: true });
        }
    }

    /**
     * 引擎驱动的传送门：只报要传的棋子，落点由引擎摇，再回放事件流
     */
    async handleEngineTeleport(player, chessIndex) {
        this.gameState.setChessMoving(true);
        try {
            const { events } = engineAdapter.teleport(chessIndex);
            await enginePlayback.play(events);
            engineAdapter.projectTo(this.gameState);

            const state = engineAdapter.state;
            if (state.phase === 'ended') {
                this.gameState.recordGameEndTime();
                if (window.progressDisplay) {
                    this.gameState.saveProgressSnapshot();
                }
                setTimeout(() => {
                    if (window.main && window.main.settlementModal) {
                        window.main.settlementModal.show(state.winner);
                    }
                }, 1000);
            } else {
                this.gameState.canReroll = false;
                this.handleMoveComplete(player);
            }

            this.uiUpdater.updateUI();
        } catch (error) {
            console.error('引擎拒绝本次传送:', error);
            import('./skillManager.js').then(module => module.skillManager?.showNotification(error.message));
            engineAdapter.projectTo(this.gameState);
            this.uiUpdater.updateUI();
        } finally {
            this.gameState.setChessMoving(false);
        }
    }

    /**
     * 退出传送门模式
     * @param {Object} [options]
     * @param {boolean} [options.notifyServer] - 是否上报「取消激活」（真正传送时随意图清掉）
     */
    exitTeleportMode({ notifyServer = false } = {}) {
        if (!window.gameInstance) return;
        window.gameInstance.isTeleportMode = false;

        // 联机下图标由快照管：要一直挂到回合交出去那一刻才收。
        // 本地抢先收起会被随后到达的激活态快照重新点亮，看起来就是图标一闪一闪
        if (this.gameState.isOnlineMultiplayer) {
            // 取消激活：把买道具的积分退回来（真正的传送随意图清掉激活态，不退）
            if (notifyServer) window.gameInstance.skillManager?.cancelItem();
            return;
        }

        if (notifyServer) window.gameInstance.skillManager?.cancelItem();
        window.gameInstance.skillManager?.restoreDiceIcon();
    }

    /**
     * 移动选中的棋子
     */
    async moveSelectedChess() {
        if (!this.gameState.selectedChess) {
            this.clearClickDebounce();
            return;
        }

        const { player, chessIndex } = this.gameState.selectedChess;

        if (this.gameState.engineDriven) {
            await this.handleEngineMove(player, chessIndex);
            return;
        }

        // 联机模式：只提交选子意图，移动与吃子由服务端裁决
        if (this.gameState.isOnlineMultiplayer && window.gameInstance && window.gameInstance.multiplayerGameManager) {
            this.gameState.selectedChess = null;
            this.clearClickDebounce();
            this.gameState.setChessMoving(true);
            window.gameInstance.multiplayerGameManager.sendIntent({ type: 'move', chessIndex });
            return;
        }

        // 非联机模式只有共享引擎一个裁决者，引擎没就绪就放弃这次点击
        if (engineAdapter.ready) {
            await this.handleEngineMove(player, chessIndex);
        } else {
            this.clearClickDebounce();
        }
    }

    /**
     * 引擎驱动的选子：把选中的棋子索引交给引擎裁决，再回放事件流
     */
    async handleEngineMove(player, chessIndex) {
        this.gameState.setChessMoving(true);
        try {
            const { events } = engineAdapter.move(chessIndex);
            await enginePlayback.play(events);
            engineAdapter.projectTo(this.gameState);

            this.gameState.selectedChess = null;
            this.clearClickDebounce();

            const state = engineAdapter.state;
            if (state.phase === 'ended') {
                this.gameState.recordGameEndTime();

                if (window.progressDisplay) {
                    this.gameState.saveProgressSnapshot();
                }

                setTimeout(() => {
                    if (window.main && window.main.settlementModal) {
                        window.main.settlementModal.show(state.winner);
                    }
                }, 1000);
            } else {
                // 引擎未推进回合说明摇到6 点，本回合继续
                this.gameState.canReroll = !events.some((event) => event.type === 'turn');
                this.handleMoveComplete(player);
            }

            this.uiUpdater.updateUI();
        } catch (error) {
            console.error('引擎拒绝本次移动:', error);
            // 引擎状态未变，重新投影以还原阶段与选中态
            engineAdapter.projectTo(this.gameState);
            this.gameState.selectedChess = null;
            this.clearClickDebounce();
            this.uiUpdater.updateUI();
        } finally {
            this.gameState.setChessMoving(false);
        }
    }

    /**
     * 清除点击防抖标志
     */
    clearClickDebounce() {
        if (this.clickTimeout) {
            clearTimeout(this.clickTimeout);
            this.clickTimeout = null;
        }
        this.isProcessingClick = false;
    }


    /**
     * 更新所有棋子的位置以重新计算叠加偏移
     */
    updateAllChessPositions(animate = true) {
        const pieceCount = this.gameState.pieceCount || 4; // 获取当前棋子个数，默认为4
        for (let player = 1; player <= 4; player++) {
            for (let chessIndex = 0; chessIndex < pieceCount; chessIndex++) {
                const chess = this.gameState.playerChess[player][chessIndex];
                if (!chess.finished && chess.position >= 0) {
                    this.animation.updateChessPosition(player, chessIndex, null, animate);
                }
            }
        }
    }

    /**
     * 检查胜利条件
     */
    checkWinner() {
        return this.gameState.playerChess[this.gameState.currentPlayer].every(chess => chess.finished);
    }

    /**
     * 调试方法：移动指定棋子一格
     * @param {number} player - 玩家编号 (1-4)
     * @param {number} chessIndex - 棋子索引 (0-3)
     * @param {number} direction - 移动方向 (1: 前进, -1: 后退)
     */
    debugMoveChessOneStep(player, chessIndex, direction) {
        debugMoveChess(player, chessIndex, direction);
    }

    /**
     * 调试方法：移动棋子（保留原有功能）
     */
    debugMoveChess() {
        const currentPlayer = this.gameState.currentPlayer;
        this.debugMoveChessOneStep(currentPlayer, 0, 1);
    }

    /**
     * 调试方法：完成所有棋子
     */
    debugFinishChess() {
        finishAllChess();
    }

    /**
     * 处理移动完成后的游戏逻辑（玩家切换）
     * @param {number} player - 玩家编号
     */
    handleMoveComplete(player) {
        // 移动结束后移除选定棋子的高亮效果
        if (this.gameState.selectedChess) {
            const { player: p, chessIndex: i } = this.gameState.selectedChess;
            const chess = this.gameState.playerChess[p][i];
            if (chess && chess.element) {
                chess.element.classList.remove('chess-movable');
            }
        }

        // 清除防抖标志
        this.clearClickDebounce();

        // 如果可以重新投骰，保持当前玩家；否则切换到下一个玩家
        if (this.gameState.canReroll) {
            this.gameState.gamePhase = 'rolling';
            this.gameState.diceValue = 0; // 重置骰子值以显示未投掷状态

            if (window.multiplayerGameManager && window.multiplayerGameManager.isOnlineMode) {
                window.multiplayerGameManager.syncDiceReset();
            }

            // 如果游戏已暂停，不启动计时器和AI操作
            if (!this.gameState.getIsPaused()) {
                // 启动新的思考时间计时器（掷骰子阶段）
                this.uiUpdater.startThinkingProgressBar(() => {
                    console.log(`玩家${this.gameState.currentPlayer}掷骰子思考时间到，自动切换到下一个玩家`);
                    // 使用 dice 的统一超时处理方法
                    this.dice?.handleThinkingTimeoutWrapper?.();
                });

                // 检查当前玩家是否为bot，如果是则触发bot操作（重新投骰情况）
                this.triggerBotOperationIfNeeded();
            } else {
                console.log('游戏已暂停，可以重新投骰，但不启动计时器和AI操作');
            }
        } else {
            // 使用 dice 的统一超时处理方法
            const handleThinkingTimeout = this.dice?.handleThinkingTimeoutWrapper
                ? this.dice.handleThinkingTimeoutWrapper.bind(this.dice)
                : null;
            const triggerBot = this.triggerBotOperationIfNeeded
                ? this.triggerBotOperationIfNeeded.bind(this)
                : null;
            this.gameState.nextPlayer(this.uiUpdater, handleThinkingTimeout, triggerBot);
        }

        // 更新UI
        this.uiUpdater.updateUI();
    }

    /**
     * 检查当前玩家是否为bot，如果是则触发bot操作
     */
    triggerBotOperationIfNeeded() {
        if (botController) {
            const isBot = botController.isCurrentPlayerBot();

            if (isBot) {
                botController.handleBotTurn();
            }
        }
    }


    /**
     * 根据位置和棋子ID查找棋子
     */
    findChessByPosition(player, position, pieceId) {
        const playerChess = this.gameState.playerChess[player];
        if (!playerChess) return null;

        // 如果有pieceId，直接使用
        if (pieceId !== undefined && playerChess[pieceId]) {
            return { chess: playerChess[pieceId], index: pieceId };
        }

        // 否则根据位置查找
        for (let i = 0; i < playerChess.length; i++) {
            if (playerChess[i].position === position) {
                return { chess: playerChess[i], index: i };
            }
        }

        return null;
    }

    /**
     * 根据playerId获取玩家编号
     */
    getPlayerNumberByPlayerId(playerId) {
        // 这里需要从multiplayerGameManager获取
        if (window.gameInstance && window.gameInstance.multiplayerGameManager) {
            return window.gameInstance.multiplayerGameManager.getPlayerNumberByPlayerId(playerId);
        }
        return null;
    }
}

// 导出棋子类
export default ChessPiece;
