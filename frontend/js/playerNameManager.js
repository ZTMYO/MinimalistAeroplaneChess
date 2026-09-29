class PlayerNameManager {
    constructor() {
        // 存储玩家名称的映射，键为玩家编号(1-4)，值为玩家名称
        this.playerNames = {
            1: '玩家1',
            2: '玩家2',
            3: '玩家3',
            4: '玩家4'
        };

        // 默认Bot名称
        this.defaultBotNames = ['Bot-1', 'Bot-2', 'Bot-3'];
    }

    /**
     * 设置玩家名称
     * @param {number} playerNumber - 玩家编号 (1-4)
     * @param {string} name - 玩家名称
     */
    setPlayerName(playerNumber, name) {
        if (playerNumber >= 1 && playerNumber <= 4) {
            this.playerNames[playerNumber] = name || `玩家${playerNumber}`;
        }
    }

    /**
     * 获取玩家名称
     * @param {number} playerNumber - 玩家编号 (1-4)
     * @returns {string} 玩家名称
     */
    getPlayerName(playerNumber) {
        return this.playerNames[playerNumber] || `玩家${playerNumber}`;
    }

    /**
     * 设置用户玩家和激活的Bot玩家的名称
     * @param {number} userPlayerNumber - 用户选择的玩家编号
     * @param {string} userName - 用户名称
     * @param {Array<number>} activeBotNumbers - 激活的AI玩家编号数组
     * @param {Object} botDifficulties - AI玩家难度配置对象
     */
    setupPlayersWithActiveBots(userPlayerNumber, userName, activeBotNumbers = [], botDifficulties = {}) {
        // 重置所有玩家名称为默认值
        this.reset();

        // 设置用户名称
        this.setPlayerName(userPlayerNumber, userName);

        // 按难度分组AI玩家
        const easyBots = [];
        const hardBots = [];
        
        activeBotNumbers.forEach(playerNumber => {
            if (playerNumber !== userPlayerNumber && playerNumber >= 1 && playerNumber <= 4) {
                const difficulty = botDifficulties[playerNumber] || 'easy';
                if (difficulty === 'hard') {
                    hardBots.push(playerNumber);
                } else {
                    easyBots.push(playerNumber);
                }
            }
        });

        // 为简单AI设置Bot-编号名称
        easyBots.forEach((playerNumber, index) => {
            this.setPlayerName(playerNumber, `Bot-${index + 1}`);
        });

        // 为困难AI设置AI-编号名称
        hardBots.forEach((playerNumber, index) => {
            this.setPlayerName(playerNumber, `AI-${index + 1}`);
        });
    }


    /**
     * 重置所有玩家名称为默认值
     */
    reset() {
        this.playerNames = {
            1: '玩家1',
            2: '玩家2',
            3: '玩家3',
            4: '玩家4'
        };
    }

    /**
     * 从URL参数初始化玩家名称
     */
    initFromUrlParams() {
        const urlParams = new URLSearchParams(window.location.search);
        const playerColor = urlParams.get('playerColor');
        const playerName = urlParams.get('playerName');

        if (playerColor && playerName) {
            this.setupPlayersWithActiveBots(parseInt(playerColor), playerName, []);
        } else {
            // 如果没有URL参数，默认玩家1为用户，其他为Bot
            this.setupPlayersWithActiveBots(1, '玩家1', []);
        }
    }
}

// 创建全局实例
export const playerNameManager = new PlayerNameManager();
export default PlayerNameManager;