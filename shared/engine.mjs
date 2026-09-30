/**
 * 极简飞行棋规则引擎
 *
 * 纯函数模块，前端与后端共用同一份规则实现。
 * 输入 (state, playerId, action) → 输出 (state, events)，不产生任何副作用。
 */

export const BASE = -1;
export const LAUNCH = 0;
export const RING_LEN = 52;
export const RUNWAY_START = 51;
export const TRACK_END = 56;
export const RUNWAY_BASE = 100;
export const CROSS_BASE = 900;
export const HOME = 999;

export const PLAYERS = [1, 2, 3, 4];
export const PIECES_PER_PLAYER = 4;

// -------------------------- 道具模式积分 --------------------------
// 积分只在道具模式里存在，规则一律由引擎算：前后端同一份，客户端不再自己记账再上报。
export const ENERGY_MAX = 100;
export const ENERGY_BASE = 15;              // 击败保底积分
export const ENERGY_PROGRESS_COEF = 0.85;   // 按对手损失的完成度加成
export const HAPPY_BONUS_PER_ENEMY = 20;    // 欢乐模式每撞一颗给的分
export const MYSTERY_BOX_MAX = 40;          // 盲盒开出 0~40

// 道具价目表（唯一一份，AI 决策与界面提示都读它）
export const ITEM_COSTS = {
    'remote-dice': 70,
    'polyhedral-dice': 50,
    teleport: 40,
    mysteryBox: 15,
};

const PIECE_COUNT_MULTIPLIERS = { 2: 1.35, 3: 1.15, 4: 1.0 };

/** 单颗棋子的完成度百分比（0~100）：外圈 0-50 + 终点航道 51-56，共 57 格 */
export function chessProgress(pos, finished = false) {
    if (finished) return 100;
    if (pos === BASE) return 0;
    const steps = TRACK_END + 1;
    return Math.min(100, Math.max(0, (Math.min(pos, TRACK_END) / steps) * 100));
}

/** 击败积分：(基础积分 + 完成度加成) × 棋子数量系数，封顶 */
export function beatReward(state, victimPos) {
    const pieceCount = state.players[state.order[0]].chesses.length;
    const multiplier = PIECE_COUNT_MULTIPLIERS[pieceCount] || 1.0;
    const raw = (ENERGY_BASE + chessProgress(victimPos) * ENERGY_PROGRESS_COEF) * multiplier;
    return Math.round(Math.min(raw, ENERGY_MAX));
}

const RING_ENTRY = { 1: 1, 2: 14, 3: 27, 4: 40 };
const OPPOSITE = { 1: 3, 2: 4, 3: 1, 4: 2 };
const JUMP_RELS = [2, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46];
const JUMP_STEP = 4;
const FLY_ENTRY = 18;
const FLY_EXIT = 30;
const CROSS_STEP = 3;

/**
 * 终点通道交叉点：1/3 号玩家共用一个，2/4 号玩家共用另一个。
 * 旧实现把所有玩家的第 3 格都当成同一个绝对位置，会让不相干的两对玩家互相阻挡。
 */
export function crossCellOf(player) {
    return CROSS_BASE + (player === 1 || player === 3 ? 0 : 1);
}

/** 相对位置 → 全体玩家共用的格子编号；返回 null 表示该位置不参与同格判定（基地） */
export function cellOf(player, rel) {
    if (rel === BASE) return null;
    if (rel === LAUNCH) return LAUNCH;
    if (rel >= 1 && rel <= 50) return ((RING_ENTRY[player] - 1 + (rel - 1)) % RING_LEN) + 1;
    if (rel >= RUNWAY_START && rel <= TRACK_END) return runwayCell(player, rel - RUNWAY_START + 1);
    return null;
}

function runwayCell(player, step) {
    if (step === CROSS_STEP) return crossCellOf(player);
    if (step === 6) return HOME;
    return RUNWAY_BASE + (player - 1) * 10 + step;
}

function beatable(cell, allowCross = false) {
    if (cell === null) return false;
    if (allowCross && cell >= CROSS_BASE && cell < CROSS_BASE + 2) return true;
    return cell >= LAUNCH && cell <= RING_LEN;
}

export function isJumpRel(rel) {
    return JUMP_RELS.includes(rel);
}

export function nextJumpRel(rel) {
    return isJumpRel(rel) ? rel + JUMP_STEP : null;
}

