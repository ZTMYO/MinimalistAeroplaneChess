/** 「这名玩家由 AI 出手吗」的唯一判据：预设机器人、托管真人、托管名单 */

/** 该 playerId 是否处于托管状态（本人离开/挂机时由服务端接管出牌） */
export function isTakeoverPlayer(playerId, manager = window.gameInstance?.multiplayerGameManager) {
    if (!manager || playerId === null || playerId === undefined) return false;
    const playerData = manager.players?.get(playerId);
    return Boolean(manager.aiTakeoverPlayers?.has(playerId) || playerData?.isAITakeover);
}

/** 该玩家编号是否整局都由 AI 出手：预设机器人或托管玩家 */
export function isAiDriven(playerNumber, manager = window.gameInstance?.multiplayerGameManager) {
    if (!manager) return false;
    const playerId = manager.getPlayerIdByPlayerNumber?.(playerNumber);
    if (playerId === null || playerId === undefined) return false;
    const playerData = manager.players?.get(playerId);
    return Boolean(playerData?.isAI) || isTakeoverPlayer(playerId, manager);
}
