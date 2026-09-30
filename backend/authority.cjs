'use strict';

/**
 * 服务端权威层：房间棋面真相的唯一持有者。
 *
 * 规则计算全部委托给 shared/engine.mjs（与前端同一份实现），
 * 本模块只负责：把玩家意图翻译成引擎动作、维护递增序号、产出全量快照。
 */

const enginePromise = import('../shared/engine.mjs');

const INTENT_TYPES = new Set(['roll', 'move', 'skip', 'teleport', 'item', 'debug']);

/** 道具骰子允许的点数上限：普通掷骰仍由服务端自己摇，客户端只有道具才能指定点数 */
const ITEM_DICE_MAX = { 'remote-dice': 6, 'polyhedral-dice': 12 };

/** 需要先激活的道具：遥控骰子等选点、传送门等选子，都不是一次动作能完成的 */
const ITEM_ACTIVATIONS = new Set(['remote-dice', 'teleport', 'mysteryBox']);

/** 只把白名单字段交给引擎，其余一律丢弃 */
function sanitizeIntent(intent) {
    switch (intent.type) {
        case 'move':
            return { type: 'move', chessIndex: Number(intent.chessIndex) };
        case 'teleport':
            return { type: 'teleport', chessIndex: Number(intent.chessIndex) };
        case 'skip':
            return { type: 'skip', reason: intent.reason === 'mysteryBox' ? 'mysteryBox' : null };
        case 'roll': {
            const maxDice = ITEM_DICE_MAX[intent.item];
            if (!maxDice) return { type: 'roll' };
            // 多面骰子只报道具、点数由服务端摇；遥控骰子由玩家选好点数上报
            if (intent.value === undefined || intent.value === null) {
                return { type: 'roll', maxDice, noBonus: true, item: intent.item };
            }
            const value = Number(intent.value);
            if (!Number.isInteger(value) || value < 1 || value > maxDice) {
                throw new Error(`非法道具点数：${intent.value}`);
            }
            return { type: 'roll', value, maxDice, noBonus: true, item: intent.item };
        }
        case 'debug':
            // 指定点数/挪棋子/改积分的调试入口
            return { type: 'debug', op: String(intent.op || ''), player: intent.player, chessIndex: intent.chessIndex, value: intent.value, delta: intent.delta };
        case 'item':
            // item 为空表示取消激活（例如点骰子退出传送门）
            return { type: 'item', item: ITEM_ACTIVATIONS.has(intent.item) ? intent.item : null };
        default:
            return { type: intent.type };
    }
}

/* 完成度采样：前 100 回合每回合记一次，之后每 5 回合一次，与旧版一致 */
const PROGRESS_FULL_ROUNDS = 100;
const PROGRESS_SAMPLE_STEP = 5;

/** 事件流留档上限：刷新回放据此重建战报，超出后丢弃最旧的批次 */
const EVENT_LOG_MAX = 2000;

/** 看门狗阈值：这么久没有任何意图就认为该玩家卡住，服务端按最小合法路径替他推进 */
const STUCK_AFTER_MS = 60 * 1000;
/** 单次兜底最多推进的步数，避免连投 6 或异常状态把看门狗拖进长循环 */
const STUCK_MAX_STEPS = 12;

function calcPlayerProgress(state, color, trackEnd) {
    const chesses = state.players[color].chesses;
    const perPiece = 100 / chesses.length;
    let total = 0;
    let allAtBase = true;
    for (const chess of chesses) {
        if (chess.finished) {
            total += perPiece;
            allAtBase = false;
        } else if (chess.pos >= 0) {
            total += Math.min((chess.pos / trackEnd) * perPiece, perPiece);
            allAtBase = false;
        }
    }
    if (allAtBase) return 0;
    return Math.round(total * 100) / 100;
}

class AuthoritySession {
    constructor(engine, { gameSessionId, colors, pieceCount, happy, skillMode = false, startEnergy = 0 }) {
        this.engine = engine;
        this.gameSessionId = gameSessionId;
        // 引擎的 order 就是回合顺序，必须按颜色升序归一化（即顺时针 1→2→3→4）；
        // 调用方传进来的是玩家加入顺序，直接使用会让下家乱跳。
        this.colors = [...colors].sort((a, b) => a - b);
        this.pieceCount = pieceCount;
        this.happy = happy;
        this.seq = 0;
        this.state = engine.createState({ players: this.colors, piecesPerPlayer: pieceCount, happy, skillMode, startEnergy });
        this.defeats = engine.emptyDefeatMatrix(this.colors);
        this.progressHistory = [];
        // 已广播过的事件流按批累积：刷新/重连的客户端据此重建右侧战报，
        // 前端不再依赖转发消息留档，从根上消除同一条战报被记两次
        this.eventLog = [];
        // 最近一次成功意图的时间戳，看门狗据此判断某位玩家是否已停止推进
        this.lastIntentAt = Date.now();
    }