export function createState({ players = PLAYERS, piecesPerPlayer = PIECES_PER_PLAYER, happy = false, skillMode = false, startEnergy = 0 } = {}) {
    const state = {
        order: [...players],
        currentIndex: 0,
        currentPlayer: players[0],
        phase: 'rolling',
        dice: null,
        // 本次点数的来源道具：false 为普通骰子，否则是道具 id（如 'remote-dice'）
        diceItem: false,
        // 已买下、还没落地（选点/选子）的道具：回合结束或改用别的动作即失效
        pendingItem: null,
        consecutiveSixes: 0,
        turn: 0,
        winner: null,
        happy,
        skillMode,
        players: {},
        energy: {},
    };
    for (const id of players) {
        state.players[id] = {
            id,
            chesses: Array.from({ length: piecesPerPlayer }, () => ({ pos: BASE, finished: false })),
            totalDistance: 0,
            defeats: 0,
        };
        state.energy[id] = Math.min(Math.max(0, startEnergy), ENERGY_MAX);
    }
    return state;
}

export function movableChess(state, playerId, dice) {
    const canLaunch = dice % 2 === 0;
    const out = [];
    state.players[playerId].chesses.forEach((chess, index) => {
        if (chess.finished) return;
        if (chess.pos === BASE) {
            if (canLaunch) out.push(index);
        } else if (chess.pos >= LAUNCH && chess.pos < TRACK_END) {
            out.push(index);
        }
    });
    return out;
}

function stackAtCell(state, cell) {
    if (cell === null) return null;
    for (const id of state.order) {
        const cells = [];
        state.players[id].chesses.forEach((chess, index) => {
            if (chess.finished || chess.pos === BASE) return;
            if (cellOf(id, chess.pos) === cell) cells.push({ player: id, index });
        });
        if (cells.length >= 2) return { player: id, cell, cells, count: cells.length };
    }
    return null;
}

function enemyAtCell(state, cell, excludePlayer) {
    if (cell === null) return null;
    for (const id of state.order) {
        if (id === excludePlayer) continue;
        const chesses = state.players[id].chesses;
        for (let index = 0; index < chesses.length; index++) {
            const chess = chesses[index];
            if (chess.finished || chess.pos === BASE) continue;
            if (cellOf(id, chess.pos) === cell) return { player: id, index };
        }
    }
    return null;
}

/** 同一格上某位对手的全部棋子（欢乐模式按颗数算奖励，因此要拿全） */
function enemiesAtCell(state, cell, excludePlayer) {
    if (cell === null) return [];
    for (const id of state.order) {
        if (id === excludePlayer) continue;
        const found = [];
        state.players[id].chesses.forEach((chess, index) => {
            if (chess.finished || chess.pos === BASE) return;
            if (cellOf(id, chess.pos) === cell) found.push({ player: id, index });
        });
        if (found.length) return found;
    }
    return [];
}

/** 目标格是否已被任意棋子占用（传送门要求落点为空位） */
function cellOccupied(state, cell) {
    if (cell === null) return false;
    for (const id of state.order) {
        for (const chess of state.players[id].chesses) {
            if (chess.finished || chess.pos === BASE) continue;
            if (cellOf(id, chess.pos) === cell) return true;
        }
    }
    return false;
}

function sendHome(state, player, index) {
    const chess = state.players[player].chesses[index];
    chess.pos = BASE;
    chess.finished = false;
}

/** 传送门可选落点：空位，按距离由近到远 */
export function teleportSpots(state, playerId, from) {
    const spots = [];
    for (let to = 1; to <= 50; to++) {
        if (to === from) continue;
        if (cellOccupied(state, cellOf(playerId, to))) continue;
        spots.push({ to, distance: Math.abs(to - from) });
    }
    return spots.sort((a, b) => a.distance - b.distance);
}

/** 传送门落点：三段加权随机（近 5 / 中 3 / 远 2） */
function teleportSpot(state, playerId, from, rng) {
    const spots = teleportSpots(state, playerId, from);
    if (!spots.length) return null;

    const segment = Math.ceil(spots.length / 3);
    const weightOf = (index) => (index < segment ? 5 : index < segment * 2 ? 3 : 2);
    let roll = rng() * spots.reduce((sum, spot, index) => sum + weightOf(index), 0);
    for (let index = 0; index < spots.length; index++) {
        roll -= weightOf(index);
        if (roll <= 0) return spots[index].to;
    }
    return spots[spots.length - 1].to;
}

