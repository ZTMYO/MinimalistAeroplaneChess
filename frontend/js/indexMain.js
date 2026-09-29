import { emojis, defaultEmoji } from '../assets/emojis.js';
import { MultiplayerManager } from './multiplayerManager.js';
import { nicknameGenerator } from './nicknameGenerator.js';
import { audioManager } from './audioManager.js';
window.audioManager = audioManager;

// 页面完全加载后，在浏览器空闲时静默预加载音频，不影响首屏体验
window.addEventListener('load', () => {
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => audioManager.preloadSounds(), { timeout: 2000 });
    } else {
        setTimeout(() => audioManager.preloadSounds(), 2000);
    }
});

// 游戏提示轮播
class GameTipsCarousel {
    constructor() {
        this.tips = [
            "这是由ZTMYO个人开发的网页游戏",
            "按F11进入全屏模式，获得最佳游戏体验",
            "AI玩家投掷的点数也是完全随机的",
            "困难AI会智能分析局势，优先发起进攻",
            "简单AI只会随机选择棋子移动",
            "道具模式：击败对手获得积分，使用强大道具",
            "摇到偶数点数即可起飞（出棋）",
            "摇到6点后可以再投一次",
            "棋子停在自身颜色格子时，跳到下一个同色格子",
            "今天的骰子也超可爱~",
            "(•▴• )咕咕～",
            "啊！要给你看什么Tip好呢...(翻",
            "连续摇到3个6，你的所有棋子会回到起点",
            "建议使用Ctrl+鼠标滚轮把页面调整到合适状态",
            "善用叠子策略，形成强大防御阻挡对手",
            "跳子与飞棋可以快速前进，但要小心叠子阻挡",
            "与叠子发生碰撞，双方碰撞的棋子都得返回起点",
            "可利用叠子阻挡后的反向移动击杀对手棋子",
            "可利用飞棋击杀终点通道上的对家棋子",
            "可利用跳子或飞棋完成双杀甚至三杀",
            "可使用道具代替投掷来规避连投3次6的惩罚",
            "掉线后可以输入房间号重连",
            "创建房间后复制链接给好友，一起游戏",
            "好友可以输入房间号加入你的房间",
            "快捷键：空格键可投掷骰子",
            "快捷键：回车键可发送聊天消息",
            "试试发送表情与对手互动吧",
            "临时离开？开启AI托管帮你自动操作",
            "只剩一颗棋子没到达终点，开启AI托管吧",
            "点击终端上的切换按钮，查看聊天记录",
            "结算查看完成度折线图，分析对手的进度趋势",
            "道具模式下击败对手棋子可获得积分",
            "使对手损失的进度越多，获得的积分越多",
            "只能在回合开始前使用道具",
            "游戏音效太吵了？可以随时关闭音效",
            "盲盒（15积分）：积分不足时的应急补给",
            "传送门（40积分）：随机传送到一个空位置",
            "多面骰子（50积分）：随机投掷1-12点数",
            "遥控骰子（70积分）：自由选择1-6任意点数",
            "只能在积分低于40时使用盲盒",
            "传送门传送到远距离位置的概率更低",
            "传送门可能会使你倒退，但或许能让你转守为攻",
            "遥控骰子投掷的6点无法获得连投奖励",
            "遥控骰子击败敌人无法获取积分",
            "满积分后获取更多积分将会溢出",
            "不知道起什么昵称，试试随机生成吧",
            "思考时间到将自动开启AI托管",
            "联机模式每次行动有20秒的思考时长",
            "连投奖励时还是你的回合，可以使用道具",
            "房主可以随时暂停和结算游戏",
            "人机模式节奏太慢了？可以开启动画加速",
            "托管你的AI是简单人机，不太聪明的样子",
            "请尽量不要离开游戏页面，以免断线！",
            "请尽量不要离开游戏页面，以免断线！",
            "私密房间不会出现在房间列表"
        ];
        this.currentIndex = 0;
        this.tipElement = null;
        this.interval = null;
    }

    init() {
        this.tipElement = document.getElementById('tipContent');
        if (!this.tipElement) return;

        // 显示第一条提示
        this.showTip(0);
        //打乱tips顺序
        this.tips = this.tips.sort(() => Math.random() - 0.5);
        // 每5秒切换一次
        this.interval = setInterval(() => {
            this.nextTip();
        }, 5000);
    }

    showTip(index) {
        if (!this.tipElement) return;

        this.currentIndex = index;
        this.tipElement.textContent = this.tips[index];
        this.tipElement.className = 'tip-content show';
    }

    nextTip() {
        if (!this.tipElement) return;

        // 向上滑出
        this.tipElement.className = 'tip-content slide-up-out';

        // 400ms后切换内容并从下方滑入
        setTimeout(() => {
            this.currentIndex = (this.currentIndex + 1) % this.tips.length;
            this.tipElement.textContent = this.tips[this.currentIndex];
            this.tipElement.className = 'tip-content slide-up-in';

            requestAnimationFrame(() => {
                this.tipElement.className = 'tip-content show';
            });
        }, 400);
    }

    destroy() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
}

// 玩家设置管理
class PlayerSetup {
    constructor() {
        this.selectedPlayer = 1;
        this.playerUsername = '玩家';
        this.selectedEmoji = defaultEmoji;
        this.emojis = emojis;
        this.emojiNames = {
            smile: '微笑',
            sad: '伤心',
            faintsmile: '浅笑',
            cute: '卖萌',
            surprised: '眨眼',
            angry: '生气',
            dead: '社死',
            sorrow: '难过',
            happy: '开心',
            nerd: '呆子',
            wink: '俏皮',
            sweat: '流汗',
            grin: '咧嘴',
            cool: '酷',
            cry: '哭泣',
            naughty: '调皮',
            scorn: '不屑',
            speechless: '无语',
            kiss: '亲亲'
        };
        this.emojiList = Object.entries(emojis)
            .filter(([key]) => key !== 'bot')
            .map(([key, emoji]) => ({
                key,
                svg: emoji.svg,
                name: this.emojiNames[key] || key
            }));
        this.emojiKeys = this.emojiList.map(item => item.key);
        this.currentEmojiIndex = this.emojiKeys.indexOf(defaultEmoji);
        // AI与棋子相关属性
        this.activeBots = new Set();
        this.botDifficulties = new Map();
        this.aiConfigInitialized = false;
        this.selectedPieceCount = 4;
        this.currentMode = null;
        this.init();
    }

    init() {
        this.setupModeSelection();
        this.setupLocalMultiplayerConfig();
    }

    // 设置AI玩家配置
    setupAIPlayerConfig() {
        // 只在第一次调用时绑定事件
        if (!this.aiConfigInitialized) {
            this.bindEvents();
            this.setupBotManagement();
            this.setupPieceCountSelector();
            this.aiConfigInitialized = true;
        }
        this.setupEmojiSwitcher();
        this.loadEmojiPreviews();
        this.updateBotPlayers();
        this.updateStartButton();

        // 恢复棋子个数的选中状态
        this.restorePieceCountSelection();

        if (window.playerIdManager) {
            const savedNickname = window.playerIdManager.getSavedNickname();
            if (savedNickname) {
                const aiUsernameInput = document.getElementById('playerUsername');
                if (aiUsernameInput && !aiUsernameInput.value.trim()) {
                    aiUsernameInput.value = savedNickname;
                    this.playerUsername = savedNickname;
                }
            }
        }
    }

    // 设置本地多人配置
    setupLocalMultiplayerConfig() {
        // 本地多人：真人颜色多选
        const localHumanColorOptions = document.getElementById('localHumanColorOptions');
        if (localHumanColorOptions) {
            localHumanColorOptions.addEventListener('click', (e) => {
                const option = e.target.closest('.color-option');
                if (!option) return;

                const color = parseInt(option.dataset.player);
                if (isNaN(color)) return;
                this.toggleLocalHumanColor(color);
            });
        }

        // 棋子个数选择器事件（本地多人模式）
        const localPieceCountOptions = document.querySelectorAll('.local-multiplayer-config .local-piece-count-option');
        localPieceCountOptions.forEach(option => {
            option.addEventListener('click', (e) => {
                // 确保点击的是正确的元素，获取data-count属性
                let target = e.target;
                if (!target.dataset.count) {
                    // 如果点击的是子元素（如count-circle），向上查找父元素
                    target = target.closest('.local-piece-count-option');
                }

                if (!target || !target.dataset.count) {
                    console.warn('无法获取棋子数量，跳过处理');
                    return;
                }

                // 移除所有选中状态
                localPieceCountOptions.forEach(opt => opt.classList.remove('selected'));
                // 添加选中状态
                target.classList.add('selected');

                const pieceCount = parseInt(target.dataset.count);
                if (!isNaN(pieceCount)) {
                    this.localMultiplayerConfig.pieceCount = pieceCount;
                    console.log(`本地多人模式选择棋子个数：${this.localMultiplayerConfig.pieceCount}`);
                } else {
                    console.error('棋子数量解析失败:', target.dataset.count);
                }
            });
        });

        // 本地多人开始游戏按钮事件
        const localStartGameBtn = document.getElementById('localStartGameBtn');
        if (localStartGameBtn) {
            localStartGameBtn.addEventListener('click', () => {
                this.startLocalMultiplayerGame();
            });
        }

        const localBotPlayersContainer = document.getElementById('localBotPlayers');
        if (localBotPlayersContainer) {
            localBotPlayersContainer.addEventListener('click', (e) => {
                const addOption = e.target.closest('.bot-add-option');
                const removeBtn = e.target.closest('.remove-btn');
                const difficultyCircle = e.target.closest('.difficulty-circle');

                if (addOption && !difficultyCircle && !removeBtn) {
                    const playerNum = parseInt(addOption.dataset.player);
                    this.addLocalBot(playerNum);
                } else if (removeBtn) {
                    const botPlayer = removeBtn.closest('.bot-player');
                    if (botPlayer) {
                        const playerNum = parseInt(botPlayer.dataset.player);
                        this.removeLocalBot(playerNum);
                    }
                } else if (difficultyCircle) {
                    const playerNum = parseInt(difficultyCircle.dataset.player);
                    this.toggleLocalBotDifficulty(playerNum);
                }
            });
        }

        // 初始化本地多人配置数据
        this.localMultiplayerConfig = {
            playerCount: 2,
            pieceCount: 4,
            players: [],
            bots: new Set(),
            botDifficulties: new Map(),
            humanColors: new Set()
        };

        // 默认选中2个真人颜色
        this.initLocalHumanColorSelection(2);

        // 初始化默认设置
        this.generatePlayersSetupFromSelection();

        // 确保默认棋子个数的UI状态正确
        this.restoreLocalPieceCountSelection();

        this.updateLocalBotPlayers();
    }

