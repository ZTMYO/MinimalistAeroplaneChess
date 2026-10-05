/**
 * 统计数据页：名字取自联机模式保存的昵称，其余全部来自本机战绩档案（statsStore）。
 * 称号全表来自 titleManager 的静态定义——没获得的标灰、获得的显示局数。
 */
import { titleManager } from './titleManager.js';
import { playerIdManager } from './playerIdManager.js';
import { listGames, modeStats } from './statsStore.js';
import { readRecentReplay, replayFileName, importReplayFile } from './replayShare.js';
import { decodeArchive } from '../../shared/replayCodec.mjs';
import { emojis } from '../assets/emojis.js';
import { playerNameManager } from './playerNameManager.js';
import SettlementModal from './settlementModal.js';

const MODE_TEXT = { ai: '人机', local: '本地', online: '联机' };

const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (!total) return '—';
    const secondsPart = String(total % 60).padStart(2, '0');
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}:${secondsPart}`;
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${secondsPart}`;
}

/** 大数转小：1000 起走 K，百万起走 M（1234 → 1.2K，123456 → 123K，1234567 → 1.2M） */
function formatCount(value) {
    const num = Number(value) || 0;
    if (num < 1000) return String(num);
    const scale = (num, unit) => {
        const scaled = num / (unit === 'K' ? 1000 : 1000000);
        const text = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, '');
        return text + unit;
    };
    return num < 1000000 ? scale(num, 'K') : scale(num, 'M');
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
}

/* 称号全表：进阶（多档家族）/ 单独 / 结算，顺序与称号一览一致 */
function titleGroups() {
    const chains = [];
    const solos = [];
    titleManager.FAMILIES.forEach((family) => {
        if (family.levels.length > 1) {
            family.levels.forEach((level) => chains.push({ ...level, source: family }));
        } else {
            solos.push({ ...family.levels[0], source: family });
        }
    });
    const settled = [...Object.values(titleManager.UNIQUE_TITLES), ...Object.values(titleManager.FINAL_TITLES)];
    return [
        { title: '进阶称号', note: '同一件事按数值升级', items: chains },
        { title: '单独称号', note: '对局中达成即得', items: solos },
        { title: '结算称号', note: '收官后按全场比较定论', items: settled }
    ];
}

const titleLookup = new Map();
titleGroups().forEach((group) => group.items.forEach((item) => titleLookup.set(item.id, item)));
const titleTotal = titleLookup.size;

function modeTagTexts(source) {
    const tags = [];
    if (source?.happyOnly) tags.push('欢乐模式');
    if (source?.itemOnly) tags.push('道具模式');
    if (source?.happyDisabled) tags.push('非欢乐模式');
    return tags;
}

function chipHtml(title, { locked = false } = {}) {
    const name = escapeHtml(title?.name || '');
    const tier = escapeHtml(title?.tier || 'common');
    return `<span class="title-chip tier-${tier}${locked ? ' is-locked' : ''}">${name}</span>`;
}

function renderHeader() {
    const playerId = String(playerIdManager.getPlayerId() || '');
    $('statsPlayerName').textContent = playerIdManager.getSavedNickname() || playerId.replace(/^player_/, '玩家_') || '玩家';
}

/** 总览与今日共用同一套格子：顺序、标签、格式都只此一份 */
function statTiles({ games, wins, seconds, kills, distance }) {
    return [
        ['总局数', formatCount(games)],
        ['胜场', formatCount(wins)],
        ['胜率', games ? `${Math.round((wins / games) * 100)}%` : '—'],
        ['总时长', formatDuration(seconds)],
        ['总击败', formatCount(kills)],
        ['总前进', `${formatCount(distance)} 格`]
    ];
}

function tilesHtml(tiles) {
    return tiles
        .map(([label, value]) => `<div class="stats-tile"><em>${label}</em><b>${escapeHtml(value)}</b></div>`)
        .join('');
}

function renderTotals(bucket) {
    $('statsTotals').innerHTML = tilesHtml(statTiles(bucket.totals));
}

/* 今日：直接从对局列表里挑出今天的（列表封顶 100 局，一天打不到那么多） */
function renderToday(mode) {
    const today = new Date().toDateString();
    const games = listGames(mode).filter((game) => new Date(game.at).toDateString() === today);
    const finished = games.filter((game) => game.finished);

    const sum = (key) => games.reduce((total, game) => total + (Number(game[key]) || 0), 0);
    $('statsToday').innerHTML = tilesHtml(statTiles({
        games: finished.length,
        wins: finished.filter((game) => game.won).length,
        seconds: sum('seconds'),
        kills: sum('kills'),
        distance: sum('distance')
    }));
}

