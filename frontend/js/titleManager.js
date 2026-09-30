import { activePlayerManager } from './activePlayerManager.js';

/**
 * 称号家族：同一件事按数值分档，只授予达到的最高一级。
 * value(stats, player) 给出该玩家的当前数值，levels 由低到高、min 是门槛。
 * 因为取的是最高一级，一次事件同时够到好几档时也只会出一条（不刷屏），
 * 后续数值继续涨则用更高一级「覆盖升级」。
 */
const FAMILIES = [
    {
        key: 'ones',
        value: (s, p) => s.maxConsecutiveOnes?.[p] || 0,
        levels: [
            { id: 'bad_luck', name: '运气不佳', desc: '连着三回合都摇到 1 点', min: 3, tier: 'common' },
            { id: 'reverse_lucky', name: '反向欧皇', desc: '连着五回合都摇到 1 点', min: 5, tier: 'rare' }
        ]
    },
    {
        key: 'no_takeoff',
        value: (s, p) => s.maxConsecutiveNoTakeoff?.[p] || 0,
        levels: [
            { id: 'unlucky_takeoff', name: '非酋', desc: '连着三回合无法起飞', min: 3, tier: 'common' },
            { id: 'super_unlucky', name: '超级非酋', desc: '连着六回合无法起飞', min: 6, tier: 'rare' },
            { id: 'forsaken', name: '天弃之子', desc: '连着十回合无法起飞', min: 10, tier: 'epic' }
        ]
    },
    {
        key: 'sixes',
        value: (s, p) => s.maxConsecutiveSixes?.[p] || 0,
        levels: [
            { id: 'lucky_king', name: '欧皇', desc: '连投三次 6', min: 3, tier: 'rare' },
            { id: 'six_streak', name: '六六大顺', desc: '连投四次 6', min: 4, tier: 'epic' },
            { id: 'dice_god', name: '天命骰神', desc: '连投五次 6', min: 5, tier: 'legendary' }
        ]
    },
    {
        key: 'move_distance',
        value: (s, p) => s.maxMoveDistance?.[p] || 0,
        levels: [
            { id: 'soaring', name: '一飞冲天', desc: '单次移动达到 25 格', min: 25, tier: 'rare' },
            { id: 'sky_high', name: '一步登天', desc: '单次移动达到 35 格', min: 35, tier: 'epic' }
        ]
    },
    {
        key: 'bounce',
        value: (s, p) => s.bounceSteps?.[p] || 0,
        levels: [
            { id: 'wind_walker', name: '逆风行者', desc: '反弹总格数超过 50 格', min: 51, tier: 'rare' },
            { id: 'bounce_master', name: '弹球大师', desc: '反弹总格数超过 100 格', min: 101, tier: 'epic' }
        ]
    },
    {
        key: 'multi_kill',
        value: (s, p) => s.maxBeatsInMove?.[p] || 0,
        happyDisabled: true,
        levels: [
            { id: 'double_kill', name: '一箭双雕', desc: '单次移动击败 2 颗棋子（撞叠子不算）', min: 2, tier: 'rare' },
            { id: 'triple_kill', name: '三连绝世', desc: '单次移动击败 3 颗棋子（撞叠子不算）', min: 3, tier: 'epic' },
            { id: 'quad_kill', name: '横扫千军', desc: '单次移动击败 4 颗棋子（撞叠子不算）', min: 4, tier: 'legendary' }
        ]
    },
    {
        key: 'collide_move',
        value: (s, p) => s.maxCollideInMove?.[p] || 0,
        happyOnly: true,
        levels: [
            { id: 'bumper_car', name: '碰碰车', desc: '单次移动碰撞 3 颗棋子', min: 3, tier: 'common' },
            { id: 'chain_crash', name: '连环碰撞', desc: '单次移动碰撞 5 颗棋子', min: 5, tier: 'rare' },
            { id: 'rampage', name: '横冲直撞', desc: '单次移动碰撞 8 颗棋子', min: 8, tier: 'epic' }
        ]
    },
    {
        key: 'teleport',
        value: (s, p) => s.maxTeleportDistance?.[p] || 0,
        levels: [
            { id: 'dimension_traveler', name: '次元旅人', desc: '单次传送超过 20 格', min: 21, tier: 'rare' },
            { id: 'void_walker', name: '虚空行者', desc: '单次传送超过 35 格', min: 36, tier: 'epic' },
            { id: 'teleport_master', name: '传送大师', desc: '单次传送超过 40 格', min: 41, tier: 'legendary' }
        ]
    },
    {
        key: 'mystery_box',
        value: (s, p) => s.mysteryBoxMax?.[p] || 0,
        levels: [
            { id: 'koi_fish', name: '锦鲤附体', desc: '盲盒开出超过 35 点积分', min: 36, tier: 'rare' },
            { id: 'lucky_burst', name: '欧气爆棚', desc: '盲盒开出满分 40 点积分', min: 40, tier: 'epic' }
        ]
    },
    {
        key: 'skill_count',
        value: (s, p) => s.skillUseCount?.[p] || 0,
        levels: [
            { id: 'skill_mania', name: '道具狂人', desc: '使用道具次数超过 10 次', min: 11, tier: 'rare' },
            { id: 'skill_master', name: '道具大师', desc: '使用道具次数超过 20 次', min: 21, tier: 'epic' }
        ]
    },
    {
        key: 'poly_high',
        value: (s, p) => (s.polyhedralMax?.[p] >= 12 ? 1 : 0),
        levels: [
            { id: 'destiny_child', name: '天命之子', desc: '多面骰子摇到 12 点', min: 1, tier: 'epic' }
        ]
    },
    {
        key: 'poly_low',
        value: (s, p) => (s.polyhedralMin?.[p] === 1 ? 1 : 0),
        levels: [
            { id: 'unlucky_bear', name: '倒霉熊', desc: '多面骰子摇到 1 点', min: 1, tier: 'epic' }
        ]
    },
    {
        key: 'box_zero',
        value: (s, p) => (s.mysteryBoxMin?.[p] === 0 ? 1 : 0),
        levels: [
            { id: 'philanthropist', name: '慈善家', desc: '盲盒开出 0 点积分', min: 1, tier: 'epic' }
        ]
    },
    {
        key: 'first_finish',
        value: (s, p) => (s.firstFinishedPlayer === p ? 1 : 0),
        levels: [
            { id: 'speed_legend', name: '最速传说', desc: '首个使棋子抵达终点', min: 1, tier: 'rare' }
        ]
    },
    {
        key: 'first_blood',
        value: (s, p) => (s.firstBeaterPlayer === p ? 1 : 0),
        levels: [
            { id: 'first_blood', name: '第一滴血', desc: '本局第一个击败对手', min: 1, tier: 'rare' }
        ]
    }
];

