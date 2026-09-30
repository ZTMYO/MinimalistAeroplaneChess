/**
 * AI 决策：只吃引擎状态，返回一个待执行的动作，服务端与单机共用。
 * 走法评分读引擎 preview 的事件流（击败、跳子、飞棋、终点、碰撞都在里面）。
 */
import { ITEM_COSTS, BASE, TRACK_END, cellOf, chessProgress, movableChess, preview, teleportSpots } from './engine.mjs';

const SCORE = {
    winNow: 2000,       // 这一步直接赢
    finish: 450,        // 送一块进终点
    beat: 500,          // 击败，另按对手损失加成
    jump: 300,
    fly: 300,           // 飞棋在事件流里也是 jump，数值够用
    collision: 550,     // 欢乐模式踩敌人换步数
    takeoff: 200,
    bounceWithBeat: 400,
    bounce: 20,
    stackCrash: -200,   // 撞叠子双方都回家，正常模式要躲
    normal: 50,
};

/** 该玩家还有几块没到终点 */
function unfinished(state, player, exclude = -1) {
    return state.players[player].chesses.filter((chess, index) => !chess.finished && index !== exclude).length;
}

/** 玩家进度：各棋子的完成度之和，用来判断谁落后 */
export function playerProgress(state, player) {
    return state.players[player].chesses.reduce((sum, chess) => sum + chessProgress(chess.pos, chess.finished), 0);
}

// 落后判据：playerProgress 是各棋子完成度之和（4 子局满分 400）
const BEHIND_GAP = 25;
const FAR_BEHIND_GAP = 60;

function isBehind(state, player, gap = BEHIND_GAP) {
    const mine = playerProgress(state, player);
    const best = Math.max(...state.order.map((id) => (id === player ? -1 : playerProgress(state, id))));
    return best - mine >= gap;
}

function isFarBehind(state, player) {
    return isBehind(state, player, FAR_BEHIND_GAP);
}

/** 被击败那一格的对手推进到什么程度（越接近终点，打掉越值） */
function victimProgressAt(state, victim, cell) {
    let best = 0;
    for (const chess of state.players[victim].chesses) {
        if (chess.finished || chess.pos === BASE) continue;
        if (cellOf(victim, chess.pos) === cell) best = Math.max(best, chessProgress(chess.pos));
    }
    return best;
}

/** 一个候选走法值多少分（分数一样时取走得最远的） */
function scoreMove(state, player, chessIndex, dice) {
    const result = preview(state, player, { type: 'move', chessIndex }, { dice });
    if (!result.ok) return null;

    const events = result.events;
    const first = events[0];
    const has = (type) => events.some((event) => event.type === type);
    let score = 0;

    if (has('finish')) {
        score += unfinished(state, player, chessIndex) === 0 ? SCORE.winNow : SCORE.finish;
    }
    for (const event of events) {
        if (event.type === 'beat') {
            score += SCORE.beat + victimProgressAt(state, event.targetPlayer, event.cell) * 3;
        }
        if (event.type === 'jump') score += SCORE.jump;
        if (event.type === 'collision_bonus') {
            score += SCORE.collision + (event.enemyCount || 1) * 100 + (event.steps || 0) * 15;
        }
        if (event.type === 'collide') score += state.happy ? SCORE.collision : SCORE.stackCrash;
    }

    const walked = events.find((event) => event.type === 'walk');
    if (first && first.type === 'launch') score += SCORE.takeoff;
    else if (walked && walked.bounced) score += has('beat') ? SCORE.bounceWithBeat : SCORE.bounce;
    else if (!has('finish') && !has('beat') && !has('jump') && !has('collision_bonus') && !has('collide')) score += SCORE.normal;
    return { score, dice };
}

/** 给定点数下最划算的走法 */
function bestMove(state, player, dice, movable = movableChess(state, player, dice)) {
    let best = null;
    for (const chessIndex of movable) {
        const scored = scoreMove(state, player, chessIndex, dice);
        if (!scored) continue;
        if (!best || scored.score > best.score) best = { ...scored, chessIndex };
    }
    return best;
}

