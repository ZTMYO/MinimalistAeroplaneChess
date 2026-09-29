/**
 * 单机 AI 的出手排程：把「回合切换 / 棋子动完」等触发合并成一条链，行动锁没放开就退避重试。
 * 联机不用它——那边由服务端驱动。
 */
import { gameState } from './gameState.js';
import { botController } from './botController.js';

const BASE_RETRY_MS = 150;
const MAX_RETRY_MS = 2000;

/**
 * 本机现在该替当前玩家出手吗。
 * 联机下不出手：AI 由服务端自己驱动（见 backend/botDriver.cjs），
 * 这里只负责单机与本地多人。
 */
function defaultShouldRun() {
    if (gameState.getIsOnlineMultiplayer()) return false;
    if (gameState.getIsPaused()) return false;
    const player = gameState.getCurrentPlayer();
    return gameState.isBotPlayer(player) || gameState.getIsAITakeover();
}

class AiTurnTrigger {
    constructor({
        shouldRun = defaultShouldRun,
        run = () => botController.handleBotTurn(),
        isBusy = () => Boolean(botController.isProcessing),
        baseRetryMs = BASE_RETRY_MS,
        maxRetryMs = MAX_RETRY_MS,
        // 包一层：全局 setTimeout 存成属性再当方法调会抛 Illegal invocation
        setTimer = (fn, ms) => setTimeout(fn, ms),
        clearTimer = (id) => clearTimeout(id)
    } = {}) {
        this.shouldRun = shouldRun;
        this.run = run;
        this.isBusy = isBusy;
        this.baseRetryMs = baseRetryMs;
        this.maxRetryMs = maxRetryMs;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.timer = null;
        this.attempt = 0;
    }

    /** 安排一次出手；已经排着就直接返回，不叠出多条处理链 */
    schedule(delay = 200) {
        if (this.timer) return;
        this.timer = this.setTimer(() => {
            this.timer = null;
            if (!this.shouldRun()) {
                this.attempt = 0;
                return;
            }
            if (this.isBusy()) {
                // 上一拍还没落地：等锁放开再补，间隔逐步放宽但不放弃
                this.attempt += 1;
                this.schedule(Math.min(this.baseRetryMs * this.attempt, this.maxRetryMs));
                return;
            }
            this.attempt = 0;
            this.run();
        }, delay);
    }

    cancel() {
        if (this.timer) {
            this.clearTimer(this.timer);
            this.timer = null;
        }
        this.attempt = 0;
    }
}

export { AiTurnTrigger };
export const aiTurnTrigger = new AiTurnTrigger();
