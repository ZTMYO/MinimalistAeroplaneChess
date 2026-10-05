/**
 * 单机 AI：决策问 shared/bot.mjs，出手沿用客户端本来那套点击路径。
 * 联机的 AI 由服务端驱动（backend/botDriver.cjs），这里只负责单机与本地多人。
 */
import { gameState } from './gameState.js';
import { engineAdapter } from './engineAdapter.js';
import { chooseAction } from '../../shared/bot.mjs';

const THINK_MIN_MS = 100;
const THINK_MAX_MS = 150;
const UNLOCK_MS = 300;
const BOX_MS = 2500; // 开盒演出期间别抢回合

class BotController {
    constructor() {
        this.isEnabled = false;
        this.isProcessing = false;
        this.botDifficulties = {};
    }

    // 旧接口保留：单机 AI 不再直接操作棋子与工具对象，调用方不用改
    setChessPiece() {}
    setUtils() {}

    setBotDifficulties(difficulties = {}) {
        this.botDifficulties = { ...this.botDifficulties, ...difficulties };
    }

    getBotDifficulty(player) {
        return this.botDifficulties[player] || 'easy';
    }

    setEnabled(enabled) {
        this.isEnabled = Boolean(enabled);
    }

    /** 当前玩家是不是本机要驱动的单机机器人/托管玩家 */
    isCurrentPlayerBot() {
        if (gameState.getIsOnlineMultiplayer()) return false;
        const player = gameState.getCurrentPlayer();
        return Boolean(gameState.isBotPlayer(player) || gameState.getIsAITakeover());
    }

    /** 走这一手：先停一下像在思考，再照引擎给的动作出手 */
    async handleBotTurn() {
        if (!this.isEnabled || this.isProcessing || !this.isCurrentPlayerBot()) return;
        if (gameState.getIsPaused() || gameState.getThreeSixesPenaltyActive()) return;

        this.isProcessing = true;
        try {
            await new Promise((resolve) => setTimeout(resolve, THINK_MIN_MS + Math.random() * (THINK_MAX_MS - THINK_MIN_MS)));
            await this._act();
        } catch (error) {
            console.error('[AI] 出手失败:', error);
        } finally {
            // 留点余量再解锁，免得同一回合被连点两次
            setTimeout(() => {
                this.isProcessing = false;
                window.eventHandler?.triggerBotOperationIfNeeded?.();
            }, UNLOCK_MS);
        }
    }

    /** 把 shared/bot 选出的动作交给客户端既有的引擎路径执行 */
    async _act() {
        const player = gameState.getCurrentPlayer();
        const action = chooseAction(engineAdapter.state, player, { difficulty: this.getBotDifficulty(player) });
        if (!action) return;

        const skillManager = window.gameInstance?.skillManager;
        const chessPiece = window.gameInstance?.chessPiece;

        switch (action.type) {
            case 'roll':
                if (action.item === 'remote-dice') {
                    await skillManager?.handleDiceSelection?.(action.value, player, null);
                } else if (action.item === 'polyhedral-dice') {
                    // 点数由引擎摇，这里只发起
                    await skillManager?.applyItemRoll?.(player, null, 12, 'polyhedral-dice');
                } else {
                    await window.eventHandler?.handleDiceClick?.();
                }
                return;
            case 'item':
                skillManager?.useSkill?.(action.item, player);
                if (action.item === 'mysteryBox') {
                    await new Promise((resolve) => setTimeout(resolve, BOX_MS));
                }
                return;
            case 'move':
                await chessPiece?.handleEngineMove?.(player, action.chessIndex);
                return;
            case 'teleport':
                await chessPiece?.handleEngineTeleport?.(player, action.chessIndex);
                return;
            default:
                return;
        }
    }
}

export const botController = new BotController();
