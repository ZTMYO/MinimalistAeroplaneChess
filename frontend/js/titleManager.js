import { activePlayerManager } from './activePlayerManager.js';

class TitleManager {
    constructor() {
        // 称号配置
        this.TITLES = {
            // 概率称号 (优先级 1)
            PROBABILITY: {
                REVERSE_LUCKY: { id: 'reverse_lucky', name: '反向欧皇', desc: '连着三回合都摇到 1 点' },
                UNLUCKY_START: { id: 'unlucky_takeoff', name: '非酋', desc: '连着三回合无法起飞' },
                LUCKY_KING: { id: 'lucky_king', name: '欧皇', desc: '连投三次 6' },
                INVISIBLE: { id: 'invisible', name: '不死传说', desc: '整局未被击败过' },
                PEACE_MAKER: { id: 'peace_maker', name: '和平使者', desc: '未击败任何对手' },
                TAILWIND_WALKER: { id: 'tailwind_walker', name: '顺风行者', desc: '在整局未发生过反弹的情况下获胜' },
                BOUNCE_KING: { id: 'wind_walker', name: '逆风行者', desc: '反弹总格数超过 50 格' },
                DIMENSION_TRAVELER: { id: 'dimension_traveler', name: '次元旅人', desc: '单次传送超过 20 格' },
                Koi_FISH: { id: 'koi_fish', name: '锦鲤附体', desc: '盲盒开出超过 35 点积分' },
                PHILANTHROPIST: { id: 'philanthropist', name: '慈善家', desc: '盲盒开出 0 点积分' },
                DESTINY_CHILD: { id: 'destiny_child', name: '天命之子', desc: '多面骰子摇到 12 点' },
                UNLUCKY_BEAR: { id: 'unlucky_bear', name: '倒霉熊', desc: '多面骰子摇到 1 点' },
                SKILL_MASTER: { id: 'skill_master', name: '道具大师', desc: '使用道具次数超过 10 次' }
            },
            // 唯一称号 (优先级 2)
            UNIQUE: {
                MARATHON: { id: 'marathon', name: '长跑冠军', desc: '移动格数全场最多' },
                SPEED_LEGEND: { id: 'speed_legend', name: '最速传说', desc: '首个使棋子抵达终点' },
                SIX_MASTER: { id: 'six_master', name: '六点狂魔', desc: '摇到 6 的次数全场最多' },
                KILLER: { id: 'killer', name: '收割者', desc: '击败对手次数最多' },
                HOME_VISITOR: { id: 'home_visitor', name: '回家常客', desc: '被对手击败次数最多' },
                CHESS_KING: { id: 'chess_king', name: '棋王', desc: '本局第一名' },
                COMEBACK: { id: 'comeback', name: '逆风翻盘', desc: '整局 60% 时间处于垫底，最后反败为胜' },
                STEADY_DOG: { id: 'steady_dog', name: '避战大师', desc: '被击败次数全场最少' }
            },
            // 默认称号
            DEFAULT: { id: 'default', name: '平凡棋手', desc: '平平淡淡才是真' }
        };
    }

    /**
     * 计算所有玩家的称号
     * @param {Object} gameState - 游戏状态对象
     * @param {Array} rankings - 排名数据 [{player: 1, position: 1, ...}]
     * @returns {Object} { playerNumber: { name, desc } }
     */
    calculateTitles(gameState, rankings) {
        const playerTitles = {};
        const activePlayers = activePlayerManager.getActivePlayers();
        
        // 预计算统计数据
        const stats = this._prepareStats(gameState, activePlayers, rankings);
        const uniqueWinners = this._computeUniqueWinners(stats, gameState, rankings, activePlayers);

        // 为每个玩家确定称号
        activePlayers.forEach(player => {
            playerTitles[player] = this._collectPlayerTitles(player, gameState, stats, rankings, uniqueWinners);
        });

        return playerTitles;
    }