class TitleManager {
    constructor() {
        this.FAMILIES = FAMILIES;

        // 结算专用的比较型称号：要等所有人收官才能定论
        this.UNIQUE_TITLES = {
            MARATHON: { id: 'marathon', name: '长跑冠军', desc: '移动格数全场最多', tier: 'common' },
            SIX_MASTER: { id: 'six_master', name: '六点狂魔', desc: '摇到 6 的次数全场最多', tier: 'common' },
            KILLER: { id: 'killer', name: '收割者', desc: '击败对手次数最多', tier: 'common' },
            HOME_VISITOR: { id: 'home_visitor', name: '回家常客', desc: '被对手击败次数最多', tier: 'common', happyDisabled: true },
            STEADY_DOG: { id: 'steady_dog', name: '避战大师', desc: '被击败次数全场最少', tier: 'common' },
            CHESS_KING: { id: 'chess_king', name: '棋王', desc: '本局第一名', tier: 'epic' },
            COMEBACK: { id: 'comeback', name: '逆风翻盘', desc: '整局 60% 时间处于垫底，最后反败为胜', tier: 'legendary' }
        };

        // 结算专用的整局型称号：只在正常收官时才算数
        this.FINAL_TITLES = {
            INVISIBLE: { id: 'invisible', name: '不死传说', desc: '整局未被击败过', tier: 'legendary', happyDisabled: true },
            PEACE_MAKER: { id: 'peace_maker', name: '和平使者', desc: '未击败任何对手', tier: 'rare' },
            TAILWIND_WALKER: { id: 'tailwind_walker', name: '顺风行者', desc: '在整局未发生过反弹的情况下获胜', tier: 'legendary', happyDisabled: true }
        };

        this.DEFAULT_TITLE = { id: 'default', name: '平凡棋手', desc: '平平淡淡才是真', tier: 'common' };

        // 同一批同时达成多个称号时的播报顺序（靠前先播）：里程碑型先于数量级
        this.ANNOUNCE_ORDER = ['first_blood', 'speed_legend'];

        // 称号分级：只决定配色，不参与任何判定
        this.TIER_NAMES = { common: '普通', rare: '稀有', epic: '史诗', legendary: '传说' };
        // 越靠前越厉害，展示时按这个顺序把强称号排在前面
        this.TIER_RANK = { legendary: 0, epic: 1, rare: 2, common: 3 };
    }

    /** 家族里当前达成的最高一级；一个都没达到返回 null */
    _topLevel(family, stats, player, isHappy) {
        if (isHappy && family.happyDisabled) return null;
        const value = family.value(stats, player);
        let index = -1;
        family.levels.forEach((level, i) => {
            if (value >= level.min) index = i;
        });
        return index >= 0 ? { level: family.levels[index], index } : null;
    }

