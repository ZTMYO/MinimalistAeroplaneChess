/** 对局回放页入口：复用整套渲染（棋盘 / 棋子 / 战报 / 消息）只读播放，走子来自档案里的动作流 */
import { gameState } from './gameState.js';
import { gameInfo } from './gameInfo.js';
import { titleManager } from './titleManager.js';
import { eventHandler } from './eventHandler.js';
import { uiUpdater } from './uiUpdater.js';
import { audioManager } from './audioManager.js';
import { energyManager } from './energyManager.js';
import { energyDisplay } from './energyDisplay.js';
import { engineAdapter } from './engineAdapter.js';
import { enginePlayback } from './enginePlayback.js';
import { activePlayerManager } from './activePlayerManager.js';
import { decodeArchive, decodeReplayAction, encodeArchive } from '../../shared/replayCodec.mjs';
import { readStashedReplay, readRecentReplay, importReplayFile, replayFileName } from './replayShare.js';
import { FlyingChessGameBase, createGameRuntime } from './gameBase.js';
import { defaultEmoji } from '../assets/emojis.js';
import { resetTitlesViews } from './titlesGallery.js';
import './titlesHoverCard.js';
import './theme.js';

// 同一回合里两手之间只留一小拍（掷骰 → 走子要连着演），换人时停一拍
const STEP_GAP_MS = 160;
const TURN_GAP_MS = 700;
// 与引擎的击败统计同一口径：普通击败、欢乐模式的碰撞奖励、撞叠子
const KILL_EVENTS = new Set(['beat', 'collision_bonus', 'collide']);
// 用道具留下的节点：激活道具、开盲盒
const ITEM_EVENTS = new Set(['item_activate', 'mystery_box']);
const PLAY_ICON = '<svg viewBox="190 80 715 860" width="15" height="15" fill="currentColor"><path d="M213.333333 896V128a42.666667 42.666667 0 0 1 65.706667-35.882667l597.333333 384a42.666667 42.666667 0 0 1 0 71.765334l-597.333333 384A42.666667 42.666667 0 0 1 213.333333 896z m85.333334-78.165333L774.4 512 298.666667 206.165333v611.669334z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 683 840" width="15" height="15" fill="currentColor"><path d="M0 0H256V840H0zM85.333 85.333V754.667H170.667V85.333zM426.667 0H682.667V840H426.667zM512 85.333V754.667H597.333V85.333z"/></svg>';

const dom = {
    track: document.getElementById('replayTrack'),
    prev: document.getElementById('replayPrev'),
    play: document.getElementById('replayPlay'),
    next: document.getElementById('replayNext'),
    step: document.getElementById('replayStep'),
    download: document.getElementById('replayDownload'),
    file: document.getElementById('replayFileInput'),
    handle: document.getElementById('replayBarHandle'),
    hide: document.getElementById('replayBarHide'),
    import: document.getElementById('replayImport'),
    markToggle: document.getElementById('replayMarkToggle'),
};

const view = {
    archive: null, cells: [], cursor: 0, timer: null, playing: false, run: 0, seek: 0,
    markMode: 'kill', marks: { kill: new Set(), title: new Set(), item: new Set() }, source: null, game: null, pristine: null
};

/* 档案规范化：raw {p,a} 与 packed 元组都接受，读不出来的那一手直接丢掉 */
function normalizeArchive(archive) {
    if (!archive || !Array.isArray(archive.actions)) return null;
    const actions = archive.actions.map((item) => {
        if (!Array.isArray(item)) return item;
        return { p: item[0], a: decodeReplayAction(item.slice(1)) };
    }).filter((item) => item && item.p !== undefined && item.a && typeof item.a.type === 'string');
    return { ...archive, actions, actionCount: actions.length };
}

/* ------------------------------ 档案 ------------------------------ */

async function loadArchive() {
    const params = new URLSearchParams(location.search);
    const sessionId = params.get('id');
    if (sessionId) {
        const response = await fetch(`/api/replay/${encodeURIComponent(sessionId)}`);
        if (!response.ok) {
            console.warn('[回放] 这局对局结束太久，档案已经回收');
            return null;
        }
        view.source = { type: 'server', sessionId };
        return normalizeArchive(decodeArchive(await response.json()));
    }
    // 面板里「最近对局」点进来的：档案就在本地存的最近列表里
    const stored = readRecentReplay(params.get('recent'));
    if (stored) {
        view.source = { type: 'recent' };
        return normalizeArchive(decodeArchive(stored));
    }
    const stashed = readStashedReplay();
    if (stashed) {
        view.source = { type: params.get('imported') ? 'imported' : 'local' };
        return normalizeArchive(decodeArchive(stashed));
    }
    return null;
}