/** 遥控骰子里最划算的一掷：优先能直接赢/终点，其次能击败 */
function bestDiceValue(state, player) {
    let best = null;
    for (let value = 1; value <= 6; value++) {
        const movable = movableChess(state, player, value);
        if (!movable.length) continue;
        const scored = bestMove(state, player, value, movable);
        if (!scored) continue;
        const worth = scored.score + value * 0.1; // 同分时走得远一点
        if (!best || worth > best.worth) best = { value, worth, score: scored.score, chessIndex: scored.chessIndex };
    }
    return best;
}

function hasChessOnTrack(state, player) {
    return state.players[player].chesses.some((chess) => !chess.finished && chess.pos >= 0 && chess.pos < TRACK_END);
}

/** 传送门：挑自己最靠前、还在主轨道上的那颗，落点交给引擎摇 */
function teleportPick(state, player) {
    const chess = state.players[player].chesses
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !item.finished && item.pos >= 0 && item.pos < 51)
        .sort((a, b) => b.item.pos - a.item.pos)[0];
    if (!chess) return null;
    if (!teleportSpots(state, player, chess.item.pos).length) return null;
    return { chessIndex: chess.index };
}

/**
 * 该玩家下一步做什么。
 * difficulty：'hard' 会买道具并挑最优的棋子和点数；'easy' 不碰道具、选子随机。
 * @returns {Object|null} 引擎动作；返回 null 表示这一步没有可做的（例如无子可动，由引擎自己跳过）
 */
export function chooseAction(state, player, { rng = Math.random, difficulty = 'hard' } = {}) {
    if (state.phase === 'ended' || state.currentPlayer !== player) return null;
    const hard = difficulty === 'hard';
    const energy = state.energy[player] || 0;

    // 道具：只有困难难度才买，优先级与旧前端一致（遥控 → 传送门 → 盲盒 → 多面骰）
    if (hard && state.phase === 'rolling' && state.skillMode && !state.pendingItem) {
        const threat = bestDiceValue(state, player);
        if (threat && threat.score >= SCORE.beat && energy >= ITEM_COSTS['remote-dice']) {
            return { type: 'item', item: 'remote-dice' };
        }
        if (isBehind(state, player) && hasChessOnTrack(state, player) && energy >= ITEM_COSTS.teleport && teleportPick(state, player)) {
            return { type: 'item', item: 'teleport' };
        }
        if (isFarBehind(state, player) && energy >= ITEM_COSTS.mysteryBox && energy < ITEM_COSTS.teleport) {
            return { type: 'item', item: 'mysteryBox' };
        }
        if (isBehind(state, player) && hasChessOnTrack(state, player) && energy >= ITEM_COSTS['polyhedral-dice']) {
            return { type: 'roll', item: 'polyhedral-dice' };
        }
    }

    // 买下的道具还欠一次落地（人类买了道具被托管时也要替他把这一手走完，所以不看难度）
    if (state.pendingItem && state.pendingItem.player === player) {
        if (state.pendingItem.item === 'remote-dice') {
            const best = bestDiceValue(state, player);
            return { type: 'roll', value: best ? best.value : undefined, maxDice: 6, noBonus: true, item: 'remote-dice' };
        }
        if (state.pendingItem.item === 'teleport') {
            const target = teleportPick(state, player);
            if (target) return { type: 'teleport', chessIndex: target.chessIndex };
        }
    }

    if (state.phase === 'rolling') return { type: 'roll' };

    if (state.phase === 'selecting') {
        if (!hard) {
            // 简单难度：可动棋子里随机挑一颗
            const movable = movableChess(state, player, state.dice);
            if (!movable.length) return null;
            return { type: 'move', chessIndex: movable[Math.floor(rng() * movable.length)] };
        }
        const best = bestMove(state, player, state.dice);
        if (best) return { type: 'move', chessIndex: best.chessIndex };
    }
    return null;
}
