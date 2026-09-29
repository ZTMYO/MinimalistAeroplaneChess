/**
 * 服务端 AI 出手：机器人和被托管玩家都由服务端按节奏走完这一手。
 * 节奏看客户端回执——各端把这一帧演完才出下一手，没人回执（脚本、旧页面）时退回估时表。
 */
const botPromise = import('../shared/bot.mjs');
const timingPromise = import('../shared/timing.mjs');

// 换手时的最小停顿：投掷前不犹豫
const THINK_MIN_MS = 0;
const THINK_MAX_MS = 60;
// 开局第一手要等各端铺好牌桌（音频、首帧渲染）
const START_GRACE_MS = 1500;

/** 刚产生的这一段演出大约要多久（与客户端行动条同一份时长表） */
let paceOf = () => 0;
timingPromise.then(({ eventsDuration }) => { paceOf = eventsDuration; }).catch(() => {});

class BotDriver {
    /**
     * @param {Object} deps
     * @param {(gameSession: Object) => Object|null} deps.sessionOf
     * @param {(gameSession: Object, color: number) => boolean} deps.isAiDriven
     * @param {(gameSession: Object, color: number) => string} deps.difficultyOf 这一家的难度（简单不碰道具、选子随机）
     * @param {(gameSession: Object, color: number, action: Object) => Object} deps.applyAction 返回 { events, seq }
     * @param {(gameSession: Object, seq: number) => Promise<boolean>} deps.settled 等各端把这帧演完（含超时），true = 真等到人回执
     * @param {(gameSession: Object) => boolean} deps.isPaused
     * @param {(gameSession: Object) => boolean} deps.isEnded
     */
    constructor(deps) {
        this.deps = deps;
        this.timers = new Map();
        this.started = new Set();
        this.busy = new Set();
    }

    /** 快照落地、恢复对局后叫一次：轮到 AI 就安排下一拍 */
    async kick(gameSession) {
        const key = gameSession && gameSession.gameSessionId;
        // 自己这一拍还在等客户端演完：让那条链负责排队，别插队把节奏带快
        if (this.busy.has(key)) return;
        this.clear(key);
        if (!this.shouldRun(gameSession)) return;

        // 轮到 AI 就立刻掷：投掷没什么好想的，不必等上一帧动画彻底收尾。
        // 这条路上的等待会把「换家」变成干等（用户反复报过：轮到 AI 卡半天才投掷）
        const delay = this.started.has(key) ? this.thinkDelay() : START_GRACE_MS;
        this.started.add(key);
        this.schedule(gameSession, delay);
    }

    shouldRun(gameSession) {
        if (!gameSession || gameSession.gameState !== 'playing') return false;
        if (this.deps.isPaused(gameSession) || this.deps.isEnded(gameSession)) return false;
        const session = this.deps.sessionOf(gameSession);
        if (!session) return false;
        return this.deps.isAiDriven(gameSession, session.state.currentPlayer);
    }

    async run(gameSession) {
        const key = gameSession.gameSessionId;
        this.busy.add(key);
        try {
            await this.act(gameSession);
        } finally {
            this.busy.delete(key);
        }
    }

    async act(gameSession) {
        if (!this.shouldRun(gameSession)) return;
        const session = this.deps.sessionOf(gameSession);
        if (!session) return;
        const color = session.state.currentPlayer;

        let chooseAction;
        try {
            ({ chooseAction } = await botPromise);
        } catch (error) {
            console.error(`[AI] 决策模块加载失败：${error.message}`);
            return;
        }

        let applied;
        try {
            const difficulty = typeof this.deps.difficultyOf === 'function'
                ? this.deps.difficultyOf(gameSession, color)
                : undefined;
            applied = this.deps.applyAction(gameSession, color, chooseAction(session.state, color, { difficulty })) || {};
        } catch (error) {
            // 出不了手就停下，交给回合看门狗兜底，别在这儿死循环
            console.error(`[AI] 玩家${color} 出手被拒：${error.message}`);
            return;
        }

        const events = applied.events || [];
        // 等各端把这帧真的演完再排下一拍。有人回执时，等回执花掉的时间本身就是这段演出的
        // 时长，到点直接接下一拍；没人能回执（脚本、旧页面）才退回估时表。
        // 把估时再叠一次就是「演完了还要愣一下」——连投 6 奖励那一掷犹豫的根源
        const acked = typeof this.deps.settled === 'function'
            ? Boolean(await this.deps.settled(gameSession, applied.seq))
            : false;
        const pace = acked ? 0 : paceOf(events);
        // 「思考」只看下一手是什么：要选子就停一下（看着像在挑棋子），要掷骰就不停——
        // 换手即掷、连投 6 奖励也立刻再掷
        const think = session.state.phase === 'selecting' ? paceOf(events) : this.thinkDelay();
        this.schedule(gameSession, pace + think);
    }

    thinkDelay() {
        return THINK_MIN_MS + Math.floor(Math.random() * (THINK_MAX_MS - THINK_MIN_MS));
    }

    schedule(gameSession, delay) {
        const key = gameSession.gameSessionId;
        // 先清掉可能已排着的那一拍（快照落地会顺手 kick 一次），保证只有一条链
        this.clear(key);
        this.timers.set(key, setTimeout(() => {
            this.timers.delete(key);
            this.run(gameSession);
        }, delay));
    }

    /** 只停这一拍的定时器（kick 会用到，别把「开局宽限」标记也清掉） */
    clear(key) {
        if (!key || !this.timers.has(key)) return;
        clearTimeout(this.timers.get(key));
        this.timers.delete(key);
    }

    /** 会话收尾：定时器与开局标记一起清 */
    dropSession(key) {
        this.clear(key);
        this.started.delete(key);
    }
}

module.exports = { BotDriver };