function renderTitles(bucket) {
    const counts = bucket.titles || {};
    const earned = Object.keys(counts).length;
    $('statsTitleSummary').textContent = `已获得 ${earned} / ${titleTotal}`;

    // 网格排布：左边 chip、右边局数；未获得的整格压灰、写「未获得」，说明挂在 hover 上
    $('statsTitles').innerHTML = titleGroups().map((group) => {
        const cells = group.items.map((title) => {
            const record = counts[title.id];
            const count = record ? record.count : 0;
            const locked = !count;
            const tier = escapeHtml(title.tier || 'common');
            const desc = [title.desc, title.note || title.source?.note, ...modeTagTexts(title.source)]
                .filter(Boolean).join('｜');
            return `<div class="stats-title-item${locked ? ' is-locked' : ''}" title="${escapeHtml(desc)}">
                        <span class="title-chip tier-${tier}${locked ? ' is-locked' : ''}">${escapeHtml(title.name)}</span>
                        <span class="stats-title-times">${locked ? '未获得' : `${formatCount(count)} 局`}</span>
                    </div>`;
        }).join('');
        return `<section class="stats-title-group">
                    <h3>${escapeHtml(group.title)}<em>${escapeHtml(group.note)}</em></h3>
                    <div class="stats-title-grid">${cells}</div>
                </section>`;
    }).join('');
}

const REPLAY_ICON = '<svg viewBox="0 0 1024 1024" width="16" height="16"><path d="M683.712 549.952L468.928 721.92a40.448 40.448 0 0 1-65.728-31.616v-343.68a40.448 40.448 0 0 1 65.728-31.616l214.784 171.904a40.448 40.448 0 0 1 0 63.104z" fill="currentColor"></path><path d="M512 27.456A484.544 484.544 0 1 1 27.456 512 36.544 36.544 0 1 1 100.48 512a411.456 411.456 0 1 0 123.328-293.696 36.544 36.544 0 1 1-51.2-52.224A483.008 483.008 0 0 1 512 27.52z" fill="currentColor"></path><path d="M138.176 23.744c20.16 0 36.928 14.912 39.744 34.304L178.368 64v151.744h151.808c20.16 0 36.928 14.912 39.744 34.304L370.368 256a40.256 40.256 0 0 1-34.24 39.808l-5.952 0.448h-192a40.256 40.256 0 0 1-39.808-34.304L97.92 256V64c0-22.208 18.048-40.256 40.256-40.256z" fill="currentColor"></path></svg>';
const DOWNLOAD_ICON = '<svg viewBox="95 130 855 800" width="14" height="13" fill="currentColor"><path d="M896 672c-17.066667 0-32 14.933333-32 32v128c0 6.4-4.266667 10.666667-10.666667 10.666667H170.666667c-6.4 0-10.666667-4.266667-10.666667-10.666667v-128c0-17.066667-14.933333-32-32-32s-32 14.933333-32 32v128c0 40.533333 34.133333 74.666667 74.666667 74.666667h682.666666c40.533333 0 74.666667-34.133333 74.666667-74.666667v-128c0-17.066667-14.933333-32-32-32z"/><path d="M488.533333 727.466667c6.4 6.4 14.933333 8.533333 23.466667 8.533333s17.066667-2.133333 23.466667-8.533333l213.333333-213.333334c12.8-12.8 12.8-32 0-44.8-12.8-12.8-32-12.8-44.8 0l-157.866667 157.866667V170.666667c0-17.066667-14.933333-32-32-32s-34.133333 14.933333-34.133333 32v456.533333L322.133333 469.333333c-12.8-12.8-32-12.8-44.8 0-12.8 12.8-12.8 32 0 44.8l211.2 213.333334z"/></svg>';

