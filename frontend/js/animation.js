import { gameState } from './gameState.js';
import { utils } from './utils.js';
import { audioManager } from './audioManager.js';

// 动画延迟常量
export const ANIMATION_DELAY = {
    BEAT_HOME_JUMP: 150,      // 跳跃落地击败后的回家延迟
    BEAT_HOME_FLY_MID: 150,     // 飞棋中途击败后的回家延迟
    BEAT_HOME_FLY_END: 250,   // 飞棋落地击败后的回家延迟
    BEAT_HOME_MOVE: 150,        // 普通移动击败后的回家延迟
    TRANSITION_BACKUP: 50,    // CSS transition 备用定时器延迟
};

class Animation {
    constructor(gameState, utils) {
        this.gameState = gameState;
        this.utils = utils;
    }

    /**
     * 恢复棋子到起始位置（仅视觉，不触发同步）
     */
    restoreChessToStart(player, chessIndex) {
        const chess = this.gameState.playerChess[player][chessIndex];
        const startPos = this.gameState.startPositions[player][chessIndex];

        if (!chess.element || !startPos) {
            return false;
        }

        const chessOffset = -5.6;
        const rotations = { 1: 180, 2: 270, 3: 0, 4: 90 };
        const baseRotation = rotations[player];
        const rotationOffset = this.getRotationOffset();
        const positionRotation = this.utils.getChessRotationAtPosition(chess.position);

        // 目标位置
        const targetX = startPos.x + chessOffset;
        const targetY = startPos.y + chessOffset;
        const centerX = targetX + 5.6;
        const centerY = targetY + 5.6;

        // 直接设置位置，不使用动画
        chess.element._moveToken = null;
        chess.element.setAttribute('x', targetX);
        chess.element.setAttribute('y', targetY);
        // 核心修正：恢复最原始的叠加旋转，不做任何“抵消” baseRotation 的操作
        chess.element.setAttribute('transform', `rotate(${baseRotation},0,0) rotate(${positionRotation},${centerX},${centerY})`);
        
        // 更新阴影：传入相对于棋盘的“最终总角度”，让 updateChessShadow 去做屏幕空间的对齐
        this.updateChessShadow(player, chessIndex, baseRotation + positionRotation);

        chess.element.classList.add('no-transition');
        chess.element.classList.remove('chess-transition');
        chess.element.classList.remove('chess-stacked');
        chess.element.style.cursor = 'pointer';
        chess.element.style.opacity = '1';
        chess.element.setAttribute('href', '#chess');
        return true;
    }

    /**
     * 将棋子恢复到完成位置（通常用于棋盘旋转后修正对勾角度）
     */
    restoreChessToFinish(player, chessIndex) {
        const chess = this.gameState.playerChess[player][chessIndex];
        const startPos = this.gameState.startPositions[player][chessIndex];

        if (chess.element && startPos) {
            const chessOffset = -5.6;
            const rotations = { 1: 180, 2: 270, 3: 0, 4: 90 };
            const baseRotation = rotations[player];
            const rotationOffset = this.getRotationOffset();

            const targetX = startPos.x + chessOffset;
            const targetY = startPos.y + chessOffset;
            const centerX = targetX + 5.6;
            const centerY = targetY + 5.6;

            chess.element._moveToken = null;
            chess.element.classList.add('no-transition');
            chess.element.setAttribute('x', targetX);
            chess.element.setAttribute('y', targetY);
            
            // 核心修正：抵消基础旋转和棋盘旋转，使勾号始终正向朝上
            chess.element.setAttribute('transform', `rotate(${baseRotation},0,0) rotate(${-baseRotation - rotationOffset},${centerX},${centerY})`);
            
            // 更新阴影：勾号正向朝上时，相对于棋盘的旋转就是 -rotationOffset
            this.updateChessShadow(player, chessIndex, -rotationOffset);

            chess.element.classList.remove('no-transition');
            chess.element.classList.remove('chess-stacked');
            chess.element.classList.add('chess-transition');
            chess.element.style.opacity = '1';
            chess.element.style.cursor = 'default';
            // 确保显示勾号
            chess.element.setAttribute('href', '#checkmark');
        }
    }


