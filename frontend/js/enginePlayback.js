/**
 * 事件回放层：把引擎事件流翻译成动画、音效与战报。
 * 这里不做规则判断，棋子位置一律以事件为准。
 */
import { gameState } from './gameState.js';
import { animation } from './animation.js';
import { gameInfo } from './gameInfo.js';
import { audioManager } from './audioManager.js';
import { energyManager } from './energyManager.js';
import { titleManager } from './titleManager.js';
import { DICE_SYMBOLS, calculateChessProgress } from './utils.js';
import { RUNWAY_BASE, CROSS_BASE } from '../../shared/engine.mjs';

const STEP_DELAY = 190;
const FINISH_DELAY = 500;
const CRASH_DELAY = 200;
const TELEPORT_FADE = 200;
// 传送聚光：格子逐格清空的间隔（斜向扫完整盘 ≈ 76 格 × 这个值）
const TELEPORT_WAVE_STEP_MS = 4;
// 传送落地后的停顿：走子有逐格节奏，传送没有，得自己留一拍才看得清落在哪
const TELEPORT_HOLD = 350;
// 欢乐模式每次碰撞后的停顿，让人看清撞到了谁
const COLLISION_BONUS_DELAY = 200;
// 撞叠子时每颗被撞棋子的积分粒子依次飞，别全挤在同一帧
const CRASH_ENERGY_DELAY = 120;
// 盲盒：图标闪烁一段，再亮出开出的点数
const BOX_ICON_DELAY = 1000;
const BOX_REVEAL_DELAY = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastMover = { player: null, chess: null };
// 这一手正在动的是哪颗棋子（jump/fly 链都算同一手，用来认「击败我的那颗棋子」）
let currentMoveChess = null;

// 本次事件流中「无子可动/被跳过」的抖动请求，待骰子定格后由调用方触发
let pendingShake = null;

// 静默回放：只把事件翻译成战报文本，不播动画、音效与粒子。
// 刷新后右侧面板需要一次性重建历史所有战报，逐条播放动画既慢又毫无意义。
let silentReplay = false;

// 这一批事件里每颗棋子走了多远：走子、跳子、飞棋连同欢乐模式的奖励步数算作同一手
let moveDistances = new Map();

// 这一批事件里每位玩家击败了几颗棋子（撞叠子走 collide 事件，不计入）
let moveBeats = new Map();

// 这一批事件里每位玩家碰撞了几颗棋子（欢乐模式，按被撞的敌方棋子数累计）
let moveCollisions = new Map();

function addMoveDistance(player, chess, distance) {
    if (!(distance > 0)) return;
    const key = `${player}-${chess}`;
    const entry = moveDistances.get(key) || { player, distance: 0 };
    entry.distance += distance;
    moveDistances.set(key, entry);
}

function flushMoveDistances() {
    moveDistances.forEach(({ player, distance }) => gameState.recordMoveDistance(player, distance));
    moveDistances = new Map();
    moveBeats.forEach((count, player) => gameState.recordMoveBeats(player, count));
    moveBeats = new Map();
    moveCollisions.forEach((count, player) => gameState.recordMoveCollisions(player, count));
    moveCollisions = new Map();
}

let announceSilent = false;

// 一批事件演完后，把本批新达成的「流程内称号」播报出去（各端都从同一份事件流得出）
function announceLiveTitles() {
    if (announceSilent) return;
    for (let player = 1; player <= 4; player++) {
        titleManager.collectLiveTitles(player, gameState).forEach((title) => {
            gameInfo.addTitleEarned(player, title.name, title.tier);
        });
    }
}

/** 静默补统计期间用：只算称号、不往战报里播报（回放点格子重建时不该冒出播报） */
function setAnnounceSilent(silent) {
    announceSilent = Boolean(silent);
}

// 道具 id → 战报名与统计键；道具使用记录统一从权威事件流生成，
// 面板各自上报的消息不在事件流里，刷新后整段记录都会丢
const ITEM_SKILL_NAMES = { 'remote-dice': '遥控骰子', 'polyhedral-dice': '多面骰子', teleport: '传送门', mysteryBox: '盲盒' };
const ITEM_USAGE_KEYS = { 'remote-dice': 'remoteDice', 'polyhedral-dice': 'polyhedralDice', teleport: 'teleport', mysteryBox: 'mysteryBox' };