/* 把档案里的开局配置写成首页那套 gameConfig，随后的初始化就按本地多人走 */
function writeGameConfig(archive) {
    sessionStorage.setItem('gameConfig', JSON.stringify({
        mode: 'local_multiplayer',
        playerCount: archive.colors.length,
        pieceCount: archive.pieceCount || 4,
        skillMode: Boolean(archive.skillMode),
        happyMode: Boolean(archive.happy),
        players: (archive.players || []).map((player) => ({
            playerNumber: player.color,
            nickname: player.nickname,
            isAI: Boolean(player.isAI)
        }))
    }));
    sessionStorage.removeItem('multiplayerGameData');
}

const MARK_MODES = { kill: '击败', title: '称号', item: '道具' };

/* 切换标记模式：按钮文字与颜色跟着走（道具模式专属的「道具」只在道具局里转得到） */
function applyMarkMode(mode) {
    view.markMode = MARK_MODES[mode] ? mode : 'kill';
    if (dom.markToggle) {
        dom.markToggle.textContent = MARK_MODES[view.markMode];
        dom.markToggle.classList.toggle('is-title', view.markMode === 'title');
        dom.markToggle.classList.toggle('is-item', view.markMode === 'item');
    }
    renderTrack();
    updateBar();
}

/* 按当前标记模式画进度条：段填到哪儿就是这一回合走到第几手，
   标记段（击败 / 称号达成 / 道具使用）单独上色 */
function renderTrack() {
    if (!dom.track) return;
    const marks = view.marks[view.markMode] || view.marks.kill;
    dom.track.classList.toggle('mode-title', view.markMode === 'title');
    dom.track.classList.toggle('mode-item', view.markMode === 'item');
    dom.track.innerHTML = view.cells.map((cell) => {
        const title = `第 ${cell.round + 1} 回合（第 ${cell.start}-${cell.end} 手）`;
        const hands = [];
        for (let step = cell.start; step <= cell.end; step += 1) {
            hands.push(`<i class="replay-hand${marks.has(step) ? ' is-mark' : ''}"></i>`);
        }
        // 落点是这一回合的前一手：看到的应是上一回合收完、骰子还没掷的局面
        return `<span class="replay-cell" data-step="${cell.start - 1}" title="${title}">${hands.join('')}</span>`;
    }).join('') + '<span class="replay-cell is-final" data-end="1" title="查看结算">结算</span>';
}

/* 预演一遍：把整局按回合切成格子，同时收两类节点——击败与称号达成。
   称号统计只有走真实回放通道（逐手喂事件）才记得下来，所以这里用适配层走一遍 */
async function buildTrack(archive) {
    const players = archive.colors.length || 1;
    view.cells = [];
    view.marks = { kill: new Set(), title: new Set(), item: new Set() };

    engineAdapter.restoreReplay(archive);
    gameState.titleStats = structuredClone(view.pristine.titleStats);
    gameState.diceStatistics = structuredClone(view.pristine.diceStatistics);
    const announced = gameState.announcedTitles;
    gameState.announcedTitles = new Map();
    gameInfo.clearMessages?.();

    enginePlayback.setAnnounceSilent?.(true);
    try {
        for (let index = 0; index < archive.actions.length; index += 1) {
            const item = archive.actions[index];
            const step = index + 1;
            // 引擎的 turn 是"第几个人走"，除人数就是第几轮；6 点连投不涨，仍算同一回合
            const round = Math.floor(engineAdapter.state.turn / players);
            const cell = view.cells[view.cells.length - 1];
            if (!cell || cell.round !== round) {
                view.cells.push({ round, start: step, end: step });
            } else {
                cell.end = step;
            }

            try {
                const out = engineAdapter.applyReplayAction(item.p, item.a);
                if (out.events.some((event) => KILL_EVENTS.has(event.type))) view.marks.kill.add(step);
                if (out.events.some((event) => ITEM_EVENTS.has(event.type))) view.marks.item.add(step);
                await enginePlayback.replay(out.events);
                if (markAnnounced()) view.marks.title.add(step);
            } catch (error) {
                console.warn('[回放] 预演在第 ' + step + ' 手停住：', error.message);
                break;
            }
        }
    } finally {
        enginePlayback.setAnnounceSilent?.(false);
        gameState.announcedTitles = announced;
    }

    renderTrack();
}

