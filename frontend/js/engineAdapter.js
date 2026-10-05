/**
 * 引擎适配层
 *
 * 单机模式不再由前端自行推导规则，而是复用 shared/engine.mjs 里的纯函数引擎。
 * 本模块只负责「引擎状态 ↔ 前端 gameState」的搬运，不触碰 DOM。
 */
import { encodeReplayAction } from '../../shared/replayCodec.mjs';
import { saveLocalGame, flushLocalGame, clearCurrentLocalGame, currentGameMode } from './replayShare.js';
import { gameState } from './gameState.js';
import {
    apply,
    preview,
    createState,
    movableChess,
    emptyDefeatMatrix,
    countBeats,
    toSnapshot,
    isJumpRel,
    makeRng,
    ENGINE_VERSION,
    PLAYERS,
    BASE,
    LAUNCH,
    TRACK_END
} from '../../shared/engine.mjs';

export { BASE, LAUNCH, TRACK_END, PLAYERS, isJumpRel };

const PHASE_TO_UI = {
    rolling: 'rolling',
    selecting: 'selecting',
    ended: 'finished'
};

function collectClientState() {
    if (!gameState) return null;
    return {
        titleStats: gameState.titleStats || null,
        announcedTitles: gameState.announcedTitles ? [...gameState.announcedTitles] : null,
        diceStatistics: gameState.diceStatistics || null,
        progressHistory: gameState.progressHistory || null,
        gameStartTime: gameState.gameStartTime || null,
        playedMs: gameState.snapshotPlayedMs ? gameState.snapshotPlayedMs() : 0,
        gameConfig: sessionStorage.getItem('gameConfig'),
        totalEnergyGained: gameState.totalEnergyGained || null,
        skillUsage: gameState.skillUsage || null
    };
}

function restoreClientState(client) {
    if (!gameState || !client) return;
    if (client.titleStats) Object.assign(gameState.titleStats, client.titleStats);
    if (Array.isArray(client.announcedTitles)) gameState.announcedTitles = new Map(client.announcedTitles);
    if (client.diceStatistics) gameState.diceStatistics = client.diceStatistics;
    if (Array.isArray(client.progressHistory)) gameState.progressHistory = client.progressHistory;
    if (client.gameStartTime) gameState.gameStartTime = client.gameStartTime;
    gameState.playedMs = Number(client.playedMs) || 0;
    gameState.playResumedAt = Date.now();
    if (client.gameConfig) {
        try {
            sessionStorage.setItem('gameConfig', client.gameConfig);
        } catch (error) { }
    }
    if (client.totalEnergyGained) gameState.totalEnergyGained = client.totalEnergyGained;
    if (client.skillUsage) gameState.skillUsage = client.skillUsage;
}

class EngineAdapter {
    constructor() {
        this.state = null;
        this.defeatCounts = null;
    }

    get ready() {
        return this.state !== null;
    }

    get happy() {
        return Boolean(this.state && this.state.happy);
    }

    /** 开新局：完全由引擎重建初始状态 */
    reset({ players = PLAYERS, piecesPerPlayer = 4, happy = false, skillMode = false, startEnergy = 0, currentPlayer = null } = {}) {
        this.state = createState({ players, piecesPerPlayer, happy, skillMode, startEnergy });
        this.defeatCounts = emptyDefeatMatrix(players);
        // 单机也要能回放：一局一颗种子，动作按序留档（和联机的服务端档案同一套口径）
        this.seed = Math.floor(Math.random() * 0xffffffff);
        this.rng = makeRng(this.seed);
        this.actions = [];
        if (currentPlayer !== null && this.state.order.includes(currentPlayer)) {
            this.state.currentIndex = this.state.order.indexOf(currentPlayer);
            this.state.currentPlayer = currentPlayer;
        }
        return this.state;
    }

