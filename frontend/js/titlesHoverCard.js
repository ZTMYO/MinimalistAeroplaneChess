import { gameState } from './gameState.js';
import { titleManager } from './titleManager.js';

const CARD_GAP = 10;
const EDGE_GAP = 8;
const MIN_WIDTH = 168;
const MIN_HEIGHT = 72;
const TREND_PAD = 5;

let card = null;
let hoveredAvatar = null;

function playerOf(avatar) {
    const matched = String(avatar.className).match(/player-(\d)-avatar/);
    return matched ? Number(matched[1]) : null;
}

function cssColor(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function trendPoints(player) {
    const history = Array.isArray(gameState.progressHistory) ? gameState.progressHistory : [];
    return history
        .map((snapshot) => snapshot?.players?.[player])
        .filter((value) => typeof value === 'number' && Number.isFinite(value));
}

function profileHtml(player) {
    if (!gameState.getIsOnlineMultiplayer || !gameState.getIsOnlineMultiplayer()) return '';

    const profiles = gameState.playerProfiles
        || (window.multiplayerGameManager && window.multiplayerGameManager.playerProfiles);
    const profile = profiles && profiles[player];
    const isAI = profile ? profile.isAI : Boolean(gameState.isBotPlayer && gameState.isBotPlayer(player));
    if (isAI) return '';
    const seated = gameState.getPlayerChess ? gameState.getPlayerChess()[player] : null;
    if (!profile && !seated) return '';

    const stats = profile && profile.stats;
    const total = stats && Number(stats.games) > 0 ? Number(stats.games) : 0;
    const wins = total ? Math.min(total, Number(stats.wins) || 0) : 0;
    const rate = total ? `${Math.round((wins / total) * 100)}%` : '—';
    const titles = stats && Number(stats.titles) > 0 ? Math.floor(Number(stats.titles)) : 0;

    return '<div class="titles-hover-body player-profile-stats">'
        + `<span class="player-profile-item"><em>总局数</em><b>${total || '—'}</b></span>`
        + `<span class="player-profile-item"><em>胜率</em><b>${rate}</b></span>`
        + `<span class="player-profile-item"><em>称号数</em><b>${titles || '—'}</b></span>`
        + '</div>';
}

function cardHtml(player) {
    const titles = titleManager.currentTitles(player, gameState);
    const body = titles.length
        ? titles.map((title) => `<span class="title-chip tier-${title.tier}">${title.name}</span>`).join('')
        : '<span class="titles-hover-empty">暂无称号</span>';

    return profileHtml(player)
        + '<div class="titles-hover-head">本局完成度</div>'
        + '<canvas class="titles-hover-trend"></canvas>'
        + '<div class="titles-hover-head">本局称号</div>'
        + `<div class="titles-hover-body">${body}</div>`;
}

function drawTrend(player, canvas) {
    let points = trendPoints(player);
    // 还没攒到两个快照就先画一条平的，别让图区空着
    if (points.length === 0) points = [0, 0];
    else if (points.length === 1) points = [points[0], points[0]];

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const yOf = (value) => TREND_PAD + (height - TREND_PAD * 2) * (1 - Math.max(0, Math.min(100, value)) / 100);
    // 两端各留出端点的半径，否则最后一个点会被画布裁掉一半
    const inset = 3;
    const stepX = (width - inset * 2) / (points.length - 1);
    const color = cssColor(`--player-${player}-color`, '#888888');

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach((value, index) => {
        const x = inset + index * stepX;
        const y = yOf(value);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(inset + (points.length - 1) * stepX, yOf(points[points.length - 1]), 2.2, 0, Math.PI * 2);
    ctx.fill();
}

function placeCard(avatar) {
    const rect = avatar.getBoundingClientRect();
    const size = card.getBoundingClientRect();
    let top = rect.bottom + CARD_GAP;
    if (top + size.height > window.innerHeight - EDGE_GAP) {
        const above = rect.top - size.height - CARD_GAP;
        top = above >= EDGE_GAP ? above : Math.max(EDGE_GAP, window.innerHeight - size.height - EDGE_GAP);
    }
    let left = rect.left + rect.width / 2 - size.width / 2;
    left = Math.min(Math.max(EDGE_GAP, left), window.innerWidth - size.width - EDGE_GAP);
    card.style.top = `${Math.round(top)}px`;
    card.style.left = `${Math.round(left)}px`;
}

function hideCard() {
    hoveredAvatar = null;
    if (card) card.style.display = 'none';
}

function showCard(avatar) {
    const player = playerOf(avatar);
    if (!player) return;
    if (!card) {
        card = document.createElement('div');
        card.className = 'titles-hover-card';
        document.body.appendChild(card);
    }
    hoveredAvatar = avatar;
    card.innerHTML = cardHtml(player);
    card.style.display = 'block';
    placeCard(avatar);
    const trend = card.querySelector('.titles-hover-trend');
    if (trend) drawTrend(player, trend);
}

// 别处（对局信息面板）滚动不该收卡：只把卡片跟着头像重新摆一次，头像真出屏了才收
function repositionCard() {
    if (!card || !hoveredAvatar || card.style.display === 'none') return;
    const rect = hoveredAvatar.getBoundingClientRect();
    if ((!rect.width && !rect.height) || rect.bottom < 0 || rect.top > window.innerHeight) {
        hideCard();
        return;
    }
    placeCard(hoveredAvatar);
}

/** 给场上所有玩家头像挂上称号悬浮卡 */
export function initTitlesHoverCards() {
    document.querySelectorAll('.player-avatar').forEach((avatar) => {
        if (avatar.dataset.titlesHover) return;
        if (!playerOf(avatar)) return;
        avatar.dataset.titlesHover = '1';
        avatar.addEventListener('mouseenter', () => showCard(avatar));
        avatar.addEventListener('mouseleave', hideCard);
    });
}

window.addEventListener('scroll', repositionCard, true);
window.addEventListener('resize', repositionCard);

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTitlesHoverCards);
} else {
    initTitlesHoverCards();
}