function piece(player, chessIndex) {
    return gameState.playerChess[player][chessIndex];
}

function stampLand(chess, position) {
    const instance = window.gameInstance && window.gameInstance.chessPiece;
    chess.lastLandPos = instance
        ? instance.generateUniqueLastLandPos(position)
        : position * 1000 + (Date.now() % 1000);
}

/** 把棋子挪到相对位置并交给 CSS 过渡，不等待过渡结束 */
function stepTo(player, chessIndex, position) {
    const chess = piece(player, chessIndex);
    if (!chess) return;
    chess.position = position;
    stampLand(chess, position);
    animation.updateChessPosition(player, chessIndex, null, true);
}

async function playLaunch(event) {
    const { player, chess, to } = event;
    lastMover = { player, chess };
    // 统计先记：静默重建也要有，否则刷新或回放时这些称号会缺
    gameState.recordTakeoffAttempt(player, true);
    if (silentReplay) {
        gameInfo.addChessMove(player, chess, 'launch', -1, to, true);
        return;
    }
    audioManager.playFlySound();
    animation.bringToFront(player, chess);
    stepTo(player, chess, to);
    gameInfo.addChessMove(player, chess, 'launch', -1, to, true);
    await sleep(STEP_DELAY);
}

async function playWalk(event) {
    const { player, chess, from, to, path, bounced, bounceReason, bounceSteps, blocker } = event;
    lastMover = { player, chess };
    addMoveDistance(player, chess, to - from);
    // 统计先记：静默重建也要有，否则刷新或回放时这些称号会缺
    if (bounced) {
        if (bounceSteps) gameState.recordBounceSteps(player, bounceSteps);
        if (bounceReason === 'stack' && blocker !== null) gameState.recordBlock(blocker);
    }
    if (silentReplay) {
        gameInfo.addChessMove(player, chess, 'move', from, to, true);
        if (bounced && bounceReason === 'stack' && blocker !== null) gameInfo.addStackBlock(player, blocker, true);
        return;
    }
    animation.bringToFront(player, chess);

    for (const step of path) {
        audioManager.playMoveSound();
        stepTo(player, chess, step.rel);
        await sleep(STEP_DELAY);
    }

    gameInfo.addChessMove(player, chess, 'move', from, to, true);
    if (bounced && bounceReason === 'stack' && blocker !== null) gameInfo.addStackBlock(player, blocker, true);
}

async function playJumpLike(event, moveType) {
    const { player, chess, from, to } = event;
    lastMover = { player, chess };
    addMoveDistance(player, chess, to - from);
    if (silentReplay) {
        gameInfo.addChessMove(player, chess, moveType, from, to, true);
        return;
    }
    audioManager.playFlySound();
    animation.bringToFront(player, chess);
    stepTo(player, chess, to);
    gameInfo.addChessMove(player, chess, moveType, from, to, true);
    await sleep(STEP_DELAY + 120);
}

async function playFinish(event) {
    const { player, chess } = event;
    gameState.recordFirstFinished(player);
    if (silentReplay) {
        gameInfo.addChessFinish(player, chess, true);
        return;
    }
    const target = piece(player, chess);
    if (target) target.finished = true;
    gameInfo.addChessFinish(player, chess, true);
    animation.moveChessToFinish(player, chess, true);
    // 到达终点的音效由动画自己收尾时播（和棋子落位同一刻），这里不再重复
    await sleep(FINISH_DELAY);
}

/** 这一击显示出来的积分：按规则该得的分，不扣积分上限的溢出（老事件没有 reward 时退回实际入账值） */
function beatDisplayEnergy(event) {
    return Number.isFinite(event.reward) ? event.reward : (event.energy || 0);
}

/**
 * 击败积分：数值由引擎随事件下发（各端同一个数，回放也不用重算）。
 * 实时路径连积分条与粒子一起演；静默回放只补战报文本，积分由快照对齐。
 */