    /**
     * 获取欢乐模式下禁用的称号 ID 集合
     */
    _getHappyModeDisabledIds() {
        return new Set([
            'invisible',
            'tailwind_walker',
            'home_visitor'
        ]);
    }

    /**
     * 调整称号文本（欢乐模式将"击败"替换为"碰撞"）
     */
    _adjustTitleForHappyMode(title, gameState) {
        if (!gameState || !gameState.isHappyMode || !gameState.isHappyMode()) {
            return title;
        }
        return {
            ...title,
            name: title.name ? title.name.replaceAll('击败', '碰撞') : title.name,
            desc: title.desc ? title.desc.replaceAll('击败', '碰撞') : title.desc
        };
    }

    /**
     * 收集玩家所有符合条件的称号（不再只取最高优先级的一个）
     * @returns {Array} 称号对象数组
     */
    _collectPlayerTitles(player, gameState, stats, rankings, uniqueWinners) {
        const titleStats = gameState.titleStats;
        const ranking = rankings.find(r => r.player === player);
        const titles = [];

        // --- 1. 概率称号 ---

        // 反向欧皇：连着三回合 1 点
        if (titleStats.consecutiveOnes[player] >= 3) {
            titles.push(this.TITLES.PROBABILITY.REVERSE_LUCKY);
        }

        // 非酋：连着三回合无法起飞
        if (titleStats.consecutiveNoTakeoff[player] >= 3) {
            titles.push(this.TITLES.PROBABILITY.UNLUCKY_START);
        }

        // 欧皇：连投三次 6
        if (titleStats.maxConsecutiveSixes[player] >= 3) {
            titles.push(this.TITLES.PROBABILITY.LUCKY_KING);
        }

        // 不死传说：正常结束游戏且整局未被击败过
        if (stats.isNormalGameEnd && stats.beenDefeatedCounts[player] === 0) {
            titles.push(this.TITLES.PROBABILITY.INVISIBLE);
        }

        // 和平使者：正常结束游戏且整局未击败过任何对手
        if (stats.isNormalGameEnd && stats.defeatOthersCounts[player] === 0) {
            titles.push(this.TITLES.PROBABILITY.PEACE_MAKER);
        }

        // 顺风行者：正常结束游戏，整局未发生过反弹且获胜
        if (stats.isNormalGameEnd && titleStats.bounceSteps && titleStats.bounceSteps[player] === 0 && ranking && ranking.position === 1) {
            titles.push(this.TITLES.PROBABILITY.TAILWIND_WALKER);
        }

        // 逆风行者：反弹格数超过 50 格
        if (titleStats.bounceSteps && titleStats.bounceSteps[player] > 50) {
            titles.push(this.TITLES.PROBABILITY.BOUNCE_KING);
        }

        // --- 道具模式称号 ---

        // 次元旅人：单次传送超过 20 格
        if (titleStats.maxTeleportDistance && titleStats.maxTeleportDistance[player] > 20) {
            titles.push(this.TITLES.PROBABILITY.DIMENSION_TRAVELER);
        }

        // 锦鲤附体：盲盒开出超过 35 点积分
        if (titleStats.mysteryBoxMax && titleStats.mysteryBoxMax[player] > 35) {
            titles.push(this.TITLES.PROBABILITY.Koi_FISH);
        }

        // 慈善家：盲盒开出 0 点积分
        if (titleStats.mysteryBoxMin && titleStats.mysteryBoxMin[player] === 0) {
            titles.push(this.TITLES.PROBABILITY.PHILANTHROPIST);
        }

        // 天命之子：多面骰子摇到 12 点
        if (titleStats.polyhedralMax && titleStats.polyhedralMax[player] >= 12) {
            titles.push(this.TITLES.PROBABILITY.DESTINY_CHILD);
        }

        // 倒霉熊：多面骰子摇到 1 点
        if (titleStats.polyhedralMin && titleStats.polyhedralMin[player] === 1) {
            titles.push(this.TITLES.PROBABILITY.UNLUCKY_BEAR);
        }

        // 道具大师：使用道具次数超过 10 次
        if (titleStats.skillUseCount && titleStats.skillUseCount[player] > 10) {
            titles.push(this.TITLES.PROBABILITY.SKILL_MASTER);
        }

        // --- 2. 唯一称号 ---

        // 最速传说 (首个完成)
        if (uniqueWinners.speedLegend === player) {
            titles.push(this.TITLES.UNIQUE.SPEED_LEGEND);
        }

        // 长跑冠军 (距离最多)
        if (uniqueWinners.marathon === player && stats.totalDistances[player] > 0) {
            titles.push(this.TITLES.UNIQUE.MARATHON);
        }

        // 收割者 (击败最多)
        if (uniqueWinners.killer === player && stats.defeatOthersCounts[player] > 0) {
            titles.push(this.TITLES.UNIQUE.KILLER);
        }

        // 六点狂魔 (6点最多)
        if (uniqueWinners.sixMaster === player && stats.diceSixCounts[player] > 0) {
            titles.push(this.TITLES.UNIQUE.SIX_MASTER);
        }

        // 回家常客 (被击败最多)
        if (uniqueWinners.homeVisitor === player && stats.beenDefeatedCounts[player] > 0) {
            titles.push(this.TITLES.UNIQUE.HOME_VISITOR);
        }

        // 避战大师 (被击败最少，且>0)
        if (uniqueWinners.steadyDog === player && stats.beenDefeatedCounts[player] > 0) {
            titles.push(this.TITLES.UNIQUE.STEADY_DOG);
        }

        // 逆风翻盘
        if (uniqueWinners.comeback === player) {
            titles.push(this.TITLES.UNIQUE.COMEBACK);
        }

        // 棋王 (第一名)
        if (uniqueWinners.chessKing === player) {
            titles.push(this.TITLES.UNIQUE.CHESS_KING);
        }

        // --- 3. 默认称号（无任何称号时兜底）---
        if (titles.length === 0) {
            titles.push(this.TITLES.DEFAULT);
        }

        // 欢乐模式：过滤掉不适配的称号，再将"击败"替换为"碰撞"
        const disabledIds = gameState?.isHappyMode?.() ? this._getHappyModeDisabledIds() : new Set();
        return titles
            .filter(t => !disabledIds.has(t.id))
            .map(t => this._adjustTitleForHappyMode(t, gameState));
    }