    /** 读档 / 接管现有棋面：按前端已有位置重建引擎状态 */
    hydrate({ playerChess, currentPlayer = 1, happy = false, skillMode = false, players = PLAYERS } = {}) {
        const sample = playerChess && playerChess[players[0]];
        const piecesPerPlayer = sample ? sample.length : 4;
        this.reset({ players, piecesPerPlayer, happy, skillMode });

        for (const id of players) {
            const source = playerChess[id] || [];
            this.state.players[id].chesses.forEach((chess, index) => {
                const item = source[index];
                if (!item) return;
                chess.pos = item.position;
                chess.finished = Boolean(item.finished);
            });
        }

        if (players.includes(currentPlayer)) {
            this.state.currentIndex = players.indexOf(currentPlayer);
            this.state.currentPlayer = currentPlayer;
        }
        this.state.phase = 'rolling';
        return this.state;
    }

    /**
     * 联机：服务端全量快照 → 本地引擎状态。
     * 客户端在联机模式下不跑规则，这里只做「快照落位」，随后由 projectTo 投影到 gameState。
     */
    applySnapshot(snapshot) {
        if (!snapshot || !snapshot.playerChess) return null;
        const players = Object.keys(snapshot.playerChess)
            .map(Number)
            .sort((a, b) => a - b);

        this.hydrate({
            playerChess: snapshot.playerChess,
            currentPlayer: snapshot.currentPlayer,
            happy: Boolean(snapshot.happyMode),
            skillMode: Boolean(snapshot.skillMode),
            players
        });

        const state = this.state;
        state.phase = snapshot.gamePhase === 'finished' ? 'ended' : (snapshot.gamePhase || 'rolling');
        state.dice = snapshot.diceValue > 0 ? snapshot.diceValue : null;
        // 积分是服务端算的：快照里带什么就是什么，本地不再自己记账
        if (snapshot.energy) {
            for (const id of state.order) {
                state.energy[id] = snapshot.energy[id] || 0;
            }
        }
        // 已激活未落地的道具：激活者就是当前回合玩家
        state.pendingItem = snapshot.pendingItem
            ? { player: snapshot.currentPlayer, item: snapshot.pendingItem }
            : null;
        // 点数来源道具（false 为普通骰子），刷新时据此还原道具专属骰面
        state.diceItem = snapshot.diceItem || false;
        state.consecutiveSixes = snapshot.consecutiveSixes || 0;
        state.winner = snapshot.winner === undefined ? null : snapshot.winner;

        if (snapshot.totalDistance) {
            for (const id of state.order) {
                if (snapshot.totalDistance[id] !== undefined) {
                    state.players[id].totalDistance = snapshot.totalDistance[id];
                }
            }
        }
        if (snapshot.defeatCounts) {
            this.defeatCounts = snapshot.defeatCounts;
        }
        return state;
    }

    /** 当前玩家在给定点数下可动的棋子索引 */
    movable(dice = this.state && this.state.dice) {
        if (!this.state || dice === null || dice === undefined) return [];
        return movableChess(this.state, this.state.currentPlayer, dice);
    }

    /**
     * 指定玩家在给定点数下可动的棋子索引，不改变棋面。
     * AI 会传假想点数，UI 高亮与选子校验也走这里，可动规则只有引擎一份。
     */
    movableFor(dice, playerId = null) {
        if (!this.state || dice === null || dice === undefined) return [];
        const player = playerId === null ? this.state.currentPlayer : playerId;
        return movableChess(this.state, player, dice);
    }

    roll(value, options = {}) {
        return this._apply({ type: 'roll', value, ...options });
    }

    /**
     * 道具骰子：点数由道具给定，且不参与连投奖励与三次 6 计数。
     * item 记录来源道具，与联机的服务端校验保持一致。
     */
    itemRoll(value, maxDice, item = null) {
        return this._apply({ type: 'roll', value, maxDice, noBonus: true, item });
    }

    move(chessIndex) {
        return this._apply({ type: 'move', chessIndex });
    }