function grantBeatEnergy(event, { animate = true } = {}) {
    const { player, targetPlayer, chess } = event;
    const energy = beatDisplayEnergy(event);
    if (!energy) return;
    if (animate) {
        energyManager.addEnergy(player, energy, 'kill', targetPlayer, chess, 0, true);
    } else {
        energyManager.addEnergyLine(player, energy, 'kill', targetPlayer, chess);
    }
}

/** 欢乐模式的碰撞：不送人回家，报一行碰撞奖励 + 按敌方棋子数给积分，随后由事件流继续播奖励步数 */
async function playCollisionBonus(event) {
    const { player, targetPlayer, targetChess, energy } = event;
    const targets = Number.isInteger(targetChess) ? targetChess : null;
    // 欢乐模式没有 beat 事件，碰撞按击败计入「第一滴血」
    gameState.recordFirstBeater(player);
    const collided = event.enemyCount || 1;
    moveCollisions.set(player, (moveCollisions.get(player) || 0) + collided);
    if (silentReplay) {
        gameInfo.addCollisionBonus(player, targetPlayer, true);
        // 道具模式下面板会过滤掉上面这行，实时看到的是积分行，静默回放按同一套规则补出来
        if (energy) energyManager.addEnergyLine(player, energy, 'happy_bonus', targetPlayer, targets);
        return;
    }

    audioManager.playBeatSound();
    gameInfo.addCollisionBonus(player, targetPlayer, true);
    if (energy) energyManager.addEnergy(player, energy, 'happy_bonus', targetPlayer, targets, 0, true);
    await sleep(COLLISION_BONUS_DELAY);
}

/** 终点通道：各家的直达格（RUNWAY_BASE 起，每人 10 格）+ 通道中段那格交叉格（CROSS_BASE） */
function isRunwayCell(cell) {
    if (!Number.isInteger(cell)) return false;
    if (cell >= RUNWAY_BASE && cell < RUNWAY_BASE + 40) return true;
    return cell >= CROSS_BASE && cell < CROSS_BASE + 2;
}

async function playBeat(event) {
    const { player, targetPlayer, chess, itemRoll } = event;
    // 遥控骰子的击败没有积分行，面板据此保留这一条（其余击败在道具模式下由积分行代替）
    const isRemoteDiceMove = itemRoll === 'remote-dice';
    gameState.recordFirstBeater(player);
    if (isRunwayCell(event.cell)) gameState.recordRunwayKill(player);
    moveBeats.set(player, (moveBeats.get(player) || 0) + 1);
    if (silentReplay) {
        gameInfo.addChessBeat(player, targetPlayer, chess, true, isRemoteDiceMove, beatDisplayEnergy(event));
        // 道具模式下面板会过滤掉上面这行（改用积分行代替），静默回放要补出同一条，
        // 否则刷新后这一局里所有的击败都不见了
        grantBeatEnergy(event, { animate: false });
        return;
    }
    audioManager.playBeatSound();
    gameInfo.addChessBeat(player, targetPlayer, chess, true, isRemoteDiceMove, beatDisplayEnergy(event));
    // 先缓存被击败棋子的当前屏幕坐标，供随后的积分粒子动画作为起点
    window.gameInstance?.multiplayerGameManager?.cacheDefeatedChessPosition(targetPlayer, chess);
    grantBeatEnergy(event);
    animation.moveChessToStart(targetPlayer, chess, null, true);
}

/**
 * 撞上叠子：双方一起回基地，先把自己撞回去再送走叠子上的人。
 * 积分按叠子上的颗数逐颗结算，粒子各从被撞棋子的位置飞出来。
 */
async function playCollide(event) {
    const { player, targetPlayer, chesses } = event;
    const energy = beatDisplayEnergy(event);
    const victims = chesses;
    gameInfo.addStackCollision(player, targetPlayer, true);
    if (silentReplay) {
        // 回放只补战报文本，积分随快照对齐
        if (energy) energyManager.addEnergyLine(player, energy, 'kill', targetPlayer);
        return;
    }
    await sleep(CRASH_DELAY);

    if (lastMover.player === player && lastMover.chess !== null) {
        animation.moveChessToStart(player, lastMover.chess, null, true);
    }
    victims.forEach((victim) => animation.moveChessToStart(victim.player, victim.index, null, true));

    if (!energy || !victims.length) return;
    const share = Math.floor(energy / victims.length);
    victims.forEach((victim, i) => {
        const amount = i === victims.length - 1 ? energy - share * i : share;
        if (amount > 0) energyManager.addEnergy(player, amount, 'kill', victim.player, victim.index, i * CRASH_ENERGY_DELAY, true);
    });
}