    moveChessToStart(player, chessIndex, playerChess = null, skipSync = false, delay = 0, skipBringToFront = false) {
        // 如果传入了playerChess参数，使用传入的；否则使用gameState中的
        const chessData = playerChess || this.gameState.playerChess;
        const chess = chessData[player][chessIndex];
        const startPos = this.gameState.startPositions[player][chessIndex];

        // beat 引发的回家动画可能与当前行动动画重叠，允许跳过层级调整以避免打断 transition
        if (!skipBringToFront) {
            this.bringToFront(player, chessIndex);
        }

        // 更新棋子的游戏状态
        chess.position = -1;
        if (this.chessPiece) {
            chess.lastLandPos = this.chessPiece.generateUniqueLastLandPos(chess.position);
        }
        chess.finished = false;

        if (!chess.element || !startPos) {
            return;
        }

        const chessOffset = -5.6;
        const rotations = { 1: 180, 2: 270, 3: 0, 4: 90 };
        const baseRotation = rotations[player];
        const targetX = startPos.x + chessOffset;
        const targetY = startPos.y + chessOffset;
        
        // 获取当前棋子的实际位置（考虑旋转变换）
        const currentX = parseFloat(chess.element.getAttribute('x'));
        const currentY = parseFloat(chess.element.getAttribute('y'));

        // 检查棋子是否需要移动动画：如果当前DOM位置与目标位置不同，则需要动画
        const needsAnimation = Math.abs(currentX - targetX) > 1 || Math.abs(currentY - targetY) > 1;
        
        const executeAnimation = () => {
            if (needsAnimation) {
                // 临时禁用CSS transition，使用JavaScript动画实现直线移动
                chess.element.classList.add('no-transition');
                chess.element.classList.remove('chess-transition');
                // 击败音效由事件回放统一播（enginePlayback.playBeat），这里别再响一次
                
                // 执行直线动画
                this.animateDirectMovement(player, chessIndex, chess.element, currentX, currentY, targetX, targetY, baseRotation, () => {
                    // 动画完成后的回调
                    chess.element.classList.remove('chess-stacked');
                    chess.element.style.cursor = 'pointer';
                    chess.element.style.opacity = '1';
                    chess.element.setAttribute('href', '#chess');
                });
            } else {
                // 如果棋子已经在起始区域，直接设置位置
                chess.element.setAttribute('x', targetX);
                chess.element.setAttribute('y', targetY);
                // 恢复基础旋转
                chess.element.setAttribute('transform', `rotate(${baseRotation},0,0)`);
                
                // 更新阴影
                this.updateChessShadow(player, chessIndex, baseRotation);

                chess.element.classList.remove('chess-stacked');
                chess.element.classList.add('chess-transition');
                chess.element.classList.remove('no-transition');
                chess.element.style.cursor = 'pointer';
                chess.element.style.opacity = '1';
                chess.element.setAttribute('href', '#chess');
            }
        };

        if (delay > 0) {
            setTimeout(executeAnimation, delay);
        } else {
            executeAnimation();
        }
    }