    /**
     * 预计算每项唯一称号的唯一得主
     * 平局时以玩家编号小者为胜（确定性裁决）
     */
    _computeUniqueWinners(stats, gameState, rankings, activePlayers) {
        const winners = {};

        // 最速传说 - 仅首个完成者，不可能有平局
        winners.speedLegend = stats.firstFinished;
        
        // 长跑冠军 - 距离最高，平局取编号小者
        winners.marathon = this._findTiebreakWinner(activePlayers, stats.totalDistances, 'max', 1);
        
        // 收割者 - 击败最多，平局取编号小者
        winners.killer = this._findTiebreakWinner(activePlayers, stats.defeatOthersCounts, 'max', 1);
        
        // 六点狂魔 - 六点最多，平局取编号小者
        winners.sixMaster = this._findTiebreakWinner(activePlayers, stats.diceSixCounts, 'max', 1);
        
        // 回家常客 - 被击败最多，平局取编号小者
        winners.homeVisitor = this._findTiebreakWinner(activePlayers, stats.beenDefeatedCounts, 'max', 1);
        
        // 避战大师 - 被击败最少（且>0），平局取编号小者
        winners.steadyDog = this._findTiebreakWinner(activePlayers, stats.beenDefeatedCounts, 'min', 1);

        // 棋王 - 第一名，且必须在完成度上独占第一（与第二名同分时视为并列，不授予）
        if (rankings && rankings.length > 0) {
            const firstPlayer = rankings.find(r => r.position === 1);
            const secondPlayer = rankings.find(r => r.position === 2);
            // 没有第二名 / 第一名完成度严格大于第二名 → 真正领先
            const isSoleLeader = firstPlayer && (!secondPlayer || firstPlayer.progress > secondPlayer.progress);
            winners.chessKing = isSoleLeader ? firstPlayer.player : null;
        }

        // 逆风翻盘 - 需要额外逻辑，单独计算
        winners.comeback = this._findComebackWinner(activePlayers, gameState, rankings);

        return winners;
    }