    // 初始化本地多人真人颜色选择（默认按 1,3,2,4 顺序选满）
    initLocalHumanColorSelection(playerCount) {
        if (!this.localMultiplayerConfig) return;
        this.localMultiplayerConfig.humanColors = new Set();
        const order = [1, 3, 2, 4];
        for (let i = 0; i < playerCount; i++) {
            this.localMultiplayerConfig.humanColors.add(order[i]);
        }
        this.updateLocalHumanColorSelectionUI();
        this.updateLocalMultiplayerPlayerCountFromSelection();
    }

    updateLocalHumanColorSelectionUI() {
        const container = document.getElementById('localHumanColorOptions');
        if (!container || !this.localMultiplayerConfig) return;
        const selected = this.localMultiplayerConfig.humanColors || new Set();
        const canRemoveHuman = selected.size > 2;
        const playersById = new Map((this.localMultiplayerConfig.players || []).map(p => [p.id, p]));

        container.querySelectorAll('.color-option').forEach(opt => {
            const color = parseInt(opt.dataset.player);
            const player = playersById.get(color);
            const isAI = !!(player && player.isAI === true);
            const isHuman = selected.has(color);

            opt.classList.toggle('selected', isHuman || isAI);

            const circle = opt.querySelector('.color-circle');
            if (!circle) return;

            const existingEmoji = circle.querySelector('.multiplayer-emoji');
            const existingBadge = circle.querySelector('.kick-player-btn');

            if (!isHuman && !isAI) {
                if (existingEmoji) existingEmoji.remove();
                if (existingBadge) existingBadge.remove();
                return;
            }

            const svgMarkup = isAI ? this.getEmojiSvg('bot') : this.getHumanEmojiSvg(color, player);
            if (svgMarkup) {
                if (existingEmoji) {
                    existingEmoji.innerHTML = svgMarkup;
                } else {
                    const emojiEl = document.createElement('div');
                    emojiEl.className = 'multiplayer-emoji';
                    emojiEl.innerHTML = svgMarkup;
                    circle.appendChild(emojiEl);
                }
            }

            // AI 座位随时可移除；真人座位需保留至少 2 人，不足时不渲染无效按钮
            if (existingBadge) existingBadge.remove();
            if (isAI || canRemoveHuman) {
                const badge = this.createRemoveSeatBadge(isAI ? '移除AI玩家' : '移除该玩家');
                badge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (isAI) this.removeLocalBot(color);
                    else this.toggleLocalHumanColor(color);
                });
                circle.appendChild(badge);
            }
        });
    }

    getEmojiSvg(key) {
        const emoji = this.emojis && this.emojis[key];
        return emoji ? emoji.svg : '';
    }

    getHumanEmojiSvg(color, player) {
        const storedIndex = this.playerEmojiIndices ? this.playerEmojiIndices[color] : null;
        const emojiIndex = storedIndex != null ? storedIndex : (player ? player.emojiIndex : 0);
        const item = this.emojiList && this.emojiList[emojiIndex || 0];
        return item ? item.svg : this.getEmojiSvg(defaultEmoji);
    }

    createRemoveSeatBadge(title = '移除该玩家') {
        const badge = document.createElement('div');
        badge.className = 'kick-player-btn';
        badge.title = title;
        badge.innerHTML = '<svg t="1777870303975" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5679" width="30" height="30"><path d="M85.333333 512a64 64 0 0 1 64-64h725.333334a64 64 0 0 1 0 128h-725.333334A64 64 0 0 1 85.333333 512z" fill="currentColor" p-id="5680"></path></svg>';
        return badge;
    }

    toggleLocalHumanColor(color) {
        if (!this.localMultiplayerConfig) return;

        const selected = this.localMultiplayerConfig.humanColors || new Set();
        if (selected.has(color)) {
            // 至少保留2个真人
            if (selected.size <= 2) return;
            selected.delete(color);
        } else {
            // 最多4个
            if (selected.size >= 4) return;
            selected.add(color);
        }

        this.localMultiplayerConfig.humanColors = selected;
        this.updateLocalHumanColorSelectionUI();
        this.updateLocalMultiplayerPlayerCountFromSelection();
        this.rebuildLocalPlayersFromSelection();
    }

    updateLocalMultiplayerPlayerCountFromSelection() {
        if (!this.localMultiplayerConfig) return;
        const humanCount = (this.localMultiplayerConfig.humanColors || new Set()).size;
        const aiCount = (this.localMultiplayerConfig.players || []).filter(p => p && p.isAI === true).length;
        this.localMultiplayerConfig.playerCount = humanCount + aiCount;

        const localStartGameBtn = document.getElementById('localStartGameBtn');
        if (localStartGameBtn) {
            localStartGameBtn.disabled = humanCount < 2;
            localStartGameBtn.textContent = humanCount < 2
                ? '至少需要2个玩家'
                : `开始游戏 (${humanCount}人${aiCount > 0 ? `${aiCount}机` : ''})`;
        }
    }

    // 本地多人：AI昵称按难度分组独立编号（Bot-# / AI-#），与真人编号无关
    recalculateLocalBotNames() {
        if (!this.localMultiplayerConfig || !Array.isArray(this.localMultiplayerConfig.players)) return;

        const aiPlayers = this.localMultiplayerConfig.players.filter(p => p && p.isAI === true);
        if (aiPlayers.length === 0) return;

        const easyIds = [];
        const hardIds = [];

        aiPlayers.forEach(p => {
            const d = this.localMultiplayerConfig.botDifficulties.get(p.id) || 'easy';
            if (d === 'hard') hardIds.push(p.id);
            else easyIds.push(p.id);
        });

        easyIds.sort((a, b) => a - b);
        hardIds.sort((a, b) => a - b);

        aiPlayers.forEach(p => {
            const d = this.localMultiplayerConfig.botDifficulties.get(p.id) || 'easy';
            if (d === 'hard') {
                p.name = `AI-${hardIds.indexOf(p.id) + 1}`;
            } else {
                p.name = `Bot-${easyIds.indexOf(p.id) + 1}`;
            }
        });
    }

    // 根据当前选择的真人颜色重建本地多人玩家列表
    rebuildLocalPlayersFromSelection() {
        if (!this.localMultiplayerConfig || !Array.isArray(this.localMultiplayerConfig.players)) return;

        const selectedHumanColors = Array.from(this.localMultiplayerConfig.humanColors || []).sort((a, b) => a - b);
        const existingById = new Map(this.localMultiplayerConfig.players.map(p => [p.id, p]));
        const aiPlayers = this.localMultiplayerConfig.players.filter(p => p && p.isAI === true);

        const humans = selectedHumanColors.map((id, index) => {
            const existing = existingById.get(id);
            const expectedName = `玩家${index + 1}`;
            
            if (existing && existing.isAI !== true) {
                let newName = existing.name;
                if (/^玩家\d+$/.test(newName) && newName !== expectedName) {
                    newName = expectedName;
                }
                return { ...existing, id, name: newName };
            }
            return {
                id,
                name: expectedName,
                emojiIndex: 0
            };
        });

        // 若某个颜色被选为真人，则对应AI（若存在）应被移除
        const filteredAI = aiPlayers.filter(p => !selectedHumanColors.includes(p.id));
        filteredAI.forEach(p => {
            // 确保bot集合与难度映射一致
            this.localMultiplayerConfig.bots.add(p.id);
            if (!this.localMultiplayerConfig.botDifficulties.has(p.id)) {
                this.localMultiplayerConfig.botDifficulties.set(p.id, 'easy');
            }
        });

        // 重建players
        this.localMultiplayerConfig.players = [...humans, ...filteredAI];

        this.recalculateLocalBotNames();

        // 同步bots集合
        const aiIds = new Set(filteredAI.map(p => p.id));
        Array.from(this.localMultiplayerConfig.bots).forEach(id => {
            if (!aiIds.has(id)) {
                this.localMultiplayerConfig.bots.delete(id);
                this.localMultiplayerConfig.botDifficulties.delete(id);
            }
        });

        this.generatePlayersSetupWithExistingPlayers();
    }

    generatePlayersSetupFromSelection() {
        if (!this.localMultiplayerConfig) return;
        this.generatePlayersSetup((this.localMultiplayerConfig.humanColors || new Set()).size);
    }

    ensureLocalAIEmojiKey(player, difficulty) {
        if (!player || player.isAI !== true) return;
        player.aiEmojiKey = 'bot';
    }


    // 生成玩家设置组件
    generatePlayersSetup(playerCount) {
        const playersSetupArea = document.getElementById('playersSetupArea');
        playersSetupArea.innerHTML = '';

        // 先保留已添加的AI玩家
        const existingAI = (this.localMultiplayerConfig.players || []).filter(p => p && p.isAI === true);

        // 根据选择的真人颜色重建真人玩家
        const selectedHumanColors = Array.from(this.localMultiplayerConfig.humanColors || []).sort((a, b) => a - b);
        const humans = selectedHumanColors.map((id, index) => ({
            id,
            name: `玩家${index + 1}`,
            emojiIndex: 0
        }));

        // 更新players
        const humanIds = new Set(humans.map(p => p.id));
        const filteredAI = existingAI.filter(p => !humanIds.has(p.id));
        this.localMultiplayerConfig.players = [...humans, ...filteredAI];

        // 重建bots集合
        this.localMultiplayerConfig.bots.clear();
        filteredAI.forEach(p => {
            this.localMultiplayerConfig.bots.add(p.id);
            if (!this.localMultiplayerConfig.botDifficulties.has(p.id)) {
                this.localMultiplayerConfig.botDifficulties.set(p.id, 'easy');
            }
        });

        // 渲染真人玩家行
        humans.forEach((p, idx) => {
            const displayNumber = idx + 1;
            const item = this.createPlayerSetupItem(p.id, displayNumber);
            playersSetupArea.appendChild(item);

            // 同步到配置（与createPlayerSetupItem的input绑定一致）
            const playerData = this.localMultiplayerConfig.players.find(pp => pp.id === p.id);
            if (playerData) {
                playerData.name = p.name;
                playerData.emojiIndex = 0;
            }

            this.setupMultiEmojiSwitcher(item, p.id);
        });
        // 更新开始游戏按钮显示

        const localStartGameBtn = document.getElementById('localStartGameBtn');
        const humanCount = humans.length;
        const totalPlayers = humans.length + filteredAI.length;
        this.localMultiplayerConfig.playerCount = totalPlayers;
        localStartGameBtn.disabled = humanCount < 2;
        localStartGameBtn.textContent = `开始游戏 (${totalPlayers}人)`;

        this.updateLocalBotPlayers();
    }

    generatePlayersSetupWithExistingPlayers() {
        const playersSetupArea = document.getElementById('playersSetupArea');
        if (!playersSetupArea) return;
        playersSetupArea.innerHTML = '';

        const players = (this.localMultiplayerConfig.players || []).filter(p => p && p.isAI !== true);

        players.forEach((p, index) => {
            const displayNumber = index + 1;
            const item = this.createPlayerSetupItem(p.id, displayNumber);
            playersSetupArea.appendChild(item);

            const usernameInput = item.querySelector('.username-input');
            if (usernameInput) {
                usernameInput.value = p.name;
                usernameInput.placeholder = `玩家${displayNumber}`;
            }

            // 同步表情
            if (!this.playerEmojiIndices) this.playerEmojiIndices = {};
            this.playerEmojiIndices[p.id] = p.emojiIndex || 0;

            this.setupMultiEmojiSwitcher(item, p.id);

        });

        // 同步人数与按钮状态（最少2个真人）
        this.updateLocalMultiplayerPlayerCountFromSelection();

        this.updateLocalBotPlayers();
    }

    updateLocalBotPlayers() {
        const container = document.getElementById('localBotPlayers');
        if (!container) return;

        const preview = container.closest('.bot-players-preview');
        if (preview) {
            const hasAI = this.localMultiplayerConfig.players.some(p => p && p.isAI === true);
            const hasEmptySlot = this.localMultiplayerConfig.players.length < 4;
            preview.style.display = (hasAI || hasEmptySlot) ? 'block' : 'none';
        }

        container.innerHTML = '';

        if (!this.localMultiplayerConfig || !Array.isArray(this.localMultiplayerConfig.players)) {
            return;
        }

        this.recalculateLocalBotNames();

        const aiPlayers = this.localMultiplayerConfig.players.filter(p => p && p.isAI === true);
        const easyIds = [];
        const hardIds = [];
        aiPlayers.forEach(p => {
            const d = this.localMultiplayerConfig.botDifficulties.get(p.id) || 'easy';
            if (d === 'hard') hardIds.push(p.id);
            else easyIds.push(p.id);
        });
        easyIds.sort((a, b) => a - b);
        hardIds.sort((a, b) => a - b);

        const allSlots = [1, 2, 3, 4];
        const playersById = new Map(this.localMultiplayerConfig.players.map(p => [p.id, p]));

        allSlots.forEach(playerNum => {
            const p = playersById.get(playerNum);
            if (p && p.isAI === true) {
                const difficulty = this.localMultiplayerConfig.botDifficulties.get(playerNum) || 'easy';
                const difficultyText = difficulty === 'easy' ? '简单' : '困难';
                const botPlayer = document.createElement('div');
                botPlayer.className = 'bot-player';
                botPlayer.dataset.player = playerNum;

                // 昵称按同难度独立编号
                const botName = difficulty === 'hard'
                    ? `AI-${hardIds.indexOf(playerNum) + 1}`
                    : `Bot-${easyIds.indexOf(playerNum) + 1}`;

                botPlayer.innerHTML = `
                    <div class="difficulty-circle player-${playerNum}-color" data-player="${playerNum}" title="点击切换难度">
                        <span class="difficulty-text">${difficultyText}</span>
                    </div>
                    <div class="bot-info">
                        <span class="bot-name">${botName}</span>
                    </div>
                    <div class="remove-btn"><svg t="1777870303975" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5679" width="30" height="30"><path d="M85.333333 512a64 64 0 0 1 64-64h725.333334a64 64 0 0 1 0 128h-725.333334A64 64 0 0 1 85.333333 512z" fill="currentColor" p-id="5680"></path></svg></div>
                `;

                container.appendChild(botPlayer);
            } else if (!p) {
                const addOption = document.createElement('div');
                addOption.className = 'bot-add-option';
                addOption.dataset.player = playerNum;
                addOption.innerHTML = `
                    <div class="color-circle player-${playerNum}-color">
                        <div class="add-icon">
                            <svg t="1777824616733" class="icon black-icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5251" width="30" height="30">
                                <path d="M576 64H448v384H64v128h384v384h128V576h384V448H576z" fill="currentColor" p-id="5252"></path>
                            </svg>
                        </div>
                    </div>
                    <span class="placeholder-text">添加AI</span>
                `;
                container.appendChild(addOption);
            }
        });

        this.updateLocalHumanColorSelectionUI();
    }

    addLocalBot(playerNum) {
        if (!this.localMultiplayerConfig || !Array.isArray(this.localMultiplayerConfig.players)) {
            return;
        }

        const exists = this.localMultiplayerConfig.players.some(p => p.id === playerNum);
        if (exists) {
            return;
        }

        const difficulty = 'easy';

        this.localMultiplayerConfig.players.push({
            id: playerNum,
            name: '',
            emojiIndex: 0,
            isAI: true,
            aiEmojiKey: 'bot'
        });

        this.localMultiplayerConfig.bots.add(playerNum);
        this.localMultiplayerConfig.botDifficulties.set(playerNum, difficulty);

        this.recalculateLocalBotNames();

        this.updateLocalMultiplayerPlayerCountFromSelection();

        this.generatePlayersSetupWithExistingPlayers();
    }

    removeLocalBot(playerNum) {
        if (!this.localMultiplayerConfig || !Array.isArray(this.localMultiplayerConfig.players)) {
            return;
        }

        const player = this.localMultiplayerConfig.players.find(p => p.id === playerNum);
        if (!player || player.isAI !== true) {
            return;
        }

        this.localMultiplayerConfig.players = this.localMultiplayerConfig.players.filter(p => p.id !== playerNum);
        this.localMultiplayerConfig.bots.delete(playerNum);
        this.localMultiplayerConfig.botDifficulties.delete(playerNum);

        this.recalculateLocalBotNames();

        this.updateLocalMultiplayerPlayerCountFromSelection();

        this.generatePlayersSetupWithExistingPlayers();
    }

    toggleLocalBotDifficulty(playerNum) {
        if (!this.localMultiplayerConfig || !Array.isArray(this.localMultiplayerConfig.players)) {
            return;
        }

        const player = this.localMultiplayerConfig.players.find(p => p.id === playerNum);
        if (!player || player.isAI !== true) {
            return;
        }

        const currentDifficulty = this.localMultiplayerConfig.botDifficulties.get(playerNum) || 'easy';
        const newDifficulty = currentDifficulty === 'easy' ? 'hard' : 'easy';
        this.localMultiplayerConfig.botDifficulties.set(playerNum, newDifficulty);
        this.ensureLocalAIEmojiKey(player, newDifficulty);
        this.recalculateLocalBotNames();
        this.updateLocalBotPlayers();
        this.generatePlayersSetupWithExistingPlayers();
    }

    // 创建单个玩家设置项（本地多人）
    createPlayerSetupItem(playerIndex, displayNumber = null) {
        // 如果没有传入displayNumber，则使用playerIndex作为显示编号
        const displayNum = displayNumber || playerIndex;

        const playerSetupItem = document.createElement('div');
        playerSetupItem.className = 'player-setup-item';
        playerSetupItem.innerHTML = `
            <!-- 表情切换器和用户名输入水平排列 -->
            <div class="player-setup-row">
                <!-- 表情切换器 -->
                <div class="emoji-switcher" data-player="${playerIndex}">
                    <button class="emoji-nav-btn prev-emoji" id="prevEmoji">‹</button>
                    <div class="current-emoji-display">
                        <div class="emoji-preview player-${playerIndex}-color">
                            <div class="emoji-content" id="emojiPreview${playerIndex}"></div>
                        </div>
                        <span class="emoji-name" id="emojiName${playerIndex}">开心</span>
                    </div>
                    <button class="emoji-nav-btn next-emoji" id="nextEmoji">›</button>
                </div>

                <!-- 用户名输入 -->
                <div class="username-input-group" id="usernameInputGroup${playerIndex}">
                    <input type="text" class="username-input" placeholder="玩家${displayNum}" 
                           maxlength="8" value="玩家${displayNum}" data-player="${playerIndex}">
                </div>
            </div>
        `;

        // 设置表情切换事件
        this.setupMultiEmojiSwitcher(playerSetupItem, playerIndex);

        // 设置用户名输入事件
        const usernameInput = playerSetupItem.querySelector('.username-input');
        usernameInput.addEventListener('input', (e) => {
            const playerData = this.localMultiplayerConfig.players.find(p => p.id === playerIndex);
            if (playerData) {
                playerData.name = e.target.value;
            }
        });
        
        usernameInput.addEventListener('blur', (e) => {
            const playerData = this.localMultiplayerConfig.players.find(p => p.id === playerIndex);
            if (playerData && !e.target.value.trim()) {
                const defaultName = usernameInput.placeholder || `玩家${displayNum}`;
                e.target.value = defaultName;
                playerData.name = defaultName;
            }
        });

        return playerSetupItem;
    }

    // 设置表情切换器事件
    setupMultiEmojiSwitcher(container, playerIndex) {
        const prevBtn = container.querySelector('.prev-emoji');
        const nextBtn = container.querySelector('.next-emoji');
        const emojiPreview = container.querySelector(`#emojiPreview${playerIndex}`);
        const emojiName = container.querySelector(`#emojiName${playerIndex}`);

        // 初始化当前表情索引
        if (!this.playerEmojiIndices) {
            this.playerEmojiIndices = {};
        }
        this.playerEmojiIndices[playerIndex] = 0;

        // 更新表情显示
        const updateEmoji = () => {
            const currentIndex = this.playerEmojiIndices[playerIndex];
            const emoji = this.emojiList[currentIndex];
            if (emoji && emojiPreview && emojiName) {
                emojiPreview.innerHTML = emoji.svg;
                emojiName.textContent = emoji.name;

                // 更新配置数据
                const playerData = this.localMultiplayerConfig.players.find(p => p.id === playerIndex);
                if (playerData) {
                    playerData.emojiIndex = this.playerEmojiIndices[playerIndex];
                }

                this.updateLocalHumanColorSelectionUI();
            }
        };

        // 初始化显示
        updateEmoji();

        // 移除之前的事件监听器，避免重复绑定
        if (prevBtn) {
            const newPrevBtn = prevBtn.cloneNode(true);
            prevBtn.parentNode.replaceChild(newPrevBtn, prevBtn);
            newPrevBtn.addEventListener('click', () => {
                console.log('Previous emoji button clicked for player:', playerIndex);
                this.playerEmojiIndices[playerIndex] =
                    (this.playerEmojiIndices[playerIndex] - 1 + this.emojiList.length) % this.emojiList.length;
                updateEmoji();
            });
        }

        // 下一个表情
        if (nextBtn) {
            const newNextBtn = nextBtn.cloneNode(true);
            nextBtn.parentNode.replaceChild(newNextBtn, nextBtn);
            newNextBtn.addEventListener('click', () => {
                console.log('Next emoji button clicked for player:', playerIndex);
                this.playerEmojiIndices[playerIndex] =
                    (this.playerEmojiIndices[playerIndex] + 1) % this.emojiList.length;
                updateEmoji();
            });
        }
    }

    setupModeSelection() {
        const mainMenuContainer = document.getElementById('mainMenuContainer');
        const playerConfigWrapper = document.getElementById('playerConfigWrapper');
        const rulesPanelWrapper = document.getElementById('rulesPanelWrapper');
        
        const menuOnlineBtn = document.getElementById('menuOnlineBtn');
        const menuAiBtn = document.getElementById('menuAiBtn');
        const menuLocalBtn = document.getElementById('menuLocalBtn');
        const menuRulesBtn = document.getElementById('menuRulesBtn');
        
        const backToMainMenu = document.getElementById('backToMainMenu');
        const rulesBackBtn = document.getElementById('rulesBackBtn');
        const configTitle = document.getElementById('configTitle');

        // 在线联机
        if (menuOnlineBtn) {
            menuOnlineBtn.addEventListener('click', () => {
                this.currentMode = 'online';
                if (configTitle) configTitle.textContent = '房间列表';
                if (mainMenuContainer) mainMenuContainer.style.display = 'none';
                if (playerConfigWrapper) playerConfigWrapper.style.display = 'block';
                this.showOnlineMultiplayerConfig();
            });
        }

        // 人机对战
        if (menuAiBtn) {
            menuAiBtn.addEventListener('click', () => {
                this.currentMode = 'ai';
                if (configTitle) configTitle.textContent = '人机对战设置';
                if (mainMenuContainer) mainMenuContainer.style.display = 'none';
                if (playerConfigWrapper) playerConfigWrapper.style.display = 'block';
                this.showConfigPanel();
                this.showAIConfig();
            });
        }

        // 本地多人
        if (menuLocalBtn) {
            menuLocalBtn.addEventListener('click', () => {
                this.currentMode = 'local';
                if (configTitle) configTitle.textContent = '本地多人设置';
                if (mainMenuContainer) mainMenuContainer.style.display = 'none';
                if (playerConfigWrapper) playerConfigWrapper.style.display = 'block';
                this.showConfigPanel();
                this.hideAIConfig();
            });
        }

        // 规则说明
        if (menuRulesBtn) {
            menuRulesBtn.addEventListener('click', () => {
                console.log('点击规则说明按钮');
                if (mainMenuContainer) mainMenuContainer.style.display = 'none';
                if (rulesPanelWrapper) rulesPanelWrapper.style.display = 'block';
            });
        }

        // 返回主菜单
        if (backToMainMenu) {
            backToMainMenu.addEventListener('click', () => {
                this.handleBackButton();
            });
        }

        // 规则页面返回
        if (rulesBackBtn) {
            rulesBackBtn.addEventListener('click', () => {
                if (rulesPanelWrapper) rulesPanelWrapper.style.display = 'none';
                if (mainMenuContainer) mainMenuContainer.style.display = 'flex';
            });
        }
    }

    showMainMenu() {
        const mainMenuContainer = document.getElementById('mainMenuContainer');
        const playerConfigWrapper = document.getElementById('playerConfigWrapper');
        const rulesPanelWrapper = document.getElementById('rulesPanelWrapper');

        if (mainMenuContainer) mainMenuContainer.style.display = 'flex';
        if (playerConfigWrapper) playerConfigWrapper.style.display = 'none';
        if (rulesPanelWrapper) rulesPanelWrapper.style.display = 'none';

        this.currentMode = null;
        this.resetAllConfigPanels();
    }

    showConfigPanel() {
        const mainMenuContainer = document.getElementById('mainMenuContainer');
        const playerConfigWrapper = document.getElementById('playerConfigWrapper');
        const playerConfigPanel = document.getElementById('playerConfigPanel');

        if (mainMenuContainer) mainMenuContainer.style.display = 'none';
        if (playerConfigWrapper) playerConfigWrapper.style.display = 'block';
        if (playerConfigPanel) playerConfigPanel.style.display = 'flex';

        // 强制浏览器执行 Layout，确保后续动画平滑
        playerConfigPanel.offsetHeight; 

        try {
            if (this.currentMode === 'local' || this.currentMode === 'ai') {
                sessionStorage.setItem('lastPanel', this.currentMode);
            }
        } catch (error) {
            // ignore
        }

        if (this.currentMode === 'local') {
            if (document.getElementById('localMultiplayerConfig')) document.getElementById('localMultiplayerConfig').style.display = 'flex';
            if (document.getElementById('aiBattleConfig')) document.getElementById('aiBattleConfig').style.display = 'none';
            if (document.getElementById('onlineMultiplayerConfig')) document.getElementById('onlineMultiplayerConfig').style.display = 'none';
        } else if (this.currentMode === 'ai') {
            if (document.getElementById('localMultiplayerConfig')) document.getElementById('localMultiplayerConfig').style.display = 'none';
            if (document.getElementById('aiBattleConfig')) document.getElementById('aiBattleConfig').style.display = 'flex';
            if (document.getElementById('onlineMultiplayerConfig')) document.getElementById('onlineMultiplayerConfig').style.display = 'none';
        }
    }

    showModeSelection() {
        this.showMainMenu();
    }

    resetAllConfigPanels() {
        // 隐藏所有配置子面板
        const localMultiplayerConfig = document.getElementById('localMultiplayerConfig');
        const onlineMultiplayerConfig = document.getElementById('onlineMultiplayerConfig');
        const aiBattleConfig = document.getElementById('aiBattleConfig');

        if (localMultiplayerConfig) {
            localMultiplayerConfig.style.display = 'none';
        }
        if (onlineMultiplayerConfig) {
            onlineMultiplayerConfig.style.display = 'none';
        }
        if (aiBattleConfig) {
            aiBattleConfig.style.display = 'none';
        }

        // 重置在线多人配置的子面板
        const roomSelection = document.getElementById('roomSelection');
        const roomConfig = document.getElementById('roomConfig');
        if (roomSelection) {
            roomSelection.style.display = 'flex';
        }
        if (roomConfig) {
            roomConfig.style.display = 'none';
        }
    }

    hideAIConfig() {
        const botPlayersPreview = document.querySelector('.ai-battle-config .bot-players-preview');
        if (botPlayersPreview) {
            botPlayersPreview.style.display = 'none';
        }
    }

    showAIConfig() {
        const botPlayersPreview = document.querySelector('.ai-battle-config .bot-players-preview');
        if (botPlayersPreview) {
            botPlayersPreview.style.display = 'block';
        }

        // 清理人机对战配置页面的多人联机状态残留
        this.clearAIConfigMultiplayerState();

        // 初始化AI玩家配置
        this.setupAIPlayerConfig();

        const aiConfigPanel = document.querySelector('.ai-battle-config');
        if (aiConfigPanel) {
            const colorOptions = aiConfigPanel.querySelectorAll('.color-option');
            colorOptions.forEach(option => {
                option.classList.remove('selected');
            });
            // 确保默认选中的颜色有正确的selected样式
            const defaultOption = aiConfigPanel.querySelector(`.color-option[data-player="${this.selectedPlayer}"]`);
            if (defaultOption) {
                defaultOption.classList.add('selected');
            }
        }

        // 延迟执行表情显示更新，确保DOM已完全渲染
        setTimeout(() => {
            this.updateCurrentEmojiDisplay();
        }, 100);
    }

    // 清理人机对战配置页面的多人联机状态残留
    clearAIConfigMultiplayerState() {
        // 清理sessionStorage中的多人联机相关配置，但保留本地多人配置
        sessionStorage.removeItem('multiplayerGameData');

        // 清理人机对战配置页面的多人联机状态残留
        const aiConfigPanel = document.querySelector('.ai-battle-config');
        if (aiConfigPanel) {
            const colorOptions = aiConfigPanel.querySelectorAll('.color-option');
            colorOptions.forEach(option => {
                const circle = option.querySelector('.color-circle');

                if (circle) {
                    // 移除选中状态
                    circle.classList.remove('selected');
                    option.classList.remove('selected');

                    // 清除多人联机的表情元素
                    const existingEmoji = circle.querySelector('.multiplayer-emoji');
                    if (existingEmoji) {
                        existingEmoji.remove();
                    }

                    // 重置样式，确保所有选项都可用
                    option.style.pointerEvents = 'auto';
                    option.style.opacity = '1';

                    // 清除可能的AI状态标记
                    option.removeAttribute('data-ai-occupied');
                    option.removeAttribute('data-ai-difficulty');
                }

                // 清理昵称显示
                const playerNickname = option.querySelector('.player-nickname');
                if (playerNickname) {
                    playerNickname.style.display = 'none';
                    playerNickname.textContent = '';
                }
            });

            // 重置人机模式的默认选中状态（玩家1）
            const firstOption = aiConfigPanel.querySelector('.color-option[data-player="1"]');
            if (firstOption) {
                firstOption.classList.add('selected');
            }
        }

        // 同时清理全局的color-option元素，防止状态混乱
        const allColorOptions = document.querySelectorAll('.color-option');
        allColorOptions.forEach(option => {
            const circle = option.querySelector('.color-circle');
            if (circle) {
                // 清除多人联机的表情元素
                const existingEmoji = circle.querySelector('.multiplayer-emoji');
                if (existingEmoji) {
                    existingEmoji.remove();
                }

                // 重置AI相关属性
                option.removeAttribute('data-ai-occupied');
                option.removeAttribute('data-ai-difficulty');

                // 重置样式
                option.style.pointerEvents = 'auto';
                option.style.opacity = '1';
            }

            // 清理昵称显示
            const playerNickname = option.querySelector('.player-nickname');
            if (playerNickname) {
                playerNickname.style.display = 'none';
                playerNickname.textContent = '';
            }
        });

        // 重置人机模式的内部状态
        this.activeBots.clear();
        this.botDifficulties.clear();
        this.selectedPlayer = 1;
        this.selectedEmoji = 'smile'; // 使用默认表情字符串键而不是数字索引
        this.selectedPieceCount = 4;

        // 更新UI显示
        this.updateBotPlayers();
        this.updateCurrentEmojiDisplay();
        this.updateStartButton();
    }

    // 显示在线联机配置
    showOnlineMultiplayerConfig() {
        const mainMenuContainer = document.getElementById('mainMenuContainer');
        const playerConfigWrapper = document.getElementById('playerConfigWrapper');
        const playerConfigPanel = document.getElementById('playerConfigPanel');
        const onlineMultiplayerConfig = document.getElementById('onlineMultiplayerConfig');

        this.currentMode = 'online';

        try {
            sessionStorage.setItem('lastPanel', 'online');
        } catch (error) {
            // ignore
        }

        if (mainMenuContainer) mainMenuContainer.style.display = 'none';
        if (playerConfigWrapper) playerConfigWrapper.style.display = 'block';
        if (playerConfigPanel) playerConfigPanel.style.display = 'flex';

        // 隐藏其他配置面板
        const localConfig = document.getElementById('localMultiplayerConfig');
        const aiConfig = document.getElementById('aiBattleConfig');
        if (localConfig) localConfig.style.display = 'none';
        if (aiConfig) aiConfig.style.display = 'none';

        // 显示在线联机配置
        if (onlineMultiplayerConfig) onlineMultiplayerConfig.style.display = 'flex';

        // 只在在线联机模式下初始化MultiplayerManager
        if (!window.multiplayerManager) {
            console.log('初始化MultiplayerManager');
            window.multiplayerManager = new MultiplayerManager();
        } else {
            console.log('MultiplayerManager已存在，重新绑定事件');
            window.multiplayerManager.bindEvents();
        }
    }

    // 处理返回按钮
    handleBackButton() {
        if (this.currentMode === 'online' && window.multiplayerManager) {
            // 让多人联机管理器处理返回逻辑
            window.multiplayerManager.handleBackButton();
        } else {
            this.showMainMenu();
        }
    }

    bindEvents() {
        // 颜色选择事件 - 只绑定AI配置面板中的颜色选择器
        const aiConfigPanel = document.querySelector('.ai-battle-config');
        if (aiConfigPanel) {
            const colorOptions = aiConfigPanel.querySelectorAll('.color-option');
            colorOptions.forEach(option => {
                option.addEventListener('click', (e) => {
                    this.selectColor(parseInt(e.currentTarget.dataset.player));
                });
            });
        }

        // 用户名输入事件
        const usernameInput = document.getElementById('playerUsername');
        if (usernameInput) {
            usernameInput.addEventListener('input', (e) => {
                this.playerUsername = e.target.value.trim();
                // 持久化保存到 localStorage
                if (window.playerIdManager) {
                    window.playerIdManager.saveNickname(this.playerUsername);
                }
            });
        }

        // 人机对战模式的随机昵称按钮
        const aiNicknameDiceBtn = document.getElementById('aiNicknameDice');
        if (aiNicknameDiceBtn) {
            aiNicknameDiceBtn.addEventListener('click', () => {
                // 添加点击动画
                aiNicknameDiceBtn.classList.add('clicking');
                setTimeout(() => {
                    aiNicknameDiceBtn.classList.remove('clicking');
                }, 500);

                const randomNickname = nicknameGenerator.generate();
                if (usernameInput) {
                    usernameInput.value = randomNickname;
                    this.playerUsername = randomNickname;
                    // 持久化保存到 localStorage
                    if (window.playerIdManager) {
                        window.playerIdManager.saveNickname(randomNickname);
                    }
                }
            });
        }

        // 开始游戏按钮事件
        const startGameBtn = document.getElementById('startGame');
        if (startGameBtn) {
            startGameBtn.addEventListener('click', () => {
                this.startGame();
            });
        }
    }

    setupEmojiSwitcher() {
        // 只在AI配置面板中查找表情切换器
        const aiConfigPanel = document.querySelector('.ai-battle-config');
        if (!aiConfigPanel) {
            console.warn('找不到AI配置面板');
            return;
        }

        const prevBtn = aiConfigPanel.querySelector('#prevEmoji');
        const nextBtn = aiConfigPanel.querySelector('#nextEmoji');

        // 移除之前的事件监听器，避免重复绑定
        if (prevBtn) {
            prevBtn.replaceWith(prevBtn.cloneNode(true));
            const newPrevBtn = aiConfigPanel.querySelector('#prevEmoji');
            if (newPrevBtn) {
                newPrevBtn.addEventListener('click', () => {
                    this.currentEmojiIndex = (this.currentEmojiIndex - 1 + this.emojiKeys.length) % this.emojiKeys.length;
                    this.selectedEmoji = this.emojiKeys[this.currentEmojiIndex];
                    this.updateCurrentEmojiDisplay();
                });
            }
        }

        if (nextBtn) {
            nextBtn.replaceWith(nextBtn.cloneNode(true));
            const newNextBtn = aiConfigPanel.querySelector('#nextEmoji');
            if (newNextBtn) {
                newNextBtn.addEventListener('click', () => {
                    this.currentEmojiIndex = (this.currentEmojiIndex + 1) % this.emojiKeys.length;
                    this.selectedEmoji = this.emojiKeys[this.currentEmojiIndex];
                    this.updateCurrentEmojiDisplay();
                });
            }
        }
    }

    setupBotManagement() {
        const botPlayersContainer = document.querySelector('.ai-battle-config .bot-players');
        if (!botPlayersContainer) {
            return;
        }

        botPlayersContainer.addEventListener('click', (e) => {
            const addOption = e.target.closest('.bot-add-option');
            const removeBtn = e.target.closest('.remove-btn');
            const difficultyCircle = e.target.closest('.difficulty-circle');

            if (addOption && !difficultyCircle && !removeBtn) {
                const playerNum = parseInt(addOption.dataset.player);
                this.addBot(playerNum);
            } else if (removeBtn) {
                const botPlayer = removeBtn.closest('.bot-player');
                if (botPlayer) {
                    const playerNum = parseInt(botPlayer.dataset.player);
                    this.removeBot(playerNum);
                }
            } else if (difficultyCircle) {
                // 点击难度圆圈切换难度
                const playerNum = parseInt(difficultyCircle.dataset.player);
                this.toggleBotDifficulty(playerNum);
            }
        });
    }

    setupPieceCountSelector() {
        // 只选择人机对战配置中的棋子个数选择器
        const pieceCountOptions = document.querySelectorAll('.ai-battle-config .piece-count-option');

        pieceCountOptions.forEach(option => {
            option.addEventListener('click', (e) => {
                const count = parseInt(e.currentTarget.dataset.count);
                this.selectPieceCount(count);
            });
        });
    }

    selectPieceCount(count) {
        // 更新选中状态 - 只针对人机对战配置中的选择器
        const aiConfigOptions = document.querySelectorAll('.ai-battle-config .piece-count-option');
        aiConfigOptions.forEach(option => {
            option.classList.remove('selected');
        });

        const selectedOption = document.querySelector(`.ai-battle-config .piece-count-option[data-count="${count}"]`);
        if (selectedOption) {
            selectedOption.classList.add('selected');
        }

        this.selectedPieceCount = count;
        console.log(`选择棋子个数：${count}`);
    }

    // 恢复棋子个数的选中状态
    restorePieceCountSelection() {
        // 移除所有选中状态
        const aiConfigOptions = document.querySelectorAll('.ai-battle-config .piece-count-option');
        aiConfigOptions.forEach(option => {
            option.classList.remove('selected');
        });

        // 恢复当前选中的棋子个数状态
        const selectedOption = document.querySelector(`.ai-battle-config .piece-count-option[data-count="${this.selectedPieceCount}"]`);
        if (selectedOption) {
            selectedOption.classList.add('selected');
        }
    }

    // 恢复本地多人模式棋子个数的选中状态
    restoreLocalPieceCountSelection() {
        // 移除所有选中状态
        const localPieceCountOptions = document.querySelectorAll('.local-multiplayer-config .local-piece-count-option');
        localPieceCountOptions.forEach(option => {
            option.classList.remove('selected');
        });

        // 恢复当前选中的棋子个数状态
        const selectedOption = document.querySelector(`.local-multiplayer-config .local-piece-count-option[data-count="${this.localMultiplayerConfig.pieceCount}"]`);
        if (selectedOption) {
            selectedOption.classList.add('selected');
        }
    }

    addBot(playerNum) {
        if (playerNum === this.selectedPlayer || this.activeBots.has(playerNum)) {
            return;
        }
        this.activeBots.add(playerNum);
        // 默认设置为简单难度
        this.botDifficulties.set(playerNum, 'easy');
        this.updateBotPlayers();
        this.updateStartButton();
        console.log(`添加AI玩家${playerNum}`);
    }

    removeBot(playerNum) {
        this.activeBots.delete(playerNum);
        // 移除难度设置
        this.botDifficulties.delete(playerNum);
        this.updateBotPlayers();
        this.updateStartButton();
        console.log(`移除AI玩家${playerNum}`);
    }

    toggleBotDifficulty(playerNum) {
        const currentDifficulty = this.botDifficulties.get(playerNum) || 'easy';
        const newDifficulty = currentDifficulty === 'easy' ? 'hard' : 'easy';
        this.botDifficulties.set(playerNum, newDifficulty);
        this.updateBotPlayers();
        console.log(`Bot ${playerNum} 难度切换为: ${newDifficulty}`);
    }

    selectColor(playerNumber) {
        // 此方法用于AI对战配置面板的颜色选择器

        // 如果选择的是当前已选中的玩家，直接返回
        if (this.selectedPlayer === playerNumber) {
            return;
        }

        // 更新选中状态 - 只在AI配置面板中操作
        const aiConfigPanel = document.querySelector('.ai-battle-config');
        if (!aiConfigPanel || aiConfigPanel.style.display === 'none') {
            return;
        }

        const colorOptions = aiConfigPanel.querySelectorAll('.color-option');

        colorOptions.forEach(option => {
            option.classList.remove('selected');
        });

        // 使用更精确的选择器，只选择AI配置面板中的color-option元素
        const selectedOption = aiConfigPanel.querySelector(`.color-option[data-player="${playerNumber}"]`);

        if (selectedOption) {
            selectedOption.classList.add('selected');
        }

        // 如果新选中的玩家在activeBots中，将其移除（人类玩家不能同时是bot）
        if (this.activeBots.has(playerNumber)) {
            this.activeBots.delete(playerNumber);
            this.botDifficulties.delete(playerNumber);
            console.log(`玩家${playerNumber}切换为人类玩家，从AI列表中移除`);
        }

        this.selectedPlayer = playerNumber;

        // 更新表情预览的颜色样式
        const emojiPreview = aiConfigPanel.querySelector('.emoji-preview');

        if (emojiPreview) {
            // 移除所有玩家颜色类
            emojiPreview.classList.remove('player-1-color', 'player-2-color', 'player-3-color', 'player-4-color');
            // 添加当前选中玩家的颜色类
            emojiPreview.classList.add(`player-${playerNumber}-color`);
        }

        this.updateBotPlayers();
        this.updateStartButton();
    }

    updateCurrentEmojiDisplay() {
        // 只在AI配置面板中查找表情显示元素
        const aiConfigPanel = document.querySelector('.ai-battle-config');
        if (!aiConfigPanel) {
            console.warn('找不到AI配置面板');
            return;
        }

        const previewElement = aiConfigPanel.querySelector('#currentEmojiPreview');
        const nameElement = aiConfigPanel.querySelector('#currentEmojiName');

        // 确保表情数据已加载
        if (!this.emojis || Object.keys(this.emojis).length === 0) {
            console.warn('表情数据尚未加载，跳过表情显示更新');
            return;
        }

        if (previewElement && nameElement && this.emojis[this.selectedEmoji]) {
            previewElement.innerHTML = this.emojis[this.selectedEmoji].svg;
            nameElement.textContent = this.emojiNames[this.selectedEmoji] || this.selectedEmoji;

            // 确保表情预览器有正确的颜色样式
            // 移除所有玩家颜色类
            previewElement.classList.remove('player-1-color', 'player-2-color', 'player-3-color', 'player-4-color');
            // 添加当前选中玩家的颜色类
            previewElement.classList.add(`player-${this.selectedPlayer}-color`);
        } else {
            console.warn('表情显示元素未找到或表情数据无效:', {
                previewElement: !!previewElement,
                nameElement: !!nameElement,
                selectedEmoji: this.selectedEmoji,
                emojiData: !!this.emojis[this.selectedEmoji]
            });
        }
    }

    loadEmojiPreviews() {
        // 确保表情数据已加载
        if (!this.emojis || !this.emojiKeys || this.emojiKeys.length === 0) {
            console.warn('表情数据未加载完成');
            return;
        }

        // 确保当前表情索引有效
        if (this.currentEmojiIndex < 0 || this.currentEmojiIndex >= this.emojiKeys.length) {
            this.currentEmojiIndex = 0;
        }

        // 确保选中的表情与索引匹配
        this.selectedEmoji = this.emojiKeys[this.currentEmojiIndex];
        this.updateCurrentEmojiDisplay();
    }

    updateBotPlayers() {
        // 确保只在AI配置面板显示时才更新
        const aiConfigPanel = document.querySelector('.ai-battle-config');
        if (!aiConfigPanel || aiConfigPanel.style.display === 'none') {
            return;
        }

        const botPlayersContainer = document.querySelector('.ai-battle-config .bot-players');
        if (!botPlayersContainer) {
            console.warn('找不到AI配置面板中的bot-players容器');
            return;
        }

        // 清空容器
        botPlayersContainer.innerHTML = '';

        // 获取除了人类玩家之外的其他三个玩家位置
        const availablePlayerNumbers = [1, 2, 3, 4].filter(num => num !== this.selectedPlayer);

        // 按难度分组计算编号
        const easyBots = [];
        const hardBots = [];

        availablePlayerNumbers.forEach(playerNum => {
            if (this.activeBots.has(playerNum)) {
                const difficulty = this.botDifficulties.get(playerNum) || 'easy';
                if (difficulty === 'hard') {
                    hardBots.push(playerNum);
                } else {
                    easyBots.push(playerNum);
                }
            }
        });

        // 按顺序显示可用的玩家位置
        availablePlayerNumbers.forEach(playerNum => {
            if (this.activeBots.has(playerNum)) {
                // 显示已激活的AI玩家
                const botPlayer = document.createElement('div');
                botPlayer.className = 'bot-player';
                botPlayer.dataset.player = playerNum;

                // 获取当前AI的难度设置，默认为简单
                const currentDifficulty = this.botDifficulties.get(playerNum) || 'easy';
                const difficultyText = currentDifficulty === 'easy' ? '简单' : '困难';

                // 根据难度和在同类中的位置计算名称
                let botName;
                if (currentDifficulty === 'hard') {
                    const indexInHard = hardBots.indexOf(playerNum) + 1;
                    botName = `AI-${indexInHard}`;
                } else {
                    const indexInEasy = easyBots.indexOf(playerNum) + 1;
                    botName = `Bot-${indexInEasy}`;
                }

                botPlayer.innerHTML = `
                    <div class="difficulty-circle player-${playerNum}-color" data-player="${playerNum}" title="点击切换难度">
                        <span class="difficulty-text">${difficultyText}</span>
                    </div>
                    <div class="bot-info">
                        <span class="bot-name">${botName}</span>
                    </div>
                    <div class="remove-btn"><svg t="1777870303975" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5679" width="30" height="30"><path d="M85.333333 512a64 64 0 0 1 64-64h725.333334a64 64 0 0 1 0 128h-725.333334A64 64 0 0 1 85.333333 512z" fill="currentColor" p-id="5680"></path></svg></div>
                `;

                botPlayersContainer.appendChild(botPlayer);
            } else {
                // 显示可添加的AI选项
                const addOption = document.createElement('div');
                addOption.className = 'bot-add-option';
                addOption.dataset.player = playerNum;
                addOption.innerHTML = `
                    <div class="color-circle player-${playerNum}-color">
                        <div class="add-icon">
                            <svg t="1777824616733" class="icon black-icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5251" width="30" height="30">
                                <path d="M576 64H448v384H64v128h384v384h128V576h384V448H576z" fill="currentColor" p-id="5252"></path>
                            </svg>
                        </div>
                    </div>
                    <span class="placeholder-text">添加AI</span>
                `;

                botPlayersContainer.appendChild(addOption);
            }
        });
    }

    updateStartButton() {
        const startGameBtn = document.getElementById('startGame');
        const totalPlayers = 1 + this.activeBots.size; // 人类玩家 + AI玩家
        if (totalPlayers >= 2) {
            startGameBtn.disabled = false;
            startGameBtn.textContent = `开始游戏 (1人${this.activeBots.size > 0 ? `${this.activeBots.size}机` : ''})`;
        } else {
            startGameBtn.disabled = true;
            startGameBtn.textContent = '至少需要2个玩家';
        }
    }

    startGame() {
        const username = document.getElementById('playerUsername').value.trim() || '玩家';

        // 数据清理：确保数据一致性
        // 1. 从activeBots中移除人类玩家
        if (this.activeBots.has(this.selectedPlayer)) {
            console.warn(`检测到activeBots中包含人类玩家${this.selectedPlayer}，自动移除`);
            this.activeBots.delete(this.selectedPlayer);
        }

        // 2. 清理botDifficulties：只保留activeBots中的玩家
        const validBotDifficulties = new Map();
        for (const bot of this.activeBots) {
            if (this.botDifficulties.has(bot)) {
                validBotDifficulties.set(bot, this.botDifficulties.get(bot));
            } else {
                // 如果某个bot没有难度设置，默认为easy
                validBotDifficulties.set(bot, 'easy');
            }
        }
        this.botDifficulties = validBotDifficulties;

        // 验证玩家数量（1个人类玩家 + bot数量）
        const totalPlayers = 1 + this.activeBots.size;
        if (totalPlayers < 2) {
            alert('至少需要2个玩家才能开始游戏！');
            return;
        }

        // 获取道具模式开关状态
        const skillModeCheckbox = document.getElementById('aiSkillModeCheckbox');
        const skillMode = skillModeCheckbox ? skillModeCheckbox.checked : false;
        const happyModeCheckbox = document.getElementById('aiHappyModeCheckbox');
        const happyMode = happyModeCheckbox ? happyModeCheckbox.checked : false;

        // 构建游戏配置
        const gameConfig = {
            mode: 'ai_battle',
            humanPlayer: this.selectedPlayer,
            humanEmoji: this.selectedEmoji,
            humanUsername: username,
            pieceCount: this.selectedPieceCount,
            bots: Array.from(this.activeBots),
            botDifficulties: Object.fromEntries(this.botDifficulties),
            skillMode: skillMode,
            happyMode: happyMode
        };

        console.log('游戏配置:', gameConfig);
        sessionStorage.setItem('gameConfig', JSON.stringify(gameConfig));

        // 保存当前游戏模式状态和详细配置
        sessionStorage.setItem('lastGameMode', this.currentMode);
        const aiConfigState = {
            selectedPlayer: this.selectedPlayer,
            selectedEmoji: this.selectedEmoji,
            selectedPieceCount: this.selectedPieceCount,
            activeBots: Array.from(this.activeBots),
            botDifficulties: Object.fromEntries(this.botDifficulties),
            username: username,
            skillMode: skillMode,
            happyMode: happyMode
        };
        sessionStorage.setItem('lastAIConfig', JSON.stringify(aiConfigState));

        // 跳转到游戏页面
        window.location.href = '/game';
    }

    // 开始本地多人游戏
    startLocalMultiplayerGame() {
        // 验证玩家数量
        if (this.localMultiplayerConfig.playerCount < 2) {
            alert('至少需要2个玩家才能开始游戏！');
            return;
        }

        // 验证所有玩家都有名称
        for (let player of this.localMultiplayerConfig.players) {
            if (!player.name || player.name.trim() === '') {
                alert('请为所有玩家输入名称！');
                return;
            }
        }

        // 获取道具模式开关状态
        const skillModeCheckbox = document.getElementById('localSkillModeCheckbox');
        const skillMode = skillModeCheckbox ? skillModeCheckbox.checked : false;
        const happyModeCheckbox = document.getElementById('localHappyModeCheckbox');
        const happyMode = happyModeCheckbox ? happyModeCheckbox.checked : false;

        // 构建本地多人游戏配置
        const localGameConfig = {
            mode: 'local_multiplayer',
            playerCount: this.localMultiplayerConfig.playerCount,
            pieceCount: this.localMultiplayerConfig.pieceCount,
            skillMode: skillMode,
            happyMode: happyMode,
            players: this.localMultiplayerConfig.players.map(player => ({
                id: player.id,
                name: player.name.trim(),
                emojiIndex: player.emojiIndex,
                emoji: (() => {
                    if (player.isAI === true) {
                        const difficulty = this.localMultiplayerConfig.botDifficulties.get(player.id) || 'easy';
                        this.ensureLocalAIEmojiKey(player, difficulty);
                        return { key: player.aiEmojiKey || 'bot' };
                    }

                    const item = this.emojiList[player.emojiIndex];
                    return { key: (item && item.key) ? item.key : defaultEmoji };
                })(),
                isAI: player.isAI === true
            }))
        };

        // 如果存在AI，透传bots与难度配置
        const botIds = this.localMultiplayerConfig.players.filter(p => p.isAI).map(p => p.id);
        if (botIds.length > 0) {
            localGameConfig.bots = botIds;
            localGameConfig.botDifficulties = {};
            botIds.forEach(id => {
                const d = this.localMultiplayerConfig.botDifficulties.get(id) || 'easy';
                localGameConfig.botDifficulties[id] = d;
            });
        }

        console.log('本地多人游戏配置:', localGameConfig);
        sessionStorage.setItem('gameConfig', JSON.stringify(localGameConfig));

        // 保存当前游戏模式状态和详细配置
        sessionStorage.setItem('lastGameMode', this.currentMode);
        // 保存本地多人配置，包含道具模式状态
        const localConfigState = {
            playerCount: this.localMultiplayerConfig.playerCount,
            pieceCount: this.localMultiplayerConfig.pieceCount,
            players: this.localMultiplayerConfig.players,
            bots: this.localMultiplayerConfig.players.filter(p => p.isAI).map(p => p.id),
            botDifficulties: (() => {
                const result = {};
                if (this.localMultiplayerConfig && this.localMultiplayerConfig.botDifficulties) {
                    for (const [id, diff] of this.localMultiplayerConfig.botDifficulties.entries()) {
                        result[id] = diff;
                    }
                }
                return result;
            })(),
            skillMode: skillMode,
            happyMode: happyMode
        };
        sessionStorage.setItem('lastLocalConfig', JSON.stringify(localConfigState));

        // 跳转到游戏页面
        window.location.href = '/game';
    }

    // 恢复游戏模式状态
    restoreGameModeState() {
        const lastGameMode = sessionStorage.getItem('lastGameMode');
        if (lastGameMode) {
            console.log('恢复上次的游戏模式:', lastGameMode);

            if (lastGameMode === 'ai') {
                // 模拟点击人机对战按钮
                this.currentMode = 'ai';
                const configTitle = document.getElementById('configTitle');
                configTitle.textContent = '人机对战设置';
                this.showConfigPanel();
                this.showAIConfig();

                // 恢复AI配置详细信息
                this.restoreAIConfig();
                sessionStorage.removeItem('lastGameMode');
                return true;
            } else if (lastGameMode === 'local') {
                // 模拟点击本地多人按钮
                this.currentMode = 'local';
                const configTitle = document.getElementById('configTitle');
                configTitle.textContent = '本地多人设置';
                this.showConfigPanel();
                this.hideAIConfig();

                // 恢复本地多人配置详细信息
                this.restoreLocalConfig();
                sessionStorage.removeItem('lastGameMode');
                return true;
            }

            // 清除保存的状态，避免下次访问时自动恢复
            sessionStorage.removeItem('lastGameMode');
        }
        return false;
    }

    // 恢复AI配置详细信息
    restoreAIConfig() {
        const lastAIConfig = sessionStorage.getItem('lastAIConfig');
        if (lastAIConfig) {
            try {
                const config = JSON.parse(lastAIConfig);
                console.log('恢复AI配置:', config);

                // 恢复选中的玩家颜色
                if (config.selectedPlayer) {
                    this.selectColor(config.selectedPlayer);
                }

                // 恢复选中的表情
                if (config.selectedEmoji !== undefined) {
                    this.selectedEmoji = config.selectedEmoji;
                    this.updateCurrentEmojiDisplay();
                }

                // 恢复棋子个数
                if (config.selectedPieceCount) {
                    this.selectedPieceCount = config.selectedPieceCount;
                    this.restorePieceCountSelection();
                }

                // 恢复用户名
                if (config.username) {
                    const usernameInput = document.getElementById('playerUsername');
                    if (usernameInput) {
                        usernameInput.value = config.username;
                    }
                }

                // 恢复AI玩家配置
                if (config.activeBots && config.activeBots.length > 0) {
                    // 确保恢复的activeBots中不包含当前选中的人类玩家
                    const filteredBots = config.activeBots.filter(bot => bot !== this.selectedPlayer);
                    this.activeBots = new Set(filteredBots);

                    // 恢复难度设置：只保留activeBots中玩家的难度
                    this.botDifficulties = new Map();
                    if (config.botDifficulties) {
                        for (const bot of this.activeBots) {
                            const difficulty = config.botDifficulties[bot] || 'easy';
                            this.botDifficulties.set(bot, difficulty);
                        }
                    }

                    this.updateBotPlayers();
                    this.updateStartButton();
                    console.log('恢复AI配置后，activeBots:', Array.from(this.activeBots), 'botDifficulties:', Object.fromEntries(this.botDifficulties));
                }

                // 恢复道具模式勾选状态
                if (config.skillMode !== undefined) {
                    const skillModeCheckbox = document.getElementById('aiSkillModeCheckbox');
                    if (skillModeCheckbox) {
                        skillModeCheckbox.checked = config.skillMode;
                        console.log('恢复道具模式状态:', config.skillMode);
                    }
                }
                // 恢复欢乐模式勾选状态
                if (config.happyMode !== undefined) {
                    const happyModeCheckbox = document.getElementById('aiHappyModeCheckbox');
                    if (happyModeCheckbox) {
                        happyModeCheckbox.checked = config.happyMode;
                    }
                }

                sessionStorage.removeItem('lastAIConfig');
            } catch (error) {
                console.error('恢复AI配置失败:', error);
            }
        }
    }

    // 恢复本地多人配置详细信息
    restoreLocalConfig() {
        const lastLocalConfig = sessionStorage.getItem('lastLocalConfig');
        if (lastLocalConfig) {
            try {
                const config = JSON.parse(lastLocalConfig);
                console.log('恢复本地多人配置:', config);

                // 恢复玩家数量
                if (config.playerCount) {
                    this.localMultiplayerConfig.playerCount = config.playerCount;
                    // 更新玩家数量选择器UI
                    const playerCountOptions = document.querySelectorAll('.local-multiplayer-config .player-count-option');
                    playerCountOptions.forEach(option => {
                        option.classList.remove('selected');
                        if (parseInt(option.dataset.count) === config.playerCount) {
                            option.classList.add('selected');
                        }
                    });
                }

                // 恢复棋子个数
                if (config.pieceCount) {
                    this.localMultiplayerConfig.pieceCount = config.pieceCount;
                    // 调用专用的恢复方法
                    this.restoreLocalPieceCountSelection();
                }

                // 恢复玩家配置
                if (config.players) {
                    this.localMultiplayerConfig.players = config.players;

                    // 重建真人颜色选择（humanColors）
                    this.localMultiplayerConfig.humanColors = new Set(
                        (config.players || []).filter(p => p && p.isAI !== true).map(p => p.id)
                    );
                    this.updateLocalHumanColorSelectionUI();
                    this.updateLocalMultiplayerPlayerCountFromSelection();

                    // 重建AI占位状态（bots与botDifficulties）
                    this.localMultiplayerConfig.bots.clear();
                    this.localMultiplayerConfig.botDifficulties.clear();
                    (config.players || []).forEach(p => {
                        if (p && p.isAI === true) {
                            this.localMultiplayerConfig.bots.add(p.id);
                            const diff = (config.botDifficulties && config.botDifficulties[p.id]) || 'easy';
                            this.localMultiplayerConfig.botDifficulties.set(p.id, diff);
                        }
                    });

                    this.recalculateLocalBotNames();

                    // 重新生成玩家设置UI（保留AI标记）
                    this.generatePlayersSetupWithExistingPlayers();
                }

                // 恢复道具模式勾选状态
                if (config.skillMode !== undefined) {
                    const skillModeCheckbox = document.getElementById('localSkillModeCheckbox');
                    if (skillModeCheckbox) {
                        skillModeCheckbox.checked = config.skillMode;
                        console.log('恢复本地多人道具模式状态:', config.skillMode);
                    }
                }
                // 恢复欢乐模式勾选状态
                if (config.happyMode !== undefined) {
                    const happyModeCheckbox = document.getElementById('localHappyModeCheckbox');
                    if (happyModeCheckbox) {
                        happyModeCheckbox.checked = config.happyMode;
                    }
                }

                sessionStorage.removeItem('lastLocalConfig');
            } catch (error) {
                console.error('恢复本地多人配置失败:', error);
            }
        }
    }
}