async function playReset(event, diceValue = 0) {
    const { player, pieces } = event;
    gameInfo.addThreeSixesPenalty(player, true);
    if (silentReplay) return;
    // 这段回基地的演出期间别让 AI 接着出手，骰子也不许被别的渲染改成准备态
    gameState.setThreeSixesPenaltyActive?.(true);

    // 惩罚这一刻的 6 定在警告红上，别退回灰骰子
    const diceDisplay = document.getElementById('diceDisplay');
    if (diceDisplay && diceValue > 0 && diceValue <= DICE_SYMBOLS.length) {
        diceDisplay.textContent = DICE_SYMBOLS[diceValue - 1];
        diceDisplay.className = 'dice-icon dice-penalty-warning rolled dice-glowing';
    }

    // 事件里给的是实际回基地的棋子编号（已到终点的不算）
    const moved = pieces;
    if (moved.length) audioManager.playBeatSound();
    moved.forEach((index) => animation.moveChessToStart(player, index, null, true));
    await sleep(FINISH_DELAY);
    gameState.setThreeSixesPenaltyActive?.(false);
}

/** 传送门：起点与落点都是引擎给的，前端只负责淡出淡入 */
/** 传送门：源格与目标格亮一下，让玩家看清传送到哪 */
function highlightTeleportCells(player, from, to) {
    const utils = window.gameInstance && window.gameInstance.utils;
    const svg = document.getElementById('board-svg');
    if (!svg || !utils || typeof utils.getAbsolutePosition !== 'function') return;
    window.gameInstance?.chessPiece?.clearTeleportHighlights?.();
    [from, to].forEach((pos) => {
        if (pos === undefined || pos === null || pos < 0) return;
        const abs = utils.getAbsolutePosition(player, pos);
        if (abs === undefined || abs === null) return;
        // 终点通道每个玩家各一套格子，按玩家过滤；主轨道是共用的
        const sel = abs >= 51 ? `[data-cpos="${abs}"].player-${player}` : `[data-cpos="${abs}"]`;
        svg.querySelectorAll(sel).forEach((el) => el.classList.add('teleport-grid-highlight'));
    });
}

/** 传送波纹扫过的元素顺序：编号格与航道箭头一起，从观察者视角的左上角扫到右下角 */
function teleportWaveElements(board) {
    return Array.from(board.querySelectorAll('use[data-cpos], use[href="#arrow"]'))
        .map((element) => {
            const rect = element.getBoundingClientRect();
            const order = rect.left + rect.width / 2 + (rect.top + rect.height / 2);
            return { element, order };
        })
        .sort((a, b) => a.order - b.order)
        .map((item) => item.element);
}

/**
 * 传送门的聚光：编号格子按斜向逐格清成「无填充」，源格与目标格留着填充，
 * 环道上正在跑的其它棋子隐去。只切类名，棋盘与棋子的位置一概不动。
 */
async function openTeleportVeil(chessElement) {
    const board = document.getElementById('board-svg');
    if (!board || !chessElement) return null;
    board.classList.add('teleport-focus');
    chessElement.classList.add('teleport-spotlight');

    // 逐格清空：按斜向顺序给递增延迟，等波纹扫完再往下演
    let step = 0;
    teleportWaveElements(board).forEach((element) => {
        if (element.classList.contains('teleport-grid-highlight')) return; // 起落两格保持填充
        element.style.transitionDelay = `${step * TELEPORT_WAVE_STEP_MS}ms`;
        step += 1;
        element.classList.add('teleport-void');
    });

    // 环道上正在跑的其它棋子隐去；起点区、终点区停着的原样保留
    const pieceCount = gameState.pieceCount || 4;
    for (let player = 1; player <= 4; player++) {
        const pieces = gameState.playerChess[player];
        if (!pieces) continue;
        for (let i = 0; i < pieceCount; i++) {
            const chess = pieces[i];
            if (!chess || !chess.element || chess.element === chessElement) continue;
            const onBoard = chess.position !== -1 && !chess.finished;
            chess.element.classList.toggle('teleport-dimmed', onBoard);
        }
    }

    // 等波纹铺满（最后一格还要走完自己的过渡）
    await sleep(step * TELEPORT_WAVE_STEP_MS + 200);
    return board;
}