    /**
     * 直线动画方法
     */
    animateDirectMovement(player, chessIndex, element, startX, startY, endX, endY, baseRotation, callback, isFinishAnimation = false) {
        const duration = 500; // 动画持续时间（毫秒）
        const startTime = performance.now();
        // 归属标记：直接落位或后发起的动画会把它顶掉，旧动画下一帧就自行收手
        const token = {};
        element._moveToken = token;

        // 预先获取初始位置的旋转角度
        const chess = this.gameState.playerChess[player][chessIndex];
        const positionRotation = this.utils.getChessRotationAtPosition(chess.position);
        
        const animate = (currentTime) => {
            if (element._moveToken !== token) return;
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // 使用缓动函数（ease-out）
            const easeProgress = 1 - Math.pow(1 - progress, 3);

            // 计算当前位置
            const currentX = startX + (endX - startX) * easeProgress;
            const currentY = startY + (endY - startY) * easeProgress;

            // 更新元素位置
            element.setAttribute('x', currentX);
            element.setAttribute('y', currentY);
            
            // 计算中心点用于旋转
            const centerX = currentX + 5.6;
            const centerY = currentY + 5.6;

            // 始终保持正确朝向：基础旋转 + 位置旋转
            element.setAttribute('transform', `rotate(${baseRotation},0,0) rotate(${positionRotation},${centerX},${centerY})`);
            
            // 更新阴影：传入棋子相对于棋盘的最终绝对旋转角度
            this.updateChessShadow(player, chessIndex, baseRotation + positionRotation);

            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                // 动画完成，恢复CSS transition并执行回调
                element.classList.add('chess-transition');
                element.classList.remove('no-transition');
                if (callback) callback();
            }
        };

