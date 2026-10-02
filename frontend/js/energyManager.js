import { gameState } from './gameState.js';
import { ENERGY_MAX } from '../../shared/engine.mjs';

class EnergyManager {
    constructor() {
        this.skillModeEnabled = false;
        this.maxEnergy = ENERGY_MAX;

        this.playerEnergy = {
            1: 0,
            2: 0,
            3: 0,
            4: 0
        };
        this.energyDisplay = null; // 将在初始化时设置
    }

    /**
     * 初始化积分系统
     */
    init() {
        // 检查是否启用道具模式（本地模式读开局配置，联机由服务端下发）
        try {
            this.skillModeEnabled = gameState.isSkillModeEnabled();
        } catch (error) {
            console.error('[积分系统] 初始化失败:', error);
            this.skillModeEnabled = false;
        }

        // 重置所有玩家积分
        if (this.skillModeEnabled) {
            this.resetAllEnergy();
        }

        // 更新提示文字
        this._updateHintText();
    }

    /**
     * 更新技能面板提示文字
     */
    _updateHintText() {
        const hintEl = document.querySelector('.skill-energy-hint');
        if (!hintEl) return;
        if (typeof gameState?.isHappyMode === 'function' && gameState.isHappyMode()) {
            hintEl.textContent = '碰撞敌人来获取积分';
        } else {
            hintEl.textContent = '击败玩家来获取积分';
        }
    }

    /**
     * 检查是否启用道具模式
     */
    isSkillModeEnabled() {
        return this.skillModeEnabled;
    }

    /**
     * 设置积分显示模块引用
     */
    setEnergyDisplay(energyDisplay) {
        this.energyDisplay = energyDisplay;
    }


    /**
     * 增加玩家积分
     * @param {number} player - 玩家编号
     * @param {number} amount - 增加的积分值
     * @param {string} source - 积分来源 ('kill', 'mysteryBox', 'happy_bonus')
     * @param {number} targetPlayer - 被击败的玩家（可选）
     * @param {number} targetChessIndex - 被击败的棋子索引（可选）
     * @param {number} delay - 粒子动画延迟（可选）
     */
    addEnergy(player, amount, source = 'mysteryBox', targetPlayer = null, targetChessIndex = null, delay = 0, skipLineSync = false) {
        if (!this.skillModeEnabled) {
            return;
        }

        const oldEnergy = this.playerEnergy[player];
        this.playerEnergy[player] = Math.min(oldEnergy + amount, this.maxEnergy);

        // 记录实际获得的积分（扣除溢出部分，用于结算统计）
        const actualAdded = this.playerEnergy[player] - oldEnergy;
        if (window.gameInstance && window.gameInstance.gameState) {
            window.gameInstance.gameState.totalEnergyGained[player] += actualAdded;
        }

        // 网络回放模式：不添加消息
        const isReplayMode = window.gameInstance && window.gameInstance.chessPiece && window.gameInstance.chessPiece._isNetworkReplayMode;
        
        // 发送积分获取的gameInfo消息（skipLineSync：这条各端都能从事件流自己算出，不必再中转一次）
        if (window.gameInfo && !isReplayMode) {
            window.gameInfo.addEnergyGain(player, Math.round(amount), skipLineSync, source, targetPlayer, targetChessIndex);
        }

        // 更新UI显示
        if (this.energyDisplay) {
            // 如果是因为击杀获得积分，且知道目标，则播放粒子动画并延迟更新进度条
            if (source === 'kill' && targetPlayer !== null && targetChessIndex !== null) {
                const startSource = this.energyDisplay.getChessCenterPosition(targetPlayer, targetChessIndex) || targetPlayer;
                this.energyDisplay.playEnergyParticles(startSource, targetChessIndex, player, () => {
                    this.energyDisplay.updateEnergyBar(player, this.playerEnergy[player]);
                    this.energyDisplay.showEnergyGainAnimation(player, amount);

                    // 检查是否达到满积分
                    if (this.isEnergyFull(player) && oldEnergy < this.maxEnergy) {
                        this.energyDisplay.triggerFullEnergyEffect(player);
                    }
                }, amount, delay);
            } else if (source === 'mysteryBox' && amount > 0) {
                // 如果是盲盒获取积分，获取骰子元素作为起点
                const diceIcon = document.querySelector('.dice-icon');
                if (diceIcon) {
                    this.energyDisplay.playEnergyParticles(diceIcon, null, player, () => {
                        this.energyDisplay.updateEnergyBar(player, this.playerEnergy[player]);
                        this.energyDisplay.showEnergyGainAnimation(player, amount);

                        // 检查是否达到满积分
                        if (this.isEnergyFull(player) && oldEnergy < this.maxEnergy) {
                            this.energyDisplay.triggerFullEnergyEffect(player);
                        }
                    }, amount);
                } else {
                    this.energyDisplay.updateEnergyBar(player, this.playerEnergy[player]);
                    this.energyDisplay.showEnergyGainAnimation(player, amount);

                    if (this.isEnergyFull(player) && oldEnergy < this.maxEnergy) {
                        this.energyDisplay.triggerFullEnergyEffect(player);
                    }
                }
            } else if (source === 'happy_bonus' && targetPlayer !== null && targetChessIndex !== null) {
                // 欢乐模式碰撞奖励：从被碰撞棋子位置发射粒子
                const startSource = this.energyDisplay.getChessCenterPosition(targetPlayer, targetChessIndex) || targetPlayer;
                this.energyDisplay.playEnergyParticles(startSource, targetChessIndex, player, () => {
                    this.energyDisplay.updateEnergyBar(player, this.playerEnergy[player]);
                    this.energyDisplay.showEnergyGainAnimation(player, amount);

                    if (this.isEnergyFull(player) && oldEnergy < this.maxEnergy) {
                        this.energyDisplay.triggerFullEnergyEffect(player);
                    }
                }, amount);
            } else {
                this.energyDisplay.updateEnergyBar(player, this.playerEnergy[player]);
                this.energyDisplay.showEnergyGainAnimation(player, amount);

                // 检查是否达到满积分
                if (this.isEnergyFull(player) && oldEnergy < this.maxEnergy) {
                    this.energyDisplay.triggerFullEnergyEffect(player);
                }
            }
        }

        // 更新道具可用性
        this.updateSkillAvailability();
    }

