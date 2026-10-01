class PlayerIdManager {
    constructor() {
        this.playerId = null;
        this.init();
    }

    /**
     * 初始化玩家ID
     */
    init() {
        this.playerId = this.getOrCreatePlayerId();
        console.log('玩家ID已初始化:', this.playerId);
    }

    /**
     * 获取或创建持久化的玩家ID
     * @returns {string} 玩家ID
     */
    getOrCreatePlayerId() {
        // 尝试从localStorage获取已存在的玩家ID
        let playerId = localStorage.getItem('aeroplaneChess_playerId');

        if (!playerId) {
            // 如果不存在，生成新的玩家ID并存储
            playerId = this.generatePlayerId();
            localStorage.setItem('aeroplaneChess_playerId', playerId);
            console.log('生成新的玩家ID:', playerId);
        }

        return playerId;
    }

    /**
     * 生成新的玩家ID
     * @returns {string} 新的玩家ID
     */
    generatePlayerId() {
        return 'player_' + Math.random().toString(36).substr(2, 4);
    }

    /**
     * 获取当前玩家ID
     * @returns {string} 当前玩家ID
     */
    getPlayerId() {
        return this.playerId;
    }


    /**
     * 清除玩家ID
     */
    clearPlayerId() {
        localStorage.removeItem('aeroplaneChess_playerId');
        this.playerId = null;
        console.log('玩家ID已清除');
    }


    /**
     * 保存玩家昵称到本地存储
     * @param {string} nickname - 要保存的昵称
     */
    nicknameKey(mode) {
        return mode ? 'aeroplaneChess_playerNickname.' + mode : 'aeroplaneChess_playerNickname';
    }

    saveNickname(nickname, mode = null) {
        if (!nickname || !nickname.trim()) {
            // 如果昵称为空，删除存储的昵称
            localStorage.removeItem(this.nicknameKey(mode));
            console.log('清除存储的昵称');
        } else {
            localStorage.setItem(this.nicknameKey(mode), nickname.trim());
            console.log('保存昵称到本地存储:', nickname.trim());
        }
    }

    /**
     * 从本地存储获取玩家昵称
     * @returns {string|null} 存储的昵称，如果不存在则返回null
     */
    getSavedNickname() {
        return localStorage.getItem('aeroplaneChess_playerNickname');
    }

    /**
     * 清除保存的昵称
     */
    clearNickname() {
        localStorage.removeItem('aeroplaneChess_playerNickname');
        console.log('昵称已清除');
    }

}

// 创建全局实例
const playerIdManager = new PlayerIdManager();
window.playerIdManager = playerIdManager;

export { playerIdManager, PlayerIdManager };