    /**
     * 联机本地抢先演一手：按本地权威状态推演出这一手并直接接管，
     * 不记动作流也不落档——随后到达的权威快照会整体覆盖它。
     */
    previewAndAdopt(action) {
        if (!this.ready) return null;
        const result = preview(this.state, this.state.currentPlayer, action);
        if (!result.ok) return null;
        this.state = result.state;
        countBeats(this.defeatCounts, result.events);
        return result;
    }

    /** 买下道具：扣积分并记下激活态（选点/选子由后续动作消费） */
    activateItem(item) {
        return this._apply({ type: 'item', item });
    }

    /** 取消已激活的道具：引擎把预扣的积分退回 */
    cancelItem() {
        return this._apply({ type: 'item', item: null });
    }

    /** 调试：前后挪棋子（不判规则），只用于摆局面 */
    debugMove(player, chessIndex, delta) {
        return this._apply({ type: 'debug', op: 'move', player, chessIndex, delta });
    }

    /** 调试：把当前玩家的棋子全部送到终点 */
    debugFinish() {
        return this._apply({ type: 'debug', op: 'finish' });
    }

    /** 调试：直接设定某位玩家的积分 */
    debugSetEnergy(player, value) {
        return this._apply({ type: 'debug', op: 'energy', player, value });
    }

    teleport(chessIndex) {
        return this._apply({ type: 'teleport', chessIndex });
    }

    skip(reason = null) {
        return this._apply({ type: 'skip', reason });
    }

    snapshot(options) {
        return toSnapshot(this.state, options);
    }

    /**
     * 预览一步移动的结算结果，不改动真实棋面。
     * AI 推演要试不同点数，因此允许传假想的骰子值；规则判定与真实执行同源。
     * 动作非法（不可移动、阶段不符）时返回 null。
     */
    previewMove(chessIndex, { dice = null, playerId = null } = {}) {
        if (!this.ready) return null;
        const player = playerId === null ? this.state.currentPlayer : playerId;
        const result = preview(this.state, player, { type: 'move', chessIndex }, { dice });
        return result.ok ? result : null;
    }

    _apply(action) {
        const actor = this.state.currentPlayer;
        const { state, events } = apply(this.state, actor, action, this.rng);
        this.state = state;
        this.actions.push([actor, ...encodeReplayAction(action)]);
        countBeats(this.defeatCounts, events);
        if (state.phase === 'ended') {
            clearCurrentLocalGame();
        } else {
            this.saveSnapshot();
        }
        return { state, events };
    }

    /** 回放：按档案的开局配置与种子重建，动作不入档、也不投影，交给调用方逐步驱动 */
    restoreReplay(archive) {
        this.state = createState({
            players: archive.colors,
            piecesPerPlayer: archive.pieceCount || 4,
            happy: Boolean(archive.happy),
            skillMode: Boolean(archive.skillMode),
            startEnergy: Number(archive.startEnergy) || 0
        });
        this.defeatCounts = emptyDefeatMatrix(archive.colors);
        this.seed = archive.seed;
        this.rng = makeRng(archive.seed);
        this.actions = [];
        return this.state;
    }

    /** 回放专用：指定玩家执行一手，只推进状态并返回事件，不记档 */
    applyReplayAction(player, action) {
        const { state, events } = apply(this.state, player, action, this.rng);
        this.state = state;
        countBeats(this.defeatCounts, events);
        return { state, events };
    }

    saveSnapshot({ force = false } = {}) {
        // 已经收场（自然终局，或手动结算把前端阶段置成 finished）就别再落档，
        // 否则离开页面时那次补写会把刚清掉的存档又写回来
        if (!this.state || this.state.phase === 'ended' || gameState.getGamePhase?.() === 'finished') return;
        const payload = {
            state: this.state,
            defeats: this.defeatCounts,
            seed: this.seed,
            rngState: this.rng.current ? this.rng.current() : null,
            actions: this.actions,
            client: collectClientState(),
            savedAt: Date.now()
        };
        if (force) flushLocalGame(payload);
        else saveLocalGame(payload);
    }