    /** 只写一行积分战报：实时与静默回放共用，数值由引擎随事件给出 */
    addEnergyLine(player, amount, source, targetPlayer = null, targetChessIndex = null) {
        if (!this.skillModeEnabled) return;
        window.gameInfo?.addEnergyGain(player, Math.round(amount), true, source, targetPlayer, targetChessIndex);
    }

    /** 按权威快照对齐积分：联机下这是唯一入口，本地不再自己记账也不再上报 */
    applySnapshot(energy) {
        if (!this.skillModeEnabled || !energy) return;
        for (const [player, value] of Object.entries(energy)) {
            const num = Number(player);
            if (num >= 1 && num <= 4 && Number.isFinite(value)) {
                this.setEnergy(num, value);
            }
        }
    }

    /**
     * 获取玩家当前积分
     * @param {number} player - 玩家编号
     * @returns {number} 积分值
     */
    getEnergy(player) {
        return this.playerEnergy[player] || 0;
    }

    /**
     * 设置玩家积分（用于同步）
     * @param {number} player - 玩家编号
     * @param {number} energy - 积分值
     * @param {boolean} skipDisplay - 是否跳过UI更新
     */
    setEnergy(player, energy, skipDisplay = false) {
        if (!this.skillModeEnabled) {
            return;
        }

        const oldEnergy = this.playerEnergy[player];
        this.playerEnergy[player] = Math.min(energy, this.maxEnergy);

        if (!skipDisplay && this.energyDisplay) {
            this.energyDisplay.updateEnergyBar(player, this.playerEnergy[player]);

            // 检查是否达到满积分
            if (this.isEnergyFull(player) && oldEnergy < this.maxEnergy) {
                this.energyDisplay.triggerFullEnergyEffect(player);
            }
        }
    }

    /**
     * 检查积分是否已满
     * @param {number} player - 玩家编号
     * @returns {boolean} 是否已满
     */
    isEnergyFull(player) {
        return this.playerEnergy[player] >= this.maxEnergy;
    }

    /**
     * 重置所有玩家积分
     */
    resetAllEnergy() {
        for (let player = 1; player <= 4; player++) {
            this.playerEnergy[player] = 0;
        }
    }

    /** 按引擎当前积分重设积分条：起手初始积分、回放跳转都靠它对齐 */
    syncFromState(energy = {}) {
        for (let player = 1; player <= 4; player += 1) {
            if (energy[player] === undefined) continue;
            this.setEnergy(player, energy[player], true);
            this.energyDisplay?.updateEnergyBar?.(player, energy[player]);
        }
    }

    /**
     * 更新道具可用性（调用skillManager）
     */
    updateSkillAvailability() {
        if (window.gameInstance && window.gameInstance.skillManager) {
            window.gameInstance.skillManager.updateSkillAvailability();
        }
    }
}

// 创建全局实例
export const energyManager = new EnergyManager();
export default EnergyManager;