/** 加积分并返回实际到账数（封顶后的增量），道具模式下才有 */
function grantEnergy(state, player, amount) {
    if (!state.skillMode || amount <= 0) return 0;
    const before = state.energy[player] || 0;
    const after = Math.min(before + amount, ENERGY_MAX);
    state.energy[player] = after;
    return after - before;
}

function beatAtCell(state, cell, byPlayer, events, { allowCross = false } = {}) {
    // 欢乐模式没有击败：落在敌人格上走 happyCollision（奖励前进），不做任何送人回基地
    if (state.happy) return null;
    if (!beatable(cell, allowCross)) return null;
    const target = enemyAtCell(state, cell, byPlayer);
    if (!target) return null;
    // 被击败棋子当时的落点：击败积分按对手损失的完成度算，得在送回基地之前量下来
    const victimPos = state.players[target.player].chesses[target.index].pos;
    sendHome(state, target.player, target.index);
    state.players[byPlayer].defeats += 1;
    // 遥控骰子能指定点数，击败不给积分（避免刷分）；多面骰子照常计分
    const isRemoteDice = state.diceItem === 'remote-dice';
    const reward = isRemoteDice ? 0 : beatReward(state, victimPos);
    const gain = isRemoteDice ? 0 : grantEnergy(state, byPlayer, reward);
    events.push({ type: 'beat', player: byPlayer, targetPlayer: target.player, chess: target.index, cell, itemRoll: state.diceItem, reward, energy: gain });
    return target;
}

/** 欢乐模式允许的连锁次数上限，避免极端情况下绕不完 */
const HAPPY_CHAIN_LIMIT = 32;

/**
 * 欢乐模式的碰撞结算：落在对手棋子上不送人回基地，改为按敌方棋子数奖励前进
 * （每颗 2 步，至少 2 步），走完再看落点能否跳子/飞棋、是否又是一次碰撞（连锁）。
 */
function happyCollision(state, player, index, events) {
    for (let guard = 0; guard < HAPPY_CHAIN_LIMIT; guard++) {
        const chess = state.players[player].chesses[index];
        if (chess.finished) return;

        const cell = cellOf(player, chess.pos);
        const enemies = enemiesAtCell(state, cell, player);
        if (!enemies.length) return;

        const steps = Math.max(2, enemies.length * 2);
        state.players[player].defeats += enemies.length;
        // 撞几颗给几份积分，数值由引擎算给各端（战报行直接读它）
        const gain = grantEnergy(state, player, HAPPY_BONUS_PER_ENEMY * enemies.length);
        events.push({
            type: 'collision_bonus',
            player,
            targetPlayer: enemies[0].player,
            targetChess: enemies[0].index,
            cell,
            enemyCount: enemies.length,
            steps,
            energy: gain,
        });

        const finished = walk(state, player, index, { fromRel: chess.pos, forward: steps, back: 0 }, events);
        if (finished) return;

        // 奖励步数的落点若是起跳点/飞棋点，照常触发（其内部的击败检测在欢乐模式下已被禁用）
        handleSpecialPositions(state, player, index, state.players[player].chesses[index].pos, events);
    }
}

function emitStack(state, player, rel, events) {
    const cell = cellOf(player, rel);
    if (cell === null || cell === HOME) return;
    // 起飞点上的「叠子」只是几颗还没进环的自家棋子：那里谁都走不到、谁也拦不住，
    // 不产生任何交互与影响，所以不算叠子、也不播报
    if (cell === LAUNCH) return;
    const chesses = [];
    state.players[player].chesses.forEach((chess, index) => {
        if (chess.finished || chess.pos === BASE) return;
        if (cellOf(player, chess.pos) === cell) chesses.push(index);
    });
    if (chesses.length >= 2) events.push({ type: 'stack', player, cell, chesses, count: chesses.length });
}

function opponentStackAtCross(state, player) {
    const stack = stackAtCell(state, crossCellOf(player));
    return stack && stack.player === OPPOSITE[player] ? stack : null;
}

function stackInMovePath(state, player, fromRel, steps) {
    if (fromRel < LAUNCH || fromRel >= RUNWAY_START) return null;
    for (let step = 1; step <= steps; step++) {
        const rel = fromRel + step;
        if (rel > 50) break;
        const stack = stackAtCell(state, cellOf(player, rel));
        if (stack && stack.player !== player) {
            return {
                rel,
                cell: cellOf(player, rel),
                distance: step,
                remaining: steps - step,
                isExactHit: step === steps,
                needsBounce: step < steps,
                player: stack.player,
                cells: stack.cells,
            };
        }
    }
    return null;
}

