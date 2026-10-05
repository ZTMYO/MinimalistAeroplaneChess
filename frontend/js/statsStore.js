/**
 * 本机战绩档案：不登录、不上云，全部存在这一台浏览器里。
 * 人机与联机各记一份（本地多人不计入统计）；
 * 每份 = 累计合计(totals) + 称号计数(titles)，外加一份对局摘要列表(games，封顶 GAMES_MAX 局)。
 * 回放档案不在这里：仍在 replayShare 的「最近 5 局」里，靠 replayId 对号。
 */
const PROFILE_KEY = 'flyingChess.statsProfile';
const GAMES_MAX = 100;
export const STATS_MODES = ['ai', 'online'];

const emptyBucket = () => ({
    totals: { games: 0, wins: 0, seconds: 0, distance: 0, kills: 0, titles: 0 },
    titles: {}
});

const emptyProfile = () => ({
    modes: Object.fromEntries(STATS_MODES.map((mode) => [mode, emptyBucket()])),
    games: []
});

/** 读档案：读不出来或形状不对就当没有（还没发版，不做旧结构兼容） */
export function loadProfile() {
    try {
        const raw = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
        if (raw && raw.modes && raw.modes.ai && raw.modes.online && Array.isArray(raw.games)) return raw;
    } catch (error) {
        // 读不出来就当没有
    }
    return emptyProfile();
}

function writeProfile(profile) {
    try {
        localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
        return true;
    } catch (error) {
        console.warn('[战绩] 本机存储写入失败，这一局的统计没能留下:', error.message);
        return false;
    }
}

/**
 * 落一局战绩。entry 由结算处组装（见 settlementModal.recordFinishedGame）：
 * { mode, modeKey, players, pieces, kind, nickname, won, winner, turns, hands, seconds,
 *   kills, distance, progress, titles: [称号id], mySeat,
 *   players: [{ seat, rank, name, isAI, emoji, progress, finished, defeatCounts, titles }] }
 * 本地多人不入统计，直接忽略。
 * @returns {string|null} 这一笔的 id，稍后拿到回放档案时用 attachReplayId 补上
 */
export function recordGame(entry) {
    if (!entry || !STATS_MODES.includes(entry.mode)) return null;
    const profile = loadProfile();
    const bucket = profile.modes[entry.mode];
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const game = {
        id,
        at: Date.now(),
        mode: entry.mode,
        modeKey: entry.modeKey || entry.mode,
        players: Array.isArray(entry.players) ? entry.players : [],
        pieces: entry.pieces || 4,
        kind: entry.kind || '经典',
        nickname: entry.nickname || '',
        mySeat: entry.mySeat || 0,
        won: Boolean(entry.won),
        finished: Boolean(entry.finished),
        winner: entry.winner || 0,
        turns: entry.turns || 0,
        hands: entry.hands || 0,
        seconds: entry.seconds || 0,
        kills: entry.kills || 0,
        distance: entry.distance || 0,
        progress: entry.progress || 0,
        replayId: null
    };

    // 这一模式的累计合计
    if (game.finished) {
        bucket.totals.games += 1;
        if (game.won) bucket.totals.wins += 1;
    }
    bucket.totals.seconds += game.seconds;
    bucket.totals.distance += game.distance;
    bucket.totals.kills += game.kills;

    // 称号计数：按「在多少局里拿到过」记
    const titles = Array.isArray(entry.titles) ? entry.titles : [];
    for (const titleId of titles) {
        if (!titleId) continue;
        const record = bucket.titles[titleId] || { count: 0, firstAt: game.at, lastAt: game.at };
        record.count += 1;
        record.lastAt = game.at;
        if (!record.firstAt) record.firstAt = game.at;
        bucket.titles[titleId] = record;
    }
    bucket.totals.titles = Object.keys(bucket.titles).length;
    game.titles = titles;

    // 列表封顶：丢最老的，累计合计不动
    profile.games.unshift(game);
    if (profile.games.length > GAMES_MAX) profile.games.length = GAMES_MAX;

    writeProfile(profile);
    return id;
}

/** 回放档案到位后（联机是异步取回来的）把 id 补到那一笔上 */
export function attachReplayId(id, replayId) {
    if (!id || !replayId) return;
    const profile = loadProfile();
    const game = profile.games.find((item) => item.id === id);
    if (!game) return;
    game.replayId = replayId;
    writeProfile(profile);
}

/** 某一模式的对局摘要（新的在前），不传就是全部 */
export function listGames(mode = null) {
    const games = loadProfile().games;
    return mode ? games.filter((game) => game.mode === mode) : games;
}

/** 某一模式的累计与称号：{ totals, titles } */
export function modeStats(mode) {
    const profile = loadProfile();
    return profile.modes[mode] || emptyBucket();
}