    /** 该家族在当前模式下是否不授予 */
    _isFamilyDisabled(family, gameState) {
        return Boolean(family.happyDisabled && gameState?.isHappyMode?.());
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
     * 收集该玩家此刻新达成的「流程内称号」：条件只看本机统计、达成即定论，
     * 所以可以当场播报（结算那批比较型/整局型的称号不在此列）。
     * 每族只播当前达到的最高一级，记在 gameState.announcedTitles（玩家-家族 → 已播到第几级），
     * 数值继续涨就再播一次升级后的那一级——一次事件够到多档也只出一条。
     */
    collectLiveTitles(player, gameState) {
        const stats = gameState?.titleStats;
        const announced = gameState?.announcedTitles;
        if (!stats || !announced) return [];

        const isHappy = Boolean(gameState?.isHappyMode?.());
        const earned = [];
        this.FAMILIES.forEach((family) => {
            const top = this._topLevel(family, stats, player, isHappy);
            if (!top) return;
            const key = `${player}-${family.key}`;
            const announcedIndex = announced.get(key);
            if (announcedIndex !== undefined && announcedIndex >= top.index) return;
            announced.set(key, top.index);
            earned.push(top.level);
        });

        // 同时达成多个时按里程碑优先排序（第一滴血在前，连杀在后），同优先级保持家族顺序
        const order = this.ANNOUNCE_ORDER;
        return earned.sort((a, b) => {
            const ra = order.indexOf(a.id);
            const rb = order.indexOf(b.id);
            return (ra < 0 ? order.length : ra) - (rb < 0 ? order.length : rb);
        });
    }

    /**
     * 结算：家族称号只取达到的最高一级，另加结算专用的比较型 / 整局型称号
     * @returns {Array} 称号对象数组
     */
    _collectPlayerTitles(player, gameState, stats, rankings, uniqueWinners) {
        const titleStats = gameState.titleStats;
        const ranking = rankings.find(r => r.player === player);
        const isHappy = Boolean(gameState?.isHappyMode?.());
        const titles = [];

        // --- 1. 家族称号：同一件事只发最高一级，一次够到多档也不会刷屏 ---
        this.FAMILIES.forEach((family) => {
            const top = this._topLevel(family, titleStats, player, isHappy);
            if (top) titles.push(top.level);
        });

        // --- 2. 结算专用：整局型（只在正常收官时算数）---
        if (stats.isNormalGameEnd && stats.beenDefeatedCounts[player] === 0) {
            titles.push(this.FINAL_TITLES.INVISIBLE);
        }
        if (stats.isNormalGameEnd && stats.defeatOthersCounts[player] === 0) {
            titles.push(this.FINAL_TITLES.PEACE_MAKER);
        }
        if (stats.isNormalGameEnd && titleStats.bounceSteps && titleStats.bounceSteps[player] === 0 && ranking && ranking.position === 1) {
            titles.push(this.FINAL_TITLES.TAILWIND_WALKER);
        }

        // --- 3. 结算专用：跨玩家比较型 ---
        if (uniqueWinners.marathon === player && stats.totalDistances[player] > 0) {
            titles.push(this.UNIQUE_TITLES.MARATHON);
        }
        if (uniqueWinners.killer === player && stats.defeatOthersCounts[player] > 0) {
            titles.push(this.UNIQUE_TITLES.KILLER);
        }
        if (uniqueWinners.sixMaster === player && stats.diceSixCounts[player] > 0) {
            titles.push(this.UNIQUE_TITLES.SIX_MASTER);
        }
        if (uniqueWinners.homeVisitor === player && stats.beenDefeatedCounts[player] > 0) {
            titles.push(this.UNIQUE_TITLES.HOME_VISITOR);
        }
        if (uniqueWinners.steadyDog === player && stats.beenDefeatedCounts[player] > 0) {
            titles.push(this.UNIQUE_TITLES.STEADY_DOG);
        }
        if (uniqueWinners.comeback === player) {
            titles.push(this.UNIQUE_TITLES.COMEBACK);
        }
        if (uniqueWinners.chessKing === player) {
            titles.push(this.UNIQUE_TITLES.CHESS_KING);
        }

        // 欢乐模式先滤掉不适配的，再兜底「平凡棋手」；反过来的话
        // 一个只拿到被禁称号的玩家会被筛成「没有任何称号」
        const kept = titles.filter((t) => !(isHappy && t.happyDisabled));
        if (kept.length === 0) {
            kept.push(this.DEFAULT_TITLE);
        }
        return kept.map(t => this._adjustTitleForHappyMode(t, gameState));
    }

    /**
     * 预计算每项唯一称号的唯一得主
     * 平局时以玩家编号小者为胜（确定性裁决）
     */
    _computeUniqueWinners(stats, gameState, rankings, activePlayers) {
        const winners = {};

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