function stackInJumpPath(state, player, fromRel, toRel) {
    if (fromRel <= LAUNCH || toRel <= LAUNCH) return null;
    const lo = Math.min(fromRel, toRel);
    const hi = Math.max(fromRel, toRel);
    for (let rel = lo + 1; rel < hi; rel++) {
        const stack = stackAtCell(state, cellOf(player, rel));
        if (stack && stack.player !== player) return { rel, cell: cellOf(player, rel), player: stack.player };
    }
    return null;
}

function walk(state, player, index, { fromRel, forward, back, bounceReason = null, blocker = null }, events) {
    const chess = state.players[player].chesses[index];
    const path = [];
    let rel = fromRel;

    for (let i = 0; i < forward; i++) {
        rel += 1;
        path.push({ rel, cell: cellOf(player, rel) });
    }

    const finished = rel === TRACK_END && back === 0;

    for (let i = 0; i < back && rel > LAUNCH; i++) {
        rel -= 1;
        path.push({ rel, cell: cellOf(player, rel) });
    }

    chess.pos = rel;
    events.push({ type: 'walk', player, chess: index, from: fromRel, to: rel, path, bounced: back > 0, bounceReason, bounceSteps: back, blocker });

    if (finished) {
        chess.finished = true;
        events.push({ type: 'finish', player, chess: index });
    }
    return finished;
}

function resolveMove(state, player, index, events) {
    const chess = state.players[player].chesses[index];
    const dice = state.dice;

    if (chess.pos === BASE) {
        chess.pos = LAUNCH;
        state.players[player].totalDistance += 1;
        events.push({ type: 'launch', player, chess: index, to: LAUNCH });
        emitStack(state, player, LAUNCH, events);
        return;
    }

    const fromRel = chess.pos;
    state.players[player].totalDistance += dice;

    const stack = state.happy ? null : stackInMovePath(state, player, fromRel, dice);
    const stackCrash = Boolean(stack && stack.isExactHit);
    const stackBounce = Boolean(stack && stack.needsBounce);
    // 欢乐模式不做终点反弹，超出就停在终点
    const overshootRaw = fromRel + dice > TRACK_END ? fromRel + dice - TRACK_END : 0;
    const overshoot = state.happy ? 0 : overshootRaw;

    let forward = dice;
    if (stackCrash || stackBounce) forward = stack.distance;
    else if (overshootRaw) forward = TRACK_END - fromRel;

    let back = 0;
    if (stackBounce) back = Math.min(stack.remaining, fromRel + forward - LAUNCH);
    else if (overshoot) back = overshoot;

    const bounceReason = stackBounce ? 'stack' : (overshoot ? 'overshoot' : null);
    const blocker = stackBounce ? stack.player : null;
    const finished = walk(state, player, index, { fromRel, forward, back, bounceReason, blocker }, events);
    if (finished) {
        if (state.players[player].chesses.every((c) => c.finished)) state.winner = player;
        return;
    }

    if (stackCrash) {
        // 被撞回家的每颗棋子都按击败结算给撞的人加分（落点要在送回基地之前量）。
        // 遥控骰子撞的同样不给分，和单颗击败一致；累计值另记一份未截断的 reward 供显示
        let gain = 0;
        let reward = 0;
        if (state.diceItem !== 'remote-dice') {
            for (const victim of stack.cells) {
                const victimPos = state.players[victim.player].chesses[victim.index].pos;
                const each = beatReward(state, victimPos);
                reward += each;
                gain += grantEnergy(state, player, each);
            }
        }
        sendHome(state, player, index);
        for (const victim of stack.cells) sendHome(state, victim.player, victim.index);
        events.push({ type: 'collide', player, targetPlayer: stack.player, cell: stack.cell, chesses: stack.cells, reward, energy: gain });
        return;
    }

    if (stackBounce || overshoot) {
        if (state.happy) happyCollision(state, player, index, events);
        else beatAtCell(state, cellOf(player, chess.pos), player, events);
        return;
    }

    handleSpecialPositions(state, player, index, chess.pos, events);
    if (state.happy) happyCollision(state, player, index, events);
    else beatAtCell(state, cellOf(player, chess.pos), player, events);
    emitStack(state, player, chess.pos, events);
}

