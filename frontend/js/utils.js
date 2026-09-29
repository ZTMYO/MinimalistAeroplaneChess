export const DICE_SYMBOLS = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

// 根据棋子在轨道上的位置计算应该的旋转角度
export function getChessRotationAtPosition(position) {
    // 特定位置的旋转角度（拐角处）
    const specificRotations = {
        1: -90,   // 逆时针转90度
        5: -90,   // 逆时针转90度
        8: 90,    // 顺时针转90度
        14: 90,   // 顺时针转90度
        19: -90,  // 逆时针转90度
        21: 90,   // 顺时针转90度
        27: 90,   // 顺时针转90度
        30: -90,  // 逆时针转90度
        34: 90,   // 顺时针转90度
        40: 90,   // 顺时针转90度
        44: -90,  // 逆时针转90度
        47: 90,    // 顺时针转90度
        50: 90
    };

    // 累积旋转角度
    let totalRotation = 0;

    // 遍历所有已经过的拐角位置，累积旋转角度
    for (let pos = 1; pos <= position; pos++) {
        if (specificRotations.hasOwnProperty(pos)) {
            totalRotation += specificRotations[pos];
        }
    }

    return totalRotation;
}

// 将玩家的相对位置转换为绝对轨道位置（以玩家1为参考）
export function getAbsolutePosition(player, relativePosition) {
    if (relativePosition === -1) return -1; // 起始区域
    if (relativePosition >= 51) return relativePosition; // 终点通道（51及以上），每个玩家独立，不参与beat检测
    if (relativePosition === 0) return 0; // 所有玩家的起点都是位置0

    // 根据映射关系.txt的规则进行转换
    if (player === 1) {
        // 玩家1的绝对位置就是其相对位置
        return relativePosition;
    } else if (player === 4) {
        // 玩家4的转换规则
        if (relativePosition >= 14) {
            return relativePosition - 13;
        } else if (relativePosition >= 1 && relativePosition <= 11) {
            return relativePosition + 39;
        } else if (relativePosition === 12) {
            return -3; // 玩家1到不了的位置
        } else if (relativePosition === 13) {
            return -2 // 玩家1到不了的位置
        }
    } else if (player === 3) {
        // 玩家3的转换规则
        if (relativePosition >= 1 && relativePosition <= 24) {
            return relativePosition + 26;
        } else if (relativePosition === 25) {
            return -3; // 玩家1到不了的位置
        } else if (relativePosition === 26) {
            return -2;// 玩家1到不了的位置
        }
        else if (relativePosition >= 27) {
            return relativePosition - 26;
        }
    } else if (player === 2) {
        // 玩家2的转换规则
        if (relativePosition >= 1 && relativePosition <= 37) {
            return relativePosition + 13;
        } else if (relativePosition === 38) {
            return -3; // 玩家1到不了的位置
        } else if (relativePosition === 39) {
            return -2;// 玩家1到不了的位置
        }
        else if (relativePosition >= 40) {
            return relativePosition - 39;
        }
    }

    return relativePosition; // 默认返回原位置
}

// 计算单个棋子的完成度（百分比），供积分结算用
export function calculateChessProgress(chess, player) {
    if (chess.finished) return 100;
    if (chess.position === -1) return 0;

    // 外圈轨道 0-50 + 终点航道 51-56，共 57 格
    const totalSteps = 57;
    let currentSteps = 0;
    if (chess.position >= 0 && chess.position <= 50) {
        currentSteps = chess.position;
    } else if (chess.position >= 51 && chess.position <= 56) {
        currentSteps = 51 + (chess.position - 51);
    }

    const progress = (currentSteps / totalSteps) * 100;
    return Math.min(100, Math.max(0, progress));
}

// 判断指定绝对位置是否为叠子（同一玩家的两个或多个棋子在同一位置）
export function isStackAtAbsolutePosition(absolutePosition, gameState) {
    if (absolutePosition === -1 || absolutePosition < 0) return null;

    const playerChess = gameState.getPlayerChess ? gameState.getPlayerChess() : gameState.playerChess;
    const pieceCount = gameState.pieceCount || 4; // 获取当前棋子个数，默认为4

    // 统计每个玩家在该位置的棋子数量
    for (let player = 1; player <= 4; player++) {
        const chessAtPosition = [];

        for (let chessIndex = 0; chessIndex < pieceCount; chessIndex++) {
            const chess = playerChess[player][chessIndex];
            if (chess.finished || chess.position === -1) continue;

            const chessAbsolutePos = getAbsolutePosition(player, chess.position);
            if (chessAbsolutePos === absolutePosition) {
                chessAtPosition.push({ player, chessIndex, chess });
            }
        }

        // 如果该玩家在此位置有2个或以上棋子，则为叠子
        if (chessAtPosition.length >= 2) {
            return {
                isStack: true,
                player: player,
                chessCount: chessAtPosition.length,
                chessList: chessAtPosition
            };
        }
    }

    return null;
}

export const utils = {
    getChessRotationAtPosition,
    getAbsolutePosition,
    isStackAtAbsolutePosition,
};