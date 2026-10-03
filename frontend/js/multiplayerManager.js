import { reconnectManager } from './reconnectManager.js';
import { nicknameGenerator } from './nicknameGenerator.js';

// 本地乐观改动（AI 名单）最多压这么久：服务端一直没回声就别再挡着权威名单
const AI_OP_TTL_MS = 4000;

class MultiplayerManager {
    constructor() {
        this.wsClient = null;
        this.isHost = false;
        this.currentPlayer = null;
        this.roomCode = null;
        this.currentRoom = null; // 当前房间数据
        this.players = new Map(); // playerId -> playerData
        this.aiPlayers = new Map(); // AI玩家数据
        this.aiDifficulties = new Map(); // AI难度设置
        this._pendingAIOps = []; // 还没被服务端回声确认的 AI 名单改动（点太快也不回弹）
        this.playerReadyStatus = new Map(); // playerId -> isReady 准备状态
        this.currentEmojiIndex = 0;
        this.emojis = null;
        this.emojiKeys = [];
        this.selectedEmoji = 'smile'; // 默认表情

        // 大厅房间列表
        this.publicRooms = [];
        this.roomSearchQuery = '';
        this.publicRoomsRefreshInterval = null;

        // 重连相关配置
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.isDestroyed = false;
        this.isLeavingRoom = false; // 标志：正在主动离开房间

        this._backGuardEnabled = false;
        this._suppressNextPopstate = false;
        this._popstateHandler = null;

        this.offlineCountdowns = new Map(); // playerId -> { endAt, intervalId }

        this._exitToMainMenuAfterLeave = false;

        this._reconnectRoomCode = null;

        this.roomChatMessages = [];
        this.roomChatMaxCount = 50;
        this.roomChatOpen = false;
        this.roomChatUnreadCount = 0;



        this.init();
    }



    startOfflineCountdown(playerId, durationSeconds = 10) {
        if (!playerId) return;

        this.stopOfflineCountdown(playerId);

        const endAt = Date.now() + durationSeconds * 1000;
        const intervalId = setInterval(() => {
            const remainingSeconds = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
            this.updateOfflineOverlayForPlayer(playerId, remainingSeconds);

            if (remainingSeconds <= 0) {
                this.stopOfflineCountdown(playerId);
            }
        }, 250);

        this.offlineCountdowns.set(playerId, { endAt, intervalId });

        // 立即刷新一次
        this.updateOfflineOverlayForPlayer(playerId, Math.max(0, Math.ceil((endAt - Date.now()) / 1000)));
    }

    stopOfflineCountdown(playerId) {
        const existing = this.offlineCountdowns.get(playerId);
        if (existing && existing.intervalId) {
            clearInterval(existing.intervalId);
        }
        this.offlineCountdowns.delete(playerId);
        this.removeOfflineOverlayForPlayer(playerId);
    }

    getRemainingOfflineSeconds(playerId) {
        const entry = this.offlineCountdowns.get(playerId);
        if (!entry || !entry.endAt) return null;
        return Math.max(0, Math.ceil((entry.endAt - Date.now()) / 1000));
    }

    findColorCircleByPlayerId(playerId) {
        if (!playerId) return null;
        const player = this.players.get(playerId);
        const color = player ? player.color : null;
        if (!color) return null;

        const multiplayerPanel = document.getElementById('onlineMultiplayerConfig');
        if (!multiplayerPanel) return null;

        const option = multiplayerPanel.querySelector(`.color-option[data-player="${color}"]`);
        if (!option) return null;
        return option.querySelector('.color-circle');
    }

    updateOfflineOverlayForPlayer(playerId, remainingSeconds) {
        const circle = this.findColorCircleByPlayerId(playerId);
        if (!circle) return;

        let overlay = circle.querySelector('.offline-countdown-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'offline-countdown-overlay';
            circle.appendChild(overlay);
        }

        overlay.textContent = String(remainingSeconds);
    }

    removeOfflineOverlayForPlayer(playerId) {
        const circle = this.findColorCircleByPlayerId(playerId);
        if (!circle) return;
        const overlay = circle.querySelector('.offline-countdown-overlay');
        if (overlay) {
            overlay.remove();
        }
    }

    async init() {
        try {
            // 动态导入表情数据
            const emojiModule = await import('../assets/emojis.js');
            this.emojis = emojiModule.emojis;

            // 获取表情键列表，排除bot表情
            this.emojiKeys = Object.keys(this.emojis).filter(key => key !== 'bot');

            this.bindEvents();
            this.initEmojiSwitcher();
            this.initRoomCodeInputs();

            this.initPublicRoomList();
            this.initRoomNameEditor();

            // 恢复保存的昵称到输入框
            this.restoreSavedNickname();

            // 启动连接状态监控
            this.startConnectionMonitor();

            // 如果当前就在房间列表界面，主动拉取一次房间列表
            if (this.isRoomSelectionActive()) {
                this.requestPublicRooms();
                this.startPublicRoomsAutoRefresh();
            }
        } catch (error) {
            console.error('初始化多人联机管理器失败:', error);
        }
    }

    startPublicRoomsAutoRefresh() {
        if (this.publicRoomsRefreshInterval) {
            clearInterval(this.publicRoomsRefreshInterval);
        }
        this.publicRoomsRefreshInterval = setInterval(() => {
            if (this.isDestroyed) return;
            if (!this.isRoomSelectionActive()) return;
            this.requestPublicRooms();
        }, 2000);
    }

    stopPublicRoomsAutoRefresh() {
        if (this.publicRoomsRefreshInterval) {
            clearInterval(this.publicRoomsRefreshInterval);
            this.publicRoomsRefreshInterval = null;
        }
    }