function renderGames(mode) {
    const games = listGames(mode);
    $('statsGamesSummary').textContent = games.length ? `最近 ${games.length} 局` : '';
    const box = $('statsGames');
    if (!games.length) {
        box.innerHTML = '<p class="stats-empty">还没有战绩，先去打一局吧</p>';
        return;
    }

    box.innerHTML = games.map((game) => {
        const hasReplay = Boolean(game.replayId && readRecentReplay(game.replayId));
        // 名次直接用存档里的 rank（结算排序过的名次，不是座位顺序）
        const mySeat = (game.players || []).find((seat) => seat.seat === game.mySeat);
        const myRank = (mySeat && mySeat.rank) || 0;
        const rankBadge = myRank
            ? `<span class="stats-game-rank${myRank === 1 ? ' is-first' : ''}">第${myRank}名</span>`
            : '';
        const tags = [`${(game.players || []).length}人`, `${game.pieces}子`, game.kind]
            .map((text) => `<span class="recent-replay-tag">${escapeHtml(text)}</span>`)
            .join('');

        const actions = hasReplay
            ? `<button type="button" class="recent-replay-icon" data-open="${game.replayId}" title="查看回放">${REPLAY_ICON}</button>
               <button type="button" class="recent-replay-icon" data-download="${game.replayId}" title="下载回放">${DOWNLOAD_ICON}</button>`
            : '';

        return `<article class="stats-game-row" data-detail="${game.id}">
                    <div class="stats-game-head">
                        <div class="stats-game-tags">${rankBadge}${tags}</div>
                        <div class="stats-game-actions">${actions}</div>
                    </div>
                    <div class="stats-game-meta">${formatTime(game.at)} · ${formatCount(game.hands)} 手 · ${formatDuration(game.seconds)} · 完成度 ${game.progress}%</div>
                </article>`;
    }).join('');
}

/* 单局详情：卡片就用结算模态框那一套（翻转卡片 + 称号轮播），只把容器指到本页 */
const rankingCards = new SettlementModal();
rankingCards.modal = document.getElementById('statsDetailModal');
rankingCards.rankingsContainer = document.getElementById('statsDetailPlayers');
rankingCards.dataAnalysisContainer = document.getElementById('statsDetailAnalysis');

function openDetail(gameId) {
    const game = listGames().find((item) => item.id === gameId);
    if (!game) return;

    $('statsDetailTitle').textContent = `${MODE_TEXT[game.mode] || '对局'} · ${game.kind}`;
    $('statsDetailMeta').textContent = `${formatTime(game.at)}  ${formatCount(game.hands)} 手  ${formatDuration(game.seconds)}`;

    const seats = Array.isArray(game.players) ? game.players : [];
    seats.forEach((seat) => {
        playerNameManager.setPlayerName(seat.seat, seat.name || `玩家${seat.seat}`);
        const holder = document.getElementById(`player-${seat.seat}-emoji`);
        if (holder) holder.innerHTML = seat.emoji && emojis[seat.emoji] ? emojis[seat.emoji].svg : '';
    });

    rankingCards.renderRankings(seats.map((seat) => ({
        player: seat.seat,
        progress: seat.progress || 0,
        defeatCounts: seat.defeatCounts || {},
        finishedCount: seat.finished || 0,
        title: (seat.titles || []).map((id) => titleLookup.get(id)).filter(Boolean)
    })));
    rankingCards.triggerSequentialFlip();
    rankingCards.modal.classList.add('show');
}

function closeDetail() {
    rankingCards.hide();
}

function downloadReplay(id) {
    const stored = readRecentReplay(id);
    if (!stored) return;
    const blob = new Blob([JSON.stringify(stored)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = replayFileName(decodeArchive(stored));
    link.click();
    URL.revokeObjectURL(url);
}

function bindEvents() {
    const toggle = $('statsModeToggle');
    if (toggle) {
        toggle.addEventListener('click', (event) => {
            const button = event.target.closest('.stats-mode-btn');
            if (button && button.dataset.mode !== currentMode) setMode(button.dataset.mode);
        });
    }

    $('statsGames').addEventListener('click', (event) => {
        const action = event.target.closest('[data-open], [data-download]');
        if (action) {
            if (action.dataset.open) {
                window.location.href = `replay.html?recent=${encodeURIComponent(action.dataset.open)}`;
            } else if (action.dataset.download) {
                downloadReplay(action.dataset.download);
            }
            return;
        }

        // 点行看这一局的结算详情
        const row = event.target.closest('[data-detail]');
        if (row) openDetail(row.dataset.detail);
    });

    $('statsDetailClose').addEventListener('click', closeDetail);
    $('statsDetailModal').addEventListener('click', (event) => {
        if (event.target === $('statsDetailModal')) closeDetail();
    });

    const picker = $('statsReplayPicker');
    if (picker) {
        picker.addEventListener('change', async (event) => {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            try {
                window.location.href = await importReplayFile(file);
            } catch (error) {
                picker.value = '';
                window.alert(error.message);
            }
        });
    }
}

let currentMode = 'online';

function setMode(mode) {
    currentMode = mode === 'online' ? 'online' : 'ai';
    document.querySelectorAll('#statsModeToggle .stats-mode-btn').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.mode === currentMode);
    });
    render();
}

function render() {
    const bucket = modeStats(currentMode);
    renderHeader();
    renderTotals(bucket);
    renderToday(currentMode);
    renderGames(currentMode);
    renderTitles(bucket);
}

bindEvents();
setMode('online');