// 初始化多人联机管理器
let multiplayerManager;

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    // 初始化游戏提示轮播
    const gameTipsCarousel = new GameTipsCarousel();
    gameTipsCarousel.init();

    // 清理之前的实例，避免缓存问题
    if (window.multiplayerManager) {
        window.multiplayerManager.destroy();
        window.multiplayerManager = null;
    }

    // 检查URL参数，如果有房间号则自动尝试加入
    const urlParams = new URLSearchParams(window.location.search);
    const roomCode = urlParams.get('room');
    const reason = urlParams.get('reason');

    // 处理被踢出的通知
    if (reason === 'kicked') {
        const errorEl = document.createElement('div');
        errorEl.className = 'room-error-message';
        errorEl.textContent = '你已被房主踢出房间';
        document.body.appendChild(errorEl);
        
        // 3秒后自动移除通知
        setTimeout(() => {
            if (errorEl && errorEl.parentNode) {
                errorEl.remove();
            }
        }, 3000);

        // 清除 URL 中的参数，避免刷新重复弹出
        const newUrl = new URL(window.location);
        newUrl.searchParams.delete('reason');
        window.history.replaceState({}, '', newUrl);
    }

    const shouldResetReadyOnRoomReturn = sessionStorage.getItem('aeroplaneChess_resetReadyOnRoomReturn') === 'true';
    if (shouldResetReadyOnRoomReturn) {
        sessionStorage.removeItem('aeroplaneChess_resetReadyOnRoomReturn');
    }

    const playerSetup = new PlayerSetup();

    if (roomCode) {
        playerSetup.showOnlineMultiplayerConfig();

        const mm = window.multiplayerManager;
        if (mm && typeof mm.showRoomConfigWithLoading === 'function') {
            mm.showRoomConfigWithLoading();
            mm.roomCode = (roomCode || '').toUpperCase().trim();
            if (typeof mm.updateRoomInfo === 'function') {
                mm.updateRoomInfo();
            }
        }

        autoJoinRoom(roomCode);
        return;
    }

    if (!playerSetup.restoreGameModeState()) {
        playerSetup.showModeSelection();
    }

    // 监听左侧控制面板高度变化，同步到右侧游戏规则面板
    const leftPanel = document.querySelector('.index-content > .control-panel:first-child');
    const rulesPanel = document.querySelector('.index-content .game-rules-panel');
    if (leftPanel && rulesPanel) {
        // 已删除同步高度逻辑
    }
});
async function autoJoinRoom(roomCode) {
    try {
        console.log('开始自动加入房间:', roomCode);

        // 初始化MultiplayerManager
        multiplayerManager = window.multiplayerManager || new MultiplayerManager();
        window.multiplayerManager = multiplayerManager;

        // 连接到服务器
        console.log('正在连接到服务器...');
        const connected = await multiplayerManager.connectToServer();

        if (!connected) {
            throw new Error('无法连接到服务器');
        }

        console.log('服务器连接成功');

        const shouldResetReadyOnRoomReturn = sessionStorage.getItem('aeroplaneChess_resetReadyOnRoomReturn') === 'true';
        if (shouldResetReadyOnRoomReturn && window.playerIdManager) {
            const playerId = window.playerIdManager.getPlayerId();
            if (playerId) {
                try {
                    localStorage.removeItem(`ready_${(roomCode || '').toUpperCase().trim()}_${playerId}`);
                } catch (e) {
                    // ignore
                }
            }
        }

        // 直接通过WebSocket客户端加入房间
        multiplayerManager.wsClient.joinRoom(roomCode);

    } catch (error) {
        console.error('自动加入房间失败:', error);
        // 如果自动加入失败，显示错误信息并回到房间列表
        showRoomError('无法连接到房间');
        try {
            const url = new URL(window.location);
            url.searchParams.delete('room');
            window.history.replaceState({}, '', url);
        } catch (e) {
            // ignore
        }

        if (window.multiplayerManager && typeof window.multiplayerManager.showRoomSelection === 'function') {
            window.multiplayerManager.showRoomSelection();
        }
    }
}

// 显示房间错误信息的函数
function showRoomError(message) {
    // 创建错误提示元素
    const errorDiv = document.createElement('div');
    errorDiv.className = 'room-error-message';
    errorDiv.textContent = message;

    document.body.appendChild(errorDiv);

    // 3秒后自动移除错误信息
    setTimeout(() => {
        if (errorDiv.parentNode) {
            errorDiv.parentNode.removeChild(errorDiv);
        }
    }, 3000);
}