/* 这一手有没有人新拿到称号：collectLiveTitles 只报没播报过的，顺手就会登记掉。
   重建时每手都调它，登记表就只留「重跑到的那一手之前」已经拿过的称号 */
function markAnnounced() {
    for (let player = 1; player <= 4; player += 1) {
        if (titleManager.collectLiveTitles(player, gameState).length) return true;
    }
    return false;
}

/* ------------------------------ 播放 ------------------------------ */

function stopPlay() {
    view.run += 1; // 换代号：还卡在等待里的那一轮循环就此作废，不能跟新一轮并排跑
    view.playing = false;
    if (view.timer) clearTimeout(view.timer);
    view.timer = null;
    if (dom.play) dom.play.innerHTML = PLAY_ICON;
}

function sleep(ms) {
    return new Promise((resolve) => {
        view.timer = setTimeout(resolve, ms);
    });
}

/* 一手放完（棋子到位、战报播完）才掷下一手：定时器改成串行的等待 */
async function startPlay() {
    if (!view.archive) {
        dom.file?.click();
        return;
    }
    if (view.playing) return stopPlay();
    if (view.cursor >= view.archive.actions.length) return;
    view.playing = true;
    const run = ++view.run;
    if (dom.play) dom.play.innerHTML = PAUSE_ICON;

    while (view.playing && run === view.run && view.cursor < view.archive.actions.length) {
        const turnEnded = await stepForward();
        if (!view.playing || run !== view.run) return;
        await sleep(turnEnded ? TURN_GAP_MS : STEP_GAP_MS);
    }
    const reachedEnd = view.cursor >= view.archive.actions.length;
    if (run === view.run) stopPlay();
    // 整局放完就和解算弹一套结算，中途被打断则不弹
    if (reachedEnd && run + 1 === view.run) showSettlement();
}

/* 走一手：引擎算 → 演出（棋子移动、战报、消息都在这条链上） → 刷界面 */
async function stepForward() {
    if (!view.archive || view.cursor >= view.archive.actions.length) return;
    const item = view.archive.actions[view.cursor];
    view.cursor += 1;
    updateBar();

    try {
        const { events } = engineAdapter.applyReplayAction(item.p, item.a);

        // 掷骰：闪一段再定格（点数取事件里的，不重新摇）
        const diceEvent = (events || []).find((event) => event.type === 'dice' && event.value);
        if (diceEvent) {
            if (diceEvent.item === 'polyhedral-dice') {
                window.gameInstance?.skillManager?.showPolyhedralDice?.(diceEvent.value);
            } else {
                await enginePlayback.playRollAnimation?.(diceEvent.value);
                const diceDisplay = document.getElementById('diceDisplay');
                if (diceDisplay) diceDisplay.classList.toggle('remote-dice', diceEvent.item === 'remote-dice');
            }
            uiUpdater.updateDiceDisplay?.(diceEvent.value, diceEvent.player);
        }

        // 无子可动的抖动由事件流给（只有 skip / pass 才带），不是每掷一次都抖
        const shake = events && events.length ? await enginePlayback.play(events) : null;
        if (shake) await enginePlayback.playDiceShake?.(shake);
        engineAdapter.projectTo(gameState);
        uiUpdater.updateUI();
        return (events || []).some((event) => event.type === 'turn');
    } catch (error) {
        console.error('[回放] 这一手播不了:', error);
        stopPlay();
        return false;
    }
}

/* 从开局逐手静默重放到第 target 手：棋面、战报、称号统计一起回到那一刻。
   跳着看时统计不能就地累加，只能从干净底子重跑一遍（每手一批，和实时对局同口径） */