/** 收场：格子用同一道波纹铺回去，棋子与高亮立刻恢复 */
async function closeTeleportVeil(board) {
    if (!board) return;

    board.querySelectorAll('.teleport-dimmed, .teleport-spotlight').forEach((el) => {
        el.classList.remove('teleport-dimmed', 'teleport-spotlight');
    });

    const faded = teleportWaveElements(board).filter((element) => element.classList.contains('teleport-void'));
    if (!faded.length) {
        board.classList.remove('teleport-focus');
        return;
    }

    // 逐格还给本色：同一道斜向波纹再扫回来
    faded.forEach((element, index) => {
        element.style.transitionDelay = `${index * TELEPORT_WAVE_STEP_MS}ms`;
    });
    faded.forEach((element) => element.classList.remove('teleport-void'));

    await sleep(faded.length * TELEPORT_WAVE_STEP_MS + 200);
    faded.forEach((element) => { element.style.transitionDelay = ''; });
    board.classList.remove('teleport-focus');
}

async function playTeleport(event) {
    const { player, chess, from, to } = event;
    lastMover = { player, chess };
    if (silentReplay) {
        gameInfo.addChessMove(player, chess, 'teleport', from, to, true);
        return;
    }
    animation.bringToFront(player, chess);
    gameInfo.addChessMove(player, chess, 'teleport', from, to, true);

    const element = piece(player, chess)?.element;
    // 先把起落两格标记出来（聚光里它们保持填充，其余格子逐格清空），再进聚光
    highlightTeleportCells(player, from, to);
    // openTeleportVeil 内部等到波纹扫完，所以下面直接起飞，中间不再停顿
    const focus = element ? await openTeleportVeil(element) : null;

    try {
        if (element) {
            // 音效跟着这一颗起飞的那一刻响，别提前铺满整段演出
            audioManager.playFlySound();
            element.classList.add('chess-teleport-fade');
            void element.offsetWidth;
            element.style.opacity = '0';
            await sleep(TELEPORT_FADE);

            stepTo(player, chess, to);
            element.style.opacity = '1';
            await sleep(TELEPORT_FADE);

            element.classList.remove('chess-teleport-fade');
        } else {
            audioManager.playFlySound();
            stepTo(player, chess, to);
        }

        await sleep(TELEPORT_HOLD);
        await closeTeleportVeil(focus);
    } finally {
        // 兜底收场（已经收过就是空操作）与格子标记清理
        await closeTeleportVeil(focus);
        window.gameInstance?.chessPiece?.clearTeleportHighlights?.();
    }
}

/** 道具使用的战报与统计，实时与静默回放共用（刷新后战报能重建、各端统计一致） */
/** 道具「使用」这条：只出战报，使用次数等结果那一步再记，避免取消道具也计数 */
function recordItemUsage(item, player, extra = {}) {
    const skillName = ITEM_SKILL_NAMES[item];
    if (!skillName) return;

    gameInfo.addSkillUsage(player, skillName, extra, true, silentReplay);
}

