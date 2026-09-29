class DefeatCountDisplay {
    constructor() {
        this.defeatCountElements = {};
        this.initializeElements();
    }

    // 初始化击败次数显示元素
    initializeElements() {
        for (let player = 1; player <= 4; player++) {
            this.defeatCountElements[player] = {};
            for (let opponent = 1; opponent <= 4; opponent++) {
                if (player !== opponent) {
                    // 桌面端元素
                    const elementId = `defeat-count-${player}-${opponent}`;
                    const element = document.getElementById(elementId);
                    if (element) {
                        this.defeatCountElements[player][opponent] = element;
                    }

                    // 移动端元素
                    const mobileElementId = `defeat-count-mobile-${player}-${opponent}`;
                    const mobileElement = document.getElementById(mobileElementId);
                    if (mobileElement) {
                        // 如果没有桌面端元素，直接使用移动端元素
                        if (!this.defeatCountElements[player][opponent]) {
                            this.defeatCountElements[player][opponent] = mobileElement;
                        } else {
                            // 如果有桌面端元素，创建数组存储两个元素
                            this.defeatCountElements[player][opponent] = [
                                this.defeatCountElements[player][opponent],
                                mobileElement
                            ];
                        }
                    }
                }
            }
        }
    }

    // 更新击败次数显示
    updateDefeatCount(attackerPlayer, defeatedPlayer, count) {
        const element = this.defeatCountElements[attackerPlayer]?.[defeatedPlayer];
        if (element) {
            // 格式化显示，默认显示为单个数字，不使用三位数格式
            const formattedCount = count.toString();
            
            // 如果element是数组（同时有桌面端和移动端元素）
            if (Array.isArray(element)) {
                element.forEach(el => {
                    if (el) {
                        el.textContent = formattedCount;
                    }
                });
            } else {
                // 单个元素
                element.textContent = formattedCount;
            }
        }
    }


    // 重置所有击败次数显示
    resetAllDefeatCounts() {
        for (let player = 1; player <= 4; player++) {
            for (let opponent = 1; opponent <= 4; opponent++) {
                if (player !== opponent) {
                    this.updateDefeatCount(player, opponent, 0);
                }
            }
        }
    }
}

// 创建并导出击败次数显示实例
export const defeatCountDisplay = new DefeatCountDisplay();
export default DefeatCountDisplay;