        requestAnimationFrame(animate);
    }

    /**
     * 更新所有棋子的位置
     */
    updateAllChessPositions(animate = true) {
        const pieceCount = this.gameState.pieceCount || 4; // 获取当前棋子个数，默认为4
        for (let player = 1; player <= 4; player++) {
            for (let i = 0; i < pieceCount; i++) {
                this.updateChessPosition(player, i, null, animate);
            }
        }
    }

    /**
     * 将棋子移动到完成位置
     */
    moveChessToFinish(player, chessIndex, skipSync = false) {
        const chess = this.gameState.playerChess[player][chessIndex];
        const startPos = this.gameState.startPositions[player][chessIndex];

        // 移动开始前，先将棋子移到最顶层
        this.bringToFront(player, chessIndex);

        if (chess.element && startPos) {
            const chessOffset = -5.6;
            const baseRotations = { 1: 180, 2: 270, 3: 0, 4: 90 };
            const baseRotation = baseRotations[player];

            // 获取当前棋子的实际位置
            const currentX = parseFloat(chess.element.getAttribute('x'));
            const currentY = parseFloat(chess.element.getAttribute('y'));

            // 目标位置
            const targetX = startPos.x + chessOffset;
            const targetY = startPos.y + chessOffset;

            // 使用直线动画移动到完成位置
            chess.element.classList.add('no-transition');
            chess.element.classList.remove('chess-transition');
            audioManager.playFlySound();
            // 执行直线动画
            this.animateDirectMovement(player, chessIndex, chess.element, currentX, currentY, targetX, targetY, baseRotation, () => {
                // 动画完成后的回调
                chess.element.classList.remove('chess-stacked');
                chess.element.style.cursor = 'default';
                chess.element.style.opacity = '1';
                // 切换为勾号图案
                chess.element.setAttribute('href', '#checkmark');
                
                // 核心优化：直接设置最终位置和旋转，不产生额外的自转动画
                const centerX = targetX + 5.6;
                const centerY = targetY + 5.6;
                const rotationOffset = this.getRotationOffset();
                
                // 移除过渡效果以实现瞬间切换图案和修正角度
                chess.element.classList.add('no-transition');
                // 核心修正：抵消基础旋转和棋盘旋转，使勾号始终正向朝上
                chess.element.setAttribute('transform', `rotate(${baseRotation},0,0) rotate(${-baseRotation - rotationOffset},${centerX},${centerY})`);
                
                // 更新阴影：勾号正向朝上时，相对于棋盘的旋转就是 -rotationOffset
                this.updateChessShadow(player, chessIndex, -rotationOffset);
                
                // 强制重绘后恢复过渡
                if (chess.element instanceof SVGElement) {
                    try { chess.element.getBBox(); } catch (e) {}
                }
                chess.element.classList.remove('no-transition');
                chess.element.classList.add('chess-transition');
                
                audioManager.playFinishSound();
            }, true); // 传入 isFinishAnimation 标志
        } else {
            console.error(`[Animation] moveChessToFinish失败 - 玩家${player}棋子${chessIndex}`);
            console.error(`[Animation] 棋子DOM元素: ${chess.element ? '存在' : '不存在'}`);
            console.error(`[Animation] 起始位置数据: ${startPos ? '存在' : '不存在'}`);
        }
    }

    /**
     * 获取当前全局旋转补偿角度
     * @returns {number} 补偿角度
     */
    getRotationOffset() {
        return window.boardRotation || 0;
    }

    /**
     * 更新棋子阴影方向，使其在屏幕上始终朝下
     * @param {number} player - 玩家编号
     * @param {number} chessIndex - 棋子索引
     * @param {number} absoluteBoardRotation - 棋子相对于棋盘的绝对旋转角度（已包含baseRotation和positionRotation）
     */
    updateChessShadow(player, chessIndex, absoluteBoardRotation) {
        const chess = this.gameState.playerChess[player][chessIndex];
        if (!chess || !chess.element) return;

        // 获取棋盘相对于屏幕的旋转角度
        const boardRotation = this.getRotationOffset();
        
        // 计算棋子相对于屏幕的绝对旋转角度
        const absoluteScreenRotation = absoluteBoardRotation + boardRotation;
        
        // 将角度转为弧度
        const rad = (absoluteScreenRotation * Math.PI) / 180;
        
        // 计算补偿后的 dx 和 dy，使得阴影在屏幕空间永远指向 (0, 1)
        // 我们需要抵消掉棋子本身的所有旋转
        const dx = Math.sin(rad).toFixed(3);
        const dy = Math.cos(rad).toFixed(3);
        
        // 应用阴影
        chess.element.style.filter = `drop-shadow(${dx}px ${dy}px 0.5px var(--shadow-2))`;
    }

    /**
     * 更新棋子位置
     */
    updateChessPosition(player, chessIndex, callback = null, animate = true) {
        return new Promise(async (resolve) => {
            const chess = this.gameState.playerChess[player][chessIndex];
            
            // 如果棋子已完成，使用专门的完成状态恢复方法，确保对勾旋转角度正确
            if (chess.finished) {
                this.restoreChessToFinish(player, chessIndex);
                if (callback) {
                    const result = callback();
                    if (result instanceof Promise) await result;
                }
                resolve();
                return;
            }

            // 如果棋子在起始区域，使用专门的恢复方法
            if (chess.position === -1) {
                this.restoreChessToStart(player, chessIndex);
                if (callback) {
                    const result = callback();
                    if (result instanceof Promise) await result;
                }
                resolve();
                return;
            }

            const trackPos = this.gameState.mainTrack[chess.position];

            if (chess.element && trackPos) {
                const chessOffset = -5.6;

                // 获取基于玩家的基础旋转角度
                const rotations = { 1: 180, 2: 270, 3: 0, 4: 90 };
                const baseRotation = rotations[player];
                
                // 获取基于位置的旋转角度
                const positionRotation = this.utils.getChessRotationAtPosition(chess.position);
                const rotationOffset = this.getRotationOffset();

                // 计算叠加偏移
                const stackOffset = this.calculateStackOffset(player, chessIndex, chess.position);
                
                // 处理叠子外轮廓样式
                if (chess.element) {
                    const hasStackOffset = (stackOffset.x !== 0 || stackOffset.y !== 0);
                    const isFinishLane = chess.position >= 51 && chess.position <= 56;
                    const shouldHighlightStack = chess.position !== 0 && (!isFinishLane || chess.position === 53);
                    const isStacked = hasStackOffset && shouldHighlightStack;
                    if (isStacked) {
                        chess.element.classList.add('chess-stacked');
                    } else {
                        chess.element.classList.remove('chess-stacked');
                    }
                }

                // 棋子中心坐标（包含叠加偏移）
                const centerX = trackPos.x + chessOffset + 5.6 + stackOffset.x;
                const centerY = trackPos.y + chessOffset + 5.6 + stackOffset.y;

                if (!animate) {
                    chess.element._moveToken = null;
                    chess.element.classList.add('no-transition');
                    chess.element.classList.remove('chess-transition');
                    
                    chess.element.setAttribute('x', trackPos.x + chessOffset + stackOffset.x);
                    chess.element.setAttribute('y', trackPos.y + chessOffset + stackOffset.y);
                    // 恢复朝向
                    chess.element.setAttribute('transform', `rotate(${baseRotation},0,0) rotate(${positionRotation},${centerX},${centerY})`);
                    
                    // 更新阴影
                    this.updateChessShadow(player, chessIndex, baseRotation + positionRotation);

                    // 强制重绘
                    if (chess.element instanceof SVGElement) {
                        try { chess.element.getBBox(); } catch (e) {}
                    }
                    if (callback) {
                        const result = callback();
                        if (result instanceof Promise) await result;
                    }
                    resolve();
                } else {
                    // 确保先启用过渡类
                    chess.element.classList.add('chess-transition');
                    chess.element.classList.remove('no-transition');

                    // 强制触发一次重绘，确保浏览器记录下当前的起始位置，防止“闪现”
                    try { chess.element.getBBox(); } catch (e) {}

                    // 直接更新属性，不再使用 requestAnimationFrame，
                    // 配合 getBBox() 强制同步，在大多数现代浏览器中足以触发 transition
                    chess.element.setAttribute('x', trackPos.x + chessOffset + stackOffset.x);
                    chess.element.setAttribute('y', trackPos.y + chessOffset + stackOffset.y);
                    // 叠加旋转
                    chess.element.setAttribute('transform', `rotate(${baseRotation},0,0) rotate(${positionRotation},${centerX},${centerY})`);

                    // 更新阴影
                    this.updateChessShadow(player, chessIndex, baseRotation + positionRotation);

                    let callbackExecuted = false;
                    const finish = async () => {
                        if (callbackExecuted) return;
                        callbackExecuted = true;
                        chess.element.removeEventListener('transitionend', handleTransitionEnd);
                        if (callback) {
                            const result = callback();
                            if (result instanceof Promise) await result;
                        }
                        resolve();
                    };

                    const handleTransitionEnd = (event) => {
                        if (event.target === chess.element && (event.propertyName === 'transform' || event.propertyName === 'x' || event.propertyName === 'y')) {
                            finish();
                        }
                    };
                    chess.element.addEventListener('transitionend', handleTransitionEnd);
                    
                    // 备用定时器，防止 transitionend 事件不触发
                    setTimeout(finish, ANIMATION_DELAY.TRANSITION_BACKUP);
                }
            } else {
                resolve();
            }
        });
    }

    /**
     * 将棋子移到最顶层显示
     * @param {number} player - 玩家编号
     * @param {number} chessIndex - 棋子索引
     */
    bringToFront(player, chessIndex) {
        const chess = this.gameState.playerChess[player][chessIndex];
        if (chess && chess.element && chess.element.parentNode) {
            if (this.gameState.isInChessAnimation) {
                return;
            }
            if (chess.element.parentNode.lastChild !== chess.element) {
                chess.element.parentNode.appendChild(chess.element);
                window.getComputedStyle(chess.element).transform;
            }
        }
    }

    /**
     * 计算棋子叠加偏移
     */
    calculateStackOffset(player, chessIndex, position) {
        // 如果棋子在起始区域或已完成，不需要偏移
        if (position === -1 || this.gameState.playerChess[player][chessIndex].finished) {
            return { x: 0, y: 0 };
        }

        // 获取同一位置的己方棋子
        const samePositionChess = [];
        const pieceCount = this.gameState.pieceCount; // 获取当前棋子个数
        for (let i = 0; i < pieceCount; i++) {
            const chess = this.gameState.playerChess[player][i];
            if (!chess.finished && chess.position === position) {
                samePositionChess.push({ index: i, lastLandPos: chess.lastLandPos || 0 });
            }
        }

        // 如果只有一个棋子在这个位置，不需要偏移
        if (samePositionChess.length <= 1) {
            return { x: 0, y: 0 };
        }

        // 按 lastLandPos 升序排序
        samePositionChess.sort((a, b) => a.lastLandPos - b.lastLandPos);

        // 找到当前棋子在排序后列表中的索引
        const stackIndex = samePositionChess.findIndex(item => item.index === chessIndex);
        if (stackIndex === -1) {
            return { x: 0, y: 0 };
        }

        // 根据棋子数量动态调节偏移量
        const chessCount = samePositionChess.length;
        let baseOffset;
        if (chessCount === 2) {
            baseOffset = 2.5; // 2颗棋子时偏移量较大
        } else if (chessCount === 3) {
            baseOffset = 2.0; // 3颗棋子时偏移量中等
        } else {
            baseOffset = 1.5; // 4颗棋子时偏移量较小
        }

        // 根据位置旋转角度决定偏移方向
        const positionRotation = this.utils.getChessRotationAtPosition(player, position, this.gameState);

        // 确定偏移方向
        let direction;
        if (Math.abs(positionRotation) === 180 || positionRotation === 0) {
            // positionRotation为±180或0时，棋子朝向为水平轴，偏移使用垂直轴
            direction = { x: 0, y: 1 };
        } else if (Math.abs(positionRotation) === 90 || Math.abs(positionRotation) === 270) {
            // positionRotation为90或270时，棋子朝向为垂直轴，偏移使用水平轴
            direction = { x: 1, y: 0 };
        } else {
            // 默认情况
            direction = { x: 0, y: 1 };
        }

        // 计算双向偏移，保持棋子在中心
        let offsetMultiplier;
        if (chessCount === 2) {
            // 2颗棋子：一个向负方向，一个向正方向
            offsetMultiplier = stackIndex === 0 ? -0.5 : 0.5;
        } else if (chessCount === 3) {
            // 3颗棋子：中间不偏移，两边各偏移
            offsetMultiplier = stackIndex === 0 ? -1 : (stackIndex === 1 ? 0 : 1);
        } else {
            // 4颗棋子：两个向负方向，两个向正方向
            offsetMultiplier = stackIndex < 2 ? -(1.5 - stackIndex * 0.5) : (stackIndex - 1.5) * 0.5;
        }

        return {
            x: direction.x * baseOffset * offsetMultiplier,
            y: direction.y * baseOffset * offsetMultiplier
        };
    }

    /**
     * 按当前棋面重算叠子样式与偏移。
     * 叠子被拆开后，留在原地的那颗不会再有任何位置更新，
     * 只在被移动的那颗身上 toggle 类名，就会把它永远留在叠子外观上。
     */
    refreshStackStyles() {
        const pieceCount = this.gameState.pieceCount || 4;
        const countAt = new Map(); // 「玩家:位置」→ 该格有几颗己方棋子
        for (let player = 1; player <= 4; player++) {
            const pieces = this.gameState.playerChess[player];
            if (!pieces) continue;
            for (let i = 0; i < pieceCount; i++) {
                const chess = pieces[i];
                if (!chess || chess.finished || chess.position < 0) continue;
                const key = `${player}:${chess.position}`;
                countAt.set(key, (countAt.get(key) || 0) + 1);
            }
        }

        for (let player = 1; player <= 4; player++) {
            const pieces = this.gameState.playerChess[player];
            if (!pieces) continue;
            for (let i = 0; i < pieceCount; i++) {
                const chess = pieces[i];
                if (!chess || !chess.element) continue;
                const stacked = (countAt.get(`${player}:${chess.position}`) || 0) > 1;
                // 只碰「现在是叠子」和「还挂着旧样式」的棋子，其余不动，免得打断正在跑的动画
                if (stacked || chess.element.classList.contains('chess-stacked')) {
                    this.updateChessPosition(player, i, null, true);
                }
            }
        }
    }


}

// 创建并导出动画实例
export const animation = new Animation(gameState, utils);
export default Animation;