function handleSpecialPositions(state, player, index, rel, events) {
    const crossStack = state.happy ? null : opponentStackAtCross(state, player);
    const blocked = Boolean(crossStack);

    if (rel === 14) {
        jump(state, player, index, rel + JUMP_STEP, events);
        if (blocked) {
            events.push({ type: 'blocked', reason: 'cross-stack', player, chess: index, cell: crossCellOf(player), targetPlayer: crossStack.player });
            return true;
        }
        if (state.players[player].chesses[index].pos === FLY_ENTRY) {
            fly(state, player, index, FLY_EXIT, events);
        }
        return true;
    }

    if (rel === FLY_ENTRY) {
        beatAtCell(state, cellOf(player, rel), player, events);
        if (blocked) {
            events.push({ type: 'blocked', reason: 'cross-stack', player, chess: index, cell: crossCellOf(player), targetPlayer: crossStack.player });
            jump(state, player, index, rel + JUMP_STEP, events);
            return true;
        }
        fly(state, player, index, FLY_EXIT, events);
        if (state.players[player].chesses[index].pos === FLY_EXIT) {
            jump(state, player, index, FLY_EXIT + JUMP_STEP, events);
        }
        return true;
    }

    const target = nextJumpRel(rel);
    if (target !== null) {
        jump(state, player, index, target, events);
        return true;
    }

    return false;
}

function jump(state, player, index, targetRel, events) {
    const chess = state.players[player].chesses[index];
    const fromRel = chess.pos;
    const fromCell = cellOf(player, fromRel);
    const targetCell = cellOf(player, targetRel);

    const inPath = stackInJumpPath(state, player, fromRel, targetRel);
    if (inPath) {
        events.push({ type: 'blocked', reason: 'jump-stack-in-path', player, chess: index, cell: inPath.cell, targetPlayer: inPath.player });
        beatAtCell(state, fromCell, player, events);
        return;
    }

    const targetStack = stackAtCell(state, targetCell);
    if (targetStack && targetStack.player !== player) {
        events.push({ type: 'blocked', reason: 'jump-target-stack', player, chess: index, cell: targetCell, targetPlayer: targetStack.player });
        beatAtCell(state, fromCell, player, events);
        return;
    }

    beatAtCell(state, fromCell, player, events);
    events.push({ type: 'jump', player, chess: index, from: fromRel, to: targetRel, path: [fromRel, targetRel] });
    chess.pos = targetRel;
    state.players[player].totalDistance += targetRel - fromRel;
    beatAtCell(state, targetCell, player, events);
}

function fly(state, player, index, targetRel, events) {
    const chess = state.players[player].chesses[index];
    const fromRel = chess.pos;
    const targetCell = cellOf(player, targetRel);

    if (!state.happy) {
        const crossStack = opponentStackAtCross(state, player);
        if (crossStack) {
            events.push({ type: 'blocked', reason: 'cross-stack', player, chess: index, cell: crossCellOf(player), targetPlayer: crossStack.player });
            return;
        }
        const targetStack = stackAtCell(state, targetCell);
        if (targetStack && targetStack.player !== player) {
            sendHome(state, player, index);
            for (const victim of targetStack.cells) sendHome(state, victim.player, victim.index);
            events.push({ type: 'collide', player, targetPlayer: targetStack.player, cell: targetCell, chesses: targetStack.cells });
            return;
        }
    }

    events.push({ type: 'fly', player, chess: index, from: fromRel, to: targetRel, path: [fromRel, targetRel] });
    chess.pos = targetRel;
    state.players[player].totalDistance += targetRel - fromRel;

    const cross = crossCellOf(player);
    // 交叉点是两两共用的（1/3、2/4），2 人局或 3 人局里对家可能根本不在局中
    const opposite = state.players[OPPOSITE[player]];
    const opponentAtCross = Boolean(opposite) && opposite.chesses.some(
        (c) => !c.finished && c.pos === RUNWAY_START + CROSS_STEP - 1
    );
    if (opponentAtCross) beatAtCell(state, cross, player, events, { allowCross: true });

    beatAtCell(state, targetCell, player, events);
}

function rollDie(rng, max = 6) {
    return 1 + Math.floor(rng() * max);
}

function requireTurn(state, playerId, phase) {
    if (state.currentPlayer !== playerId) throw new Error(`当前轮到玩家 ${state.currentPlayer}`);
    if (state.phase !== phase) throw new Error(`阶段 ${state.phase} 不接受该操作`);
}

function requireTurnIn(state, playerId, phases) {
    if (state.currentPlayer !== playerId) throw new Error(`当前轮到玩家 ${state.currentPlayer}`);
    if (!phases.includes(state.phase)) throw new Error(`阶段 ${state.phase} 不接受该操作`);
}

