import { playerIdManager } from './playerIdManager.js';

class ReconnectManager {
    constructor() {
        this.gameSessionId = null;
        this.roomCode = null;
        this.playerNickname = null;
        this.playerEmoji = null;
        this.playerColor = null;
        this.isHost = false;
        
        // 初始化时尝试从存储中恢复玩家身份
        this.loadPlayerIdentity();
    }

    /**
     * 获取当前玩家ID（从 PlayerIdManager 获取）
     */
    get playerId() {
        return playerIdManager.getPlayerId();
    }


    /**
     * 从本地存储加载玩家身份信息
     */
    loadPlayerIdentity() {
        // playerId 现在由 PlayerIdManager 管理，不需要在这里加载
        // 从localStorage加载持久化信息
        this.playerNickname = localStorage.getItem('aeroplaneChess_playerNickname');
        this.playerEmoji = localStorage.getItem('aeroplaneChess_playerEmoji');
        this.playerColor = localStorage.getItem('aeroplaneChess_playerColor');
        this.isHost = localStorage.getItem('aeroplaneChess_isHost') === 'true';

        // 从sessionStorage加载会话信息
        this.gameSessionId = sessionStorage.getItem('aeroplaneChess_gameSessionId');
        this.roomCode = sessionStorage.getItem('aeroplaneChess_roomCode');
    }

    /**
     * 清除玩家身份信息
     */
    clearPlayerIdentity() {
        this.gameSessionId = null;
        this.roomCode = null;
        this.playerNickname = null;
        this.playerEmoji = null;
        this.playerColor = null;
        this.isHost = false;

        // 清除localStorage
        localStorage.removeItem('aeroplaneChess_playerEmoji');
        localStorage.removeItem('aeroplaneChess_playerColor');
        localStorage.removeItem('aeroplaneChess_isHost');

        // 清除sessionStorage
        sessionStorage.removeItem('aeroplaneChess_gameSessionId');
        sessionStorage.removeItem('aeroplaneChess_roomCode');
    }



    /**
     * 更新游戏会话ID
     */
    updateGameSessionId(gameSessionId) {
        this.gameSessionId = gameSessionId;
        if (gameSessionId) {
            sessionStorage.setItem('aeroplaneChess_gameSessionId', gameSessionId);
        } else {
            sessionStorage.removeItem('aeroplaneChess_gameSessionId');
        }
        console.log('游戏会话ID已更新:', gameSessionId);
    }

    /**
     * 更新房间号
     */
    updateRoomCode(roomCode) {
        if (this.roomCode === roomCode) return;
        this.roomCode = roomCode;
        if (roomCode) {
            sessionStorage.setItem('aeroplaneChess_roomCode', roomCode);
        } else {
            sessionStorage.removeItem('aeroplaneChess_roomCode');
        }
        console.log('房间号已更新:', roomCode);
    }

}

// 创建全局实例
const reconnectManager = new ReconnectManager();
window.reconnectManager = reconnectManager;

export { reconnectManager, ReconnectManager };