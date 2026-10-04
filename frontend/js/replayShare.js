/** 回放档案的搬运：联机的在服务端会话里，单机的在本地引擎适配层里，回放页只认档案本身 */
import { encodeArchive, decodeArchive } from '../../shared/replayCodec.mjs';
import { ENGINE_VERSION } from '../../shared/engine.mjs';

const STASH_KEY = 'flyingChess.replayArchive';

export function stashReplayArchive(archive) {
    try {
        sessionStorage.setItem(STASH_KEY, JSON.stringify(encodeArchive(archive)));
        return true;
    } catch (error) {
        console.warn('[回放] 档案暂存失败:', error.message);
        return false;
    }
}

/** 取走即销毁：本地回放只在内存里放一程，不在玩家浏览器里留存（要留存只能下载文件） */
export function readStashedReplay() {
    try {
        const raw = sessionStorage.getItem(STASH_KEY);
        sessionStorage.removeItem(STASH_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        return null;
    }
}

export function clearStashedReplay() {
    sessionStorage.removeItem(STASH_KEY);
}

/** 导入一份回放文件：校验后暂存，返回要跳转的地址（首页与回放页共用） */
export async function importReplayFile(file) {
    let archive = null;
    try {
        archive = decodeArchive(JSON.parse(await file.text()));
    } catch (error) {
        throw new Error('文件读不出内容，不是一份回放档案');
    }
    if (!archive || !Array.isArray(archive.actions) || !archive.colors) {
        throw new Error('这不是一份对局回放文件');
    }
    if (archive.engineVersion !== ENGINE_VERSION) console.warn('[回放] 档案来自其它引擎版本，规则可能有差异');
    if (!stashReplayArchive(archive)) {
        throw new Error('回放暂存失败，可能是浏览器存储写满了');
    }
    return 'replay.html?local=1&imported=1';
}


/** 结算页用：给出这一局的回放入口地址（没有档案时返回 null） */
export function buildReplayHref(archive) {
    const gameSessionId = window.multiplayerGameManager?.gameSessionId;
    if (gameSessionId) return `replay.html?id=${encodeURIComponent(gameSessionId)}`;
    if (!archive) return null;
    return stashReplayArchive(archive) ? 'replay.html?local=1' : null;
}

/* ------------------------- 最近对局 ------------------------- */

const RECENT_KEY = 'flyingChess.recentReplays';
const RECENT_MAX = 5;

/** 时间戳压出的 4 位短后缀：同日连打几局也不会撞名 */
export function replayTag() {
    return (Math.imul(Date.now() & 0x7fffffff, 2654435761) >>> 0).toString(36).slice(-4);
}

/** 档案里能直接读出来的展示信息：模式、人数、棋子数、模式标签 */
export function replaySummary(archive) {
    const modeKey = archive.mode === 'ai_battle' ? 'ai' : (archive.mode === 'online_multiplayer' ? 'online' : 'local');
    const mode = { ai: '人机', online: '联机', local: '本地' }[modeKey];
    const kind = `${archive.skillMode ? '道具' : ''}${archive.happy ? '欢乐' : ''}` || '经典';
    return {
        modeKey,
        mode,
        players: (archive.colors || []).length || 4,
        pieces: archive.pieceCount || 4,
        kind,
        hands: archive.actionCount || (archive.actions || []).length
    };
}

/** 下载用的文件名：[极简飞行棋]人机3人3子道具欢乐-abcd.json */
export function replayFileName(archive) {
    const summary = replaySummary(archive);
    return `[极简飞行棋]${summary.mode}${summary.players}人${summary.pieces}子${summary.kind}-${replayTag()}.json`;
}

/** 人机 / 联机各存各的最近 RECENT_MAX 场；本地多人不留档 */
const RECENT_MODES = ['ai', 'online'];

const recentKeyOf = (mode) => RECENT_KEY + '.' + mode;

function readRecentList(mode) {
    try {
        const list = JSON.parse(localStorage.getItem(recentKeyOf(mode)) || '[]');
        // 没有动作的档案回放不了（联机局曾误存过这种），不摆出来
        return Array.isArray(list) ? list.filter((item) => (item.archive?.actionCount || item.archive?.actions?.length || 0) > 0) : [];
    } catch (error) {
        return [];
    }
}

function writeRecentReplays(list, mode) {
    try {
        localStorage.setItem(recentKeyOf(mode), JSON.stringify(list.slice(0, RECENT_MAX)));
    } catch (error) { }
}

/* 同一局重复结算时不重复入库：内容里挑几个不会变的字段做键 */
function recentId(archive) {
    return `${archive.seed}-${archive.actionCount}-${(archive.colors || []).join('')}`;
}

/** 这一场的模式（ai / online / local），按档案里记的模式归位 */
function recentModeOf(archive) {
    return replaySummary(archive).modeKey;
}

/** 记一场对局：同局只留一份、最新的排最前、只保最近 5 场；本地多人不入档 */
export function addRecentReplay(archive) {
    if (!archive || !Array.isArray(archive.colors)) return null;
    const mode = recentModeOf(archive);
    if (!RECENT_MODES.includes(mode)) return null;
    const id = recentId(archive);
    const list = readRecentList(mode).filter((item) => item.id !== id);
    list.unshift({ id, at: Date.now(), archive: encodeArchive(archive) });
    writeRecentReplays(list, mode);
    return id;
}

/** 某一模式的最近对局列表 */
export function listRecentReplays(mode) {
    return RECENT_MODES.includes(mode) ? readRecentList(mode) : [];
}

/** 取某一场的档案（紧凑形式）：不传模式就在两个模式里找（回放页只拿得到 id） */
export function readRecentReplay(id, mode = null) {
    for (const target of (mode ? [mode] : RECENT_MODES)) {
        const item = readRecentList(target).find((entry) => entry.id === id);
        if (item) return item.archive;
    }
    return null;
}

/* ------------------------- 单机续局：本地存档 ------------------------- */

const LOCAL_KEY = 'flyingChess.localGame';

/* 人机与本地多人各存各的，互不干扰；键后缀由当前对局模式决定 */
function modeKey(mode = null) {
    const resolved = mode || currentGameMode();
    return resolved ? LOCAL_KEY + '.' + resolved : LOCAL_KEY;
}

export function currentGameMode() {
    try {
        return JSON.parse(sessionStorage.getItem('gameConfig') || '{}').mode || null;
    } catch (error) {
        return null;
    }
}
const SAVE_MIN_GAP_MS = 800;
let lastSavedAt = 0;

/** 单机对局存档：种子 + 动作流，刷新或中途离开后据此接着打 */
export function saveLocalGame(archive) {
    if (!archive) return;
    const now = Date.now();
    if (now - lastSavedAt < SAVE_MIN_GAP_MS) return;
    lastSavedAt = now;
    let raw = null;

    try {
        raw = JSON.stringify(archive);
    } catch (error) {
        // 整份存不下（多半是某个字段不可序列化），退到只保称号相关的那几项
        const client = archive.client || {};
        raw = JSON.stringify({
            ...archive,
            client: {
                titleStats: client.titleStats || null,
                announcedTitles: client.announcedTitles || null,
                gameStartTime: client.gameStartTime || null
            }
        });
    }

    try {
        localStorage.setItem(modeKey(), raw);
    } catch (error) {
    }
}

/** 页面即将离开时补写一次，保证最后一手不丢 */
export function flushLocalGame(archive) {
    if (!archive) return;
    lastSavedAt = 0;
    saveLocalGame(archive);
}

export function loadLocalGame(mode = null) {
    try {
        const own = localStorage.getItem(modeKey(mode));
        if (own) return JSON.parse(own);

        // 过渡：老键上的存档按它自己记的模式归位，属于别的模式就不认
        const legacy = localStorage.getItem(LOCAL_KEY);
        if (!legacy) return null;
        const saved = JSON.parse(legacy);
        const legacyMode = saved && saved.client && saved.client.gameConfig
            ? JSON.parse(saved.client.gameConfig).mode
            : null;
        if (mode && legacyMode && legacyMode !== mode) return null;
        if (legacyMode) {
            localStorage.setItem(modeKey(legacyMode), legacy);
            localStorage.removeItem(LOCAL_KEY);
        }
        return saved;
    } catch (error) {
        return null;
    }
}

export function clearLocalGame(mode = null) {
    lastSavedAt = 0;
    if (mode) {
        localStorage.removeItem(modeKey(mode));
        localStorage.removeItem(LOCAL_KEY);
        return;
    }
    localStorage.removeItem(modeKey('ai_battle'));
    localStorage.removeItem(modeKey('local_multiplayer'));
    localStorage.removeItem(LOCAL_KEY);
    clearStashedReplay();
}

export function clearCurrentLocalGame() {
    const mode = currentGameMode();
    if (mode) clearLocalGame(mode);
}
