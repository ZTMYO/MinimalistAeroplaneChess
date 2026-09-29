class ActivePlayerManager {
    constructor() {
        // 存储激活的玩家编号数组，默认所有玩家都激活
        this.activePlayers = [1, 2, 3, 4];
        // 当前激活玩家在激活列表中的索引
        this.currentActiveIndex = 0;
    }

    /**
     * 设置激活的玩家
     * @param {Array<number>} playerNumbers - 激活的玩家编号数组
     */
    setActivePlayers(playerNumbers) {
        // 验证输入，不进行排序，保持原有顺序
        this.activePlayers = playerNumbers.filter(num => num >= 1 && num <= 4);
        
        // 重置当前激活玩家索引
        this.currentActiveIndex = 0;
        // 更新UI显示
        this.updatePlayerVisibility();
    }

    /**
     * 获取激活的玩家列表
     * @returns {Array<number>} 激活的玩家编号数组
     */
    getActivePlayers() {
        return [...this.activePlayers];
    }

    /**
     * 检查玩家是否激活
     * @param {number} playerNumber - 玩家编号
     * @returns {boolean} 是否激活
     */
    isPlayerActive(playerNumber) {
        return this.activePlayers.includes(playerNumber);
    }



    /**
     * 设置当前激活玩家
     * @param {number} playerNumber - 玩家编号
     */
    setCurrentActivePlayer(playerNumber) {
        const index = this.activePlayers.indexOf(playerNumber);
        if (index !== -1) {
            this.currentActiveIndex = index;
        } else {
            console.warn(`玩家${playerNumber}不在激活列表中`);
        }
    }

    /**
     * 更新玩家UI元素的可见性
     */
    updatePlayerVisibility() {
        // 更新桌面端玩家信息
        for (let player = 1; player <= 4; player++) {
            const isActive = this.isPlayerActive(player);
            
            // 桌面端玩家信息（在.players-info容器内）
            const desktopPlayerInfo = document.querySelector(`.players-info .player-${player}-info`);
            if (desktopPlayerInfo) {
                desktopPlayerInfo.style.display = isActive ? 'flex' : 'none';
            }
            
            // 移动端上方玩家信息（在.players-top容器内）
            const mobileTopPlayerInfo = document.querySelector(`.players-top .player-${player}-info`);
            if (mobileTopPlayerInfo) {
                mobileTopPlayerInfo.style.visibility = isActive ? 'visible' : 'hidden';
                mobileTopPlayerInfo.style.display = 'flex';
            }
            
            // 移动端下方玩家信息（在.players-bottom容器内）
            const mobileBottomPlayerInfo = document.querySelector(`.players-bottom .player-${player}-info`);
            if (mobileBottomPlayerInfo) {
                mobileBottomPlayerInfo.style.visibility = isActive ? 'visible' : 'hidden';
                mobileBottomPlayerInfo.style.display = 'flex';
            }
            
            // 进度条
            const progressItem = document.querySelector(`.progress-item[data-player="${player}"]`);
            if (progressItem) {
                progressItem.style.display = isActive ? 'flex' : 'none';
            }
            
            // 棋子元素
            const chessElements = document.querySelectorAll(`#board-svg use[href="#chess"].player-${player}`);
            chessElements.forEach(element => {
                element.style.display = isActive ? 'block' : 'none';
            });
            
        }
    }


    /**
     * 重置为默认状态（所有玩家激活）
     */
    reset() {
        this.activePlayers = [1, 2, 3, 4];
        this.currentActiveIndex = 0;
        this.updatePlayerVisibility();
    }
}

// 创建单例实例
const activePlayerManager = new ActivePlayerManager();

export { activePlayerManager };