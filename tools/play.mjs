#!/usr/bin/env node
/**
 * 命令行对局工具：直接读写 JSON 棋面，用来在不开浏览器、不开后端的情况下验证引擎。
 *
 *   node tools/play.mjs --new --out board.json
 *   node tools/play.mjs --in board.json --player 1 --action roll --dice 4
 *   node tools/play.mjs --in board.json --player 1 --action move:0
 *   node tools/play.mjs --in board.json --auto 200
 *   node tools/play.mjs --games 20 --seed 7
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { apply, createState, movableChess, cellOf } from '../shared/engine.mjs';

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            args._.push(token);
            continue;
        }
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) args[key] = true;
        else {
            args[key] = next;
            i += 1;
        }
    }
    return args;
}

function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function loadState(file) {
    return JSON.parse(readFileSync(file, 'utf8'));
}

function saveState(file, state) {
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function printEvents(events) {
    for (const event of events) {
        const extra = Object.entries(event)
            .filter(([key]) => !['type', 'player'].includes(key))
            .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
            .join(' ');
        console.log(`  ${event.type.padEnd(8)} p${event.player} ${extra}`);
    }
}

function printBoard(state) {
    console.log(
        `  轮次 ${state.turn} | 当前玩家 ${state.currentPlayer} | 阶段 ${state.phase} | 骰子 ${state.dice ?? '-'}`
    );
    for (const id of state.order) {
        const row = state.players[id].chesses
            .map((chess, index) => {
                const label = chess.finished ? 'HOME' : chess.pos === -1 ? 'BASE' : `rel${chess.pos}/cell${cellOf(Number(id), chess.pos)}`;
                return `#${index}:${label}`;
            })
            .join('  ');
        console.log(`  玩家${id} 败${state.players[id].defeats}  ${row}`);
    }
    if (state.winner !== null) console.log(`  胜者：玩家 ${state.winner}`);
}

function autoPlay(state, maxSteps, rng) {
    let steps = 0;
    let current = state;
    while (current.phase !== 'ended' && steps < maxSteps) {
        steps += 1;
        const player = current.currentPlayer;
        if (current.phase === 'rolling') {
            current = apply(current, player, { type: 'roll' }, rng).state;
            continue;
        }
        const movable = movableChess(current, player, current.dice);
        const pick = movable[Math.floor(rng() * movable.length)];
        current = apply(current, player, { type: 'move', chessIndex: pick }).state;
    }
    return { state: current, steps };
}

function runBatch(games, seed, maxSteps) {
    let ended = 0;
    for (let game = 0; game < games; game++) {
        const rng = makeRng(seed + game);
        const { state, steps } = autoPlay(createState(), maxSteps, rng);
        if (state.phase === 'ended') ended += 1;
        console.log(
            `第 ${String(game + 1).padStart(3)} 局  步数 ${String(steps).padStart(5)}  胜者 ${state.winner ?? '无'}`
        );
    }
    console.log(`\n${games} 局中 ${ended} 局正常分出胜负`);
    return ended === games ? 0 : 1;
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
        console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace('/**', '').trim());
        return 0;
    }

    if (args.games) {
        return runBatch(Number(args.games), Number(args.seed ?? 1), Number(args.max ?? 40000));
    }

    let state = args.new ? createState({ happy: Boolean(args.happy) }) : null;
    if (args.in) state = loadState(args.in);
    if (!state) {
        console.error('需要 --new 或 --in <file>');
        return 1;
    }

    if (args.auto) {
        const { state: next, steps } = autoPlay(state, Number(args.auto), makeRng(Number(args.seed ?? 1)));
        console.log(`自动走了 ${steps} 步`);
        printBoard(next);
        if (args.out) saveState(args.out, next);
        return 0;
    }

    const player = Number(args.player ?? state.currentPlayer);
    const action = String(args.action ?? '');

    if (!action) {
        printBoard(state);
        if (args.out) saveState(args.out, state);
        return 0;
    }

    let payload;
    if (action === 'roll') payload = { type: 'roll' };
    else if (action === 'skip') payload = { type: 'skip' };
    else if (action.startsWith('move:')) payload = { type: 'move', chessIndex: Number(action.slice(5)) };
    else {
        console.error(`无法识别的动作：${action}`);
        return 1;
    }
    if (args.dice) payload.value = Number(args.dice);

    const { state: next, events } = apply(state, player, payload, makeRng(Number(args.seed ?? 1)));
    printEvents(events);
    printBoard(next);
    if (args.out) saveState(args.out, next);
    return 0;
}

process.exitCode = main();