function endTurn(state, events) {
    state.consecutiveSixes = 0;
    state.dice = null;
    state.diceItem = false;
    state.phase = 'rolling';
    state.turn += 1;
    state.currentIndex = (state.currentIndex + 1) % state.order.length;
    state.currentPlayer = state.order[state.currentIndex];
    state.pendingItem = null;
    events.push({ type: 'turn', player: state.currentPlayer });
}

/** 道具模式下扣钱：买不起或没开道具模式一律拒绝 */
function chargeItem(state, player, item) {
    const cost = ITEM_COSTS[item];
    if (!state.skillMode) throw new Error('本局未开启道具模式');
    if (cost === undefined) throw new Error(`未知道具 ${item}`);
    if ((state.energy[player] || 0) < cost) throw new Error(`积分不足：${item} 需要 ${cost}`);
    // 盲盒是落后方的翻盘手段，积分够高时禁止再摇
    if (item === 'mysteryBox' && (state.energy[player] || 0) >= MYSTERY_BOX_MAX) {
        throw new Error(`积分已达 ${MYSTERY_BOX_MAX}，盲盒不可使用`);
    }
    state.energy[player] -= cost;
    return cost;
}

/** 买下道具只记激活态，真正的效果等选点/选子落地（盲盒当场开盒并交出回合） */
function activateItem(state, player, item, events, rng) {
    const cost = chargeItem(state, player, item);

    if (item === 'mysteryBox') {
        // 开盒数值由引擎摇，客户端只负责演出，刷新/回放都不会再对不上号
        const amount = Math.floor(rng() * (MYSTERY_BOX_MAX + 1));
        const gain = grantEnergy(state, player, amount);
        events.push({ type: 'mystery_box', player, cost, amount, energy: gain });
        endTurn(state, events);
        return;
    }

    state.pendingItem = { player, item, cost };
    events.push({ type: 'item_activate', player, item, cost });
}

/** 取消已激活的道具：预扣的积分原样退回，免得选不出落点时白花钱 */
function cancelItem(state, player, events) {
    const pending = state.pendingItem;
    if (!pending || pending.player !== player) throw new Error('没有待取消的道具');
    grantEnergy(state, player, pending.cost);
    events.push({ type: 'item_cancel', player, item: pending.item, refund: pending.cost });
    state.pendingItem = null;
}

/** 调试动作：直接改棋面，不走规则。只有开了调试通道的服务端才会放进来 */
function applyDebug(state, playerId, action, events, rng) {
    if (action.op === 'dice') {
        // 指定点数就是一次普通掷骰，后面该交回合、该挨三次 6 惩罚都照旧
        const result = apply(state, playerId, { type: 'roll', value: Number(action.value) }, rng);
        Object.assign(state, result.state);
        events.push(...result.events);
        return;
    }
    if (action.op === 'move') {
        const chess = state.players[Number(action.player)]?.chesses[Number(action.chessIndex)];
        if (!chess) throw new Error('棋子不存在');
        const delta = Number(action.delta) || 0;
        chess.pos = delta > 0 ? Math.min(chess.pos + delta, TRACK_END) : Math.max(chess.pos + delta, BASE);
        chess.finished = false;
        return;
    }
    if (action.op === 'finish') {
        // 把当前玩家的棋子逐个送到终点（摆终局用），满了就按引擎的规则判胜
        const player = state.currentPlayer;
        const chesses = state.players[player]?.chesses;
        if (!chesses) throw new Error('玩家不在本局');
        chesses.forEach((chess, index) => {
            chess.pos = TRACK_END;
            chess.finished = true;
            events.push({ type: 'finish', player, chess: index });
        });
        if (chesses.every((chess) => chess.finished)) {
            state.winner = player;
            state.phase = 'ended';
            events.push({ type: 'end', winner: player });
        }
        return;
    }
    if (action.op === 'energy') {
        const player = Number(action.player);
        if (state.energy[player] === undefined) throw new Error('玩家不在本局');
        state.energy[player] = Math.max(0, Math.min(ENERGY_MAX, Number(action.value) || 0));
        return;
    }
    throw new Error('未知调试操作：' + action.op);
}

