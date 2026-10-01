/**
 * 回放档案的紧凑编解码（前端与后端共用）：动作压成 [玩家, 动作码, 参数…]，
 * 例如 [1, 1, 2] 就是「玩家1 移动第3颗棋子」；不认识的动作用 9 号兜底原样带上。
 */
export const REPLAY_FORMAT = 1;

const ACTION_CODES = { roll: 0, move: 1, item: 2, skip: 3, teleport: 4 };
const ACTION_NAMES = ['roll', 'move', 'item', 'skip', 'teleport'];
const RAW_CODE = 9;

const ITEM_CODES = { 'remote-dice': 1, 'polyhedral-dice': 2, teleport: 3, mysteryBox: 4 };
const ITEM_NAMES = [null, 'remote-dice', 'polyhedral-dice', 'teleport', 'mysteryBox'];
const REASON_CODES = { mysteryBox: 1 };
const REASON_NAMES = [null, 'mysteryBox'];

export function encodeReplayAction(action = {}) {
    return trimTrailingZeros(buildActionTuple(action));
}

function buildActionTuple(action = {}) {
    const code = ACTION_CODES[action.type];
    if (code === undefined) return [RAW_CODE, action];

    switch (action.type) {
        case 'roll':
            // noBonus 与 maxDice 同进同出，解码时按 maxDice 还原，省一个字段
            return [0, action.value || 0, action.maxDice || 0, ITEM_CODES[action.item] || 0];
        case 'move':
        case 'teleport':
            return [code, action.chessIndex || 0];
        case 'item':
            return [2, ITEM_CODES[action.item] || 0];
        case 'skip':
            return [3, REASON_CODES[action.reason] || 0];
        default:
            return [RAW_CODE, action];
    }
}

export function decodeReplayAction(tuple = []) {
    const [code, a = 0, b = 0, c = 0] = tuple;
    if (code === RAW_CODE) return a;
    switch (ACTION_NAMES[code]) {
        case 'roll': {
            const action = { type: 'roll' };
            if (a) action.value = a;
            if (b) {
                action.maxDice = b;
                action.noBonus = true;
            }
            if (c && ITEM_NAMES[c]) action.item = ITEM_NAMES[c];
            return action;
        }
        case 'move':
            return { type: 'move', chessIndex: a };
        case 'teleport':
            return { type: 'teleport', chessIndex: a };
        case 'item':
            return { type: 'item', item: ITEM_NAMES[a] || null };
        case 'skip': {
            const action = { type: 'skip' };
            if (REASON_NAMES[a]) action.reason = REASON_NAMES[a];
            return action;
        }
        default:
            return null;
    }
}

/* 尾部补零没有信息量，去掉；解码时缺的段按 0 处理。
   keep 是保底长度：动作码本身可能是 0（掷骰），连它一起削掉整手就读不出来了 */
function trimTrailingZeros(tuple, keep = 1) {
    let end = tuple.length;
    while (end > keep && tuple[end - 1] === 0 && typeof tuple[end - 1] === 'number') end -= 1;
    return tuple.slice(0, end);
}

/** 原始档案 → 紧凑档案（元组数组） */
export function encodeArchive(archive) {
    if (!archive) return null;
    if (archive.format === REPLAY_FORMAT) return archive;
    return {
        format: REPLAY_FORMAT,
        engineVersion: archive.engineVersion,
        mode: archive.mode || '',
        seed: archive.seed,
        colors: archive.colors,
        pieceCount: archive.pieceCount,
        happy: archive.happy ? 1 : 0,
        skillMode: archive.skillMode ? 1 : 0,
        startEnergy: archive.startEnergy || 0,
        players: (archive.players || []).map((player) => [player.color, player.nickname, player.isAI ? 1 : 0, player.emoji || '']),
        finished: archive.finished ? 1 : 0,
        winner: archive.winner || 0,
        turn: archive.turn || 0,
        actionCount: (archive.actions || []).length,
        actions: (archive.actions || []).map((item) => trimTrailingZeros([item.p, ...encodeReplayAction(item.a)], 2))
    };
}

/** 紧凑档案 → 原始档案；已经是原始格式的原样返回 */
export function decodeArchive(packed) {
    if (!packed || packed.format !== REPLAY_FORMAT) return packed;
    return {
        engineVersion: packed.engineVersion,
        mode: packed.mode || '',
        seed: packed.seed,
        colors: packed.colors,
        pieceCount: packed.pieceCount,
        happy: Boolean(packed.happy),
        skillMode: Boolean(packed.skillMode),
        startEnergy: packed.startEnergy || 0,
        players: (packed.players || []).map((player) => ({
            color: player[0],
            nickname: player[1],
            isAI: Boolean(player[2]),
            emoji: player[3] || null
        })),
        finished: Boolean(packed.finished),
        winner: packed.winner || null,
        turn: packed.turn || 0,
        actionCount: (packed.actions || []).length,
        // 早先的裁剪把「裸掷骰」削成了只剩玩家号，缺动作码时按掷骰补回来
        actions: (packed.actions || []).map((item) => {
            const rest = item.slice(1);
            return { p: item[0], a: decodeReplayAction(rest.length ? rest : [0]) };
        })
    };
}
