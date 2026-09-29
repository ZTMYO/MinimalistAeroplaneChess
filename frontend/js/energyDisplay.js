import { ENERGY_MAX } from '../../shared/engine.mjs';

class EnergyDisplay {
    constructor() {
        this.energyBars = {}; // 存储每个玩家的积分条元素
        this.maxEnergy = ENERGY_MAX; // 上限只有引擎那一份
    }

    /**
     * 初始化积分条UI
     */
    init() {
        // 为每个玩家创建积分条
        for (let player = 1; player <= 4; player++) {
            this.createEnergyBar(player);
        }
    }

    /**
     * 创建单个玩家的积分条
     * @param {number} player - 玩家编号
     */
    createEnergyBar(player) {
        // 防止重复创建
        if (document.querySelector(`.energy-bar-wrapper.player-${player}`)) {
            return;
        }

        // 桌面端：在 player-info 中添加
        const desktopPlayerInfo = document.querySelector(`.players-info .player-${player}-info`);
        if (desktopPlayerInfo) {
            const energyBarHTML = this.createEnergyBarHTML(player);
            if (player === 3 || player === 4) {
                desktopPlayerInfo.insertAdjacentHTML('afterbegin', energyBarHTML);
            } else {
                desktopPlayerInfo.insertAdjacentHTML('beforeend', energyBarHTML);
            }
        }

        // 移动端：根据玩家位置添加
        if (player === 1 || player === 4) {
            const mobilePlayerInfo = document.querySelector(`.players-top .player-${player}-info`);
            if (mobilePlayerInfo) {
                const energyBarHTML = this.createEnergyBarHTML(player, 'mobile-top');
                mobilePlayerInfo.insertAdjacentHTML('beforeend', energyBarHTML);
            }
        } else if (player === 2) {
            const mobilePlayerInfo = document.querySelector(`.players-bottom .player-2-info`);
            if (mobilePlayerInfo) {
                const energyBarHTML = this.createEnergyBarHTML(player, 'mobile-bottom-2');
                mobilePlayerInfo.insertAdjacentHTML('beforeend', energyBarHTML);
            }
        } else if (player === 3) {
            const mobilePlayerInfo = document.querySelector(`.players-bottom .player-3-info`);
            if (mobilePlayerInfo) {
                const energyBarHTML = this.createEnergyBarHTML(player, 'mobile-bottom-3');
                mobilePlayerInfo.insertAdjacentHTML('afterbegin', energyBarHTML);
            }
        }

        // 存储元素引用
        this.energyBars[player] = {
            containers: document.querySelectorAll(`.energy-bar-container.player-${player}`),
            wrappers: document.querySelectorAll(`.energy-bar-wrapper.player-${player}`),
            fills: document.querySelectorAll(`.energy-bar-fill-${player}`),
            values: document.querySelectorAll(`.energy-value-${player}`)
        };

        // 设置积分条容器的当前玩家颜色
        this.setEnergyBarPlayerColor(player);
    }

    /**
     * 设置积分条容器的当前玩家颜色
     * @param {number} player - 玩家编号
     */
    setEnergyBarPlayerColor(player) {
        const playerColor = this.getPlayerColor(player);
        const containers = document.querySelectorAll(`.energy-bar-container.player-${player}`);
        
        containers.forEach(container => {
            container.style.setProperty('--current-player-color', playerColor);
        });
    }

    /**
     * 生成积分条HTML
     * @param {number} player - 玩家编号
     * @param {string} position - 位置标识（可选）：'mobile-top', 'mobile-bottom-2', 'mobile-bottom-3'
     * @returns {string} HTML字符串
     */
    createEnergyBarHTML(player, position = '') {
        // 根据位置添加额外的class用于CSS定位
        const positionClass = position ? ` energy-bar-${position}` : '';
        return `
            <div class="energy-bar-wrapper player-${player}${positionClass}">
                <div class="energy-bar-container player-${player}">
                    <div class="energy-bar-fill energy-bar-fill-${player} player-${player}"></div>
                </div>
                <div class="energy-value energy-value-${player}">0</div>
            </div>
        `;
    }