    /**
     * 寻找指定统计维度中胜出的玩家（带确定性平局裁决）
     * @param {Array} players - 活跃玩家列表
     * @param {Object} statsMap - 统计数据 { player: value }
     * @param {'max'|'min'} mode - 取最大值还是最小值
     * @param {number} minValue - 有效参与的最小值
     * @returns {number|null} 胜出的玩家编号，无合格者返回 null
     */
    _findTiebreakWinner(players, statsMap, mode, minValue) {
        const valid = players.filter(p => statsMap[p] !== undefined && statsMap[p] >= minValue);
        if (valid.length === 0) return null;

        let bestValue;
        if (mode === 'max') {
            bestValue = Math.max(...valid.map(p => statsMap[p]));
        } else {
            bestValue = Math.min(...valid.map(p => statsMap[p]));
        }

        // 找出所有达到最佳值的玩家，取编号最小者
        const tied = valid.filter(p => statsMap[p] === bestValue);
        return tied.length > 0 ? Math.min(...tied) : null;
    }

    /**
     * 计算逆风翻盘称号的得主
     */
    _findComebackWinner(activePlayers, gameState, rankings) {
        if (!gameState.progressHistory || gameState.progressHistory.length < 5) return null;
        
        const history = gameState.progressHistory;
        if (!rankings) return null;
        
        const champion = rankings.find(r => r.position === 1);
        if (!champion) return null;
        
        const player = champion.player;
        let behindCount = 0;

        history.forEach(snapshot => {
            const playerProgress = snapshot.players[player] || 0;
            const progresses = Object.values(snapshot.players);
            const minProgress = Math.min(...progresses);
            if (playerProgress === minProgress) {
                behindCount++;
            }
        });

        return behindCount / history.length >= 0.6 ? player : null;
    }

    /**
     * 预计算统计数据，用于唯一称号判定
     */
    _prepareStats(gameState, activePlayers, rankings) {
        const stats = {
            totalDistances: {},
            diceSixCounts: {},
            defeatOthersCounts: {},
            beenDefeatedCounts: {},
            firstFinished: gameState.titleStats.firstFinishedPlayer,
            // 是否正常结束游戏（至少有一名玩家所有棋子到达终点）
            // 强制结算时没有任何玩家完成全部棋子，不应触发某些称号
            isNormalGameEnd: false
        };

        // 检查是否正常结束：有玩家的全部棋子都到达终点
        for (const p of activePlayers) {
            const chesses = gameState.playerChess?.[p];
            if (chesses && chesses.length > 0) {
                const allFinished = chesses.every(c => c.finished || c.position === 56);
                if (allFinished) {
                    stats.isNormalGameEnd = true;
                    break;
                }
            }
        }

        activePlayers.forEach(player => {
            // 前进距离
            stats.totalDistances[player] = gameState.getTotalDistance(player);
            
            // 6点次数
            stats.diceSixCounts[player] = gameState.diceStatistics[player]?.[6] || 0;
            
            // 击败他人次数
            let defeatOthers = 0;
            for (let target = 1; target <= 4; target++) {
                if (target !== player) {
                    defeatOthers += gameState.defeatCounts[player]?.[target] || 0;
                }
            }
            stats.defeatOthersCounts[player] = defeatOthers;

            // 被击败次数 (从其他玩家的 defeatCounts 中汇总)
            let beenDefeated = 0;
            activePlayers.forEach(other => {
                if (other !== player) {
                    beenDefeated += gameState.defeatCounts[other]?.[player] || 0;
                }
            });
            stats.beenDefeatedCounts[player] = beenDefeated;
        });

        return stats;
    }

}

export const titleManager = new TitleManager();