/** 道具「结果」这条（谁用了什么、摇到几点）+ 使用次数与相关统计 */
function recordItemResult(item, player, extra = {}) {
    const skillName = ITEM_SKILL_NAMES[item];
    if (!skillName) return;

    if (extra.diceValue || (item === 'teleport' && Number.isFinite(extra.fromPosition) && Number.isFinite(extra.toPosition))) {
        gameInfo.addSkillResult(player, skillName, extra, true, silentReplay);
    }

    const stats = gameState.titleStats;
    if (stats && stats.skillUseCount[player] !== undefined) {
        stats.skillUseCount[player] += 1;
    }
    const usageKey = ITEM_USAGE_KEYS[item];
    if (usageKey && gameState.skillUsage && gameState.skillUsage[player] && gameState.skillUsage[player][usageKey] !== undefined) {
        gameState.skillUsage[player][usageKey] += 1;
    }

    if (item === 'polyhedral-dice' && stats && Number.isInteger(extra.diceValue)) {
        if (extra.diceValue > (stats.polyhedralMax[player] || 0)) stats.polyhedralMax[player] = extra.diceValue;
        if (extra.diceValue < (stats.polyhedralMin[player] || 99)) stats.polyhedralMin[player] = extra.diceValue;
    }
    if (item === 'teleport' && stats && stats.maxTeleportDistance && Number.isFinite(extra.fromPosition) && Number.isFinite(extra.toPosition)) {
        const distance = Math.abs(extra.toPosition - extra.fromPosition);
        if (distance > (stats.maxTeleportDistance[player] || 0)) stats.maxTeleportDistance[player] = distance;
    }
    if (item === 'mysteryBox' && stats && Number.isInteger(extra.amount)) {
        if (extra.amount > (stats.mysteryBoxMax[player] || 0)) stats.mysteryBoxMax[player] = extra.amount;
        if (extra.amount < (stats.mysteryBoxMin[player] || 99)) stats.mysteryBoxMin[player] = extra.amount;
    }
}

/**
 * 盲盒：图标闪烁 → 开出的点数 → 积分条。
 * 开出多少由引擎摇，各端只有一份数值，刷新回放补出来的战报也一致。
 */
async function playMysteryBox(event) {
    const { player, amount, energy } = event;
    const skillManager = window.gameInstance && window.gameInstance.skillManager;
    // 整段演出期间不许落暂停，否则动画会压在暂停提示上
    skillManager?.markItemSettlement?.(BOX_ICON_DELAY + BOX_REVEAL_DELAY);
    audioManager.playSkillSound?.();

    skillManager?.showMysteryBoxIcon?.(player);
    await sleep(BOX_ICON_DELAY);
    skillManager?.removeMysteryBoxIcon?.(true);

    // 账以快照为准：这里只补一行战报；数值浮动文本显式播，别挂在粒子的回调里
    energyManager.addEnergyLine(player, energy, 'mysteryBox');
    skillManager?.showEnergyGainAnimation?.(amount, player);
    // 开出多少战报里那条「获得 +N积分」所有人看到的是同一句，本机不再另弹提示
    await sleep(BOX_REVEAL_DELAY);
}

/** 抖动一个元素（骰面、数字牌都行）：只加抖动与音效，颜色一概不管 */
function shakeElement(element) {
    if (!element) return;
    void element.offsetWidth; // 强制重排，保证抖动动画每次都重新触发
    element.classList.add('dice-shake');
    setTimeout(() => element.classList.remove('dice-shake'), 500);
    setTimeout(() => audioManager.playShakeSound(), 300);
}

/**
 * 掷骰演出：先闪一段随机点数再定格（与实时掷骰同一套观感）。
 * 定格只写点数，颜色交给调用方的 updateDiceDisplay。
 */
async function playRollAnimation(value) {
    const diceDisplay = document.getElementById('diceDisplay');
    if (!diceDisplay || !value) return;
    audioManager.playRollingSound();
    diceDisplay.className = 'dice-icon';
    void diceDisplay.offsetWidth;
    diceDisplay.classList.add('dice-flashing');
    const flashInterval = setInterval(() => {
        diceDisplay.textContent = DICE_SYMBOLS[Math.floor(Math.random() * DICE_SYMBOLS.length)];
    }, 100);
    await sleep(500);
    clearInterval(flashInterval);
    diceDisplay.classList.remove('dice-flashing');
    diceDisplay.textContent = DICE_SYMBOLS[value - 1] || diceDisplay.textContent;
}

/**
 * 无法移动/被跳过时骰面震动：只摘闪烁与警告红，颜色保持此刻的样子。
 */