async function replayTo(target) {
    if (!view.archive || !view.pristine) return;
    const token = ++view.seek;

    engineAdapter.restoreReplay(view.archive);
    // 终点勾号是直接换 SVG 图案（href=#checkmark）画的，回到从前必须换回来
    document.querySelectorAll('#board-svg use[href="#checkmark"]').forEach((element) => element.setAttribute('href', '#chess'));
    gameInfo.clearMessages?.();
    gameState.titleStats = structuredClone(view.pristine.titleStats);
    gameState.diceStatistics = structuredClone(view.pristine.diceStatistics);
    // 已播报登记表从空开始，随重跑补齐：倒回重看时，后面的称号才会再弹一次
    gameState.announcedTitles = new Map();
    gameState.clearProgressHistory?.();

    const players = view.archive.colors.length || 1;
    let round = 0;
    view.cursor = 0;
    enginePlayback.setAnnounceSilent?.(true);
    try {
        while (view.cursor < target && token === view.seek) {
            const item = view.archive.actions[view.cursor];
            view.cursor += 1;
            const out = engineAdapter.applyReplayAction(item.p, item.a);
            // 一手一批：单次移动类的统计靠批次清零，整局拼一起会把「单次」算成全场累计
            await enginePlayback.replay(out.events);
            markAnnounced();
            for (const event of out.events) {
                const diceStats = gameState.diceStatistics?.[event.player];
                if (event.type === 'dice' && diceStats && diceStats[event.value] !== undefined) diceStats[event.value] += 1;
            }
            engineAdapter.projectTo(gameState);
            const currentRound = Math.floor(engineAdapter.state.turn / players);
            if (currentRound !== round) {
                round = currentRound;
                gameState.currentRound = currentRound;
                gameState.saveProgressSnapshot?.();
            }
        }
    } finally {
        enginePlayback.setAnnounceSilent?.(false);
    }
    if (token !== view.seek) return; // 重跑期间又跳了一次，这一趟作废

    engineAdapter.projectTo(gameState);
    view.game?.animation?.updateAllChessPositions?.(false);
    energyManager.syncFromState(engineAdapter.state ? engineAdapter.state.energy : {});
    uiUpdater.updateUI();
    updateBar();
}

/* 跳到第 N 手 */
function seekTo(step) {
    stopPlay();
    if (!view.archive) return Promise.resolve();
    return replayTo(Math.max(0, Math.min(step, view.archive.actions.length)));
}

function updateBar() {
    const total = view.archive ? view.archive.actions.length : 0;
    if (dom.step) dom.step.textContent = `${view.cursor} / ${total}`;
    if (!dom.track) return;
    // 每一段对应一手：走完的段实心，当前所在的那一格单独描一圈
    const cells = dom.track.children;
    const active = view.cursor + 1;
    let playing = null;
    for (let index = 0; index < cells.length && index < view.cells.length; index += 1) {
        const info = view.cells[index];
        const done = Math.max(0, Math.min(info.end - info.start + 1, view.cursor - info.start + 1));
        const hands = cells[index].children;
        for (let hand = 0; hand < hands.length; hand += 1) {
            hands[hand].classList.toggle('is-done', hand < done);
        }
        const isCurrent = active >= info.start && active <= info.end;
        cells[index].classList.toggle('is-current', isCurrent);
        if (isCurrent) playing = cells[index];
    }
    // 走到头时高亮末尾那格「结算」
    const finalCell = dom.track.lastElementChild;
    if (finalCell && finalCell.dataset.end) {
        const done = view.cursor >= total;
        finalCell.classList.toggle('is-current', done);
        if (done) playing = finalCell;
    }
    // 播放推进时把当前格带进可视范围，别让进度跑出屏幕
    if (playing) {
        const left = playing.offsetLeft;
        const right = left + playing.offsetWidth;
        if (left < dom.track.scrollLeft) dom.track.scrollLeft = left - 10;
        else if (right > dom.track.scrollLeft + dom.track.clientWidth) dom.track.scrollLeft = right - dom.track.clientWidth + 10;
    }
}

/* ------------------------------ 结算 ------------------------------ */

async function showSettlement() {
    const modal = view.game?.settlementModal;
    if (!view.archive || !modal) return;
    await replayTo(view.archive.actions.length);
    modal.show(view.archive.winner || null);
}

/* ------------------------------ 下载 / 导入 ------------------------------ */