export function apply(state, playerId, action, rng = Math.random) {
    if (state.phase === 'ended') throw new Error('对局已结束');
    const next = structuredClone(state);
    const events = [];

    if (action.type === 'roll') {
        requireTurn(next, playerId, 'rolling');
        const maxDice = action.maxDice || 6;
        const value = action.value ?? rollDie(rng, maxDice);
        if (!Number.isInteger(value) || value < 1 || value > maxDice) throw new Error(`非法点数：${value}`);

        // 遥控骰子先在激活时买了单，这里只消费激活态；不认这笔账就没法白拿道具
        if (action.item === 'remote-dice') {
            const pending = next.pendingItem;
            if (!pending || pending.item !== 'remote-dice' || pending.player !== playerId) {
                throw new Error('遥控骰子尚未激活');
            }
        }
        // 多面骰子在这一掷买下；已经为它激活过就不再收第二遍
        const planned = next.pendingItem;
        const alreadyPaid = Boolean(planned && planned.item === 'polyhedral-dice' && planned.player === playerId);
        const cost = action.item === 'polyhedral-dice' && !alreadyPaid
            ? chargeItem(next, playerId, action.item)
            : 0;
        next.pendingItem = null;

        // 道具骰子只走一次普通行进，不参与连投奖励与三次 6 计数。
        // diceItem 记来源道具（不只是布尔量），刷新后客户端据此还原专属骰面
        const countsSix = !action.noBonus;
        // 掷之前已经连出两个 6：这一手就是「冒险的那一手」，客户端据此给骰子上红光
        const sixesBefore = next.consecutiveSixes;
        next.dice = value;
        next.diceItem = countsSix ? false : (action.item || true);
        next.consecutiveSixes = countsSix && value === 6 ? next.consecutiveSixes + 1 : 0;
        events.push({ type: 'dice', player: playerId, value, item: next.diceItem || null, cost, sixStreak: next.consecutiveSixes });

        if (next.consecutiveSixes >= 3 && !next.happy) {
            // 已经抵达终点的棋子留在终点，不跟着回基地
            const pieces = [];
            next.players[playerId].chesses.forEach((chess, index) => {
                if (chess.finished) return;
                sendHome(next, playerId, index);
                pieces.push(index);
            });
            events.push({ type: 'reset', player: playerId, reason: 'three-sixes', pieces });
            endTurn(next, events);
            return { state: next, events };
        }

        // 欢乐模式不做三次6惩罚，计数清零后照常连投
        if (next.consecutiveSixes >= 3) next.consecutiveSixes = 0;

        if (movableChess(next, playerId, value).length === 0) {
            events.push({ type: 'skip', player: playerId, value });
            endTurn(next, events);
            return { state: next, events };
        }

        next.phase = 'selecting';
        return { state: next, events };
    }

    if (action.type === 'move') {
        requireTurn(next, playerId, 'selecting');
        if (!movableChess(next, playerId, next.dice).includes(action.chessIndex)) {
            throw new Error(`棋子 ${action.chessIndex} 当前不可移动`);
        }
        const value = next.dice;
        resolveMove(next, playerId, action.chessIndex, events);

        if (next.winner !== null) {
            next.phase = 'ended';
            events.push({ type: 'end', winner: next.winner });
        } else if (value === 6 && !next.diceItem) {
            // 6 点连投：这一手走完还归他，客户端据此播「获得 [连投奖励]」
            next.dice = null;
            next.phase = 'rolling';
            events.push({ type: 'reroll', player: playerId });
        } else {
            endTurn(next, events);
        }
        return { state: next, events };
    }

    if (action.type === 'skip') {
        // 盲盒会在掷骰前直接跳过回合，因此两个阶段都接受
        requireTurnIn(next, playerId, ['rolling', 'selecting']);
        events.push({ type: 'pass', player: playerId, reason: action.reason || null });
        endTurn(next, events);
        return { state: next, events };
    }

    if (action.type === 'item') {
        requireTurnIn(next, playerId, ['rolling', 'selecting']);
        if (action.item) activateItem(next, playerId, action.item, events, rng);
        else cancelItem(next, playerId, events);
        return { state: next, events };
    }

    if (action.type === 'teleport') {
        requireTurnIn(next, playerId, ['rolling', 'selecting']);
        const index = action.chessIndex;
        const chess = next.players[playerId].chesses[index];
        if (!chess) throw new Error(`棋子 ${index} 不存在`);
        // 能传的是「还没到终点」的棋子：起始区和已完成的传不了，终点通道上（51-55）可以传回主轨道
        if (chess.finished || chess.pos === BASE) {
            throw new Error('起始区或已完成的棋子无法传送');
        }
        // 传送门同样先买后用
        if (next.pendingItem?.item !== 'teleport' || next.pendingItem.player !== playerId) {
            throw new Error('传送门尚未激活');
        }
        const to = teleportSpot(next, playerId, chess.pos, rng);
        if (to === null) throw new Error('没有可用的空位进行传送');
        next.pendingItem = null;

        const from = chess.pos;
        if (to > from) next.players[playerId].totalDistance += to - from;
        chess.pos = to;
        events.push({ type: 'teleport', player: playerId, chess: index, from, to });
        endTurn(next, events);
        return { state: next, events };
    }

    if (action.type === 'debug') {
        applyDebug(next, playerId, action, events, rng);
        return { state: next, events };
    }

    throw new Error('未知动作：' + action.type);
}