    /** 续局：直接接管一份保存下来的局面（不重放动作） */
    adoptState(state, { defeats = null, seed = null, rngState = null, actions = [], client = null } = {}) {
        this.state = state;
        this.defeatCounts = defeats || emptyDefeatMatrix(state.order);
        this.seed = Number.isInteger(seed) ? seed : Math.floor(Math.random() * 0xffffffff);
        this.rng = makeRng(this.seed, rngState);
        this.actions = Array.isArray(actions) ? actions : [];
        this.pendingClientState = client || null;
        restoreClientState(client);
        return this.state;
    }

    /** 续局收尾：流程起来后再套一次客户端状态 */
    reapplyClientState() {
        if (!this.pendingClientState) return false;
        restoreClientState(this.pendingClientState);
        return true;
    }

    /** 单机整局档案：种子 + 动作流，够回放用（联机那份由服务端会话产出，字段一致） */
    getReplay(players = []) {
        if (!this.state) return null;
        return {
            format: 1,
            engineVersion: ENGINE_VERSION,
            // 下载文件名要用它区分人机 / 本地，存档里带一份
            mode: currentGameMode() || '',
            seed: this.seed,
            colors: [...this.state.order],
            pieceCount: this.state.players[this.state.order[0]].chesses.length,
            happy: this.state.happy ? 1 : 0,
            skillMode: this.state.skillMode ? 1 : 0,
            startEnergy: gameState.getInitialEnergy ? gameState.getInitialEnergy() : 0,
            players: (players || []).map((p) => [p.color, p.nickname, p.isAI ? 1 : 0, p.emoji || '']),
            actionCount: this.actions.length,
            actions: this.actions,
            finished: this.state.phase === 'ended' ? 1 : 0,
            winner: this.state.winner || 0,
            turn: this.state.turn || 0
        };
    }

    /**
     * 引擎 → 视图：把权威状态整体投影到 gameState。
     * 前端此后的任何读取（渲染、高亮、进度条）都以投影结果为准。
     */
    projectTo(gameState) {
        const state = this.state;
        if (!state) return;

        // 走 setter 而不是直接赋值：回合切换的彩色控制台日志挂在 setter 上，
        // 直接写字段会把它整段跳过
        if (typeof gameState.setCurrentPlayer === 'function') {
            gameState.setCurrentPlayer(state.currentPlayer);
        } else {
            gameState.currentPlayer = state.currentPlayer;
        }
        // 暂停期间保留 UI 的暂停阶段，避免被引擎阶段覆盖；
        // 否则恢复时 gameBase.resumeGame 会因为阶段不是 paused 而不再重启进度条
        if (typeof gameState.getIsPaused !== 'function' || !gameState.getIsPaused()) {
            gameState.gamePhase = PHASE_TO_UI[state.phase] || state.phase;
        }
        gameState.diceValue = state.dice === null ? 0 : state.dice;
        gameState.consecutiveSixes = state.consecutiveSixes;
        gameState.winner = state.winner;

        for (const id of state.order) {
            const player = state.players[id];
            player.chesses.forEach((chess, index) => {
                const target = gameState.playerChess[id][index];
                if (!target) return;
                target.position = chess.pos;
                target.finished = chess.finished;
            });
            if (gameState.totalDistance) {
                gameState.totalDistance[id] = player.totalDistance;
            }
            if (gameState.defeatCounts && gameState.defeatCounts[id]) {
                for (const other of state.order) {
                    if (other === id) continue;
                    if (gameState.defeatCounts[id][other] === undefined) continue;
                    gameState.defeatCounts[id][other] = this.defeatCounts[id][other];
                }
            }
        }
    }
}

export const engineAdapter = new EngineAdapter();
export { EngineAdapter };
export default engineAdapter;
