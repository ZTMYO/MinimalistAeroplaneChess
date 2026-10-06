class ProgressDisplay {
    constructor() {
        this.progressPanel = null;
        this.progressItems = {};
        this.init();
    }

    // 初始化进度显示系统
    init() {
        this.progressPanel = document.querySelector('.progress-panel');
        if (!this.progressPanel) {
            console.warn('进度面板未找到');
            return;
        }

        // 获取进度条的实际内容容器
        this.progressContent = this.progressPanel.querySelector('.progress-content') || this.progressPanel;

        // 初始化进度项元素引用
        for (let player = 1; player <= 4; player++) {
            const item = this.progressContent.querySelector(`[data-player="${player}"]`);
            if (item) {
                this.progressItems[player] = {
                    element: item,
                    fillElement: item.querySelector('.progress-fill')
                };
            }
        }
    }

    // 计算单个玩家的完成进度
    calculatePlayerProgress(player, gameState) {
        try {
            const allPlayerChess = gameState.getPlayerChess();
            if (!allPlayerChess || !allPlayerChess[player]) {
                console.warn(`无法获取玩家${player}的棋子数据`);
                return 0;
            }
            
            const playerChess = allPlayerChess[player];
            let totalProgress = 0;
            const pieceCount = gameState.pieceCount || 4; // 获取当前棋子个数，默认为4
            const progressPerPiece = 100 / pieceCount; // 每个棋子的进度权重

            // 先检查是否所有棋子都在起点，如果是则直接返回0，避免浮点数精度问题
            let allAtStart = true;
            let finishedCount = 0;
            
            for (let chessIndex = 0; chessIndex < pieceCount; chessIndex++) {
                const chess = playerChess[chessIndex];
                if (!chess) {
                    console.warn(`玩家${player}的棋子${chessIndex}数据不存在`);
                    continue;
                }
                
                if (chess.finished) {
                    finishedCount++;
                    allAtStart = false;
                } else if (chess.position !== -1) {
                    allAtStart = false;
                }
            }
            
            // 如果所有棋子都在起点，直接返回0
            if (allAtStart && finishedCount === 0) {
                return 0;
            }
            
            // 如果所有棋子都完成了，直接返回100
            if (finishedCount === pieceCount) {
                return 100;
            }

            // 正常计算进度
            for (let chessIndex = 0; chessIndex < pieceCount; chessIndex++) {
                const chess = playerChess[chessIndex];
                if (!chess) {
                    continue;
                }
                
                if (chess.finished) {
                    // 棋子已完成，给该棋子的完整进度权重
                    totalProgress += progressPerPiece;
                } else if (chess.position === -1) {
                    // 棋子在起始区域，进度为0
                    totalProgress += 0;
                } else {
                    // 棋子在轨道上，根据位置计算进度
                    // 位置0-56对应0到该棋子权重的进度
                    const chessProgress = Math.min((chess.position / 56) * progressPerPiece, progressPerPiece);
                    totalProgress += chessProgress;
                }
            }

            // 使用更精确的舍入方法，避免浮点数精度问题
            const result = Math.round(totalProgress * 10000) / 10000; // 保留四位小数后再舍入
            return Math.round(result * 100) / 100; // 最终保留两位小数
        } catch (error) {
            console.error(`计算玩家${player}进度时出错:`, error);
            return 0;
        }
    }

    // 更新单个玩家的进度显示
    updatePlayerProgress(player, progress) {
        const item = this.progressItems[player];
        if (!item) return;

        const percentage = Math.round(progress);
        
        // 更新进度条宽度
        item.fillElement.style.width = `${percentage}%`;
    }

    // 更新所有玩家的进度
    updateAllProgress(gameState) {
        const progressData = [];

        // 计算所有玩家的进度
        for (let player = 1; player <= 4; player++) {
            const progress = this.calculatePlayerProgress(player, gameState);
            progressData.push({
                player: player,
                progress: progress
            });
            
            // 更新显示
            this.updatePlayerProgress(player, progress);
        }

        // 按进度排序并重新排列
        this.sortProgressItems(progressData);
    }

    // 根据进度对进度条进行排序
    sortProgressItems(progressData) {
        // 按进度从高到低排序
        progressData.sort((a, b) => b.progress - a.progress);

        // 获取当前DOM元素的顺序
        const currentOrder = Array.from(this.progressContent.children).map(element => {
            return parseInt(element.getAttribute('data-player'));
        });

        // 计算新的顺序
        const newOrder = progressData.map(data => data.player);

        // 只有当顺序真正发生变化时才重新排列
        const orderChanged = !currentOrder.every((player, index) => player === newOrder[index]);

        if (orderChanged) {
            // 重新排列DOM元素
            progressData.forEach((data, index) => {
                const item = this.progressItems[data.player];
                if (item && item.element) {
                    // 添加移动动画类
                    item.element.classList.add('moving');
                    
                    // 移动到新位置
                    setTimeout(() => {
                        this.progressContent.appendChild(item.element);
                        item.element.classList.remove('moving');
                    }, 50);
                }
            });
        }
    }

    // 重置所有进度显示
    resetAllProgress() {
        for (let player = 1; player <= 4; player++) {
            this.updatePlayerProgress(player, 0);
        }

        // 恢复初始顺序
        const initialOrder = [1, 2, 3, 4];
        initialOrder.forEach(player => {
            const item = this.progressItems[player];
            if (item && item.element) {
                this.progressContent.appendChild(item.element);
            }
        });
    }
}

// 创建全局实例
export const progressDisplay = new ProgressDisplay();
export default ProgressDisplay;