    /* 事件流留档，超限时从旧到新截断 */
    recordEvents(events) {
        if (!Array.isArray(events) || events.length === 0) return;
        this.eventLog.push(...events);
        if (this.eventLog.length > EVENT_LOG_MAX) {
            this.eventLog = this.eventLog.slice(-EVENT_LOG_MAX);
        }
    }

    /* 回合推进时按采样策略记录各玩家完成度，供结算折线图使用 */
    recordProgress(round) {
        if (round > PROGRESS_FULL_ROUNDS && round % PROGRESS_SAMPLE_STEP !== 0) return;
        if (this.progressHistory.some((item) => item.round === round)) return;
        const players = {};
        for (const color of this.colors) players[color] = calcPlayerProgress(this.state, color, this.engine.TRACK_END);
        this.progressHistory.push({ round, players });
        if (this.progressHistory.length > 500) this.progressHistory.shift();
    }

    /** 全量快照：客户端拿到后整体替换本地棋面，不需要做增量合并 */
    snapshot(events = []) {
        // diceValue 只反映引擎当前状态：回合结束后引擎会清空 state.dice，
        // 客户端据此把骰子落回「未投掷」的深灰态。本次点数只随事件流做瞬时表现，
        // 不能用历史点数兜底，否则下一位玩家开局会看到上家的点数与颜色。
        return this.engine.toSnapshot(this.state, {
            gameSessionId: this.gameSessionId,
            seq: this.seq,
            events,
            diceValue: this.state.dice,
            defeatCounts: this.defeats,
            progressHistory: this.progressHistory,
        });
    }

    /** 对局恢复：棋面没变，推进一次 seq 产出快照让各端重新对齐，并重置看门狗计时 */
    markResumed() {
        this.seq += 1;
        this.lastIntentAt = Date.now();
        return this.snapshot();
    }

    /**
     * 接受一名玩家的意图，在服务端算完规则后返回新快照。
     * 非法意图不改变任何状态，只返回 ok:false。
     */
    applyIntent(color, intent, rng = Math.random) {
        if (!intent || typeof intent.type !== 'string') {
            return { ok: false, error: '缺少动作类型' };
        }
        if (!INTENT_TYPES.has(intent.type)) {
            return { ok: false, error: `未知动作 ${intent.type}` };
        }
        if (!this.colors.includes(color)) {
            return { ok: false, error: `玩家 ${color} 不在本局` };
        }

        // 非法字段（如越界的道具点数）只回拒绝，不改状态
        let sanitized;
        try {
            sanitized = sanitizeIntent(intent);
        } catch (error) {
            return { ok: false, error: error.message };
        }

        let result;
        try {
            result = this.engine.apply(this.state, color, sanitized, rng);
        } catch (error) {
            return { ok: false, error: error.message };
        }

        this.state = result.state;
        this.seq += 1;
        this.engine.countBeats(this.defeats, result.events);
        this.recordProgress(this.state.turn);
        this.recordEvents(result.events);
        this.lastIntentAt = Date.now();

        return { ok: true, snapshot: this.snapshot(result.events) };
    }

    /** 该会话是否已长时间无人操作（对局结束后不再判定） */
    isStuck(now = Date.now()) {
        if (this.state.phase === 'ended') return false;
        return now - this.lastIntentAt > STUCK_AFTER_MS;
    }

    /**
     * 按最小合法路径替卡住的玩家推进，直到回合易主或对局结束。
     * 掷骰阶段直接掷骰，选子阶段取第一架可动棋子——只求把回合交出去，不替玩家做优选。
     * engine.apply 每次返回新对象，因此循环里必须重新读取 this.state，
     * 否则会一直盯着进入函数时的那帧旧状态，永远推进不去。
     */
    advanceStuckTurn(rng = Math.random) {
        const results = [];
        for (let i = 0; i < STUCK_MAX_STEPS; i++) {
            const cur = this.state;
            if (!cur || cur.phase === 'ended') break;
            if (cur.phase !== 'rolling' && cur.phase !== 'selecting') break;

            let intent;
            if (cur.phase === 'rolling') {
                intent = { type: 'roll' };
            } else {
                const movable = this.engine.movableChess(cur, cur.currentPlayer, cur.dice);
                if (!movable.length) break;
                intent = { type: 'move', chessIndex: movable[0] };
            }

            const result = this.applyIntent(cur.currentPlayer, intent, rng);
            if (!result.ok) break;
            results.push(result);

            if (this.state.phase === 'ended' || this.state.currentPlayer !== cur.currentPlayer) break;
        }
        return results;
    }
}

async function createAuthoritySession(options) {
    const engine = await enginePromise;
    return new AuthoritySession(engine, {
        gameSessionId: options.gameSessionId,
        colors: options.colors,
        pieceCount: options.pieceCount || 4,
        happy: Boolean(options.happy),
        skillMode: Boolean(options.skillMode),
        startEnergy: Number(options.startEnergy) || 0,
    });
}

module.exports = { createAuthoritySession };