/**
 * 预览一次动作的结果，不改动传入的状态。
 * apply 本身就是纯函数，预览与执行必然得到同一份结果，AI 推演不会和真实规则分叉。
 * AI 需要试不同的假想点数，因此允许用 dice 覆盖当前骰子值。
 */
export function preview(state, playerId, action, { dice = null, rng = Math.random } = {}) {
    const trial = structuredClone(state);
    if (dice !== null && dice !== undefined) {
        trial.currentPlayer = playerId;
        trial.phase = 'selecting';
        trial.dice = dice;
        trial.diceItem = false;
    }

    try {
        const { state: next, events } = apply(trial, playerId, action, rng);
        return { ok: true, state: next, events };
    } catch (error) {
        return { ok: false, error: error.message, events: [] };
    }
}

export function emptyDefeatMatrix(colors) {
    const matrix = {};
    for (const attacker of colors) {
        matrix[attacker] = {};
        for (const target of colors) {
            if (target !== attacker) matrix[attacker][target] = 0;
        }
    }
    return matrix;
}

export function countBeats(matrix, events) {
    for (const event of events) {
        // 欢乐模式的碰撞按敌方棋子数计入击败统计，普通模式一次击败算一次
        const isBeat = event.type === 'beat';
        const isCollision = event.type === 'collision_bonus';
        const isCollide = event.type === 'collide';
        if (!isBeat && !isCollision && !isCollide) continue;
        if (isCollide) {
            // 撞上叠子双方都算被击败：撞的人吃下叠子上所有棋子，叠子主人收下撞上来的那颗
            if (matrix[event.player] && matrix[event.player][event.targetPlayer] !== undefined) {
                matrix[event.player][event.targetPlayer] += (event.chesses || []).length || 1;
            }
            if (matrix[event.targetPlayer] && matrix[event.targetPlayer][event.player] !== undefined) {
                matrix[event.targetPlayer][event.player] += 1;
            }
            continue;
        }
        if (!matrix[event.player] || matrix[event.player][event.targetPlayer] === undefined) continue;
        matrix[event.player][event.targetPlayer] += isCollision ? (event.enemyCount || 1) : 1;
    }
    return matrix;
}

/**
 * 全量快照：客户端拿到后整体替换本地棋面，无需增量合并。
 * 前后端共用同一份定义，避免两边字段漂移。
 *
 * diceItem / pendingItem 是道具的进行中状态（点数来源、已激活未落的道具），
 * energy 是道具模式的积分（非道具局恒为 0）；刷新后都靠快照还原。
 */
export function toSnapshot(state, { gameSessionId = null, seq = 0, events = [], defeatCounts = null, diceValue, progressHistory = null } = {}) {
    const playerChess = {};
    const defeats = {};
    const totalDistance = {};
    const energy = {};

    for (const id of state.order) {
        playerChess[id] = state.players[id].chesses.map((chess) => ({
            position: chess.pos,
            finished: chess.finished,
        }));
        defeats[id] = state.players[id].defeats;
        totalDistance[id] = state.players[id].totalDistance;
        energy[id] = state.energy[id] || 0;
    }

    return {
        type: 'gameSnapshot',
        gameSessionId,
        seq,
        currentPlayer: state.currentPlayer,
        gamePhase: state.phase,
        diceValue: diceValue !== undefined ? diceValue : state.dice,
        diceItem: state.diceItem || false,
        pendingItem: state.pendingItem ? state.pendingItem.item : null,
        winner: state.winner,
        consecutiveSixes: state.consecutiveSixes,
        round: state.turn,
        pieceCount: state.players[state.order[0]].chesses.length,
        happyMode: state.happy,
        skillMode: state.skillMode,
        energy,
        playerChess,
        defeats,
        totalDistance,
        defeatCounts: defeatCounts || emptyDefeatMatrix(state.order),
        progressHistory: progressHistory || [],
        events,
    };
}