function shakeDice(value) {
    const diceDisplay = document.getElementById('diceDisplay');
    if (!diceDisplay) return;
    const resolved = value || gameState.diceValue || 0;
    // 没有点数可定格时不震动
    if (resolved <= 0) return;

    diceDisplay.classList.remove('dice-flashing', 'dice-penalty-warning', 'dice-third-penalty');
    diceDisplay.classList.add('dice-glowing');
    shakeElement(diceDisplay);
    setTimeout(() => diceDisplay.classList.remove('dice-glowing'), 500);
}

async function handleEvent(event, lastDiceValue = 0, lastDiceItem = null) {
    switch (event.type) {
        case 'dice':
            // 实时路径的掷骰战报由快照投影负责，这里只在静默回放时补上，保证两侧战报一致
            // 道具骰的点数并进道具那一条，不再单独出一行
            if (silentReplay && !event.item) gameInfo.addDiceRoll(event.player, event.value, true);
            // 事件里带道具 id 说明是道具骰子，战报与统计据此生成
            if (event.item) recordItemResult(event.item, event.player, { diceValue: event.value });
            gameState.recordRollStreak(event.player, event.value, Boolean(event.item));
            gameState.recordTurnStart(event.player);
            break;
        case 'launch':
            gameState.recordLaunch(event.player, event.chess);
            await playLaunch(event);
            break;
        case 'walk':
            currentMoveChess = { player: event.player, chess: event.chess };
            gameState.recordAirportStep(event.player, event.chess, event.from);
            await playWalk(event);
            break;
        case 'jump':
            currentMoveChess = { player: event.player, chess: event.chess };
            await playJumpLike(event, 'jump');
            break;
        case 'fly':
            currentMoveChess = { player: event.player, chess: event.chess };
            await playJumpLike(event, 'fly');
            break;
        case 'finish':
            await playFinish(event);
            break;
        case 'beat':
            gameState.recordRevengeKill(event.player, event.targetPlayer, event.chess);
            if (currentMoveChess && currentMoveChess.player === event.player) {
                gameState.recordOrioleKill(event.player, event.targetPlayer, event.chess);
                gameState.recordBeatenBy(event.targetPlayer, event.player, currentMoveChess.chess);
                gameState.recordKill(event.player, currentMoveChess.chess, event.targetPlayer);
            }
            gameState.recordBeatenHome(event.targetPlayer, event.chess);
            await playBeat(event);
            break;
        case 'collision_bonus':
            await playCollisionBonus(event);
            break;
        case 'collide':
            await playCollide(event);
            break;
        case 'blocked':
            if (Number.isInteger(event.targetPlayer)) gameState.recordBlock(event.targetPlayer);
            gameInfo.addStackBlock(event.player, event.targetPlayer, true);
            break;
        case 'stack':
            gameInfo.addStackFormation(event.player, true);
            break;
        case 'reset':
            await playReset(event, lastDiceValue);
            break;
        case 'teleport':
            recordItemResult('teleport', event.player, {
                fromPosition: event.from,
                toPosition: event.to
            });
            if (event.to - event.from === 1) gameState.recordPettyTeleport(event.player);
            gameState.recordAirportStep(event.player, event.chess, event.from);
            await playTeleport(event);
            break;
        case 'skip':
            if (silentReplay) {
                gameInfo.addNoMovableChess(event.player, event.value || lastDiceValue, true);
                break;
            }
            gameState.recordTakeoffAttempt(event.player, false);
            gameInfo.addNoMovableChess(event.player, event.value || lastDiceValue, true);
            // 抖动必须发生在骰子定格之后，这里只登记，由快照落地后统一触发
            pendingShake = { player: event.player, value: event.value || lastDiceValue, item: lastDiceItem };
            break;
        case 'pass':
            // pass 事件不带点数，沿用同一批事件里最近一次掷骰的点数
            gameInfo.addNoMovableChess(event.player, lastDiceValue, true);
            if (!silentReplay) pendingShake = { player: event.player, value: lastDiceValue, item: lastDiceItem };
            break;
        case 'item_activate':
            // 道具是服务端出手的（AI/托管），声音得由事件流补上
            if (!silentReplay) audioManager.playSkillSound?.();
            recordItemUsage(event.item, event.player);
            break;
        case 'mystery_box': {
            const { player, amount, energy } = event;
            // 开盒放弃本回合，使用次数与开出的点数都从这一个事件记（回放也能重建）
            recordItemUsage('mysteryBox', player);
            recordItemResult('mysteryBox', player, { amount });
            if (silentReplay) {
                if (energy > 0) energyManager.addEnergyLine(player, energy, 'mysteryBox');
                break;
            }
            await playMysteryBox(event);
            break;
        }
        case 'end':
            if (!silentReplay) audioManager.playGameOverSound();
            gameInfo.addPlayerWin(event.winner, true);
            break;
        case 'reroll':
            // 6 点连投奖励：走完这一手还归他（实时与刷新回放都从这里出）
            gameState.markReroll(event.player);
            gameInfo.addConsecutiveBonus(event.player, true);
            break;
        default:
            break;
    }
}