function downloadArchive() {
    if (!view.archive) return;
    // 服务端那份也是紧凑格式，直接沿用同一份编码逻辑，文件名由前端统一命名
    const blob = new Blob([JSON.stringify(encodeArchive(view.archive))], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = replayFileName(view.archive);
    link.click();
    URL.revokeObjectURL(url);
}

async function importFile(file) {
    location.href = await importReplayFile(file);
}

/* ------------------------------ 页面 ------------------------------ */

class ReplayGame extends FlyingChessGameBase {
    constructor() {
        super();
        this.initializeGame();
    }

    async initializeGame() {
        try {
            view.game = this;
            audioManager.preloadSounds?.(true);
            audioManager.updateToggleButtonUI();

            // 档案可能没有（比如直接打开这一页）：那就用默认配置把界面摆好，只等导入
            view.archive = await loadArchive();
            const config = view.archive
                ? {
                    colors: view.archive.colors,
                    pieceCount: view.archive.pieceCount || 4,
                    happy: Boolean(view.archive.happy),
                    skillMode: Boolean(view.archive.skillMode)
                }
                : { colors: [1, 2, 3, 4], pieceCount: 4, happy: false, skillMode: false };

            if (view.archive) writeGameConfig(view.archive);

            // 按配置开一局（等价于本地多人开局），先把棋盘和头像摆到位
            gameState.resetGameState();
            gameState.happyMode = config.happy;
            gameState.initializePlayerChess(config.pieceCount);
            activePlayerManager.setActivePlayers(config.colors);

            // 道具局：积分条与击败积分演出都挂在这套系统上，回放页得自己初始化一次
            if (gameState.isSkillModeEnabled()) {
                energyManager.init();
                energyDisplay.init();
            }
            // 结算重建要从"什么都没发生过"开始累加，先留一份干净底子
            view.pristine = {
                titleStats: structuredClone(gameState.titleStats),
                diceStatistics: structuredClone(gameState.diceStatistics)
            };

            if (view.archive) {
                engineAdapter.reset({
                    players: config.colors,
                    piecesPerPlayer: config.pieceCount,
                    happy: config.happy,
                    skillMode: config.skillMode
                });
                gameState.engineDriven = true;
                engineAdapter.restoreReplay(view.archive);
                // 昵称与表情：档案里有谁就叫谁，表情缺失时按 AI / 人类各给个兜底
                for (const player of view.archive.players || []) {
                    this.updatePlayerName(player.color, player.nickname);
                    this.updatePlayerEmoji(player.color, player.emoji || (player.isAI ? 'bot' : defaultEmoji));
                }
            }

            this.setupChessElements();
            eventHandler.setGameInstance(this);
            uiUpdater.updateUI();
            uiUpdater.rotateBoard?.(0);
            // 已经躺在本地（导入的 / 最近对局）就没什么可下载的，这个按钮不摆出来
            if (dom.download) {
                const stored = view.source && (view.source.type === 'imported' || view.source.type === 'recent');
                dom.download.style.display = stored ? 'none' : '';
            }
            // 没有可播的档案时，标记开关没有意义
            const playable = Boolean(view.archive && view.archive.actions.length);
            if (dom.markToggle) {
                dom.markToggle.style.display = playable ? '' : 'none';
            }

            // 回放页的结算不给「查看回放」入口，免得套娃
            if (this.settlementModal) this.settlementModal.renderReplayEntry = () => '';

            // 界面按钮与进度条：先绑好，再上锁（锁会把骰子和棋盘的入口摘掉）
            this.setupUiButtons();
            this.bindBar();
            this.setupBarToggle();
            this.lockInput();

            if (view.archive && view.archive.actions.length) {
                await buildTrack(view.archive);
                // 预演会一路走到终局，结束后把棋面与统计放回开局
                await replayTo(0);
            } else if (view.archive) {
                console.warn('[回放] 档案里没有可播放的动作');
            }
        } catch (error) {
            console.error('[回放] 初始化失败:', error);
        }
    }

    bindBar() {
        dom.play?.addEventListener('click', startPlay);
        dom.prev?.addEventListener('click', () => seekTo(view.cursor - 1));
        dom.next?.addEventListener('click', () => seekTo(view.cursor + 1));
        dom.markToggle?.addEventListener('click', () => {
            const modes = view.archive?.skillMode ? ['kill', 'title', 'item'] : ['kill', 'title'];
            applyMarkMode(modes[(modes.indexOf(view.markMode) + 1) % modes.length]);
        });
        dom.track?.addEventListener('click', async (event) => {
            const cell = event.target?.closest?.('.replay-cell');
            if (!cell) return;
            if (cell.dataset.end) {
                showSettlement();
                return;
            }
            // 正在播的时候点格子只换位置，不打断播放
            const wasPlaying = view.playing;
            await seekTo(Number(cell.dataset.step));
            if (wasPlaying) startPlay();
        });
        // 滚轮直接横着推格子，别去滚页面
        dom.track?.addEventListener('wheel', (event) => {
            if (!event.deltaY || dom.track.scrollWidth <= dom.track.clientWidth) return;
            event.preventDefault();
            dom.track.scrollLeft += event.deltaY;
        }, { passive: false });
        dom.download?.addEventListener('click', () => {
            try {
                downloadArchive();
            } catch (error) {
                alert(error.message);
            }
        });
        dom.file?.addEventListener('change', (event) => {
            const file = event.target.files && event.target.files[0];
            if (file) importFile(file).catch((error) => alert(`导入失败：${error.message}`));
            event.target.value = '';
        });

        document.addEventListener('keydown', (event) => {
            const tag = event.target && event.target.tagName;
            if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'LABEL') return;
            if (event.key === 'ArrowLeft') seekTo(view.cursor - 1);
            else if (event.key === 'ArrowRight') seekTo(view.cursor + 1);
            else if (event.key === ' ') {
                event.preventDefault();
                startPlay();
            }
        });
    }

    /* 收起走按钮，展开靠底部那个箭头——所以箭头只在收起后露面 */
    setupBarToggle() {
        dom.handle?.addEventListener('click', () => document.body.classList.remove('bar-collapsed'));
        dom.hide?.addEventListener('click', () => document.body.classList.add('bar-collapsed'));
    }

    /* 界面按钮自己绑：规则书、音效开关——不依赖 eventHandler，避免和"出手"那套混在一起 */
    setupUiButtons() {
        // 用事件委托：按钮节点如果被重建过，仍然能命中当前那个
        document.addEventListener('click', (event) => {
            const target = event.target;
            if (!target || !target.closest) return;

            const audioBtn = target.closest('#toggleAudio');
            if (audioBtn) {
                const nextEnabled = !audioManager.isEnabled;
                try {
                    audioManager.setEnabled(nextEnabled);
                } catch (error) {
                    console.warn('[回放] 切换音效出错:', error && error.message);
                }
                audioManager.updateToggleButtonUI();
                if (audioManager.isEnabled) audioManager.playMoveSound?.();
                return;
            }

            if (target.closest('#returnHome')) {
                // 回放没有对局进度可丢，直接回首页（和观战一样不问确认）。
                // 顺手清掉模式记忆，不然首页会落回上次那个模式的配置面板
                sessionStorage.removeItem('lastGameMode');
                window.location.replace('index.html');
                return;
            }

            if (target.closest('#showRules')) {
                const rulesModal = document.getElementById('rules-modal');
                if (rulesModal) {
                    resetTitlesViews();
                    rulesModal.style.display = 'flex';
                }
                return;
            }

            if (target.closest('#rules-close')) {
                const rulesModal = document.getElementById('rules-modal');
                if (rulesModal) rulesModal.style.display = 'none';
                return;
            }

            const rulesModal = document.getElementById('rules-modal');
            if (rulesModal && target === rulesModal) rulesModal.style.display = 'none';
        });
    }

    /* 只拦"下棋"这件事：界面按钮（音效、规则书等）照常可用 */
    lockInput() {
        document.body.classList.add('replay-mode');

        // 技能入口对回放没有意义，藏起来
        const skillBtn = document.getElementById('skillBtn');
        if (skillBtn) skillBtn.style.display = 'none';

        // 界面按钮一个都不禁用，要拦的只是"出手"：把棋盘与骰子的入口摘掉
        this.eventHandler.setupChessEvents = function () { };
        this.eventHandler.rebindChessEvents = function () { };
        this.eventHandler.handleDiceClick = function () { };
        const diceDisplay = document.getElementById('diceDisplay');
        if (diceDisplay) {
            diceDisplay.style.pointerEvents = 'none';
            diceDisplay.style.cursor = 'default';
        }

        // 棋盘上的点击也拦掉（棋子选中/走子都从这儿进来）
        document.addEventListener('click', (event) => {
            const target = event.target;
            if (!target || !target.closest) return;
            if (target.closest('.replay-bar-fixed') || target.closest('.replay-bar-handle')) return;
            if (target.closest('#board-svg')) {
                event.stopPropagation();
                event.preventDefault();
            }
        }, true);
    }
}

const runtime = createGameRuntime(ReplayGame);

document.addEventListener('DOMContentLoaded', () => {
    runtime.initializeGame();
});

export { ReplayGame };