    getFallbackParticleStartPosition() {
        const centerArea = document.querySelector('.game-controls-center');
        if (centerArea) {
            const centerRect = centerArea.getBoundingClientRect();
            if (centerRect.width > 0 && centerRect.height > 0) {
                return {
                    x: centerRect.left + centerRect.width / 2,
                    y: centerRect.top + centerRect.height / 2
                };
            }
        }

        return {
            x: window.innerWidth / 2,
            y: window.innerHeight / 2
        };
    }

    getElementCenterPosition(element) {
        if (!element || typeof element.getBoundingClientRect !== 'function') {
            return null;
        }

        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
            };
        }

        const parentRect = element.parentElement ? element.parentElement.getBoundingClientRect() : null;
        if (parentRect && parentRect.width > 0 && parentRect.height > 0) {
            return {
                x: parentRect.left + parentRect.width / 2,
                y: parentRect.top + parentRect.height / 2
            };
        }

        return null;
    }

    getChessCenterPosition(player, chessIndex) {
        const playerChess = window.gameState?.getPlayerChess?.();
        const chessObj = playerChess?.[player]?.[chessIndex];
        return this.getElementCenterPosition(chessObj?.element);
    }

    resolveParticleStartPosition(startSource, startChessIndex) {
        try {
            if (startSource && typeof startSource.x === 'number' && typeof startSource.y === 'number') {
                return { x: startSource.x, y: startSource.y };
            }

            if (startSource && typeof startSource.getBoundingClientRect === 'function') {
                const elementCenter = this.getElementCenterPosition(startSource);
                if (elementCenter) {
                    return elementCenter;
                }
            } else if (typeof startSource === 'number') {
                const chessCenter = this.getChessCenterPosition(startSource, startChessIndex);
                if (chessCenter) {
                    return chessCenter;
                }
            }
        } catch (e) {
            console.warn('[积分动画] 获取起点坐标失败，使用屏幕中心', e);
        }

        return this.getFallbackParticleStartPosition();
    }

    /**
     * 播放积分获取粒子动画
     * @param {number|Element|Object} startSource - 起点（可以是玩家编号、DOM元素、或 {x, y} 坐标快照）
     * @param {number|null} startChessIndex - 起点棋子索引（当startSource为玩家编号时使用）
     * @param {number} endPlayer - 终点玩家（获得积分者）
     * @param {Function} onComplete - 动画完成后的回调函数
     * @param {number} amount - 获取的积分值，用于决定粒子数量
     * @param {number} delay - 动画延迟触发时间（毫秒）
     */
    playEnergyParticles(startSource, startChessIndex, endPlayer, onComplete, amount = 10, delay = 0) {
        if (delay > 0) {
            setTimeout(() => {
                this.playEnergyParticles(startSource, startChessIndex, endPlayer, onComplete, amount, 0);
            }, delay);
            return;
        }

        const startPosition = this.resolveParticleStartPosition(startSource, startChessIndex);
        const startX = startPosition.x;
        const startY = startPosition.y;

        // 尝试获取终点坐标（寻找可见的积分条）
        let endX = window.innerWidth / 2;
        let endY = window.innerHeight / 2;
        let foundEnd = false;

        if (this.energyBars[endPlayer] && this.energyBars[endPlayer].wrappers) {
            for (let i = 0; i < this.energyBars[endPlayer].wrappers.length; i++) {
                const wrapper = this.energyBars[endPlayer].wrappers[i];
                const rect = wrapper.getBoundingClientRect();
                // 检查元素是否可见（宽高大于0）
                if (rect.width > 0 && rect.height > 0) {
                    endX = rect.left + rect.width / 2;
                    endY = rect.top + rect.height / 2;
                    foundEnd = true;
                    break;
                }
            }
        }

        if (!foundEnd) {
            console.warn('[积分动画] 未找到可见的积分条，跳过动画');
            if (onComplete) onComplete();
            return;
        }

        // 创建粒子容器
        const particleContainer = document.createElement('div');
        particleContainer.className = 'energy-particle-layer';
        document.body.appendChild(particleContainer);

        // 粒子颜色（使用玩家边框颜色）
        const color = this.getPlayerParticleColor(endPlayer);
        
        // 根据获取的积分值动态计算粒子数量 (每2点积分约等于1个粒子，限制在 6-25 之间)
        // 使用 amount 至少为 1 以防异常
        const baseCount = Math.max(1, Math.floor(amount / 2));
        const particleCount = Math.min(Math.max(baseCount + Math.floor(Math.random() * 4), 6), 25);
        
        let completedCount = 0;

        for (let i = 0; i < particleCount; i++) {
            const particle = document.createElement('div');
            particle.className = 'energy-particle';

            particle.style.setProperty('--energy-particle-color', color);
            
            particle.style.left = `${startX - 2}px`;
            particle.style.top = `${startY - 2}px`;
            
            particleContainer.appendChild(particle);

            // 第一阶段：向外随机散开 (爆点)
            const angle = Math.random() * Math.PI * 2;
            const distance = Math.random() * 40 + 20; // 20-60px的散开距离
            const scatterX = startX + Math.cos(angle) * distance;
            const scatterY = startY + Math.sin(angle) * distance;

            // 动画时间
            const scatterDuration = 300 + Math.random() * 200; // 300-500ms
            const flyDuration = 500 + Math.random() * 300; // 500-800ms
            const flyDelay = scatterDuration + Math.random() * 200; // 散开后停留一下

            // 使用 Web Animations API 播放第一阶段散开
            const scatterAnim = particle.animate([
                { transform: 'scale(0) translate(0, 0)', opacity: 0 },
                { transform: 'scale(1)', opacity: 1, offset: 0.3 },
                { transform: `scale(1) translate(${scatterX - startX}px, ${scatterY - startY}px)`, opacity: 1 }
            ], {
                duration: scatterDuration,
                easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
                fill: 'forwards'
            });

            // 第二阶段：飞向终点
            scatterAnim.onfinish = () => {
                // 贝塞尔曲线控制点，让粒子划出弧线
                const ctrlX = scatterX + (endX - scatterX) * 0.5 + (Math.random() - 0.5) * 200;
                const ctrlY = scatterY + (endY - scatterY) * 0.5 - 100 - Math.random() * 100; // 稍微向上弯曲

                // 稍微错开起飞时间
                setTimeout(() => {
                    // 使用多帧关键点模拟贝塞尔曲线
                    const frames = [];
                    const steps = 15; // 增加关键帧以平滑曲线
                    for (let j = 0; j <= steps; j++) {
                        const t = j / steps;
                        // 二次贝塞尔曲线公式: (1-t)^2*P0 + 2t(1-t)*P1 + t^2*P2
                        const currentX = Math.pow(1 - t, 2) * scatterX + 2 * t * (1 - t) * ctrlX + Math.pow(t, 2) * endX;
                        const currentY = Math.pow(1 - t, 2) * scatterY + 2 * t * (1 - t) * ctrlY + Math.pow(t, 2) * endY;
                        
                        frames.push({
                            transform: `translate(${currentX - startX}px, ${currentY - startY}px) scale(${1 - t * 0.5})`,
                            opacity: 1 - t * 0.3 // 飞行中逐渐变小并略微透明
                        });
                    }

                    const flyAnim = particle.animate(frames, {
                        duration: flyDuration,
                        easing: 'ease-in-out',
                        fill: 'forwards'
                    });

                    flyAnim.onfinish = () => {
                        particle.remove();
                        completedCount++;
                        if (completedCount === particleCount) {
                            particleContainer.remove();
                            if (onComplete) onComplete();
                        }
                    };
                }, Math.random() * 200);
            };
        }
    }

    /**
     * 更新积分条显示
     * @param {number} player - 玩家编号
     * @param {number} energy - 当前积分值
     */
    updateEnergyBar(player, energy) {
        if (!this.energyBars[player]) {
            console.warn(`玩家${player}的积分条未初始化`);
            return;
        }

        const percentage = Math.min((energy / this.maxEnergy) * 100, 100);
        const energyElements = this.energyBars[player];

        // 更新所有积分条填充高度
        energyElements.fills.forEach(fill => {
            fill.style.height = `${percentage}%`;

            // 积分满时添加特殊样式
            if (energy >= this.maxEnergy) {
                fill.classList.add('energy-bar-full');
            } else {
                fill.classList.remove('energy-bar-full');
            }
        });

        // 更新积分条容器的满积分状态（用于粒子效果 - 超过40即触发）
        energyElements.wrappers.forEach(wrapper => {
            if (energy > 40) {
                wrapper.classList.add('energy-full');
            } else {
                wrapper.classList.remove('energy-full');
            }
        });

        // 更新数值显示
        const displayValue = Math.floor(energy);
        energyElements.values.forEach(value => {
            value.textContent = displayValue;
        });
    }

    /**
     * 显示获得积分的动画
     * @param {number} player - 玩家编号
     * @param {number} amount - 获得的积分值
     * 注：已禁用，不在积分条旁边显示文字，改为在骰子位置显示
     */
    showEnergyGainAnimation(player, amount) {
        // 不再在积分条旁边显示文字
        // 积分获得动画已改为在骰子位置显示（由skillManager处理）
        return;
    }

    /**
     * 积分满时的特效
     * @param {number} player - 玩家编号
     */
    triggerFullEnergyEffect(player) {
        console.log(`玩家${player}积分已满！`);

        if (!this.energyBars[player]) {
            return;
        }

        const energyElements = this.energyBars[player];

        // 添加闪烁效果
        energyElements.fills.forEach(fill => {
            fill.classList.add('energy-bar-full');
        });

    }

    /**
     * 获取玩家颜色
     * @param {number} player - 玩家编号
     * @returns {string} 颜色值
     */
    getPlayerColor(player) {
        // 尝试从 CSS 变量获取颜色
        try {
            const rootStyle = getComputedStyle(document.documentElement);
            const cssColor = rootStyle.getPropertyValue(`--player-${player}-color`).trim();
            if (cssColor) {
                return cssColor;
            }
        } catch (e) {
            console.warn('[积分动画] 无法获取CSS变量，使用回退颜色', e);
        }

        return '#ffffff';
    }

    /**
     * 获取玩家粒子颜色（使用边框颜色）
     * @param {number} player - 玩家编号
     * @returns {string} 颜色值
     */
    getPlayerParticleColor(player) {
        // 尝试从 CSS 变量获取边框颜色
        try {
            const rootStyle = getComputedStyle(document.documentElement);
            const cssColor = rootStyle.getPropertyValue(`--player-${player}-color`).trim();
            if (cssColor) {
                return cssColor;
            }
        } catch (e) {
            console.warn('[积分粒子] 无法获取边框CSS变量，使用回退颜色', e);
        }

        return '#ffffff';
    }

    /**
     * 清理所有积分条
     */
    destroy() {
        for (let player = 1; player <= 4; player++) {
            const elements = document.querySelectorAll(`.energy-bar-wrapper`);
            elements.forEach(el => {
                if (el.parentNode) {
                    el.parentNode.removeChild(el);
                }
            });
        }
        this.energyBars = {};
        console.log('积分显示系统已清理');
    }
}

// 创建全局实例
export const energyDisplay = new EnergyDisplay();
export default EnergyDisplay;