async function play(events) {
    if (!events || events.length === 0) return null;
    pendingShake = null;
    currentMoveChess = null;
    moveDistances = new Map();
    moveBeats = new Map();
    moveCollisions = new Map();
    // skip / pass 事件自身不带点数与道具，沿用同一批事件里最近一次掷骰的
    let lastDiceValue = 0;
    let lastDiceItem = null;
    for (const event of events) {
        if (event.type === 'dice' && event.value > 0) {
            lastDiceValue = event.value;
            lastDiceItem = event.item || null;
        }
        await handleEvent(event, lastDiceValue, lastDiceItem);
    }
    flushMoveDistances();
    announceLiveTitles();
    return pendingShake;
}

/**
 * 抖动演出：多面骰抖那张数字牌（等它亮出点数再抖），其余抖中央的骰面。颜色一概不管。
 */
async function playDiceShake(shake) {
    if (!shake || !shake.value) return;

    if (shake.item === 'polyhedral-dice') {
        // 数字牌还在滚 / 刚亮出点数：等它演完再抖它自己
        const revealUntil = (window.gameInstance && window.gameInstance.skillManager
            && window.gameInstance.skillManager._polyhedralRevealUntil) || 0;
        const wait = revealUntil - Date.now();
        if (wait > 0) await sleep(wait);
        shakeElement(document.getElementById('polyhedralDiceDisplay'));
        await sleep(500);
        return;
    }

    if (shake.value > DICE_SYMBOLS.length) return; // 7-12 没有骰面可定格
    const diceDisplay = document.getElementById('diceDisplay');
    // 遥控骰子掷出的结果保留青色骰面：回合结束时快照里的 diceItem 会被清掉，样式不能只靠它
    if (diceDisplay) diceDisplay.classList.toggle('remote-dice', shake.item === 'remote-dice');
    shakeDice(shake.value);
    await sleep(500);
}

/**
 * 静默回放事件流：只把右侧面板的战报文本重建出来，不演动画、不弹通知。
 * 与 play 共用同一套事件翻译，保证刷新前后看到的战报完全一致；
 * 积分不在这里结算——它随快照下发，本地只负责把它显示出来。
 */
async function replay(events) {
    if (!events || events.length === 0) return;
    silentReplay = true;
    currentMoveChess = null;
    moveDistances = new Map();
    moveBeats = new Map();
    moveCollisions = new Map();
    gameInfo.setSilentMode?.(true);
    try {
        let lastDiceValue = 0;
        let lastDiceItem = null;
        for (const event of events) {
            if (event.type === 'dice' && event.value > 0) {
                lastDiceValue = event.value;
                lastDiceItem = event.item || null;
            }
            await handleEvent(event, lastDiceValue, lastDiceItem);
        }
        // 称号结算放在静默窗口里：补出来的称号要进战报，但不该当成刚拿到的弹一遍
        flushMoveDistances();
        announceLiveTitles();
    } finally {
        silentReplay = false;
        gameInfo.setSilentMode?.(false);
    }
}

export const enginePlayback = { play, replay, playDiceShake, playRollAnimation, announceLiveTitles, setAnnounceSilent, recordItemUsage };
export default enginePlayback;