    initPublicRoomList() {
        const searchInput = document.getElementById('roomSearchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.roomSearchQuery = (e.target.value || '').trim();
                this.renderPublicRoomList();
            });
        }
    }

    initRoomNameEditor() {
        const roomNameInput = document.getElementById('roomNameInput');
        if (!roomNameInput) return;

        const commit = () => {
            if (!this.isHost) return;
            if (!this.wsClient || !this.wsClient.isConnected) return;

            const name = (roomNameInput.value || '').trim();
            this.wsClient.sendMessage('update_room_name', { name });
        };

        roomNameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                roomNameInput.blur();
            }
        });

        roomNameInput.addEventListener('blur', () => {
            commit();
        });
    }

    updateConfigHeaderTitle() {
        const titleEl = document.getElementById('configTitle');
        const roomNameInput = document.getElementById('roomNameInput');
        if (!titleEl || !roomNameInput) return;

        // 房间配置界面优先（避免切换过程中 roomSelection 判断不准）
        if (this.isRoomConfigActive()) {
            const roomName = this.currentRoom?.name || (this.currentPlayer?.nickname ? `${this.currentPlayer.nickname}的房间` : '房间');
            if (this.isHost) {
                titleEl.style.display = 'none';
                roomNameInput.style.display = '';
                roomNameInput.value = roomName;
            } else {
                roomNameInput.style.display = 'none';
                titleEl.style.display = '';
                titleEl.textContent = roomName;
            }
            return;
        }

        // 房间列表界面
        if (this.isRoomSelectionActive()) {
            titleEl.style.display = '';
            roomNameInput.style.display = 'none';
            titleEl.textContent = '房间列表';
        }
    }

    // 恢复保存的昵称
    restoreSavedNickname() {
        // 使用 setTimeout 确保 DOM 已经完全加载
        setTimeout(() => {
            if (window.playerIdManager) {
                const savedNickname = window.playerIdManager.getSavedNickname();
                if (savedNickname) {
                    const nicknameInput = document.getElementById('multiplayerPlayerUsername');
                    if (nicknameInput) {
                        nicknameInput.value = savedNickname;
                    } else {
                        console.warn('[restoreSavedNickname] 昵称输入框不存在，稍后重试');
                        // 如果输入框还不存在，再次尝试
                        setTimeout(() => {
                            const input = document.getElementById('multiplayerPlayerUsername');
                            if (input) {
                                input.value = savedNickname;
                                console.log('[restoreSavedNickname] 延迟恢复昵称成功:', savedNickname);
                            }
                        }, 500);
                    }
                }
            }
        }, 100);
    }

    startConnectionMonitor() {
        // 每5秒检查一次连接状态
        this.connectionMonitorInterval = setInterval(() => {
            const ws = this.wsClient && this.wsClient.ws ? this.wsClient.ws : null;
            if (ws && ws.readyState === WebSocket.CLOSED && !this.isDestroyed) {
                console.log('检测到WebSocket连接已断开，尝试重连');
                this.attemptReconnect();
            }
        }, 5000);
    }

    bindEvents() {
        // 切回前台：房间状态可能早就过期了（掉线超时被移出，但页面还停在旧面板上）。
        // 后台挂起的 socket 常常还是「假活着」，所以一律按断线重走一遍：重连后会自动
        // rejoinRoom，人还在就刷新面板；被移出 / 局已开由错误分支把他送回首页
        this.visibilityHandler = () => {
            if (document.visibilityState !== 'visible') return;
            const roomCode = this.roomCode || (this.currentRoom && this.currentRoom.code);
            // 只在「确实已在一间房间里」时核对：建房/加入的加载阶段房间号可能还是空的或上一间的残留
            if (!roomCode || !this.currentRoom || this.isLeavingRoom || this.isDestroyed) return;
            this.wsClient?.treatAsDisconnected?.('visibility_resume');
        };
        document.addEventListener('visibilitychange', this.visibilityHandler);

        // 恢复保存的昵称到输入框
        this.restoreSavedNickname();

        // 移除之前的事件监听器，避免重复绑定
        if (this.eventHandler) {
            document.removeEventListener('click', this.eventHandler);
        }

        // 创建事件处理函数 - 只处理多人联机面板内的事件
        this.eventHandler = (e) => {
            // 检查点击事件是否发生在多人联机相关的面板内
            const multiplayerPanel = document.getElementById('onlineMultiplayerConfig');
            const roomPanel = document.getElementById('roomConfig');
            const playerConfigPanel = document.getElementById('playerConfigPanel');
            const joinRoomModal = document.getElementById('joinRoomModal');

            // 特殊处理：如果点击的是模态框背景，关闭模态框
            if (e.target === joinRoomModal) {
                this.hideJoinRoomModal();
                return;
            }

            // 如果点击不在多人联机面板、房间面板或加入房间模态框内，直接返回
            if (!multiplayerPanel?.contains(e.target) &&
                !roomPanel?.contains(e.target) &&
                !playerConfigPanel?.contains(e.target) &&
                !joinRoomModal?.contains(e.target)) {
                return;
            }



            // 处理AI玩家添加/移除事件
            const botAddOption = e.target.closest('.bot-add-option');
            const removeBtn = e.target.closest('.remove-btn');
            const botPlayer = e.target.closest('.bot-player');
            const difficultyCircle = e.target.closest('.difficulty-circle');
            const kickBtn = e.target.closest('.kick-player-btn');

            if (kickBtn) {
                return;
            }

            if (botAddOption) {
                const color = parseInt(botAddOption.dataset.color);
                this.addAIPlayer(color);
                return;
            }

            if (removeBtn && botPlayer) {
                console.log('点击移除AI玩家');
                e.stopPropagation();
                const color = parseInt(botPlayer.dataset.color);
                this.removeAIPlayer(color);
                return;
            }

            if (difficultyCircle) {
                const color = parseInt(difficultyCircle.dataset.color);
                this.toggleAIDifficulty(color);
                return;
            }

            // 查找最近的按钮元素（处理嵌套元素点击）
            let targetElement = e.target;

            while (targetElement && !targetElement.id) {
                targetElement = targetElement.parentElement;
                if (!targetElement || targetElement === document) break;
            }


            if (targetElement?.id === 'createRoomBtn') {
                console.log('创建房间');
                // 防止重复点击
                if (targetElement.disabled) {
                    return;
                }
                targetElement.disabled = true;

                // 立即进入房间面板，提供即时反馈
                this.showRoomConfigWithLoading();

                // 异步创建房间
                this.createRoomAsync().finally(() => {
                    // 2秒后重新启用按钮
                    setTimeout(() => {
                        targetElement.disabled = false;
                    }, 2000);
                });
            } else if (targetElement?.id === 'joinRoomBtn') {
                this.showJoinRoomModal();
            } else if (targetElement?.id === 'reconnectBtn') {
                this.reconnectToLastRoom();
            } else if (targetElement?.id === 'confirmJoinRoom') {
                this.joinRoom();
            } else if (targetElement?.id === 'cancelJoinRoom') {
                this.hideJoinRoomModal();
            } else if (targetElement?.id === 'closeJoinRoomModal') {
                this.hideJoinRoomModal();
            } else if (targetElement?.id === 'multiplayerStartGame') {
                if (this.isHost) {
                    this.startGame();
                }
            } else if (targetElement?.id === 'backBtn') {
                this.handleBackButton();
                if (typeof this.hideKickMenu === 'function') {
                    this.hideKickMenu();
                }
            }
        };

        // 使用事件委托来处理动态元素
        document.addEventListener('click', this.eventHandler);

        // 道具模式复选框事件
        const skillModeCheckbox = document.getElementById('skillModeCheckbox');
        if (skillModeCheckbox) {
            skillModeCheckbox.addEventListener('change', (e) => {
                if (this.isHost && this.wsClient) {
                    const skillMode = e.target.checked;
                    console.log('[配置] 道具模式变更:', skillMode);

                    // 立即更新本地房间设置
                    if (!this.currentRoom) {
                        this.currentRoom = { settings: {} };
                    }
                    if (!this.currentRoom.settings) {
                        this.currentRoom.settings = {};
                    }
                    this.currentRoom.settings.skillMode = skillMode;

                    // 发送配置更新到服务器
                    this.wsClient.sendMessage('updateSettings', {
                        settings: {
                            skillMode: skillMode
                        }
                    });

                    // 立即更新房间信息显示
                    this.updateRoomInfo();
                }
            });
        }

        // 起手积分滑块事件（道具模式下的可选开局积分）
        const initialEnergySlider = document.getElementById('onlineInitialEnergySlider');
        if (initialEnergySlider) {
            initialEnergySlider.addEventListener('input', (e) => {
                const energy = [0, 15, 30, 50, 70, 100][Number(e.target.value)] || 0;
                if (!this.isHost || !this.wsClient) return;

                if (!this.currentRoom) this.currentRoom = { settings: {} };
                if (!this.currentRoom.settings) this.currentRoom.settings = {};
                this.currentRoom.settings.initialEnergy = energy;

                this.wsClient.sendMessage('updateSettings', {
                    settings: {
                        initialEnergy: energy
                    }
                });
            });
        }

        // 欢乐模式复选框事件
        const happyModeCheckbox = document.getElementById('happyModeCheckbox');
        if (happyModeCheckbox) {
            happyModeCheckbox.addEventListener('change', (e) => {
                if (this.isHost && this.wsClient) {
                    const happyMode = e.target.checked;
                    // 立即更新本地房间设置
                    if (!this.currentRoom) {
                        this.currentRoom = { settings: {} };
                    }
                    if (!this.currentRoom.settings) {
                        this.currentRoom.settings = {};
                    }
                    this.currentRoom.settings.happyMode = happyMode;

                    // 发送配置更新到服务器
                    this.wsClient.sendMessage('updateSettings', {
                        settings: {
                            happyMode: happyMode
                        }
                    });

                    // 立即更新房间信息显示
                    this.updateRoomInfo();
                }
            });
        }

        const roomPrivacyPublicBtn = document.getElementById('roomPrivacyPublicBtn');
        const roomPrivacyPrivateBtn = document.getElementById('roomPrivacyPrivateBtn');
        if (roomPrivacyPublicBtn && roomPrivacyPrivateBtn) {
            roomPrivacyPublicBtn.addEventListener('click', () => {
                if (!this.isHost || !this.wsClient) return;
                this.setRoomPrivacy(false);
            });
            roomPrivacyPrivateBtn.addEventListener('click', () => {
                if (!this.isHost || !this.wsClient) return;
                this.setRoomPrivacy(true);
            });
        }

        // 房间号输入框事件（使用事件委托）
        document.addEventListener('input', (e) => {
            if (e.target.id === 'roomCodeInput') {
                e.target.value = e.target.value.toUpperCase();
            }
        });

        document.addEventListener('keypress', (e) => {
            if (e.target.id === 'roomCodeInput' && e.key === 'Enter') {
                this.joinRoom();
            }
        });

        // 复制房间号 - 点击房间号直接复制
        document.getElementById('roomCodeDisplay').addEventListener('click', () => {
            this.copyRoomCode();
        });

        // 颜色选择事件 - 只绑定在线联机配置面板中的color-option
        const onlineConfig = document.getElementById('onlineMultiplayerConfig');
        if (onlineConfig) {
            onlineConfig.querySelectorAll('.color-option').forEach(option => {
                option.addEventListener('click', (e) => {
                    // 检查是否点击的是add-player-btn或color-circle
                    if (e.target.classList.contains('add-player-btn') ||
                        e.target.classList.contains('color-circle') ||
                        e.target.closest('.color-circle')) {
                        const playerNum = parseInt(option.dataset.player);
                        this.selectColor(playerNum);
                    }
                });
            });
        }

        // 表情切换事件
        document.getElementById('multiplayerPrevEmoji').addEventListener('click', () => {
            this.switchEmoji(-1);
        });

        document.getElementById('multiplayerNextEmoji').addEventListener('click', () => {
            this.switchEmoji(1);
        });

        // 昵称输入事件
        const nicknameInput = document.getElementById('multiplayerPlayerUsername');
        nicknameInput.addEventListener('input', (e) => {
            // 不要立即更新本地状态，等待服务器确认
            // 只在用户停止输入后发送更新请求
            clearTimeout(this.nicknameUpdateTimeout);
            this.nicknameUpdateTimeout = setTimeout(() => {
                // 确保e.target和value存在
                if (e.target && typeof e.target.value !== 'undefined') {
                    this.updateNickname(e.target.value, { manualInput: true });
                }
            }, 500); // 500ms延迟，避免频繁发送请求
        });

        // 联机模式的随机昵称按钮
        const multiplayerNicknameDiceBtn = document.getElementById('multiplayerNicknameDice');
        if (multiplayerNicknameDiceBtn) {
            multiplayerNicknameDiceBtn.addEventListener('click', () => {
                // 添加点击动画
                multiplayerNicknameDiceBtn.classList.add('clicking');
                setTimeout(() => {
                    multiplayerNicknameDiceBtn.classList.remove('clicking');
                }, 500);

                const randomNickname = nicknameGenerator.generate();
                if (nicknameInput) {
                    nicknameInput.value = randomNickname;
                    // 立即触发昵称更新
                    clearTimeout(this.nicknameUpdateTimeout);
                    this.updateNickname(randomNickname, { manualInput: false });
                }
            });
        }

        // 添加回车键事件监听
        nicknameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                clearTimeout(this.nicknameUpdateTimeout);
                // 确保e.target和value存在
                if (e.target && typeof e.target.value !== 'undefined') {
                    this.updateNickname(e.target.value, { manualInput: true });
                    e.target.blur(); // 失去焦点
                }
            }
        });

        // 房主设置事件 - 使用事件委托处理房间配置面板中的棋子个数选择器
        const roomConfigPanel = document.getElementById('roomConfig');
        if (roomConfigPanel) {
            const pieceCountContainer = roomConfigPanel.querySelector('.piece-count-selector');
            if (pieceCountContainer) {
                pieceCountContainer.addEventListener('click', (e) => {
                    const option = e.target.closest('.piece-count-option');
                    if (option && this.isHost) {
                        const count = parseInt(option.dataset.count);
                        this.setPieceCount(count);
                    }
                });
            } else {
                // 回退方案：如果找不到容器，直接绑定所有选项
                roomConfigPanel.querySelectorAll('.piece-count-option').forEach(option => {
                    option.addEventListener('click', () => {
                        if (this.isHost) {
                            const count = parseInt(option.dataset.count);
                            this.setPieceCount(count);
                        }
                    });
                });
            }
        }

        // 准备按钮事件（移除旧的监听器，避免重复绑定）
        const playerReadyBtn = document.getElementById('playerReadyBtn');
        if (playerReadyBtn) {
            // 移除之前的监听器
            if (this.playerReadyHandler) {
                playerReadyBtn.removeEventListener('click', this.playerReadyHandler);
            }
            // 创建新的处理器并保存引用
            this.playerReadyHandler = () => {
                this.togglePlayerReady();
            };
            playerReadyBtn.addEventListener('click', this.playerReadyHandler);
        }

        this.initRoomChatUI();

    }

    initRoomChatUI() {
        const toggleBtn = document.getElementById('roomChatToggleBtn');
        const sendBtn = document.getElementById('roomChatSendBtn');
        const input = document.getElementById('roomChatInput');
        const emojiBtn = document.getElementById('roomChatEmojiBtn');
        const emojiPanel = document.getElementById('roomChatEmojiPanel');
        const emojiPanelContent = document.getElementById('roomChatEmojiPanelContent');
        if (!toggleBtn || !sendBtn || !input || !emojiBtn || !emojiPanel || !emojiPanelContent) {
            return;
        }

        this.initRoomChatEmojiPanel(emojiPanelContent);
        this.updateRoomChatUnreadBadge();

        if (!this.roomChatToggleHandler) {
            this.roomChatToggleHandler = () => this.toggleRoomChatDrawer();
            toggleBtn.addEventListener('click', this.roomChatToggleHandler);
        }

        if (!this.roomChatSendHandler) {
            this.roomChatSendHandler = () => this.sendRoomChatMessage();
            sendBtn.addEventListener('click', this.roomChatSendHandler);
        }

        if (!this.roomChatInputEnterHandler) {
            this.roomChatInputEnterHandler = (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    this.sendRoomChatMessage();
                }
            };
            input.addEventListener('keydown', this.roomChatInputEnterHandler);
        }

        if (!this.roomChatEmojiHandler) {
            this.roomChatEmojiHandler = (event) => {
                event.stopPropagation();
                this.toggleRoomChatEmojiPanel();
            };
            emojiBtn.addEventListener('click', this.roomChatEmojiHandler);
        }

        if (!this.roomChatEmojiPanelClickHandler) {
            this.roomChatEmojiPanelClickHandler = (event) => event.stopPropagation();
            emojiPanel.addEventListener('click', this.roomChatEmojiPanelClickHandler);
        }

        if (!this.roomChatDocumentClickHandler) {
            this.roomChatDocumentClickHandler = () => this.hideRoomChatEmojiPanel();
            document.addEventListener('click', this.roomChatDocumentClickHandler);
        }
    }

    updateRoomChatVisibility(enabled) {
        const drawer = document.getElementById('roomChatDrawer');
        if (!drawer) return;
        drawer.classList.toggle('is-enabled', !!enabled);
        if (!enabled) {
            drawer.classList.remove('is-open');
            this.roomChatOpen = false;
            this.clearRoomChatUnread();
            this.hideRoomChatEmojiPanel();
        }
    }

    toggleRoomChatDrawer(forceValue = null) {
        const drawer = document.getElementById('roomChatDrawer');
        if (!drawer || !drawer.classList.contains('is-enabled')) return;
        const next = forceValue == null ? !this.roomChatOpen : !!forceValue;
        this.roomChatOpen = next;
        drawer.classList.toggle('is-open', next);
        if (next) {
            this.clearRoomChatUnread();
        }
        if (!next) {
            this.hideRoomChatEmojiPanel();
        }
    }

    initRoomChatEmojiPanel(panelContent) {
        if (this.roomChatEmojiPanelInited || !panelContent) return;
        const fontEmojis = [
            '😄', '😉', '😏', '😎', '🙂', '😜',
            '🤣', '😂', '🥳', '😌', '😇', '😝',
            '👍', '👌', '✌️', '🤝', '🙏', '👊',
            '😴', '😐', '😕', '😬', '😁', '😃',
            '🤨', '😯', '🥰', '😙', '🖐️', '🤜',
            '🤞', '😑'
        ];
        panelContent.innerHTML = '';
        fontEmojis.forEach((emoji) => {
            const emojiItem = document.createElement('div');
            emojiItem.className = 'room-chat-emoji-item';
            emojiItem.textContent = emoji;
            emojiItem.addEventListener('click', (event) => {
                event.stopPropagation();
                this.insertRoomChatEmoji(emoji);
                this.hideRoomChatEmojiPanel();
            });
            panelContent.appendChild(emojiItem);
        });
        this.roomChatEmojiPanelInited = true;
    }

    clearRoomChatHistory() {
        this.roomChatMessages = [];
        this.clearRoomChatUnread();
        this.renderRoomChatMessages();
    }

    getRoomChatPlayerName(playerName, playerNumber, playerId) {
        if (playerName) return playerName;
        const byId = playerId ? this.players.get(playerId) : null;
        if (byId?.nickname) return byId.nickname;
        if (typeof playerNumber === 'number') return `玩家${playerNumber}`;
        return '系统';
    }

    getRoomChatNameColorClass(playerNumber) {
        const colorIndex = Number(playerNumber);
        if ([1, 2, 3, 4].includes(colorIndex)) {
            return `player-${colorIndex}-name`;
        }
        return '';
    }

    appendRoomChatMessage(
        { playerName, playerNumber = null, playerId = null, message = '', isSystem = false, isSpectator = false, timestamp = Date.now() },
        options = {}
    ) {
        const text = String(message || '').trim();
        if (!text) return;

        const normalizedPlayerNumber = [1, 2, 3, 4].includes(Number(playerNumber))
            ? Number(playerNumber)
            : null;

        // 观战者没有席位配色，直接用服务端给的昵称
        const name = isSystem
            ? '系统'
            : (isSpectator
                ? String(playerName || '').trim() || '游客'
                : this.getRoomChatPlayerName(playerName, normalizedPlayerNumber, playerId));
        this.roomChatMessages.push({ name, message: text, playerNumber: normalizedPlayerNumber, isSystem, isSpectator, timestamp });
        if (this.roomChatMessages.length > this.roomChatMaxCount) {
            this.roomChatMessages = this.roomChatMessages.slice(-this.roomChatMaxCount);
        }
        if (options.markUnread && !this.roomChatOpen) {
            this.roomChatUnreadCount = Math.min(this.roomChatUnreadCount + 1, 99);
            this.updateRoomChatUnreadBadge();
        }
        this.renderRoomChatMessages();
    }

    clearRoomChatUnread() {
        if (this.roomChatUnreadCount === 0) return;
        this.roomChatUnreadCount = 0;
        this.updateRoomChatUnreadBadge();
    }

    updateRoomChatUnreadBadge() {
        const badge = document.getElementById('roomChatUnreadBadge');
        if (!badge) return;
        badge.classList.toggle('is-visible', this.roomChatUnreadCount > 0);
    }

    renderRoomChatMessages() {
        const container = document.getElementById('roomChatMessages');
        if (!container) return;
        container.innerHTML = '';

        for (const item of this.roomChatMessages) {
            const row = document.createElement('div');
            row.className = 'room-chat-item';
            const safeName = this.escapeHtml(item.name);
            const safeText = this.escapeHtml(item.message);
            if (item.isSystem) {
                row.innerHTML = `<span class="system-message-text">${safeText}</span>`;
            } else if (item.isSpectator) {
                row.innerHTML = `<span class="room-chat-name spectator-text">${safeName}:</span><span>${safeText}</span>`;
            } else {
                const nameColorClass = this.getRoomChatNameColorClass(item.playerNumber);
                row.innerHTML = `<span class="room-chat-name ${nameColorClass}">${safeName}:</span><span>${safeText}</span>`;
            }
            container.appendChild(row);
        }
        container.scrollTop = container.scrollHeight;
    }

    sendRoomChatMessage() {
        const input = document.getElementById('roomChatInput');
        if (!input) return;
        const text = String(input.value || '').trim();
        if (!text) return;

        if (!this.wsClient || !this.wsClient.isConnected) {
            this.showError('连接未就绪，暂时无法发送');
            return;
        }

        this.wsClient.sendMessage('chatMessage', {
            message: text,
            timestamp: Date.now()
        });
        input.value = '';
    }

    toggleRoomChatEmojiPanel() {
        const emojiPanel = document.getElementById('roomChatEmojiPanel');
        if (!emojiPanel) return;
        emojiPanel.classList.toggle('is-open');
    }

    hideRoomChatEmojiPanel() {
        const emojiPanel = document.getElementById('roomChatEmojiPanel');
        if (!emojiPanel) return;
        emojiPanel.classList.remove('is-open');
    }

    insertRoomChatEmoji(emoji) {
        const input = document.getElementById('roomChatInput');
        if (!input) return;
        input.value = `${input.value}${emoji}`.slice(0, 40);
        input.focus();
    }

    escapeHtml(value) {
        return String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    initEmojiSwitcher() {
        this.updateEmojiDisplay();
    }

    // WebSocket连接
    async connectToServer() {
        if (this.wsClient && this.wsClient.isConnected) {
            return true;
        }

        try {
            // 动态导入WebSocketClient
            const { WebSocketClient } = await import('./websocketClient.js');
            this.wsClient = new WebSocketClient();

            return new Promise((resolve, reject) => {
                const originalOnOpen = this.wsClient.onOpen.bind(this.wsClient);

                this.wsClient.onOpen = (event) => {
                    // 先调用原始的onOpen方法设置isConnected状态
                    originalOnOpen(event);

                    console.log('WebSocket连接成功');
                    this.bindWebSocketEvents();

                    this.requestReconnectInfo();

                    // 移动端杀后台/切回前台场景：页面不会刷新，但WebSocket会重新建立。
                    // 这里相当于“无刷新刷新”：恢复roomCode并主动同步最新房间状态。
                    try {
                        const urlParams = new URLSearchParams(window.location.search);
                        const urlRoom = (urlParams.get('room') || '').toUpperCase().trim();
                        const storedRoom = (sessionStorage.getItem('aeroplaneChess_roomCode') || '').toUpperCase().trim();
                        const reconnectRoom = (reconnectManager && reconnectManager.roomCode ? String(reconnectManager.roomCode) : '').toUpperCase().trim();

                        // 只有「确实在一间已确认的房间里」才自动同步。建房/加入的加载阶段
                        // 房间面板也是开着的，但那时候的候选房间号可能来自上一间的残留，
                        // 拿它去 join 只会拿到「房间不存在」，人被误判成房间没了
                        const candidateRoom = urlRoom || reconnectRoom || storedRoom;
                        if (candidateRoom && candidateRoom.length === 4 && this.currentRoom) {
                            if (!this.roomCode) {
                                this.roomCode = candidateRoom;
                            }
                            setTimeout(() => {
                                if (!this.isDestroyed && !this.isLeavingRoom) {
                                    this.syncRoomStateAfterReconnect();
                                }
                            }, 50);
                        }
                    } catch (e) {
                        // ignore
                    }

                    // 首次进入在线联机面板时，roomSelection 已经显示但不会触发 showRoomSelection()
                    // 这里做一次兜底拉取房间列表
                    if (this.isRoomSelectionActive()) {
                        setTimeout(() => {
                            this.requestPublicRooms();
                        }, 50);
                    }
                    // 重置重连计数器
                    this.reconnectAttempts = 0;
                    resolve(true);
                };

                this.wsClient.onError = (error) => {
                    console.error('WebSocket连接错误:', error);
                    reject(error);
                };

                this.wsClient.onClose = (event) => {
                    console.log('WebSocket连接关闭', event);

                    // 如果正在主动离开房间，不要重连也不要显示状态
                    if (this.isLeavingRoom) {
                        return;
                    }

                    // 如果不是主动关闭且不在销毁状态，则尝试重连
                    if (event.code !== 1000 && event.code !== 1001 && !this.isDestroyed) {
                        // 避免立即重连，添加延迟
                        setTimeout(() => {
                            if (!this.isDestroyed && !this.isLeavingRoom && (!this.wsClient || !this.wsClient.isConnected)) {
                                this.attemptReconnect();
                            }
                        }, 2000);
                    }
                };

                // 连接到服务器 - 支持环境变量配置
                const wsUrl = window.location.protocol === 'https:'
                    ? `wss://${window.location.host}/ws`
                    : `ws://${window.location.host.replace(/:\d+/, ':3001')}`;
                this.wsClient.connect(wsUrl);
            });
        } catch (error) {
            console.error('连接服务器失败:', error);
            return false;
        }
    }

    attemptReconnect() {
        // 如果正在主动离开房间，不要重连
        if (this.isLeavingRoom) {
            console.log('主动退出房间，取消重连');
            return;
        }

        if (this.isDestroyed || this.reconnectAttempts >= this.maxReconnectAttempts) {
            // 连接失败后重定向回主页
            setTimeout(() => {
                window.location.href = '/';
            }, 2000);
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000); // 指数退避，最大10秒

        setTimeout(() => {
            if (!this.isDestroyed && !this.isLeavingRoom) {
                this.connectToServer().catch(() => {
                    // 连接失败，继续重连
                    this.attemptReconnect();
                });
            }
        }, delay);
    }

    bindWebSocketEvents() {
        if (!this.wsClient) return;

        // 绑定消息处理
        this.wsClient.onMessageType('roomCreated', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('roomJoined', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('playerJoined', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('playerLeft', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('playerDisconnected', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('playerReconnected', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('roomLeft', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('playerUpdated', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('roomUpdated', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('gameStarted', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('error', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('aiPlayerAdded', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('aiPlayerRemoved', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('hostTransferred', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('chatMessage', (message) => {
            // 添加调试日志
            console.log('房间中收到聊天消息:', {
                message: message.data?.message || message.message,
                playerNumber: message.data?.playerNumber || message.playerNumber,
                playerId: message.data?.playerId || message.playerId,
                fullMessage: message
            });

            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('playerReadyStatusChanged', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('roomReset', (message) => {
            this.handleWebSocketMessage(message);
        });

        // 注册房间设置更新消息处理器
        this.wsClient.onMessageType('settingsUpdated', (message) => {
            this.handleWebSocketMessage(message);
        });

        // 注册棋子数量配置消息处理器
        this.wsClient.onMessageType('pieceCountConfigured', (message) => {
            this.handleWebSocketMessage(message);
        });

        // 注册重新加入房间成功消息处理器
        this.wsClient.onMessageType('roomRejoined', (message) => {
            this.handleWebSocketMessage(message);
        });

        // 注册连接恢复事件处理器（页面切回前台时触发）
        this.wsClient.onMessageType('connectionRestored', () => {
            console.log('连接恢复，同步房间状态...');
            this.syncRoomStateAfterReconnect();
        });

        // 注册连接丢失事件处理器
        this.wsClient.onMessageType('connectionLost', (event) => {
            console.log('连接丢失，尝试重连...', event);
            this.attemptReconnect();
        });

        this.wsClient.onMessageType('roomsList', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('spectateJoined', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('roomNameUpdated', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('reconnectInfo', (message) => {
            this.handleWebSocketMessage(message);
        });

        this.wsClient.onMessageType('kicked', (message) => {
            this.handleWebSocketMessage(message);
        });
    }

    requestReconnectInfo() {
        if (!this.wsClient || !this.wsClient.isConnected) return;
        if (typeof this.wsClient.sendMessage !== 'function') return;
        this.wsClient.sendMessage('getReconnectInfo', {});
    }

    updateReconnectButtonVisibility(canReconnect, roomCode = null) {
        const btn = document.getElementById('reconnectBtn');
        if (!btn) return;
        if (canReconnect && roomCode && String(roomCode).trim().length === 4) {
            this._reconnectRoomCode = String(roomCode).trim().toUpperCase();
            btn.style.display = 'block';
        } else {
            this._reconnectRoomCode = null;
            btn.style.display = 'none';
        }
    }

    reconnectToLastRoom() {
        const code = (this._reconnectRoomCode || reconnectManager.roomCode || '').trim().toUpperCase();
        if (!code || code.length !== 4) {
            this.updateReconnectButtonVisibility(false);
            return;
        }
        this.joinRoomByCode(code);
    }

    /**
     * 重连后同步房间状态
     */
    syncRoomStateAfterReconnect() {
        if (!this.roomCode) {
            console.log('没有房间号，跳过状态同步');
            return;
        }

        console.log('发送 join_room 请求同步状态...');

        // 这里用 join_room 而不是 rejoinRoom：切回前台晚了一步、已经被超时移出的人，
        // join_room 还能把他放回座位（房间没开打、还有空位）；rejoinRoom 只会回「您不在该房间中」。
        // 开打了 / 房间没了 / 满员这三种服务端会带 code 拒绝，客户端收到后送他回首页
        this.wsClient.sendMessage('join_room', {
            roomCode: this.roomCode
        });
    }

    /**
     * 房间设置 → 配置面板勾选状态。
     * 建房、加入、重进房间、房主改设置都走这里，避免某条路径漏掉某个开关
     * （之前重进房间就漏了欢乐/道具模式，回到房间看到的还是未勾选）
     */
    applyRoomSettingsToControls(settings) {
        if (!settings) return;

        const skillModeCheckbox = document.getElementById('skillModeCheckbox');
        if (skillModeCheckbox && settings.skillMode !== undefined) {
            skillModeCheckbox.checked = !!settings.skillMode;
        }

        const happyModeCheckbox = document.getElementById('happyModeCheckbox');
        if (happyModeCheckbox && settings.happyMode !== undefined) {
            happyModeCheckbox.checked = !!settings.happyMode;
        }

        const pieceCount = settings.pieceCount;
        if (pieceCount !== undefined && typeof this.updatePieceCountDisplay === 'function') {
            this.updatePieceCountDisplay(pieceCount);
        }

        // 起手积分滑块：按房间设置回到对应档位；没勾道具模式时同步会把它收起来
        const energySlider = document.getElementById('onlineInitialEnergySlider');
        if (energySlider) {
            const steps = [0, 15, 30, 50, 70, 100];
            const index = steps.indexOf(Number(settings.initialEnergy) || 0);
            energySlider.value = String(index >= 0 ? index : 0);
            window.syncInitialEnergySliders?.();
        }
    }

    handleWebSocketMessage(data) {
        switch (data.type) {

            case 'reconnectInfo': {
                const canReconnect = !!(data.canReconnect ?? data.data?.canReconnect);
                const roomCode = data.roomCode ?? data.data?.roomCode;
                this.updateReconnectButtonVisibility(canReconnect, roomCode);

                // 自动重连：移动端切回前台/杀后台恢复时，用户往往不会主动刷新或点击“重连”
                // 如果URL明确指向某个房间，或服务端给的房间就是本地这一间，则自动同步状态
                try {
                    const urlParams = new URLSearchParams(window.location.search);
                    const urlRoom = (urlParams.get('room') || '').toUpperCase().trim();
                    const normalizedRoomCode = (roomCode || '').toUpperCase().trim();

                    // 只认同「就是本地这一间」的房间号：光看面板开着会把建房/加入加载阶段的
                    // 上一间残留房间号也算进来，拿它去 join 只会得到「房间不存在」
                    const isRoomContext = !!(
                        (normalizedRoomCode && urlRoom && normalizedRoomCode === urlRoom) ||
                        (this.roomCode && normalizedRoomCode && this.roomCode === normalizedRoomCode)
                    );

                    if (canReconnect && normalizedRoomCode && isRoomContext) {
                        if (!this.roomCode) {
                            this.roomCode = normalizedRoomCode;
                        }
                        this.syncRoomStateAfterReconnect();
                    }
                } catch (e) {
                    // ignore
                }
                break;
            }

            case 'kicked': {
                try {
                    console.log('收到踢出消息，立即重定向');
                    
                    // 立即清理重连信息和会话
                    if (typeof reconnectManager !== 'undefined' && reconnectManager.clear) {
                        reconnectManager.clear();
                    }
                    sessionStorage.clear();
                    
                    // 在 URL 中携带被踢出的标记
                    window.location.replace('/?reason=kicked');
                } catch (e) {
                    window.location.replace('/');
                }
                break;
            }

            case 'roomPrivacyUpdated': {
                if (!this.currentRoom) this.currentRoom = {};
                if (data.isPrivate !== undefined) {
                    this.currentRoom.isPrivate = !!data.isPrivate;
                }
                if (data.room) {
                    this.currentRoom = data.room;
                }

                const nextValue = data.room ? !!data.room.isPrivate : !!this.currentRoom.isPrivate;
                this.updateRoomPrivacyToggleUI(nextValue);
                break;
            }

            case 'roomsList': {
                const rooms = data.rooms || data.data?.rooms || [];
                this.publicRooms = Array.isArray(rooms) ? rooms : [];
                this.renderPublicRoomList();
                break;
            }

            case 'spectateJoined': {
                if (data.isReconnect) {
                    // 服务器确认了玩家在此房间中，更新本地重连信息，直接执行重连
                    console.log('[重连] 服务端确认重连，直接执行重连');
                    const roomCode = data.room?.code;
                    if (roomCode) {
                        this._reconnectRoomCode = roomCode;
                        reconnectManager.updateRoomCode(roomCode);
                        if (data.gameSessionId) {
                            reconnectManager.updateGameSessionId(data.gameSessionId);
                        }
                        this.reconnectToLastRoom();
                    }
                    break;
                }

                console.log('加入观战成功:', data.room ? data.room.code : 'unknown');
                
                // 设置观战状态标志（非常重要，否则会按普通玩家初始化）
                sessionStorage.setItem('aeroplaneChess_isSpectator', 'true');
                if (data.room) {
                    sessionStorage.setItem('aeroplaneChess_roomCode', data.room.code);
                }
                if (data.gameSessionId) {
                    sessionStorage.setItem('aeroplaneChess_gameSessionId', data.gameSessionId);
                }

                // 跳转到观战页面
                const roomCode = data.room ? data.room.code : '';
                window.location.href = `/spectate?room=${roomCode}`;
                break;
            }

            case 'roomReset': {
                // 游戏结束后返回房间：以服务器广播的房间状态为准（房主/准备状态可能被重置）
                if (data.room) {
                    this.currentRoom = data.room;
                    this.roomCode = data.room.code;

                    // 更新玩家列表
                    this.players = new Map(data.room.players.map(p => [p.id, p]));

                    // 更新当前玩家与房主状态
                    this.currentPlayer = data.room.players.find(p => p.id === this.wsClient.playerId);
                    this.isHost = this.currentPlayer ? this.currentPlayer.isHost : false;

                    // 更新准备状态
                    this.playerReadyStatus.clear();
                    data.room.players.forEach(p => {
                        this.playerReadyStatus.set(p.id, p.isReady || false);
                    });

                    this.showRoomConfig();
                    this.updateRoomInfo();
                    this.updatePlayerDisplay();

                    if (this.isHost) {
                        this.showHostSettings();
                    } else {
                        this.hideHostSettings();
                    }

                    this.updateRoomPrivacyToggleUI(!!data.room.isPrivate);
                }
                break;
            }

            case 'roomCreated': {
                console.log('房间创建成功:', data.room ? data.room.code : 'unknown');
                this.clearRoomChatHistory();

                // 清除超时定时器
                if (this.createRoomTimeout) {
                    clearTimeout(this.createRoomTimeout);
                    this.createRoomTimeout = null;
                }

                // 获取房间数据
                const roomData = data.room;
                if (roomData) {
                    // 保存房间数据
                    this.currentRoom = roomData;

                    // 更新真实的房间信息
                    this.roomCode = roomData.code;
                    this.isHost = true;
                    this.currentPlayer = roomData.players.find(p => p.isHost);
                    this.players = new Map(roomData.players.map(p => [p.color, p]));

                    // 保存房间号到重连管理器（房主也需要保存）
                    reconnectManager.updateRoomCode(this.roomCode);

                    // 同步道具/欢乐模式复选框状态
                    this.applyRoomSettingsToControls(roomData.settings);
                    this.updateRoomPrivacyToggleUI(!!roomData.isPrivate);

                    // 确保房主颜色选择器正确高亮
                    if (this.currentPlayer && this.currentPlayer.color) {
                        // 更新颜色选择器状态 - 只操作多人联机面板内的color-option
                        const multiplayerPanel = document.getElementById('onlineMultiplayerConfig');
                        if (multiplayerPanel) {
                            multiplayerPanel.querySelectorAll('.color-option').forEach(option => {
                                const playerNum = parseInt(option.dataset.player);
                                if (playerNum === this.currentPlayer.color) {
                                    option.classList.add('selected');
                                    option.querySelector('.color-circle').classList.add('selected');
                                } else {
                                    option.classList.remove('selected');
                                    option.querySelector('.color-circle').classList.remove('selected');
                                }
                            });
                        }

                        // 更新表情预览器颜色
                        const preview = document.getElementById('multiplayerEmojiPreview');
                        if (preview) {
                            preview.className = `emoji-preview player-${this.currentPlayer.color}-color`;
                        }

                        // 优先从localStorage恢复表情和昵称（避免闪烁）
                        if (this.emojis && this.emojiKeys && this.emojiKeys.length > 0) {
                            let emojiToRestore = this.currentPlayer.emoji;
                            let shouldSyncEmoji = false;

                            // 优先从localStorage读取缓存
                            try {
                                const cachedEmoji = localStorage.getItem(`emoji_${this.roomCode}_${this.currentPlayer.id}`);
                                if (cachedEmoji && this.emojiKeys.indexOf(cachedEmoji) !== -1) {
                                    // 如果服务器返回的表情和缓存不同，使用缓存
                                    if (cachedEmoji !== emojiToRestore) {
                                        emojiToRestore = cachedEmoji;
                                        shouldSyncEmoji = true;
                                    }
                                }
                            } catch (error) {
                                console.warn('从localStorage读取表情失败:', error);
                            }

                            const emojiIndex = this.emojiKeys.indexOf(emojiToRestore);
                            if (emojiIndex !== -1) {
                                this.currentEmojiIndex = emojiIndex;
                                this.selectedEmoji = emojiToRestore;
                            } else {
                                console.warn('表情不在表情列表中:', emojiToRestore);
                            }

                            // 如果需要同步到服务器（非阻塞，在后台执行）
                            if (shouldSyncEmoji && this.wsClient) {
                                setTimeout(() => {
                                    this.wsClient.updateEmoji(emojiToRestore);
                                    console.log('后台同步表情到服务器:', emojiToRestore);
                                }, 100); // 减少延迟到100ms
                            }
                        }

                        // 恢复昵称（优先从localStorage）
                        const nicknameInput = document.getElementById('multiplayerPlayerUsername');
                        if (nicknameInput) {
                            let nicknameToRestore = this.currentPlayer.nickname;
                            let shouldSyncNickname = false;

                            // 优先从localStorage读取缓存的昵称
                            try {
                                const cachedNickname = localStorage.getItem(`nickname_${this.roomCode}_${this.currentPlayer.id}`);
                                if (cachedNickname) {
                                    // 如果服务器返回的是默认昵称格式（玩家_xxxx），使用缓存
                                    const isDefaultNickname = /^玩家_[a-zA-Z0-9]{4}$/.test(this.currentPlayer.nickname);
                                    if (isDefaultNickname || cachedNickname !== this.currentPlayer.nickname) {
                                        nicknameToRestore = cachedNickname;
                                        shouldSyncNickname = true;
                                    }
                                }
                            } catch (error) {
                                console.warn('从localStorage读取昵称失败:', error);
                            }

                            // 确保设置了正确的值
                            nicknameInput.placeholder = nicknameToRestore;
                            nicknameInput.value = nicknameToRestore;

                            // 如果需要同步到服务器
                            if (shouldSyncNickname && this.wsClient) {
                                setTimeout(() => {
                                    this.wsClient.updateNickname(nicknameToRestore, { manualInput: false });
                                }, 100);
                            }
                        } else {
                            console.warn('未找到昵称输入框元素');
                        }
                    }

                    // 恢复准备状态（优先从localStorage）
                    if (this.currentPlayer && !this.currentPlayer.isHost) {
                        try {
                            const cachedReadyStatus = localStorage.getItem(`ready_${this.roomCode}_${this.currentPlayer.id}`);
                            if (cachedReadyStatus !== null) {
                                const isReady = cachedReadyStatus === 'true';
                                const currentReady = this.playerReadyStatus.get(this.currentPlayer.id) || false;

                                // 如果缓存的准备状态与服务器不同，同步到服务器
                                if (isReady !== currentReady) {
                                    console.log('从localStorage恢复准备状态:', isReady);
                                    setTimeout(() => {
                                        if (this.wsClient) {
                                            this.wsClient.toggleReady(isReady);
                                        }
                                    }, 100);
                                }
                            }
                        } catch (error) {
                            console.warn('从localStorage读取准备状态失败:', error);
                        }
                    }

                    // 启用房间返回守卫
                    this.showRoomConfig();

                    this.updateRoomInfo(); // 更新显示真实房间号
                    this.updatePlayerDisplay();
                    this.showCurrentPlayerSettings();
                    this.showHostSettings();

                    // 更新URL，添加房间号参数
                    const newUrl = new URL(window.location);
                    newUrl.searchParams.set('room', this.roomCode);
                    window.history.replaceState({}, '', newUrl);
                }
                break;
            }

            case 'roomJoined': {
                console.log('成功加入房间:', data.room.code);
                this.hideJoinRoomModal(); // 成功加入房间后关闭模态框
                this.clearRoomChatHistory();

                // 保存房间数据
                this.currentRoom = data.room;

                this.roomCode = data.room.code;
                // 从房间的玩家列表中找到当前玩家
                this.currentPlayer = data.room.players.find(p => p.id === this.wsClient.playerId);
                this.players = new Map(data.room.players.map(p => [p.id, p]));

                // 保存房间号到重连管理器
                reconnectManager.updateRoomCode(this.roomCode);

                // 初始化准备状态（从服务器数据中恢复）
                this.playerReadyStatus.clear();
                data.room.players.forEach(p => {
                    this.playerReadyStatus.set(p.id, p.isReady || false);
                });
                console.log('从服务器恢复准备状态:', Array.from(this.playerReadyStatus.entries()));

                // 正确设置isHost属性
                this.isHost = this.currentPlayer ? this.currentPlayer.isHost : false;
                console.log('当前玩家是否为房主:', this.isHost);

                // 同步道具/欢乐模式复选框状态
                this.applyRoomSettingsToControls(data.room.settings);

                // 恢复棋子个数显示
                if (data.room.settings && data.room.settings.pieceCount) {
                    this.updatePieceCountDisplay(data.room.settings.pieceCount);
                }

                this.updateRoomPrivacyToggleUI(!!data.room.isPrivate);

                // 检查房间状态和玩家身份
                if (data.room.gameState === 'playing') {
                    // 检查是否是从结算页面返回房间（不应自动跳转回游戏）
                    const urlParams = new URLSearchParams(window.location.search);
                    const isReturnToRoom = urlParams.get('returnToRoom') === 'true';

                    if (isReturnToRoom) {
                        // 从结算页面返回，清除 returnToRoom 参数，留在房间页面
                        console.log('从结算页面返回房间，不自动跳转回游戏');
                        urlParams.delete('returnToRoom');
                        const newUrl = `${window.location.pathname}?${urlParams.toString()}`;
                        window.history.replaceState({}, '', newUrl);
                        // 继续正常的房间加入流程，不跳转
                    } else if (data.gameData && this.currentPlayer) {
                        // 玩家是房间内的成员，允许重连
                        console.log('房间游戏正在进行中，玩家重连到游戏页面');
                        this.startMultiplayerGameForReconnect(data);
                        return;
                    } else {
                        // 新玩家尝试加入正在进行的游戏，拒绝加入
                        console.log('游戏正在进行中，拒绝新玩家加入');
                        this.showJoinRoomError('游戏正在进行中，无法加入');
                        this.clearRoomCodeInputs();
                        this.focusFirstInput();
                        return;
                    }
                }

                // 优先从localStorage恢复表情和昵称（避免闪烁）
                if (this.currentPlayer && this.emojis && this.emojiKeys && this.emojiKeys.length > 0) {
                    let emojiToRestore = this.currentPlayer.emoji;
                    let shouldSyncEmoji = false;

                    // 优先从localStorage读取缓存
                    try {
                        const cachedEmoji = localStorage.getItem(`emoji_${this.roomCode}_${this.currentPlayer.id}`);
                        if (cachedEmoji && this.emojiKeys.indexOf(cachedEmoji) !== -1) {
                            // 如果服务器返回的表情和缓存不同，使用缓存
                            if (cachedEmoji !== emojiToRestore) {
                                emojiToRestore = cachedEmoji;
                                shouldSyncEmoji = true;
                            }
                        }
                    } catch (error) {
                        console.warn('从localStorage读取表情失败:', error);
                    }

                    const emojiIndex = this.emojiKeys.indexOf(emojiToRestore);
                    if (emojiIndex !== -1) {
                        this.currentEmojiIndex = emojiIndex;
                        this.selectedEmoji = emojiToRestore;
                    } else {
                        console.warn('表情不在表情列表中:', emojiToRestore);
                    }

                    // 如果需要同步到服务器（非阻塞，在后台执行）
                    if (shouldSyncEmoji && this.wsClient) {
                        setTimeout(() => {
                            this.wsClient.updateEmoji(emojiToRestore);
                            console.log('后台同步表情到服务器(roomJoined):', emojiToRestore);
                        }, 100); // 减少延迟到100ms
                    }
                }

                // 恢复昵称（优先从localStorage）
                if (this.currentPlayer) {
                    const nicknameInput = document.getElementById('multiplayerPlayerUsername');
                    if (nicknameInput) {
                        let nicknameToRestore = this.currentPlayer.nickname;
                        let shouldSyncNickname = false;

                        // 优先从localStorage读取缓存的昵称
                        try {
                            const cachedNickname = localStorage.getItem(`nickname_${this.roomCode}_${this.currentPlayer.id}`);
                            if (cachedNickname) {
                                // 如果服务器返回的是默认昵称格式（玩家_xxxx），使用缓存
                                const isDefaultNickname = /^玩家_[a-zA-Z0-9]{4}$/.test(this.currentPlayer.nickname);
                                if (isDefaultNickname || cachedNickname !== this.currentPlayer.nickname) {
                                    nicknameToRestore = cachedNickname;
                                    shouldSyncNickname = true;
                                }
                            }
                        } catch (error) {
                            console.warn('从localStorage读取昵称失败:', error);
                        }

                        // 确保设置了正确的值
                        nicknameInput.placeholder = nicknameToRestore;
                        nicknameInput.value = nicknameToRestore;

                        // 如果需要同步到服务器
                        if (shouldSyncNickname && this.wsClient) {
                            setTimeout(() => {
                                this.wsClient.updateNickname(nicknameToRestore, { manualInput: false });
                            }, 100);
                        }
                    } else {
                        console.warn('未找到昵称输入框元素');
                    }
                }

                // 恢复准备状态（优先从localStorage）
                if (this.currentPlayer && !this.currentPlayer.isHost) {
                    try {
                        const cachedReadyStatus = localStorage.getItem(`ready_${this.roomCode}_${this.currentPlayer.id}`);
                        if (cachedReadyStatus !== null) {
                            const isReady = cachedReadyStatus === 'true';
                            const currentReady = this.playerReadyStatus.get(this.currentPlayer.id) || false;

                            // 如果缓存的准备状态与服务器不同，同步到服务器
                            if (isReady !== currentReady) {
                                console.log('从localStorage恢复准备状态(roomJoined):', isReady);
                                setTimeout(() => {
                                    if (this.wsClient) {
                                        this.wsClient.toggleReady(isReady);
                                    }
                                }, 100);
                            }
                        }
                    } catch (error) {
                        console.warn('从localStorage读取准备状态失败:', error);
                    }
                }

                this.showRoomConfig();
                this.updateRoomInfo();
                this.updatePlayerDisplay();

                // 根据是否为房主显示或隐藏房主设置
                if (this.isHost) {
                    this.showHostSettings();
                } else {
                    this.hideHostSettings();
                }

                // 更新URL，添加房间号参数（replaceState替换守卫条目，保持历史栈干净）
                const newUrl = new URL(window.location);
                newUrl.searchParams.set('room', this.roomCode);
                window.history.replaceState({}, '', newUrl);

                // 如果当前玩家已分配颜色，显示当前玩家设置
                if (this.currentPlayer && this.currentPlayer.color) {
                    this.showCurrentPlayerSettings();
                }
                break;
            }

            case 'playerJoined':
                this.players.set(data.player.id, data.player);

                // 更新房间数据（如果服务器提供了完整房间信息）
                if (data.room) {
                    this.currentRoom = data.room;

                    // 更新玩家列表为服务器返回的完整列表
                    if (data.room.players) {
                        this.players.clear();
                        data.room.players.forEach(player => {
                            this.players.set(player.id, player);
                            // 同时更新准备状态
                            this.playerReadyStatus.set(player.id, player.isReady || false);
                        });
                    }
                }

                this.updatePlayerDisplay();
                this.updateRoomInfo();
                break;



            case 'playerLeft':
                console.log('处理playerLeft消息:', {
                    playerId: data.playerId,
                    beforeDelete: Array.from(this.players.keys()),
                    playerData: Array.from(this.players.values()).map(p => ({ id: p.id, color: p.color, nickname: p.nickname }))
                });

                this.stopOfflineCountdown(data.playerId);

                // 更新房间数据（包含最新的房间状态）
                if (data.room) {
                    this.currentRoom = data.room;
                    // 更新玩家列表
                    this.players.clear();
                    data.room.players.forEach(player => {
                        this.players.set(player.id, player);
                    });
                } else {
                    // 如果没有data.room，只删除离开的玩家
                    const deleteResult = this.players.delete(data.playerId);
                    console.log('删除玩家结果:', {
                        deleteResult,
                        afterDelete: Array.from(this.players.keys()),
                        remainingPlayers: Array.from(this.players.values()).map(p => ({ id: p.id, color: p.color, nickname: p.nickname }))
                    });
                }

                this.updatePlayerDisplay();
                this.updateRoomInfo();
                this.updateStartGameButton();
                break;

            case 'playerDisconnected':
                // 玩家断开连接（刷新页面、关闭标签页、网络断开等）
                // 不移除玩家，只标记为离线状态
                console.log('玩家断开连接:', data.playerId);

                // 如果断开的是当前玩家自己，不处理（避免自己刷新时被移除）
                if (data.playerId === this.playerId) {
                    console.log('当前玩家自己断开连接，不处理');
                    break;
                }

                // 更新房间数据（包含最新的玩家在线状态）
                if (data.room) {
                    this.currentRoom = data.room;
                    // 更新玩家列表
                    this.players.clear();
                    data.room.players.forEach(player => {
                        this.players.set(player.id, player);
                    });
                }

                // 更新UI显示
                this.startOfflineCountdown(data.playerId, 10);
                this.updatePlayerDisplay();
                this.updateRoomInfo();
                this.updateStartGameButton();
                break;

            case 'playerReconnected':
                // 玩家重新连接
                console.log('玩家重新连接:', data.playerId);

                // 更新房间数据（包含最新的玩家在线状态）
                if (data.room) {
                    this.currentRoom = data.room;
                    // 更新玩家列表
                    this.players.clear();
                    data.room.players.forEach(player => {
                        this.players.set(player.id, player);
                    });
                }

                // 更新UI显示
                this.stopOfflineCountdown(data.playerId);
                this.updatePlayerDisplay();
                this.updateRoomInfo();
                this.updateStartGameButton();
                break;

            case 'roomLeft':
                // 收到服务器确认离开房间的消息
                // 设置一个标志，表示可以安全断开连接了
                this._roomLeftConfirmed = true;
                break;

            case 'error':
                console.error('服务器错误:', data.message);
                // 房间没了 / 局已开打 / 已被移出 / 满员：本地那套房间上下文已经过期（超时被移除、后台切回来等），
                // 面板里留着也是空壳，清掉并回首页；从房间列表手动输码加入的照旧走内联报错
                const staleRoomCodes = ['gameStarted', 'roomGone', 'notInRoom', 'roomFull'];
                if (staleRoomCodes.includes(data.code)
                    && (this.currentRoom || this.isRoomConfigActive?.())) {
                    this.returnHomeForStaleRoom(data.code);
                    break;
                }
                if (data.message && data.message.includes && (data.message.includes('房间') || data.message.includes('游戏正在进行中'))) {
                    this.showJoinRoomError(data.message);
                    this.clearRoomCodeInputs();

                } else {
                    this.showError(data.message || '服务器发生未知错误');
                }
                break;

            case 'playerUpdated':
                if (data.player) {
                    // 更新玩家信息
                    this.players.set(data.player.id, data.player);

                    // 如果是当前玩家，更新当前玩家信息
                    if (this.currentPlayer && data.player.id === this.currentPlayer.id) {
                        // 保存旧的表情
                        const oldEmoji = this.currentPlayer.emoji;

                        // 更新当前玩家信息
                        this.currentPlayer = data.player;

                        // 更新昵称输入框显示
                        const nicknameInput = document.getElementById('multiplayerPlayerUsername');
                        if (nicknameInput && data.player.nickname) {
                            // 检查是否为默认昵称格式（玩家_xxxx），如果是则不更新输入框
                            const isDefaultNickname = /^玩家_[a-zA-Z0-9]{4}$/.test(data.player.nickname);
                            if (!isDefaultNickname) {
                                nicknameInput.value = data.player.nickname;
                                nicknameInput.placeholder = data.player.nickname;
                            }
                        }

                        // 如果表情发生了变化，更新本地表情显示
                        if (data.player.emoji && data.player.emoji !== oldEmoji) {
                            // 确保表情数据已加载
                            if (this.emojis && this.emojiKeys && this.emojiKeys.length > 0) {
                                this.selectedEmoji = data.player.emoji;
                                // 找到对应的表情索引
                                const emojiIndex = this.emojiKeys.indexOf(data.player.emoji);
                                if (emojiIndex !== -1) {
                                    this.currentEmojiIndex = emojiIndex;
                                } else {
                                    console.warn('未找到表情索引，使用默认表情:', data.player.emoji);
                                    // 如果找不到表情索引，使用第一个表情作为默认值
                                    this.currentEmojiIndex = 0;
                                    this.selectedEmoji = this.emojiKeys[0];
                                }
                                this.updateEmojiDisplay();
                            } else {
                                console.warn('表情数据未加载完成，延迟更新表情显示');
                                // 延迟100ms后重试
                                setTimeout(() => {
                                    if (this.emojis && this.emojiKeys && this.emojiKeys.length > 0) {
                                        this.selectedEmoji = data.player.emoji;
                                        const emojiIndex = this.emojiKeys.indexOf(data.player.emoji);
                                        if (emojiIndex !== -1) {
                                            this.currentEmojiIndex = emojiIndex;
                                        } else {
                                            this.currentEmojiIndex = 0;
                                            this.selectedEmoji = this.emojiKeys[0];
                                        }
                                        this.updateEmojiDisplay();
                                    }
                                }, 100);
                            }
                        }
                    }

                    // 如果消息中包含完整的房间信息，更新房间数据
                    if (data.room) {
                        this.currentRoom = data.room;

                        // 更新玩家列表和准备状态为服务器返回的完整列表
                        if (data.room.players) {
                            this.players.clear();
                            data.room.players.forEach(player => {
                                this.players.set(player.id, player);
                                // 同时更新准备状态
                                this.playerReadyStatus.set(player.id, player.isReady || false);
                            });
                            // 换座会改动本人的座位编号，本人对象需以服务端座位为准
                            const self = this.currentPlayer ? this.players.get(this.currentPlayer.id) : null;
                            if (self) this.currentPlayer = self;
                            this.updateEmojiPreview();
                        }
                    }

                    // 立即更新显示
                    this.updatePlayerDisplay();
                    this.updateRoomInfo();
                }
                break;

            case 'roomUpdated':
                console.log('房间信息更新:', data);
                if (data.room) {
                    // 更新本地房间数据
                    this.currentRoom = data.room;

                    // 更新玩家列表和准备状态
                    if (data.room.players) {
                        this.players.clear();
                        data.room.players.forEach(player => {
                            this.players.set(player.id, player);
                            // 同时更新准备状态
                            this.playerReadyStatus.set(player.id, player.isReady || false);
                        });
                    }

                    // 更新AI玩家显示
                    if (this.isHost && data.room.settings && data.room.settings.aiPlayers) {
                        this.applyServerAIPlayers(data.room.settings.aiPlayers);
                    }

                    this.updatePlayerDisplay();
                    this.updateRoomInfo();
                }
                break;

            case 'roomRejoined':
                // 重新加入房间成功（切后台恢复后）
                console.log('重新加入房间成功:', data);
                if (data.room) {
                    // 更新本地房间数据
                    this.currentRoom = data.room;
                    this.roomCode = data.room.code;

                    // 更新玩家列表和准备状态
                    if (data.room.players) {
                        this.players.clear();
                        data.room.players.forEach(player => {
                            this.players.set(player.id, player);
                            // 同时更新准备状态
                            this.playerReadyStatus.set(player.id, player.isReady || false);
                        });
                    }

                    // 更新当前玩家信息
                    const currentPlayerData = data.room.players.find(p => p.id === this.playerId);
                    if (currentPlayerData) {
                        this.currentPlayer = currentPlayerData;
                        this.isHost = currentPlayerData.isHost;
                    }

                    // 更新AI玩家显示
                    if (this.isHost && data.room.settings && data.room.settings.aiPlayers) {
                        this.applyServerAIPlayers(data.room.settings.aiPlayers);
                    }

                    this.updatePlayerDisplay();
                    this.updateRoomInfo();

                    // 把服务端的房间设置回填到配置面板（重进房间最容易漏的一步）
                    this.applyRoomSettingsToControls(data.room.settings);

                    // 重建离线玩家倒计时
                    for (const [, p] of this.players) {
                        if (p.isConnected === false && p.disconnectedAt) {
                            const elapsed = Date.now() - p.disconnectedAt;
                            const remaining = Math.max(1, Math.ceil((10000 - elapsed) / 1000));
                            this.startOfflineCountdown(p.id, remaining);
                        }
                    }
                    this.updateStartGameButton();
                    console.log('房间状态已同步');
                }
                break;

            case 'playerNicknameUpdated':
                const nicknamePlayer = this.players.get(data.playerId);
                if (nicknamePlayer) {
                    nicknamePlayer.nickname = data.nickname;
                    this.updatePlayerDisplay();
                    this.updateConfigHeaderTitle();
                }
                break;

            case 'playerEmojiUpdated':
                const emojiPlayer = this.players.get(data.playerId);
                if (emojiPlayer) {
                    emojiPlayer.emoji = data.emoji;
                    this.updatePlayerDisplay();
                }
                break;

            case 'roomConfigUpdated':
                // 更新本地房间设置
                if (!this.currentRoom) {
                    this.currentRoom = { settings: {} };
                }
                if (!this.currentRoom.settings) {
                    this.currentRoom.settings = {};
                }

                if (data.pieceCount !== undefined) {
                    this.currentRoom.settings.pieceCount = data.pieceCount;
                    this.updatePieceCountDisplay(data.pieceCount);
                }
                if (data.aiPlayers !== undefined) {
                    this.applyServerAIPlayers(data.aiPlayers);
                }

                // 更新房间信息显示（包括游戏配置）
                this.updateRoomInfo();
                break;

            case 'gameStarted':
                this.startMultiplayerGame(data);
                break;

            case 'connected':
                console.log('WebSocket连接确认');
                // 连接确认消息，可以在这里做一些初始化工作
                break;

            case 'aiPlayerAdded':
                console.log('AI玩家添加成功:', data.aiPlayer);
                if (data.room && data.room.settings && data.room.settings.aiPlayers) {
                    this.applyServerAIPlayers(data.room.settings.aiPlayers);
                }
                // 更新房间信息显示（包含人数统计）
                this.updateRoomInfo();
                break;

            case 'aiPlayerRemoved':
                console.log('AI玩家移除成功:', data.colorIndex);
                if (data.room && data.room.settings && data.room.settings.aiPlayers) {
                    this.applyServerAIPlayers(data.room.settings.aiPlayers);
                }
                // 更新房间信息显示（包含人数统计）
                this.updateRoomInfo();
                break;

            case 'aiDifficultyUpdated':
                console.log('AI玩家难度更新成功:', data.colorIndex, data.difficulty);
                if (data.room && data.room.settings && data.room.settings.aiPlayers) {
                    this.applyServerAIPlayers(data.room.settings.aiPlayers);
                }
                // 更新房间信息显示（包含人数统计）
                this.updateRoomInfo();
                break;

            case 'pieceCountConfigured':
                console.log('棋子数量配置成功:', data.pieceCount);

                // 使用服务器返回的完整房间数据
                if (data.room) {
                    this.currentRoom = data.room;
                } else {
                    // 降级处理：如果没有完整房间数据，只更新设置
                    if (!this.currentRoom) {
                        this.currentRoom = { settings: {} };
                    }
                    if (!this.currentRoom.settings) {
                        this.currentRoom.settings = {};
                    }
                    this.currentRoom.settings.pieceCount = data.pieceCount;
                }

                // 更新棋子数量显示
                this.updatePieceCountDisplay(data.pieceCount);

                // 更新房间信息显示（包括游戏配置）
                this.updateRoomInfo();
                break;

            case 'hostTransferred':
                console.log('房主权限已转移:', data.newHostId, data.newHostNickname);
                console.log('当前玩家ID:', this.wsClient ? this.wsClient.playerId : 'null');
                console.log('房间数据:', data.room);

                // 更新本地房间数据
                if (this.currentRoom) {
                    this.currentRoom.host = data.room.host;
                    // 更新玩家列表，确保新房主信息正确
                    if (data.room.players) {
                        this.players.clear();
                        data.room.players.forEach(player => {
                            this.players.set(player.id, player);
                        });
                    }
                }

                // 检查当前玩家是否成为新房主
                if (this.wsClient && this.wsClient.playerId === data.newHostId) {
                    this.isHost = true;
                    console.log('当前玩家成为新房主');
                    this.showHostSettings();
                } else {
                    this.isHost = false;
                    this.hideHostSettings();
                }

                // 更新玩家显示
                this.updatePlayerDisplay();
                this.updateRoomInfo();
                break;

            case 'chatMessage':
                {
                const localPlayerId = this.wsClient ? this.wsClient.playerId : null;
                const isLocalMessage = !!(data.playerId && localPlayerId && data.playerId === localPlayerId);
                this.appendRoomChatMessage({
                    playerName: data.playerName || data.senderName,
                    playerNumber: data.playerNumber,
                    playerId: data.playerId,
                    message: data.message,
                    isSystem: data.playerNumber == null && !data.isSpectatorMessage,
                    isSpectator: !!data.isSpectatorMessage
                }, {
                    markUnread: !isLocalMessage
                });
                break;
                }

            case 'settingsUpdated': {
                console.log('[配置] 收到房间设置更新:', data.settings);

                // 使用服务器返回的完整房间数据
                if (data.room) {
                    this.currentRoom = data.room;
                } else {
                    // 降级处理：如果没有完整房间数据，只更新设置
                    if (!this.currentRoom) {
                        this.currentRoom = { settings: {} };
                    }
                    if (!this.currentRoom.settings) {
                        this.currentRoom.settings = {};
                    }
                    // 合并设置，保留其他已有的设置
                    Object.assign(this.currentRoom.settings, data.settings);
                }

                // 更新道具/欢乐模式复选框状态
                this.applyRoomSettingsToControls(data.settings);

                // 更新房间信息显示（包括游戏配置）
                this.updateRoomInfo();
                this.updateConfigHeaderTitle();
                break;
            }

            case 'roomNameUpdated': {
                if (!this.currentRoom) this.currentRoom = {};
                if (data.name) {
                    this.currentRoom.name = data.name;
                } else if (data.room && data.room.name) {
                    this.currentRoom.name = data.room.name;
                }
                this.updateConfigHeaderTitle();
                break;
            }

            case 'playerReadyStatusChanged':
                console.log(`玩家准备状态变化: ${data.playerId} -> ${data.isReady ? '已准备' : '未准备'}`);
                // 更新玩家准备状态
                this.playerReadyStatus.set(data.playerId, data.isReady);

                // 如果是当前玩家的准备状态变化，更新准备按钮文字和localStorage
                if (this.currentPlayer && data.playerId === this.currentPlayer.id) {
                    this.updatePlayerReadyButton();
                    this.updateWaitingForHostText();

                    // 同步到localStorage（确保客户端和服务器状态一致）
                    try {
                        localStorage.setItem(`ready_${this.roomCode}_${data.playerId}`, String(data.isReady));
                    } catch (error) {
                        console.warn('保存准备状态到localStorage失败:', error);
                    }
                }

                // 更新显示
                this.updatePlayerDisplay();
                // 更新开始游戏按钮状态
                this.updateStartGameButton();
                break;

            default:
                console.warn('未知的WebSocket消息类型:', data.type);
        }
    }

    async requestPublicRooms() {
        try {
            const connected = await this.connectToServer();
            if (!connected) {
                return;
            }
            if (this.wsClient && this.wsClient.isConnected) {
                this.wsClient.listRooms();
            }
        } catch (error) {
            console.warn('请求房间列表失败:', error);
        }
    }

    isRoomSelectionActive() {
        const el = document.getElementById('roomSelection');
        if (!el) return false;
        return window.getComputedStyle(el).display !== 'none';
    }

    isRoomConfigActive() {
        const el = document.getElementById('roomConfig');
        if (!el) return false;
        return window.getComputedStyle(el).display !== 'none';
    }

    getGameStateText(state) {
        const stateMap = {
            'waiting': '等待中',
            'playing': '游戏中',
            'finished': '已结束'
        };
        return stateMap[state] || state;
    }

    renderPublicRoomList() {
        const listEl = document.getElementById('publicRoomList');
        const emptyEl = document.getElementById('publicRoomListEmpty');
        if (!listEl || !emptyEl) return;

        const query = (this.roomSearchQuery || '').toLowerCase();
        const rooms = (this.publicRooms || []).filter(r => {
            const name = (r?.name || '').toLowerCase();
            return !query || name.includes(query);
        }).sort((a, b) => {
            if (a.gameState === 'waiting' && b.gameState !== 'waiting') return -1;
            if (a.gameState !== 'waiting' && b.gameState === 'waiting') return 1;
            return 0;
        });

        listEl.innerHTML = '';

        if (!rooms.length) {
            listEl.style.display = 'none';
            emptyEl.style.display = 'flex';
            return;
        }

        listEl.style.display = 'flex';
        emptyEl.style.display = 'none';
        rooms.forEach(room => {
            const item = document.createElement('div');
            item.className = 'public-room-item';
            item.dataset.roomCode = room.code;

            const name = document.createElement('div');
            name.className = 'public-room-name';
            name.textContent = room.name || '未命名房间';

            const status = document.createElement('div');
            status.className = 'public-room-status';
            const statusBadge = document.createElement('span');
            statusBadge.className = `status-badge ${room.gameState}`;
            statusBadge.textContent = this.getGameStateText(room.gameState);
            status.appendChild(statusBadge);

            const mode = document.createElement('div');
            mode.className = 'public-room-mode';
            const skillMode = room.skillMode;
            const happyMode = room.happyMode;
            if (happyMode && skillMode) {
                mode.textContent = '道欢';
            } else if (happyMode) {
                mode.textContent = '欢乐';
            } else if (skillMode) {
                mode.textContent = '道具';
            } else {
                mode.textContent = '标准';
            }

            const pieceCount = document.createElement('div');
            pieceCount.className = 'public-room-piece-count';
            pieceCount.textContent = String(room.pieceCount != null ? room.pieceCount : 4);

            const playerCountEl = document.createElement('div');
            playerCountEl.className = 'public-room-player-count';
            const playerCount = (room.playerCount != null ? room.playerCount : 0);
            const maxPlayers = (room.maxPlayers != null ? room.maxPlayers : 4);
            playerCountEl.textContent = `${playerCount}/${maxPlayers}`;

            item.appendChild(name);
            item.appendChild(mode);
            item.appendChild(pieceCount);
            item.appendChild(playerCountEl);
            item.appendChild(status);

            item.addEventListener('click', () => {
                if (room.code) {
                    if (room.gameState === 'playing') {
                        // 用玩家固定ID匹配房间成员列表，确认是否自己的房间
                        const myId = this.wsClient?.playerId;
                        const isMyRoom = myId && room.playerIds && room.playerIds.includes(myId);
                        console.log(`[房间点击] room=${room.code} myId=${myId} playerIds=${JSON.stringify(room.playerIds)} isMyRoom=${isMyRoom}`);

                        if (isMyRoom) {
                            // 自己的房间：直接重连
                            console.log(`[房间点击] 自己的房间 ${room.code}，直接重连`);
                            this.joinRoomByCode(room.code);
                        } else {
                            // 不是自己的房间：询问是否观战
                            if (confirm(`房间 ${room.name} 正在游戏中，是否进入观战？`)) {
                                this.spectateRoom(room.code);
                            }
                        }
                    } else {
                        this.joinRoomByCode(room.code);
                    }
                }
            });

            listEl.appendChild(item);
        });
    }

    async joinRoomByCode(roomCode) {
        try {
            const code = (roomCode || '').toUpperCase().trim();
            if (!code || code.length !== 4) {
                return;
            }

            const connected = await this.connectToServer();
            if (!connected) {
                return;
            }

            const emoji = this.selectedEmoji || 'smile';

            let nickname = '';
            if (window.playerIdManager) {
                nickname = window.playerIdManager.getSavedNickname() || '';
            }
            if (!nickname) {
                const nicknameInput = document.getElementById('multiplayerPlayerUsername');
                nickname = nicknameInput ? nicknameInput.value.trim() : '';
            }

            reconnectManager.updateRoomCode(code);
            this.wsClient.sendMessage('join_room', {
                roomCode: code,
                nickname,
                emoji
            });

        } catch (error) {
            console.error('通过列表加入房间失败:', error);
        }
    }

    /**
     * 加入观战
     * @param {string} roomCode - 房间号
     */
    async spectateRoom(roomCode) {
        try {
            const code = (roomCode || '').toUpperCase().trim();
            if (!code || code.length !== 4) {
                return;
            }

            const connected = await this.connectToServer();
            if (!connected) {
                return;
            }

            console.log('发送观战请求:', code);

            // 发送观战请求
            this.wsClient.spectateRoom(code);

        } catch (error) {
            console.error('加入观战失败:', error);
        }
    }
    // 显示房间配置页面（带加载状态）
    showRoomConfigWithLoading() {
        console.log('显示房间配置页面（带加载状态）');

        // 立即切换到房间配置页面
        document.getElementById('roomSelection').style.display = 'none';
        document.getElementById('roomConfig').style.display = 'flex';
        this.updateRoomChatVisibility(true);

        // 设置临时房间信息，显示加载状态
        this.roomCode = '创建中...';
        this.isHost = true;
        this.updateRoomInfo();
        this.showHostSettings();
    }

    // 异步创建房间
    async createRoomAsync() {
        try {
            // 连接到服务器
            await this.connectToServer();

            // 等待连接稳定
            await new Promise(resolve => setTimeout(resolve, 100));

            if (this.wsClient && this.wsClient.isConnected) {
                const usernameInput = document.getElementById('multiplayerPlayerUsername');
                const nickname = usernameInput ? (usernameInput.value || '').trim() : '';
                // 留空让服务器生成默认昵称，不要在客户端设置默认值

                // 将昵称保存到本地存储，便于下次自动恢复
                if (window.playerIdManager) {
                    window.playerIdManager.saveNickname(nickname);
                }

                // 使用WebSocketClient的createRoom方法，传递nickname和emoji
                this.wsClient.createRoom({
                    nickname: nickname,
                    emoji: this.selectedEmoji,
                    maxPlayers: 4,
                    gameMode: 'multiplayer'
                });

                // 设置超时处理
                this.createRoomTimeout = setTimeout(() => {
                    console.warn('创建房间超时');
                    this.handleCreateRoomTimeout();
                }, 10000); // 10秒超时

            } else {
                throw new Error('WebSocket连接未建立');
            }
        } catch (error) {
            console.error('创建房间失败:', error);
            this.handleCreateRoomError(error.message);
        }
    }

    // 处理创建房间超时
    handleCreateRoomTimeout() {
        console.log('处理创建房间超时');
        this.showError('创建房间超时，请检查网络连接后重试');
        this.showMainMenu();
    }

    // 处理创建房间错误
    handleCreateRoomError(errorMessage) {
        console.log('处理创建房间错误:', errorMessage);
        this.showError('创建房间失败: ' + errorMessage);
    }
    async createRoom() {
        console.log('开始创建房间...');
        try {
            const connected = await this.connectToServer();
            if (!connected) {
                return;
            }

            // 获取保存的昵称或使用输入框中的昵称
            let nickname = '';
            if (window.playerIdManager) {
                nickname = window.playerIdManager.getSavedNickname() || '';
            }

            // 如果没有保存的昵称，从输入框获取
            if (!nickname) {
                const nicknameInput = document.getElementById('multiplayerPlayerUsername');
                nickname = nicknameInput ? nicknameInput.value.trim() : '';
            }

            // 使用WebSocketClient的createRoom方法
            this.wsClient.createRoom({
                maxPlayers: 4,
                gameMode: 'multiplayer',
                nickname: nickname, // 使用保存的昵称，如果为空，服务器会生成默认昵称
                emoji: this.selectedEmoji
            });

        } catch (error) {
            console.error('创建房间失败:', error);
            this.showError('创建房间失败，请重试');
        }
    }

    // 显示加入房间模态框
    showJoinRoomModal() {
        console.log('显示加入房间模态框');

        const modal = document.getElementById('joinRoomModal');
        if (modal) {
            modal.style.display = 'flex';
            // 清空之前的输入和错误信息
            this.clearRoomCodeInputs();
            this.focusFirstInput();
            this.hideJoinRoomError();
            console.log('加入房间模态框已显示');
        } else {
            console.error('找不到加入房间模态框元素');
        }
    }

    // 隐藏加入房间模态框
    hideJoinRoomModal() {
        document.getElementById('joinRoomModal').style.display = 'none';
    }

    // 清空房间号输入框
    clearRoomCodeInputs() {
        console.log('清空房间号输入框');
        const inputs = document.querySelectorAll('.room-code-digit-input');
        inputs.forEach(input => {
            input.value = '';
            input.classList.remove('filled', 'error');
        });
    }

    // 聚焦第一个输入框
    focusFirstInput() {
        const firstInput = document.querySelector('.room-code-digit-input[data-index="0"]');
        if (firstInput) {
            firstInput.focus();
        }
    }

    // 获取房间号
    getRoomCode() {
        const inputs = document.querySelectorAll('.room-code-digit-input');
        let roomCode = '';
        inputs.forEach(input => {
            roomCode += input.value.toUpperCase();
        });
        return roomCode;
    }

    // 加入房间
    async joinRoom() {
        const roomCode = this.getRoomCode();

        if (!roomCode || (roomCode.length !== 4 || !/^[A-Z]{4}$/.test(roomCode))) {
            this.showJoinRoomError('加入房间失败，请检查房间号');
            this.clearRoomCodeInputs();
            this.focusFirstInput();
            return;
        }

        // 清除之前的错误信息
        this.hideJoinRoomError();

        const connected = await this.connectToServer();
        if (!connected) {
            this.showJoinRoomError('连接服务器失败');
            // 连接失败时也清空输入框
            this.clearRoomCodeInputs();
            this.focusFirstInput();
            return;
        }

        try {
            const emoji = this.selectedEmoji || 'smile';

            // 获取保存的昵称或使用输入框中的昵称
            let nickname = '';
            if (window.playerIdManager) {
                nickname = window.playerIdManager.getSavedNickname() || '';
            }

            // 如果没有保存的昵称，从输入框获取
            if (!nickname) {
                const nicknameInput = document.getElementById('multiplayerPlayerUsername');
                nickname = nicknameInput ? nicknameInput.value.trim() : '';
            }

            // 将最终使用的昵称保存到本地存储，确保同一浏览器下跨局/重连昵称一致
            if (window.playerIdManager) {
                window.playerIdManager.saveNickname(nickname);
            }

            console.log('发送加入房间请求:', { roomCode, emoji, nickname });

            // 保存房间号到重连管理器
            reconnectManager.updateRoomCode(roomCode);

            // 发送加入房间请求，等待服务器响应
            this.wsClient.sendMessage('join_room', {
                roomCode,
                nickname,
                emoji
            });

        } catch (error) {
            console.error('加入房间失败:', error);
            this.showJoinRoomError('加入房间失败，请检查房间号');
            // 出现异常时也清空输入框
            this.clearRoomCodeInputs();
            this.focusFirstInput();
        }
    }

    // 显示加入房间错误
    showJoinRoomError(message) {
        const errorDiv = document.getElementById('joinRoomError');
        errorDiv.querySelector('.error-message').textContent = message;
        errorDiv.style.display = 'block';
    }

    // 隐藏加入房间错误
    hideJoinRoomError() {
        document.getElementById('joinRoomError').style.display = 'none';
    }


    // 初始化房间号输入框事件
    initRoomCodeInputs() {
        const inputs = document.querySelectorAll('.room-code-digit-input');

        inputs.forEach((input, index) => {
            // 输入事件
            input.addEventListener('input', (e) => {
                const value = e.target.value.toUpperCase();

                // 只允许字母
                if (!/^[A-Z]?$/.test(value)) {
                    e.target.value = '';
                    return;
                }

                e.target.value = value;

                // 更新样式
                if (value) {
                    e.target.classList.add('filled');
                    // 自动跳转到下一个输入框
                    if (index < inputs.length - 1) {
                        inputs[index + 1].focus();
                    }
                } else {
                    e.target.classList.remove('filled');
                }

            });

            // 键盘事件
            input.addEventListener('keydown', (e) => {
                // 退格键处理
                if (e.key === 'Backspace') {
                    if (!e.target.value && index > 0) {
                        // 如果当前输入框为空，跳转到前一个输入框
                        inputs[index - 1].focus();
                        inputs[index - 1].value = '';
                        inputs[index - 1].classList.remove('filled');
                    }
                }

                // 左右箭头键导航
                if (e.key === 'ArrowLeft' && index > 0) {
                    inputs[index - 1].focus();
                }
                if (e.key === 'ArrowRight' && index < inputs.length - 1) {
                    inputs[index + 1].focus();
                }

                // 回车键提交
                if (e.key === 'Enter') {
                    this.joinRoom();
                }
            });

            // 粘贴事件
            input.addEventListener('paste', (e) => {
                e.preventDefault();
                const pastedText = (e.clipboardData || window.clipboardData).getData('text').toUpperCase();

                // 只处理4位字母的粘贴
                if (/^[A-Z]{4}$/.test(pastedText)) {
                    // 清空所有输入框
                    inputs.forEach(inp => {
                        inp.value = '';
                        inp.classList.remove('filled');
                    });

                    // 填充粘贴的内容
                    for (let i = 0; i < 4; i++) {
                        inputs[i].value = pastedText[i];
                        inputs[i].classList.add('filled');
                    }

                    // 将光标移动到最后一个输入框的末尾
                    const lastInput = inputs[3];
                    lastInput.focus();
                    // 设置光标位置到末尾，而不是选中文本
                    setTimeout(() => {
                        lastInput.setSelectionRange(1, 1);
                    }, 0);

                }
            });

            // 焦点事件 - 移除自动选中功能
            input.addEventListener('focus', () => {
                // 不再自动选中文本，让用户可以正常编辑
            });
        });
    }

    // 显示房间配置界面
    showRoomConfig() {
        document.getElementById('roomSelection').style.display = 'none';
        document.getElementById('roomConfig').style.display = 'flex';
        this.updateRoomChatVisibility(true);

        this.stopPublicRoomsAutoRefresh();
        this.updateConfigHeaderTitle();

        this.enableRoomBackGuard();
    }

    // 显示房间选择界面
    /** 房间没了 / 局已开打：本地房间上下文已经过期，清掉并回首页（首页会说明原因） */
    returnHomeForStaleRoom(reason = 'roomGone') {
        this._roomLeftConfirmed = true; // 别让这次跳转再触发一轮重连提示
        this.stopPublicRoomsAutoRefresh?.();
        this.currentRoom = null;
        this.roomCode = null;
        this.players.clear();
        this.aiPlayers.clear();
        this._pendingAIOps = [];
        try {
            window.location.replace(`/?reason=${encodeURIComponent(reason)}`);
        } catch (error) {
            window.location.href = '/';
        }
    }

    showRoomSelection() {
        this.ensureOnlineMultiplayerPanelVisible();
        document.getElementById('roomConfig').style.display = 'none';
        document.getElementById('roomSelection').style.display = 'flex';
        this.updateRoomChatVisibility(false);

        this.requestPublicRooms();
        this.startPublicRoomsAutoRefresh();
        
        // 回到列表页时，主动请求一次重连信息
        // 这样如果玩家刚刚“迁移”或“彻底离开”了某个游戏，主页的重连按钮能立即消失
        this.requestReconnectInfo();

        this.updateConfigHeaderTitle();

        this.disableRoomBackGuard();
    }

    ensureOnlineMultiplayerPanelVisible() {
        const mainMenuContainer = document.getElementById('mainMenuContainer');
        const playerConfigWrapper = document.getElementById('playerConfigWrapper');
        const playerConfigPanel = document.getElementById('playerConfigPanel');
        const onlineMultiplayerConfig = document.getElementById('onlineMultiplayerConfig');
        const configTitle = document.getElementById('configTitle');

        if (mainMenuContainer) {
            mainMenuContainer.style.display = 'none';
        }
        if (playerConfigWrapper) {
            playerConfigWrapper.style.display = 'block';
        }
        if (playerConfigPanel) {
            playerConfigPanel.style.display = 'flex';
        }
        if (onlineMultiplayerConfig) {
            onlineMultiplayerConfig.style.display = 'flex';
        }
        if (configTitle) {
            configTitle.textContent = '房间列表';
        }
    }

    enableRoomBackGuard() {
        if (this._backGuardEnabled) return;
        this._backGuardEnabled = true;

        if (!this._popstateHandler) {
            this._popstateHandler = () => {
                const roomConfig = document.getElementById('roomConfig');
                const roomConfigDisplay = roomConfig ? window.getComputedStyle(roomConfig).display : 'none';
                console.log(`[popstate] roomConfig display=${roomConfigDisplay}`);
                if (roomConfigDisplay === 'none') {
                    return;
                }

                // 防止 go(1) 触发的 popstate 再次弹窗
                if (this._suppressNextPopstate) {
                    this._suppressNextPopstate = false;
                    return;
                }

                const shouldLeave = confirm('确定要离开房间吗？');
                if (shouldLeave) {
                    this.leaveRoom(false);
                } else {
                    // 向前导航一步，取消"返回"操作，不破坏历史栈结构
                    this._suppressNextPopstate = true;
                    window.history.go(1);
                }
            };
        }

        window.addEventListener('popstate', this._popstateHandler);
        try {
            window.history.pushState({ __roomBackGuard: true }, '', window.location.href);
        } catch (e) {
            // ignore
        }
    }

    disableRoomBackGuard() {
        if (!this._backGuardEnabled) return;
        this._backGuardEnabled = false;
        if (this._popstateHandler) {
            window.removeEventListener('popstate', this._popstateHandler);
        }
    }

    // 添加踢人按钮到颜色圆圈
    addKickButtonToCircle(circle, playerId, playerNum) {
        // 移除已存在的踢人按钮
        this.removeKickButtonFromCircle(circle);

        const kickBtn = document.createElement('div');
        kickBtn.className = 'kick-player-btn';
        kickBtn.innerHTML = '<svg t="1777870303975" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5679" width="30" height="30"><path d="M85.333333 512a64 64 0 0 1 64-64h725.333334a64 64 0 0 1 0 128h-725.333334A64 64 0 0 1 85.333333 512z" fill="currentColor" p-id="5680"></path></svg>';
        kickBtn.title = '踢出玩家';
        kickBtn.dataset.playerId = playerId;
        kickBtn.dataset.playerNum = playerNum;

        // 添加点击事件
        kickBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.kickPlayer(playerId, playerNum);
        });

        circle.appendChild(kickBtn);
    }

    // 添加移除AI按钮到颜色圆圈
    addAIRemoveButtonToCircle(circle, playerNum) {
        // 移除已存在的踢人按钮（通用清除）
        this.removeKickButtonFromCircle(circle);

        const removeBtn = document.createElement('div');
        removeBtn.className = 'kick-player-btn';
        removeBtn.innerHTML = '<svg t="1777870303975" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5679" width="30" height="30"><path d="M85.333333 512a64 64 0 0 1 64-64h725.333334a64 64 0 0 1 0 128h-725.333334A64 64 0 0 1 85.333333 512z" fill="currentColor" p-id="5680"></path></svg>';
        removeBtn.title = '移除AI玩家';
        removeBtn.dataset.playerNum = playerNum;

        // 添加点击事件
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.removeAIPlayer(playerNum);
        });

        circle.appendChild(removeBtn);
    }

    // 从颜色圆圈移除踢人按钮
    removeKickButtonFromCircle(circle) {
        const existingKickBtn = circle.querySelector('.kick-player-btn');
        if (existingKickBtn) {
            existingKickBtn.remove();
        }
    }

    // 踢出玩家
    kickPlayer(playerId, playerNum) {
        if (!this.isHost || !this.wsClient) {
            console.warn('只有房主才能踢出玩家');
            return;
        }

        // 不能踢自己
        if (this.currentPlayer && playerId === this.currentPlayer.id) {
            console.warn('不能踢出自己');
            return;
        }

        // 发送踢人请求到服务器
        this.wsClient.sendMessage('kickPlayer', { playerId: playerId });
        console.log(`踢出玩家: ${playerId} (颜色: ${playerNum})`);
    }

    // 更新房间信息显示
    updateRoomInfo() {
        const roomCodeDisplay = document.getElementById('roomCodeDisplay');
        const currentPlayerCountDisplay = document.getElementById('currentPlayerCount');
        const gameConfigInfo = document.getElementById('gameConfigInfo');

        if (roomCodeDisplay) {
            // 如果是创建中状态，显示加载动画
            if (this.roomCode === '创建中...') {
                roomCodeDisplay.innerHTML = '<span class="loading-dots">创建中<span class="dot dot1">.</span><span class="dot dot2">.</span><span class="dot dot3">.</span></span>';
                roomCodeDisplay.classList.add('loading');
            } else {
                roomCodeDisplay.textContent = this.roomCode || '----';
                roomCodeDisplay.classList.remove('loading');
            }
        }

        if (currentPlayerCountDisplay) {
            // 计算总玩家数：真实玩家 + AI玩家
            const realPlayerCount = this.players ? this.players.size : 1;
            const aiPlayerCount = (this.currentRoom && this.currentRoom.settings && this.currentRoom.settings.aiPlayers)
                ? this.currentRoom.settings.aiPlayers.length : 0;
            const totalPlayerCount = realPlayerCount + aiPlayerCount;
            currentPlayerCountDisplay.textContent = totalPlayerCount;
        }

        // 更新游戏配置信息
        if (gameConfigInfo) {
            const pieceCount = (this.currentRoom && this.currentRoom.settings && this.currentRoom.settings.pieceCount)
                ? this.currentRoom.settings.pieceCount : 4;
            const skillMode = (this.currentRoom && this.currentRoom.settings && this.currentRoom.settings.skillMode)
                ? this.currentRoom.settings.skillMode : false;
            const happyMode = (this.currentRoom && this.currentRoom.settings && this.currentRoom.settings.happyMode)
                ? this.currentRoom.settings.happyMode : false;
            let modeText;
            if (happyMode && skillMode) {
                modeText = '道具欢乐';
            } else if (happyMode) {
                modeText = '欢乐模式';
            } else if (skillMode) {
                modeText = '道具模式';
            } else {
                modeText = '标准模式';
            }
            gameConfigInfo.textContent = `${pieceCount}棋子 - ${modeText}`;

            // 非标准模式：在右侧添加问号图标打开规则说明
            const isStandard = !happyMode && !skillMode;
            const existingHelp = gameConfigInfo.querySelector('.config-mode-help');
            if (!isStandard) {
                if (!existingHelp) {
                    const helpIcon = document.createElement('span');
                    helpIcon.className = 'config-mode-help toggle-group-help';
                    helpIcon.textContent = '?';
                    helpIcon.style.marginLeft = '6px';
                    helpIcon.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof showModeRulesModal === 'function') {
                            showModeRulesModal();
                        }
                    };
                    gameConfigInfo.appendChild(helpIcon);
                }
            } else {
                if (existingHelp) {
                    existingHelp.remove();
                }
            }
        }

        this.updateConfigHeaderTitle();
    }

    // 复制房间号
    async copyRoomCode() {
        if (!this.roomCode) return;

        try {
            await navigator.clipboard.writeText(this.roomCode);
            // 显示复制成功的提示
            const roomCodeElement = document.getElementById('roomCodeDisplay');
            const originalText = this.roomCode; // 使用实际的房间号而不是元素的textContent
            roomCodeElement.textContent = '已复制!';
            setTimeout(() => {
                roomCodeElement.textContent = originalText;
            }, 1000);
        } catch (error) {
            console.error('复制失败:', error);
        }
    }

    // 选择颜色：只有空座位能占；点到别人座位上只摆一下，不发换座意图
    selectColor(playerNum) {
        if (!this.wsClient || !this.currentPlayer) return;

        // 自己的座位，点了什么也不用做
        if (this.currentPlayer.color === playerNum) return;

        // 座位上有人（真人或 AI）：给个「这里有人」的反馈，其余什么也不做
        const roomPlayers = (this.currentRoom && this.currentRoom.players) || [];
        const aiPlayers = (this.currentRoom && this.currentRoom.settings && this.currentRoom.settings.aiPlayers) || [];
        const taken = roomPlayers.some(p => p.color === playerNum) || aiPlayers.some(ai => ai.color === playerNum);
        if (taken) {
            this.swaySeat(playerNum);
            return;
        }

        // 座位归属由服务端裁决，本地不抢先改写，
        // 否则界面上的座位会与真实回合顺序不一致
        this.wsClient.selectColor(playerNum);
    }

    // 点到别人座位上时左右摆一下
    swaySeat(playerNum) {
        const panel = document.getElementById('onlineMultiplayerConfig');
        const circle = panel && panel.querySelector(`.color-option[data-player="${playerNum}"] .color-circle`);
        if (!circle) return;
        circle.classList.remove('seat-sway');
        void circle.offsetWidth;
        circle.classList.add('seat-sway');
        setTimeout(() => circle.classList.remove('seat-sway'), 600);
    }

    // 显示当前玩家设置
    showCurrentPlayerSettings() {
        const currentPlayerSettings = document.getElementById('currentPlayerSettings');
        if (currentPlayerSettings) {
            currentPlayerSettings.style.display = 'block';

            // 确保表情显示被正确初始化
            if (this.currentPlayer && this.currentPlayer.emoji) {
                // 如果当前玩家已经有表情，同步到本地状态
                if (this.emojis && this.emojiKeys && this.emojiKeys.length > 0) {
                    const emojiIndex = this.emojiKeys.indexOf(this.currentPlayer.emoji);
                    if (emojiIndex !== -1) {
                        this.currentEmojiIndex = emojiIndex;
                        this.selectedEmoji = this.currentPlayer.emoji;
                    }
                }
            }

            this.updateEmojiPreview();
            this.updateEmojiDisplay();
        }
    }

    // 隐藏当前玩家设置
    hideCurrentPlayerSettings() {
        const currentPlayerSettings = document.getElementById('currentPlayerSettings');
        if (currentPlayerSettings) {
            currentPlayerSettings.style.display = 'none';
        }
    }

    // 切换表情
    switchEmoji(direction) {
        this.currentEmojiIndex = (this.currentEmojiIndex + direction + this.emojiKeys.length) % this.emojiKeys.length;
        this.selectedEmoji = this.emojiKeys[this.currentEmojiIndex];
        this.updateEmojiDisplay();

        if (this.wsClient && this.currentPlayer) {
            this.wsClient.updateEmoji(this.selectedEmoji);

            // 保存到localStorage，用于刷新后恢复
            try {
                localStorage.setItem(`emoji_${this.roomCode}_${this.currentPlayer.id}`, this.selectedEmoji);
            } catch (error) {
                console.warn('保存表情到localStorage失败:', error);
            }
            // 不要立即更新本地状态，等待服务器确认后再更新
            // this.currentPlayer.emoji = this.selectedEmoji;
            // this.updatePlayerDisplay();
        }
    }

    // 更新表情显示
    updateEmojiDisplay() {
        // 检查表情数据是否已加载
        if (!this.emojis || !this.emojiKeys || this.emojiKeys.length === 0) {
            console.warn('表情数据尚未加载，跳过表情显示更新');
            return;
        }

        const emojiKey = this.emojiKeys[this.currentEmojiIndex];
        const emojiData = this.emojis[emojiKey];

        if (emojiData) {
            const previewElement = document.getElementById('multiplayerCurrentEmojiPreview');
            const nameElement = document.getElementById('multiplayerCurrentEmojiName');

            if (previewElement && nameElement) {
                previewElement.innerHTML = emojiData.svg;
                nameElement.textContent = emojiData.name;
            }
        }

        this.updateEmojiPreview();
    }

    // 更新表情预览颜色
    updateEmojiPreview() {
        const preview = document.getElementById('multiplayerEmojiPreview');
        if (preview && this.currentPlayer && this.currentPlayer.color) {
            // 清除所有可能的颜色类
            preview.classList.remove('player-1-color', 'player-2-color', 'player-3-color', 'player-4-color');
            // 添加当前玩家的颜色类
            preview.classList.add(`player-${this.currentPlayer.color}-color`);
            // 确保基础类存在
            if (!preview.classList.contains('emoji-preview')) {
                preview.classList.add('emoji-preview');
            }
        }
    }

    // 更新昵称
    updateNickname(nickname, options = {}) {
        if (!this.wsClient || !this.currentPlayer) return;

        // 确保nickname是字符串类型
        if (typeof nickname !== 'string') {
            return;
        }

        // 允许空昵称，服务器会在开始游戏时生成默认昵称
        const trimmedNickname = nickname.trim();
        const { manualInput = true } = options;

        // 使用WebSocketClient的updateNickname方法
        this.wsClient.updateNickname(trimmedNickname, { manualInput });

        // 使用 playerIdManager 保存昵称到 localStorage（持久化保存）
        if (window.playerIdManager) {
            window.playerIdManager.saveNickname(trimmedNickname);
        }

        // 不要立即更新本地状态，等待服务器确认后再更新
    }

    // 更新玩家显示
    updatePlayerDisplay() {

        const multiplayerPanel = document.getElementById('onlineMultiplayerConfig');
        if (!multiplayerPanel) return;

        multiplayerPanel.querySelectorAll('.color-option').forEach(opt => {
            opt.classList.remove('selected');
            const circle = opt.querySelector('.color-circle');
            const addBtn = opt.querySelector('.add-player-btn');
            const playerInfo = opt.querySelector('.player-info');
            const playerNickname = opt.querySelector('.player-nickname');
            const playerReadyStatus = opt.querySelector('.player-ready-status');

            if (circle) {
                circle.classList.remove('selected');
                // 清除之前添加的表情元素
                const existingEmoji = circle.querySelector('.multiplayer-emoji');
                if (existingEmoji) {
                    existingEmoji.remove();
                }
                // 清除踢人按钮
                this.removeKickButtonFromCircle(circle);
                // 清除离线倒计时遮罩（避免玩家离开后残留）
                const overlay = circle.querySelector('.offline-countdown-overlay');
                if (overlay) {
                    overlay.remove();
                }
            }

            // 重置所有位置为空闲状态
            if (addBtn) addBtn.style.display = 'block';
            if (playerInfo) playerInfo.style.display = 'none';
            if (playerNickname) playerNickname.style.display = 'none';
            if (playerReadyStatus) playerReadyStatus.style.display = 'none';
        });

        // 显示实际玩家信息 - 只操作多人联机面板内的color-option
        multiplayerPanel.querySelectorAll('.color-option').forEach(option => {
            const playerNum = parseInt(option.dataset.player);
            const circle = option.querySelector('.color-circle');
            const addBtn = option.querySelector('.add-player-btn');
            const playerInfo = option.querySelector('.player-info');
            const playerNickname = option.querySelector('.player-nickname');

            // 检查基本元素是否存在（circle是必需的）
            if (!circle) {
                console.warn(`Missing circle element for player ${playerNum}`);
                return; // 跳过这个选项
            }

            // 查找占用该颜色的玩家
            const player = Array.from(this.players.values()).find(p => p.color === playerNum);

            if (player) {
                // 只要准备了或者是AI，就添加selected类（显示为玩家填充色和白色表情）
                const isReady = player.isReady || this.playerReadyStatus.get(player.id) || player.isHost || player.isAI;
                if (isReady) {
                    option.classList.add('selected');
                    circle.classList.add('selected');
                } else {
                    option.classList.remove('selected');
                    circle.classList.remove('selected');
                }

                // 隐藏添加按钮
                if (addBtn) {
                    addBtn.style.display = 'none';
                }

                // 直接在color-circle内显示表情
                this.displayPlayerEmojiInCircle(circle, player, playerNum);

                // 显示昵称在颜色圆圈下方
                if (playerNickname) {
                    // 自己那一席的昵称加粗，别的座位一眼就能区分出「哪个是我」
                    playerNickname.classList.toggle('player-nickname-me', Boolean(this.currentPlayer) && player.id === this.currentPlayer.id);
                    // 只使用服务器提供的昵称，不使用回退逻辑
                    if (player.nickname) {
                        playerNickname.textContent = player.nickname;
                        playerNickname.style.display = 'block';
                    } else {
                        playerNickname.style.display = 'none';
                    }
                }

                // 为房主添加踢人按钮（不能踢自己）
                if (this.isHost && this.currentPlayer && player.id !== this.currentPlayer.id) {
                    this.addKickButtonToCircle(circle, player.id, playerNum);
                } else {
                    // 移除可能存在的踢人按钮
                    this.removeKickButtonFromCircle(circle);
                }

                // 显示准备状态
                const playerReadyStatus = option.querySelector('.player-ready-status');
                if (playerReadyStatus) {
                    // 首先检查玩家是否在线
                    const isOnline = player.isConnected !== false; // 默认在线

                    if (!isOnline) {
                        // 玩家离线，显示离线状态
                        playerReadyStatus.textContent = '离线';
                        playerReadyStatus.className = 'player-ready-status offline';
                        playerReadyStatus.style.display = 'block';

                        const remainingSeconds = this.getRemainingOfflineSeconds(player.id);
                        if (remainingSeconds != null) {
                            this.updateOfflineOverlayForPlayer(player.id, remainingSeconds);
                        }
                    } else if (player.isHost) {
                        // 房主显示房主状态
                        playerReadyStatus.textContent = '房主';
                        playerReadyStatus.className = 'player-ready-status host';
                        playerReadyStatus.style.display = 'block';

                        this.removeOfflineOverlayForPlayer(player.id);
                    } else {
                        // 非房主玩家检查准备状态
                        const isReady = this.playerReadyStatus.get(player.id) || false;
                        playerReadyStatus.textContent = isReady ? '已准备' : '未准备';
                        playerReadyStatus.className = isReady ? 'player-ready-status ready' : 'player-ready-status not-ready';
                        playerReadyStatus.style.display = 'block';

                        this.removeOfflineOverlayForPlayer(player.id);
                    }
                }
            }
        });

        // 更新AI玩家显示，确保bot颜色选择根据在线玩家已选择的颜色动态更新
        // 所有玩家都应该能看到AI玩家的color-circle，不仅仅是房主
        const currentAIPlayers = (this.currentRoom && this.currentRoom.settings && this.currentRoom.settings.aiPlayers)
            ? this.currentRoom.settings.aiPlayers
            : [];

        // 只有房主才显示AI玩家管理界面（添加/移除按钮）
        if (this.isHost) {
            this.updateAIPlayersDisplay(currentAIPlayers);
        } else {
            // 非房主只更新color-options中的AI玩家状态显示
            this.updateColorOptionsForAI(currentAIPlayers);
        }


    }

    // 直接在color-circle内显示玩家表情（用于多人联机配置页面）
    displayPlayerEmojiInCircle(circle, player, playerNum) {
        // 检查表情数据是否已加载
        if (!this.emojis) {
            console.warn('表情数据尚未加载，延迟显示表情');
            // 延迟100ms后重试
            setTimeout(() => {
                if (this.emojis) {
                    this.displayPlayerEmojiInCircle(circle, player, playerNum);
                }
            }, 100);
            return;
        }

        // 清除之前的表情元素，避免重复显示
        const existingEmoji = circle.querySelector('.multiplayer-emoji');
        if (existingEmoji) {
            existingEmoji.remove();
        }

        // 创建表情元素
        const emojiElement = document.createElement('div');
        emojiElement.className = 'multiplayer-emoji';

        // 优先使用player.emoji，如果没有则使用第一个可用的表情（而不是总是smile）
        let emojiToUse = player.emoji;
        if (!emojiToUse || !this.emojis[emojiToUse]) {
            // 如果player.emoji不存在或无效，使用第一个可用的表情
            if (this.emojiKeys && this.emojiKeys.length > 0) {
                emojiToUse = this.emojiKeys[0];
                console.log(`使用默认表情: ${emojiToUse} (原表情: ${player.emoji})`);
            } else {
                console.warn('无可用表情，使用smile作为最后的兜底');
                emojiToUse = 'smile';
            }
        }

        // 使用SVG表情
        if (this.emojis[emojiToUse]) {
            emojiElement.innerHTML = this.emojis[emojiToUse].svg;
        } else {
            console.error('无法找到表情数据:', emojiToUse);
            return;
        }

        // 应用玩家颜色到SVG表情
        const svgElement = emojiElement.querySelector('svg');
        if (svgElement) {
            this.applyPlayerColorToSVG(svgElement, playerNum);
        }

        // 将表情元素添加到color-circle内
        circle.appendChild(emojiElement);
    }

    // 应用玩家颜色到SVG表情
    applyPlayerColorToSVG(svgElement, playerNum) {
        // 获取玩家颜色CSS变量
        const playerColor = getComputedStyle(document.documentElement)
            .getPropertyValue(`--player-${playerNum}-color`).trim();

        // 设置SVG的fill和stroke颜色
        svgElement.style.fill = playerColor;
        svgElement.style.stroke = playerColor;
        svgElement.style.color = playerColor;

        // 为SVG内的所有path元素设置颜色
        const paths = svgElement.querySelectorAll('path, circle, rect, ellipse');
        paths.forEach(path => {
            if (!path.getAttribute('fill') || path.getAttribute('fill') === 'currentColor') {
                path.setAttribute('fill', playerColor);
            }
            if (!path.getAttribute('stroke') || path.getAttribute('stroke') === 'currentColor') {
                path.setAttribute('stroke', playerColor);
            }
        });
    }

    // 显示房主设置
    showHostSettings() {
        document.getElementById('hostSettings').style.display = 'block';
        document.getElementById('waitingForHost').style.display = 'none';
        document.getElementById('playerReadySection').style.display = 'none';

        this.updateRoomPrivacyToggleUI(!!this.currentRoom?.isPrivate);

        // 从房间数据中获取AI玩家信息
        const aiPlayers = (this.currentRoom && this.currentRoom.settings && this.currentRoom.settings.aiPlayers)
            ? this.currentRoom.settings.aiPlayers
            : [];

        this.updateAIPlayersDisplay(aiPlayers);

        // 房主自动设为已准备
        if (this.currentPlayer) {
            this.playerReadyStatus.set(this.currentPlayer.id, true);
        }

        // 更新开始游戏按钮状态
        this.updateStartGameButton();
    }

    // 隐藏房主设置
    hideHostSettings() {
        document.getElementById('hostSettings').style.display = 'none';
        document.getElementById('playerReadySection').style.display = 'block';

        this.updateRoomPrivacyToggleUI(!!this.currentRoom?.isPrivate);

        // 更新准备按钮和等待文字
        this.updatePlayerReadyButton();
        this.updateWaitingForHostText();
    }

    // 设置棋子数量
    setPieceCount(count) {
        if (!this.isHost || !this.wsClient) return;

        // 立即更新本地房间设置
        if (!this.currentRoom) {
            this.currentRoom = { settings: {} };
        }
        if (!this.currentRoom.settings) {
            this.currentRoom.settings = {};
        }
        this.currentRoom.settings.pieceCount = count;

        // 使用WebSocketClient的configurePieceCount方法
        this.wsClient.configurePieceCount(count);
        this.updatePieceCountDisplay(count);

        // 立即更新房间信息显示
        this.updateRoomInfo();
    }

    setRoomPrivacy(isPrivate) {
        if (!this.wsClient) return;
        if (!this.isHost) return;

        const nextValue = !!isPrivate;

        if (!this.currentRoom) {
            this.currentRoom = {};
        }
        this.currentRoom.isPrivate = nextValue;

        this.updateRoomPrivacyToggleUI(nextValue);

        if (typeof this.wsClient.updateRoomPrivacy === 'function') {
            this.wsClient.updateRoomPrivacy(nextValue);
        } else {
            this.wsClient.sendMessage('update_room_privacy', { isPrivate: nextValue });
        }
    }

    updateRoomPrivacyToggleUI(isPrivate) {
        const toggle = document.getElementById('roomPrivacyToggle');
        const publicBtn = document.getElementById('roomPrivacyPublicBtn');
        const privateBtn = document.getElementById('roomPrivacyPrivateBtn');
        if (!toggle || !publicBtn || !privateBtn) return;

        if (!this.isHost) {
            toggle.style.display = 'none';
            return;
        }

        toggle.style.display = 'inline-flex';

        publicBtn.classList.toggle('active', !isPrivate);
        privateBtn.classList.toggle('active', !!isPrivate);
    }

    // 更新棋子数量显示
    updatePieceCountDisplay(count) {
        // 只更新在线多人联机配置面板中的棋子个数选择器
        const onlineConfigPanel = document.getElementById('onlineMultiplayerConfig');
        if (onlineConfigPanel) {
            onlineConfigPanel.querySelectorAll('.piece-count-option').forEach(option => {
                if (parseInt(option.dataset.count) === count) {
                    option.classList.add('selected');
                } else {
                    option.classList.remove('selected');
                }
            });
        }
    }

    // 更新AI玩家显示
    updateAIPlayersDisplay(aiPlayers = []) {
        const container = document.getElementById('multiplayerBotPlayers');
        container.innerHTML = '';

        // 获取空闲的颜色位置（排除真实玩家占用的位置）
        const occupiedColors = Array.from(this.players.values())
            .filter(p => p.color && !p.isAI)
            .map(p => p.color);
        const availableColors = [1, 2, 3, 4].filter(color => !occupiedColors.includes(color));

        availableColors.forEach(color => {
            const aiPlayer = aiPlayers.find(ai => ai.color === color);
            const botDiv = this.createAIPlayerElement(color, aiPlayer, aiPlayers);
            container.appendChild(botDiv);
        });

        // 同步更新color-options状态
        this.updateColorOptionsForAI(aiPlayers);

        // 更新开始游戏按钮状态
        this.updateStartGameButton();
    }

    // 更新color-options中AI玩家的状态
    updateColorOptionsForAI(aiPlayers = []) {
        // 只操作多人联机面板内的color-option，避免影响人机模式
        const multiplayerPanel = document.getElementById('onlineMultiplayerConfig');
        if (!multiplayerPanel) return;

        multiplayerPanel.querySelectorAll('.color-option').forEach(option => {
            const playerNum = parseInt(option.dataset.player);
            const addBtn = option.querySelector('.add-player-btn');
            const playerInfo = option.querySelector('.player-info');
            const playerEmoji = option.querySelector('.player-emoji');
            const playerNickname = option.querySelector('.player-nickname');
            const colorCircle = option.querySelector('.color-circle');

            // 检查该颜色是否被AI占用
            const aiPlayer = aiPlayers.find(ai => ai.color === playerNum);

            // 检查该颜色是否被真实人类玩家占用
            const realPlayer = Array.from(this.players.values()).find(p => p.color === playerNum && !p.isAI);

            if (aiPlayer && !realPlayer) {
                // AI 玩家默认视为已准备，添加 selected 类
                option.classList.add('selected');
                if (colorCircle) {
                    colorCircle.classList.add('selected');
                }

                // 该位置被AI占用
                if (addBtn) addBtn.style.display = 'none';
                if (playerInfo) playerInfo.style.display = 'block';
                if (playerNickname) {
                    playerNickname.style.display = 'block';

                    // 优先使用服务器返回的昵称，如果没有则生成
                    let botName = aiPlayer.nickname;

                    if (!botName) {
                        // 生成AI玩家名称（与bot-player中的逻辑一致）
                        const easyBots = [];
                        const hardBots = [];

                        aiPlayers.forEach(ai => {
                            if (ai.difficulty === 'hard') {
                                hardBots.push(ai.color);
                            } else {
                                easyBots.push(ai.color);
                            }
                        });

                        easyBots.sort((a, b) => a - b);
                        hardBots.sort((a, b) => a - b);

                        const difficulty = aiPlayer.difficulty || 'easy';

                        if (difficulty === 'hard') {
                            const indexInHard = hardBots.indexOf(playerNum) + 1;
                            botName = `AI-${indexInHard}`;
                        } else {
                            const indexInEasy = easyBots.indexOf(playerNum) + 1;
                            botName = `Bot-${indexInEasy}`;
                        }
                    }

                    playerNickname.textContent = botName;
                }

                // AI玩家默认准备
                const playerReadyStatus = option.querySelector('.player-ready-status');
                if (playerReadyStatus) {
                    playerReadyStatus.textContent = '已准备';
                    playerReadyStatus.className = 'player-ready-status ready';
                    playerReadyStatus.style.display = 'block';
                }

                // 设置AI头像（使用emojis.js中的bot表情）
                // 在多人联机面板中，需要在color-circle中显示表情
                if (colorCircle) {
                    // 无论是否是房主，先尝试移除已有的移除/踢人按钮，确保状态正确
                    this.removeKickButtonFromCircle(colorCircle);

                    // 清除之前的表情元素
                    const existingEmoji = colorCircle.querySelector('.multiplayer-emoji');
                    if (existingEmoji) {
                        existingEmoji.remove();
                    }

                    // 检查表情数据是否已加载
                    if (!this.emojis || !this.emojis['bot']) {
                        console.warn('表情数据尚未加载，延迟更新AI玩家显示');
                        // 延迟100ms后重试
                        setTimeout(() => {
                            this.updateColorOptionsForAI(aiPlayers);
                        }, 100);
                        return;
                    }

                    // 创建AI表情元素并添加到color-circle中
                    const emojiElement = document.createElement('div');
                    emojiElement.className = 'multiplayer-emoji';
                    emojiElement.innerHTML = this.emojis['bot'].svg;

                    // 应用玩家颜色到SVG表情
                    const svgElement = emojiElement.querySelector('svg');
                    if (svgElement) {
                        this.applyPlayerColorToSVG(svgElement, playerNum);
                    }

                    // 将表情元素添加到color-circle内
                    colorCircle.appendChild(emojiElement);

                    // 如果是房主，为AI玩家添加移除按钮
                    if (this.isHost) {
                        this.addAIRemoveButtonToCircle(colorCircle, playerNum);
                    }
                }

                // 如果存在player-emoji元素（AI配置面板），也设置表情
                if (playerEmoji) {
                    // 检查表情数据是否已加载
                    if (!this.emojis || !this.emojis['bot']) {
                        console.warn('表情数据尚未加载，跳过player-emoji更新');
                        return;
                    }

                    playerEmoji.innerHTML = this.emojis['bot'].svg;

                    // 应用玩家颜色到SVG
                    const svgElement = playerEmoji.querySelector('svg');
                    if (svgElement) {
                        svgElement.classList.add(`player-${playerNum}-color`);

                        // 获取玩家颜色CSS变量
                        const playerColor = getComputedStyle(document.documentElement)
                            .getPropertyValue(`--player-${playerNum}-color`).trim();

                        // 设置SVG的颜色
                        svgElement.style.fill = playerColor;
                        svgElement.style.stroke = playerColor;
                        svgElement.style.color = playerColor;

                        // 为SVG内的所有path元素设置颜色
                        const paths = svgElement.querySelectorAll('path, circle, rect, ellipse');
                        paths.forEach(path => {
                            if (!path.getAttribute('fill') || path.getAttribute('fill') === 'currentColor') {
                                path.setAttribute('fill', playerColor);
                            }
                            if (!path.getAttribute('stroke') || path.getAttribute('stroke') === 'currentColor') {
                                path.setAttribute('stroke', playerColor);
                            }
                        });
                    }
                }

                // 禁用该颜色选项的点击
                // 如果是房主且该位置有AI，需要允许点击（以便点击移除按钮）
                if (this.isHost && aiPlayer && !realPlayer) {
                    option.style.pointerEvents = 'auto';
                } else {
                    option.style.pointerEvents = 'none';
                }
                option.style.opacity = '1';

            } else if (!realPlayer) {
                // 该位置空闲
                option.classList.remove('selected');
                if (colorCircle) {
                    colorCircle.classList.remove('selected');
                }

                if (addBtn) addBtn.style.display = 'block';
                if (playerInfo) playerInfo.style.display = 'none';
                if (playerNickname) playerNickname.style.display = 'none';

                const playerReadyStatus = option.querySelector('.player-ready-status');
                if (playerReadyStatus) {
                    playerReadyStatus.style.display = 'none';
                }

                // 清除color-circle中的表情元素和按钮
                if (colorCircle) {
                    const existingEmoji = colorCircle.querySelector('.multiplayer-emoji');
                    if (existingEmoji) {
                        existingEmoji.remove();
                    }
                    this.removeKickButtonFromCircle(colorCircle);
                }

                // 恢复点击功能
                option.style.pointerEvents = 'auto';
                option.style.opacity = '1';
            }
            // 如果被真实玩家占用，保持原有逻辑不变
        });
    }

    // 创建AI玩家元素
    createAIPlayerElement(color, aiPlayer, allAIPlayers = []) {
        const botDiv = document.createElement('div');

        if (aiPlayer) {
            // 已添加的AI玩家
            botDiv.className = 'bot-player';
            botDiv.dataset.color = color;

            // 使用传入的allAIPlayers数组而不是从this.players获取
            // 按难度分组，并按颜色排序
            const easyBots = [];
            const hardBots = [];

            allAIPlayers.forEach(ai => {
                if (ai.difficulty === 'hard') {
                    hardBots.push(ai.color);
                } else {
                    easyBots.push(ai.color);
                }
            });

            // 按颜色排序
            easyBots.sort((a, b) => a - b);
            hardBots.sort((a, b) => a - b);

            // 优先使用服务器返回的昵称，如果没有则计算
            let botName = aiPlayer.nickname;
            const difficulty = aiPlayer.difficulty || 'easy';

            if (!botName) {
                // 计算当前AI在同难度中的编号（兜底逻辑）
                if (difficulty === 'hard') {
                    const indexInHard = hardBots.indexOf(color) + 1;
                    botName = `AI-${indexInHard}`;
                } else {
                    const indexInEasy = easyBots.indexOf(color) + 1;
                    botName = `Bot-${indexInEasy}`;
                }
            }

            const difficultyText = difficulty === 'easy' ? '简单' : '困难';

            botDiv.innerHTML = `
                <div class="difficulty-circle player-${color}-color" data-color="${color}" title="点击切换难度">
                    <span class="difficulty-text">${difficultyText}</span>
                </div>
                <div class="bot-info">
                    <span class="bot-name">${botName}</span>
                </div>
                <div class="remove-btn"><svg t="1777870303975" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5679" width="30" height="30"><path d="M85.333333 512a64 64 0 0 1 64-64h725.333334a64 64 0 0 1 0 128h-725.333334A64 64 0 0 1 85.333333 512z" fill="currentColor" p-id="5680"></path></svg></div>
            `;

        } else {
            // 添加AI玩家选项
            botDiv.className = 'bot-add-option';
            botDiv.dataset.color = color;

            botDiv.innerHTML = `
                <div class="color-circle player-${color}-color">
                    <div class="add-icon">
                        <svg t="1777824616733" class="icon black-icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5251" width="30" height="30">
                            <path d="M576 64H448v384H64v128h384v384h128V576h384V448H576z" fill="currentColor" p-id="5252"></path>
                        </svg>
                    </div>
                </div>
                <div class="placeholder-text">AI${color}</div>
            `;
        }

        return botDiv;
    }

    // 添加AI玩家
    addAIPlayer(color) {
        if (!this.isHost || !this.wsClient) return;

        // 先本地落位再上报：等服务端广播回来才画，点一下要愣一个来回。
        // 昵称按服务端同一套规则重排（简单 Bot-N、困难 AI-N，各自按颜色升序），广播回来不会跳字
        if (!this.currentRoom) this.currentRoom = { settings: {} };
        if (!this.currentRoom.settings) this.currentRoom.settings = {};
        if (!Array.isArray(this.currentRoom.settings.aiPlayers)) this.currentRoom.settings.aiPlayers = [];
        const aiPlayers = this.currentRoom.settings.aiPlayers;
        if (!aiPlayers.some(ai => ai.color === color)) {
            this._recordAIOp({ type: 'add', color, difficulty: 'easy' });
            aiPlayers.push({ color, difficulty: 'easy', nickname: '' });
            this.renumberAIPlayers(aiPlayers);
            this.updateAIPlayersDisplay(aiPlayers);
        }

        this.wsClient.addAIPlayer(color, 'easy');
    }

    /** 给 AI 重排昵称：与服务端 add/remove/难度切换时的同一套规则 */
    renumberAIPlayers(aiPlayers = []) {
        [['easy', 'Bot'], ['hard', 'AI']].forEach(([difficulty, prefix]) => {
            aiPlayers
                .filter(ai => (ai.difficulty || 'easy') === difficulty)
                .sort((a, b) => a.color - b.color)
                .forEach((ai, index) => {
                    ai.nickname = `${prefix}-${index + 1}`;
                });
        });
    }

    /** 记一条本地乐观改动（同一目标只留最新一条），等回声里体现了它就不再压着名单 */
    _recordAIOp(op) {
        this._pendingAIOps = this._pendingAIOps.filter(
            (item) => !(item.type === op.type && item.color === op.color)
        );
        this._pendingAIOps.push({ ...op, at: Date.now() });
    }

    /**
     * 服务端下发的 AI 名单落到本地：本地还没被回声确认的改动压在它上面再渲染。
     * 点得快时，先那一下的回声会晚于后一下的点击到达，不压一下就会把新改动顶回旧值。
     */
    applyServerAIPlayers(serverAIPlayers = []) {
        const list = (serverAIPlayers || []).map((ai) => ({ ...ai }));
        const now = Date.now();
        this._pendingAIOps = this._pendingAIOps.filter((op) => {
            if (now - op.at > AI_OP_TTL_MS) return false;
            const current = list.find((ai) => ai.color === op.color);
            if (op.type === 'add') return !current;
            if (op.type === 'remove') return Boolean(current);
            return !current || current.difficulty !== op.difficulty;
        });
        for (const op of this._pendingAIOps) {
            const index = list.findIndex((ai) => ai.color === op.color);
            if (op.type === 'add' && index < 0) {
                list.push({ color: op.color, difficulty: op.difficulty || 'easy', nickname: '' });
            } else if (op.type === 'remove' && index >= 0) {
                list.splice(index, 1);
            } else if (op.type === 'difficulty' && index >= 0) {
                list[index].difficulty = op.difficulty;
            }
        }
        this.renumberAIPlayers(list);

        if (this.currentRoom) {
            if (!this.currentRoom.settings) this.currentRoom.settings = {};
            this.currentRoom.settings.aiPlayers = list;
        }
        this.updateAIPlayersDisplay(list);
    }

    // 移除AI玩家
    removeAIPlayer(color) {
        if (!this.isHost || !this.wsClient) return;

        const aiPlayers = (this.currentRoom && this.currentRoom.settings && this.currentRoom.settings.aiPlayers) || [];
        if (aiPlayers.some(ai => ai.color === color)) {
            this._recordAIOp({ type: 'remove', color });
            const rest = aiPlayers.filter(ai => ai.color !== color);
            this.renumberAIPlayers(rest);
            this.currentRoom.settings.aiPlayers = rest;
            this.updateAIPlayersDisplay(rest);
        }

        this.wsClient.removeAIPlayer(color);
    }

    // 切换AI难度
    toggleAIDifficulty(color) {
        if (!this.isHost || !this.wsClient) return;

        // 发送到服务器更新难度，让服务器处理后再更新显示
        const difficulties = ['easy', 'hard'];
        const botElement = document.querySelector(`[data-color="${color}"]`);
        if (!botElement) return;

        // 从难度圆圈中获取当前难度
        const difficultyTextElement = botElement.querySelector('.difficulty-circle .difficulty-text');
        if (!difficultyTextElement) return;

        const difficultyText = difficultyTextElement.textContent;
        let currentDifficulty = 'easy';
        if (difficultyText.includes('困难')) currentDifficulty = 'hard';

        const currentIndex = difficulties.indexOf(currentDifficulty);
        const nextDifficulty = difficulties[(currentIndex + 1) % difficulties.length];

        if (this.currentRoom && this.currentRoom.settings && this.currentRoom.settings.aiPlayers) {
            const aiPlayer = this.currentRoom.settings.aiPlayers.find(ai => ai.color === color);
            if (aiPlayer) {
                this._recordAIOp({ type: 'difficulty', color, difficulty: nextDifficulty });
                aiPlayer.difficulty = nextDifficulty;
                this.renumberAIPlayers(this.currentRoom.settings.aiPlayers);

                // 立即重新渲染 AI 玩家显示
                this.updateAIPlayersDisplay(this.currentRoom.settings.aiPlayers);
            }
        }

        // 发送到服务器（服务器也会计算并返回新昵称，但我们已经在本地先更新了）
        this.wsClient.updateAIDifficulty(color, nextDifficulty);
    }

    // 切换玩家准备状态
    togglePlayerReady() {
        if (!this.wsClient || !this.currentPlayer) return;

        // 获取当前准备状态
        const currentReadyStatus = this.playerReadyStatus.get(this.currentPlayer.id) || false;
        const newReadyStatus = !currentReadyStatus;

        // 发送到服务器（带重试机制）
        this.sendToggleReadyWithRetry(newReadyStatus);

        // 立即更新本地状态（乐观更新）
        this.playerReadyStatus.set(this.currentPlayer.id, newReadyStatus);

        // 保存到localStorage
        try {
            localStorage.setItem(`ready_${this.roomCode}_${this.currentPlayer.id}`, String(newReadyStatus));
        } catch (error) {
            console.warn('保存准备状态到localStorage失败:', error);
        }

        // 更新UI
        this.updatePlayerReadyButton();
        this.updatePlayerDisplay();
        this.updateWaitingForHostText();
    }

    /**
     * 发送准备状态切换请求（带重试机制）
     * @param {boolean} isReady - 准备状态
     * @param {number} retryCount - 重试次数
     */
    sendToggleReadyWithRetry(isReady, retryCount = 0) {
        const maxRetries = 3;
        const retryDelay = 1000; // 1秒

        // 检查连接状态
        if (!this.wsClient || !this.wsClient.ws || this.wsClient.ws.readyState !== WebSocket.OPEN) {
            console.warn('WebSocket未连接，尝试重连后重试...');

            if (retryCount < maxRetries) {
                // 先尝试同步房间状态
                this.syncRoomStateAfterReconnect();

                // 延迟后重试
                setTimeout(() => {
                    this.sendToggleReadyWithRetry(isReady, retryCount + 1);
                }, retryDelay);
            } else {
                console.error('准备状态发送失败，已达最大重试次数');
                // 回滚本地状态
                this.playerReadyStatus.set(this.currentPlayer.id, !isReady);
                this.updatePlayerReadyButton();
                this.updatePlayerDisplay();
            }
            return;
        }

        // 发送准备状态
        this.wsClient.toggleReady(isReady);
        console.log(`准备状态已发送: ${isReady}`);
    }

    // 更新准备按钮文字
    updatePlayerReadyButton() {
        const readyBtn = document.getElementById('playerReadyBtn');
        if (!readyBtn || this.isHost) return;

        const isReady = this.playerReadyStatus.get(this.currentPlayer.id) || false;
        readyBtn.textContent = isReady ? '取消准备' : '准备';
    }

    // 更新"等待房主开始游戏"文字的显示
    updateWaitingForHostText() {
        const waitingForHost = document.getElementById('waitingForHost');
        if (!waitingForHost || this.isHost) return;

        const isReady = this.playerReadyStatus.get(this.currentPlayer.id) || false;
        waitingForHost.style.display = isReady ? 'block' : 'none';
    }

    // 更新开始游戏按钮的启用/禁用状态
    updateStartGameButton() {
        if (!this.isHost) return;

        const startBtn = document.getElementById('multiplayerStartGame');
        if (!startBtn) return;

        // 检查是否所有玩家都准备好了
        const allPlayersReady = this.checkAllPlayersReady();

        // 和服务端同一条线：座位数（真人 + AI）够 2 就能开。
        // 只数「在线真人」会把房主 + AI 的局也挡住，而服务端本来就允许（它只看房间人数）。
        // 离线真人另算：他们挡在 checkAllPlayersReady 那一条上，等超时移除或房主踢掉
        const seatedPlayers = this.players.size + this._aiSeatCount();
        startBtn.disabled = seatedPlayers < 2 || !allPlayersReady;
    }

    /** 房间设置里的 AI 座位数 */
    _aiSeatCount() {
        const aiPlayers = this.currentRoom && this.currentRoom.settings && this.currentRoom.settings.aiPlayers;
        return Array.isArray(aiPlayers) ? aiPlayers.length : 0;
    }

    // 检查是否所有玩家都准备好了
    checkAllPlayersReady() {
        // 遍历所有真实玩家
        for (const [playerId, player] of this.players.entries()) {
            if (player.isAI) continue;
            
            // 房主自动准备
            if (player.isHost) {
                continue;
            }
            // 离线玩家不能开始游戏
            if (player.isConnected === false) {
                return false;
            }
            // 检查非房主玩家是否准备
            const isReady = this.playerReadyStatus.get(playerId) || false;
            if (!isReady) {
                return false;
            }
        }

        // AI玩家默认准备，不需要检查
        return true;
    }

    // 开始游戏
    startGame() {
        if (!this.isHost || !this.wsClient) return;

        // 计算座位数（真人 + AI），与服务端 createGameSession 的口径一致
        const seatedPlayers = this.players.size + this._aiSeatCount();
        if (seatedPlayers < 2) {
            this.showError('至少需要2名玩家才能开始游戏');
            return;
        }

        // 检查所有玩家是否准备
        if (!this.checkAllPlayersReady()) {
            this.showError('请等待所有玩家准备');
            return;
        }

        // 禁用按钮防止重复点击
        const startBtn = document.getElementById('multiplayerStartGame');
        if (startBtn) startBtn.disabled = true;

        // 面板上的设置随开局一起交给服务端：中途那几条 updateSettings 万一没送到，
        // 开局用的也是房主眼前这套配置（道具模式、欢乐模式、起手积分）
        const settings = {};
        const skillBox = document.getElementById('skillModeCheckbox');
        if (skillBox) settings.skillMode = skillBox.checked;
        const happyBox = document.getElementById('happyModeCheckbox');
        if (happyBox) settings.happyMode = happyBox.checked;
        const energySlider = document.getElementById('onlineInitialEnergySlider');
        if (energySlider) settings.initialEnergy = [0, 15, 30, 50, 70, 100][Number(energySlider.value) || 0] || 0;

        // 使用sendMessage方法而不是直接调用send
        this.wsClient.sendMessage('startGame', { settings });
    }

    // 开始多人游戏
    startMultiplayerGame(gameData) {
        // 这里需要与现有的游戏逻辑集成
        console.log('开始多人游戏:', gameData);

        // 使用服务器传来的游戏会话ID，而不是重新生成
        const gameSessionId = gameData.gameSessionId;
        console.log('使用服务器传来的游戏会话ID:', gameSessionId);

        // 保存游戏会话ID到重连管理器，用于断线重连
        reconnectManager.updateGameSessionId(gameSessionId);

        // 构建完整的玩家列表，包括真实玩家和AI玩家
        const allPlayers = [];

        // 添加真实玩家
        Array.from(this.players.values()).forEach(player => {
            allPlayers.push({
                id: player.id, // 使用真正的玩家ID，而不是color
                color: player.color,
                nickname: player.nickname,
                emoji: player.emoji,
                isAI: false
            });
        });

        // 添加AI玩家（从房间设置中获取）
        if (this.currentRoom && this.currentRoom.settings && this.currentRoom.settings.aiPlayers) {
            this.currentRoom.settings.aiPlayers.forEach(aiPlayer => {
                allPlayers.push({
                    id: aiPlayer.color, // AI玩家可以使用color作为ID
                    color: aiPlayer.color,
                    nickname: aiPlayer.nickname || `AI玩家${aiPlayer.color}`,
                    emoji: aiPlayer.emoji || 'bot',
                    isAI: true,
                    difficulty: aiPlayer.difficulty || 'easy'
                });
            });
        }

        // 按颜色排序，确保游戏从颜色1开始（符合飞行棋规则）
        allPlayers.sort((a, b) => a.color - b.color);

        // 读取道具模式设置（优先从服务器传递的数据读取，否则从房间设置读取）
        const skillModeEnabled = gameData.skillMode !== undefined
            ? gameData.skillMode
            : (this.currentRoom?.settings?.skillMode || false);
        console.log('[配置] 道具模式:', skillModeEnabled, '(isHost:', this.isHost, ')');

        // 读取欢乐模式设置
        const happyModeEnabled = gameData.happyMode !== undefined
            ? gameData.happyMode
            : (this.currentRoom?.settings?.happyMode || false);
        console.log('[配置] 欢乐模式:', happyModeEnabled, '(isHost:', this.isHost, ')');

        // 设置正确的gameConfig，确保按钮显示正确
        const gameConfig = {
            mode: 'online_multiplayer',
            playerCount: allPlayers.length,
            pieceCount: gameData.pieceCount || 4,
            skillMode: skillModeEnabled,
            happyMode: happyModeEnabled
        };

        console.log('[配置] 最终保存的gameConfig:', gameConfig);
        sessionStorage.setItem('gameConfig', JSON.stringify(gameConfig));

        // 将游戏数据存储到sessionStorage，供game.html使用
        sessionStorage.setItem('multiplayerGameData', JSON.stringify({
            ...gameData,
            players: allPlayers,
            currentPlayer: allPlayers[0], // 按颜色排序后的第一个玩家（颜色最小）
            gameSessionId: gameSessionId, // 使用服务器传来的游戏会话ID
            isHost: this.isHost,
            skillMode: skillModeEnabled, // 明确添加道具模式配置
            happyMode: happyModeEnabled, // 明确添加欢乐模式配置
            wsClient: {
                playerId: this.wsClient.playerId,
                serverUrl: this.wsClient.serverUrl
            }
        }));

        console.log('存储的多人游戏数据:', {
            ...gameData,
            players: allPlayers,
            currentPlayer: this.currentPlayer,
            gameSessionId: gameSessionId,
            isHost: this.isHost
        });

        // 在页面跳转前优雅地关闭WebSocket连接，避免服务器认为是异常断开
        if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            console.log('页面跳转前优雅关闭WebSocket连接');
            // 使用正常关闭代码1000，避免触发重连逻辑
            this.wsClient.close(1000, 'Page navigation');
            this.wsClient = null;
        }

        // 跳转到游戏页面，添加房间号参数
        const roomParam = this.roomCode ? `?room=${this.roomCode}` : '';
        window.location.href = `/game${roomParam}`;
    }

    // 开始多人游戏（重连版本）
    startMultiplayerGameForReconnect(data) {
        console.log('重连到多人游戏:', data);

        // 从data.gameData中获取游戏会话ID，而不是直接从data中获取
        const gameSessionId = data.gameData ? data.gameData.gameSessionId : data.gameSessionId;
        console.log('使用服务器传来的游戏会话ID:', gameSessionId);

        if (!gameSessionId) {
            console.error('无法获取游戏会话ID，重连失败');
            this.showError('重连失败：无法获取游戏会话信息');
            return;
        }

        // 保存游戏会话ID到重连管理器，用于断线重连
        reconnectManager.updateGameSessionId(gameSessionId);

        // 构建完整的玩家列表，包括真实玩家和AI玩家
        const allPlayers = [];

        // 添加真实玩家
        Array.from(this.players.values()).forEach(player => {
            allPlayers.push({
                id: player.id,
                color: player.color,
                nickname: player.nickname,
                emoji: player.emoji,
                isAI: false
            });
        });

        // 添加AI玩家（从房间设置中获取）
        if (this.currentRoom && this.currentRoom.settings && this.currentRoom.settings.aiPlayers) {
            this.currentRoom.settings.aiPlayers.forEach(aiPlayer => {
                allPlayers.push({
                    id: aiPlayer.color,
                    color: aiPlayer.color,
                    nickname: aiPlayer.nickname || `AI玩家${aiPlayer.color}`,
                    emoji: aiPlayer.emoji || 'bot',
                    isAI: true,
                    difficulty: aiPlayer.difficulty || 'easy'
                });
            });
        }

        // 按颜色排序，确保游戏从颜色1开始（符合飞行棋规则）
        allPlayers.sort((a, b) => a.color - b.color);

        // 读取道具模式设置（重连时从服务器数据或房间设置读取）
        const gameData = data.gameData || data;
        const skillModeEnabled = gameData.skillMode !== undefined
            ? gameData.skillMode
            : (this.currentRoom?.settings?.skillMode || false);
        console.log('[配置] 重连时道具模式:', skillModeEnabled);

        // 设置正确的gameConfig，确保按钮显示正确
        const gameConfig = {
            mode: 'online_multiplayer',
            playerCount: allPlayers.length,
            pieceCount: gameData.pieceCount || 4,
            skillMode: skillModeEnabled // 添加道具模式配置
        };
        sessionStorage.setItem('gameConfig', JSON.stringify(gameConfig));

        // 将游戏数据存储到sessionStorage，供game.html使用，标记为重连
        sessionStorage.setItem('multiplayerGameData', JSON.stringify({
            ...(data.gameData || data),
            players: allPlayers,
            currentPlayer: allPlayers[0], // 按颜色排序后的第一个玩家（重连也保持一致）
            gameSessionId: gameSessionId,
            isHost: this.isHost,
            isReconnecting: true, // 标记为重连
            skillMode: skillModeEnabled, // 明确添加道具模式配置
            wsClient: {
                playerId: this.wsClient.playerId,
                serverUrl: this.wsClient.serverUrl
            }
        }));

        console.log('存储的重连游戏数据:', {
            ...(data.gameData || data),
            players: allPlayers,
            currentPlayer: this.currentPlayer,
            gameSessionId: gameSessionId,
            isHost: this.isHost,
            isReconnecting: true
        });

        // 在页面跳转前优雅地关闭WebSocket连接，避免服务器认为是异常断开
        if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            console.log('页面跳转前优雅关闭WebSocket连接');
            // 使用正常关闭代码1000，避免触发重连逻辑
            this.wsClient.close(1000, 'Page navigation');
            this.wsClient = null;
        }

        // 跳转到游戏页面，添加房间号参数
        const roomParam = this.roomCode ? `?room=${this.roomCode}` : '';
        window.location.href = `/game${roomParam}`;
    }

    // 处理返回按钮
    handleBackButton() {
        const roomConfig = document.getElementById('roomConfig');
        const roomSelection = document.getElementById('roomSelection');

        // 兜底：如果仍然处于某个房间中（哪怕DOM显示状态短暂不同步），返回键应当是“离开房间回列表”
        // 避免误走“返回主菜单”分支导致 destroy() + socket断开，从而出现首页URL但UI残留的错乱状态
        const isInRoom = !!(this.roomCode || this.currentRoom || (this.players && this.players.size > 0));

        // 使用 getComputedStyle 获取实际显示状态，而不是内联样式
        const roomConfigDisplay = roomConfig ? window.getComputedStyle(roomConfig).display : 'none';
        if (roomConfigDisplay !== 'none' || isInRoom) {
            // 从房间配置/房间内返回到房间选择
            this.leaveRoom(false); // 不重定向到主页，而是显示房间选择界面
        } else {
            // 从房间选择返回到主菜单（仅在确实不在任何房间中时才允许）
            // 清除URL中的room参数
            try {
                const currentUrl = new URL(window.location);
                if (currentUrl.searchParams.has('room')) {
                    currentUrl.searchParams.delete('room');
                    window.history.replaceState({}, document.title, currentUrl.toString());
                }
            } catch (error) {
                console.error('清除URL参数失败:', error);
            }

            // 不在房间中：仅做界面返回主菜单，不销毁 manager、不关闭 WebSocket
            // 这样用户从主菜单再次进入在线联机时体验更顺滑，也不会出现 socket 被断开的问题
            this.showMainMenu();
        }
    }

    // 离开房间
    leaveRoom(shouldRedirect = false) {
        // 防止重复触发离开流程（例如按钮点击 + popstate/重复事件绑定等）
        if (this.isLeavingRoom) {
            return;
        }
        // 标记正在离开房间，避免触发重连和显示状态
        this.isLeavingRoom = true;

        this.disableRoomBackGuard();

        // 显式清理重连管理器的信息，确保重连按钮立即消失
        if (window.reconnectManager) {
            console.log('[清理] 主动离开房间，清理重连信息');
            window.reconnectManager.clearPlayerIdentity();
        }

        // 立即清除URL中的room参数（在最开始就执行，确保无论如何都会清除）
        try {
            const currentUrl = new URL(window.location);
            if (currentUrl.searchParams.has('room')) {
                currentUrl.searchParams.delete('room');
                window.history.replaceState({}, document.title, currentUrl.toString());
            }
        } catch (error) {
            console.error('清除URL参数失败:', error);
        }

        const finalizeLeaveToSelection = () => {
            this.ensureOnlineMultiplayerPanelVisible();
            this.showRoomSelection();
            // 重置标志
            setTimeout(() => {
                this.isLeavingRoom = false;
            }, 1000);
        };

        // 发送离开房间消息到服务器
        const ws = this.wsClient && this.wsClient.ws ? this.wsClient.ws : null;
        if (this.wsClient && ws && ws.readyState === WebSocket.OPEN) {
            if (typeof this.wsClient.leaveRoom === 'function') {
                this.wsClient.sendMessage('leave_room', { reason: 'user_leave' });
            } else if (typeof this.wsClient.sendMessage === 'function') {
                this.wsClient.sendMessage('leave_room', { reason: 'user_leave' });
            }
        } else {
            // 如果连接已断开，直接清理
            if (this.wsClient) {
                this.wsClient.disconnect(1000, 'User left room');
                this.wsClient = null;
            }
            if (!shouldRedirect) {
                finalizeLeaveToSelection();
            }
        }

        // 仅离开房间：不需要断开socket，清空wsClient的roomCode，避免后续消息携带旧房间号
        if (this.wsClient) {
            this.wsClient.roomCode = null;
            this.wsClient.isHost = false;
        }

        // 清理localStorage中的准备状态（在清理本地状态之前）
        if (this.roomCode && this.currentPlayer) {
            try {
                localStorage.removeItem(`ready_${this.roomCode}_${this.currentPlayer.id}`);
                console.log('准备状态已从localStorage清理');
            } catch (error) {
                console.warn('清理localStorage准备状态失败:', error);
            }
        }

        // 立即清理本地状态
        this.isHost = false;
        this.currentPlayer = null;
        this.currentRoom = null;
        this.roomCode = null;
        this.players.clear();
        this.playerColor = null;
        this.playerNickname = '';
        this.playerEmoji = null;
        this.pieceCount = 4;
        this.aiPlayers.clear();
        this.aiDifficulties.clear();
        this._pendingAIOps = [];

        // 清理sessionStorage中的联机相关数据
        sessionStorage.removeItem('multiplayerRoomCode');
        sessionStorage.removeItem('multiplayerPlayerId');
        sessionStorage.removeItem('multiplayerPlayerNickname');
        sessionStorage.removeItem('multiplayerPlayerEmoji');
        sessionStorage.removeItem('multiplayerPlayerColor');
        sessionStorage.removeItem('multiplayerIsHost');
        sessionStorage.removeItem('multiplayerCurrentRoom');

        // 清理localStorage中的联机相关数据
        localStorage.removeItem('multiplayerSettings');
        localStorage.removeItem('lastMultiplayerConfig');

        console.log('本地状态和缓存已清理');

        // 清理联机配置页面的color-circle中的表情残留
        this.clearMultiplayerColorCircles();

        // 离开房间后统一回到房间选择界面，避免页面跳转导致URL/状态不同步
        // 如需回到主菜单，应通过 _exitToMainMenuAfterLeave + destroy() 走既有逻辑
        finalizeLeaveToSelection();
    }

    // 清理联机配置页面的color-circle中的表情残留
    clearMultiplayerColorCircles() {
        // 清理sessionStorage中的人机模式相关配置
        sessionStorage.removeItem('lastAIConfig');
        sessionStorage.removeItem('gameConfig');

        // 清理联机配置页面的color-circle，同时清理全局状态防止混乱
        const onlineConfig = document.getElementById('onlineMultiplayerConfig');
        if (onlineConfig) {
            const colorOptions = onlineConfig.querySelectorAll('.color-option');
            colorOptions.forEach(option => {
                const circle = option.querySelector('.color-circle');
                const addBtn = option.querySelector('.add-player-btn');
                const playerNickname = option.querySelector('.player-nickname');

                if (circle) {
                    // 移除选中状态
                    circle.classList.remove('selected');
                    option.classList.remove('selected');

                    // 清除表情元素
                    const existingEmoji = circle.querySelector('.multiplayer-emoji');
                    if (existingEmoji) {
                        existingEmoji.remove();
                    }

                    // 清除AI相关属性
                    option.removeAttribute('data-ai-occupied');
                    option.removeAttribute('data-ai-difficulty');

                    // 重置样式
                    option.style.pointerEvents = 'auto';
                    option.style.opacity = '1';
                }

                // 重置按钮和昵称显示
                if (addBtn) {
                    addBtn.style.display = 'block';
                }
                if (playerNickname) {
                    playerNickname.style.display = 'none';
                    playerNickname.textContent = '';
                }
            });
        }

        // 清理人机模式的AI配置面板状态残留
        const aiConfigPanel = document.getElementById('aiConfigPanel');
        if (aiConfigPanel) {
            const aiColorOptions = aiConfigPanel.querySelectorAll('.color-option');
            aiColorOptions.forEach(option => {
                const circle = option.querySelector('.color-circle');
                if (circle) {
                    // 清除多人联机模式可能留下的表情元素
                    const existingEmoji = circle.querySelector('.multiplayer-emoji');
                    if (existingEmoji) {
                        existingEmoji.remove();
                    }
                }

                // 清除AI相关属性
                option.removeAttribute('data-ai-occupied');
                option.removeAttribute('data-ai-difficulty');

                // 重置样式
                option.style.pointerEvents = 'auto';
                option.style.opacity = '1';

                // 清理昵称显示
                const playerNickname = option.querySelector('.player-nickname');
                if (playerNickname) {
                    playerNickname.style.display = 'none';
                    playerNickname.textContent = '';
                }
            });
        }

        // 重置多人联机模式的内部状态
        this.aiPlayers.clear();
        this.aiDifficulties.clear();
        this.currentRoom = null;
        this.isHost = false;
        this.playerColor = null;
        this.playerNickname = '';
        this.playerEmoji = null;
        this.pieceCount = 4;

        // 清理AI玩家显示
        const botPlayersContainer = document.getElementById('multiplayerBotPlayers');
        if (botPlayersContainer) {
            botPlayersContainer.innerHTML = '';
        }

        // 重置房主设置显示
        const hostSettings = document.getElementById('hostSettings');
        if (hostSettings) {
            hostSettings.style.display = 'none';
        }

        // 隐藏当前玩家设置面板
        this.hideCurrentPlayerSettings();

        // 恢复保存的昵称（不清空，而是从缓存恢复）
        const nicknameInput = document.getElementById('multiplayerPlayerUsername');
        if (nicknameInput) {
            // 优先从缓存恢复昵称
            if (window.playerIdManager) {
                const savedNickname = window.playerIdManager.getSavedNickname();
                if (savedNickname) {
                    nicknameInput.value = savedNickname;
                    console.log('[leaveRoom] 已恢复保存的昵称:', savedNickname);
                } else {
                    nicknameInput.value = '';
                }
            } else {
                nicknameInput.value = '';
            }
            nicknameInput.placeholder = '输入昵称';
        }
    }

    // 显示主菜单
    showMainMenu() {
        const mainMenuContainer = document.getElementById('mainMenuContainer');
        const playerConfigWrapper = document.getElementById('playerConfigWrapper');
        const rulesPanelWrapper = document.getElementById('rulesPanelWrapper');
        const onlineMultiplayerConfig = document.getElementById('onlineMultiplayerConfig');

        if (mainMenuContainer) {
            mainMenuContainer.style.display = 'flex';
        }
        if (playerConfigWrapper) {
            playerConfigWrapper.style.display = 'none';
        }
        if (rulesPanelWrapper) {
            rulesPanelWrapper.style.display = 'none';
        }
        if (onlineMultiplayerConfig) {
            onlineMultiplayerConfig.style.display = 'none';
        }
        this.updateRoomChatVisibility(false);
    }

    // 显示错误信息
    showError(message) {
        console.error('显示错误信息:', message);
        // 可以在这里添加更好的错误显示UI
        alert(message);
    }

    // 清理资源
    destroy() {
        this.isDestroyed = true;
        this.isLeavingRoom = true; // 标记正在离开，避免重连
        this.updateRoomChatVisibility(false);

        this.disableRoomBackGuard();

        // 清理离线倒计时
        if (this.offlineCountdowns && this.offlineCountdowns.size) {
            for (const [playerId, entry] of this.offlineCountdowns.entries()) {
                if (entry && entry.intervalId) {
                    clearInterval(entry.intervalId);
                }
                this.removeOfflineOverlayForPlayer(playerId);
            }
            this.offlineCountdowns.clear();
        }

        // 清理事件监听器
        if (this.eventHandler) {
            document.removeEventListener('click', this.eventHandler);
            this.eventHandler = null;
        }

        if (this.visibilityHandler) {
            document.removeEventListener('visibilitychange', this.visibilityHandler);
            this.visibilityHandler = null;
        }

        // 清理准备按钮事件监听器
        if (this.playerReadyHandler) {
            const playerReadyBtn = document.getElementById('playerReadyBtn');
            if (playerReadyBtn) {
                playerReadyBtn.removeEventListener('click', this.playerReadyHandler);
            }
            this.playerReadyHandler = null;
        }

        if (this.roomChatToggleHandler) {
            const toggleBtn = document.getElementById('roomChatToggleBtn');
            if (toggleBtn) {
                toggleBtn.removeEventListener('click', this.roomChatToggleHandler);
            }
            this.roomChatToggleHandler = null;
        }
        if (this.roomChatSendHandler) {
            const sendBtn = document.getElementById('roomChatSendBtn');
            if (sendBtn) {
                sendBtn.removeEventListener('click', this.roomChatSendHandler);
            }
            this.roomChatSendHandler = null;
        }
        if (this.roomChatInputEnterHandler) {
            const chatInput = document.getElementById('roomChatInput');
            if (chatInput) {
                chatInput.removeEventListener('keydown', this.roomChatInputEnterHandler);
            }
            this.roomChatInputEnterHandler = null;
        }

        // 清理连接监控定时器
        if (this.connectionMonitorInterval) {
            clearInterval(this.connectionMonitorInterval);
            this.connectionMonitorInterval = null;
        }

        // 清理创建房间超时定时器
        if (this.createRoomTimeout) {
            clearTimeout(this.createRoomTimeout);
            this.createRoomTimeout = null;
        }

        // 清理WebSocket连接
        if (this.wsClient) {
            this.wsClient.disconnect(1000, 'Manager destroyed'); // 正常关闭
            this.wsClient = null;
        }

        // 清理所有本地状态
        this.isHost = false;
        this.currentPlayer = null;
        this.currentRoom = null;
        this.roomCode = null;
        this.players.clear();
        this.playerColor = null;
        this.playerNickname = '';
        this.playerEmoji = null;
        this.pieceCount = 4;
        this.aiPlayers.clear();
        this.aiDifficulties.clear();
        this.roomChatMessages = [];

        // 清理所有缓存数据
        sessionStorage.removeItem('multiplayerRoomCode');
        sessionStorage.removeItem('multiplayerPlayerId');
        sessionStorage.removeItem('multiplayerPlayerNickname');
        sessionStorage.removeItem('multiplayerPlayerEmoji');
        sessionStorage.removeItem('multiplayerPlayerColor');
        sessionStorage.removeItem('multiplayerIsHost');
        sessionStorage.removeItem('multiplayerCurrentRoom');
        localStorage.removeItem('multiplayerSettings');
        localStorage.removeItem('lastMultiplayerConfig');

        console.log('MultiplayerManager已完全销毁，所有状态和缓存已清理');
    }
}

// 导出类
export { MultiplayerManager };
window.MultiplayerManager = MultiplayerManager;
