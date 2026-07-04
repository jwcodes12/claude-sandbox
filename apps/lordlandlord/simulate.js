import { generateDeck, CARD_TYPES, PROPERTIES } from './src/js/cards.js';
// Step 8: the engine singleton is gone — this sim owns its state object and
// binds the old helper names to the state-first API.
import {
    initGameStateS, startTurnS, endTurnS,
    playCardToZoneS, executeActionS, proposeActionS, reactJustSayNoS,
    resolvePendingActionS, checkWinnerS, calculateRentS
} from './src/js/engine.js';
import { enumerateLegalActions as enumerateLegalActionsState } from './src/js/core/legal.js';
import { createRng } from './src/js/core/rng.js';

const gameState = {};
const initGameState = (cards, playerCount = 2, seed = 1, rngState = null) =>
    initGameStateS(gameState, cards, playerCount, seed, rngState);
const startTurn = (pid) => startTurnS(gameState, pid);
const endTurn = () => endTurnS(gameState);
const playCardToZone = (card, zone, pid, options = {}) => playCardToZoneS(gameState, card, zone, pid, options);
const executeAction = (card, pid, tid, options = {}) => executeActionS(gameState, card, pid, tid, options);
const proposeAction = (card, pid, tid, options = {}) => proposeActionS(gameState, card, pid, tid, options);
const reactJustSayNo = (noCard, pid, against = null) => reactJustSayNoS(gameState, noCard, pid, against);
const resolvePendingAction = (concedingId = null) => resolvePendingActionS(gameState, concedingId);
const checkWinner = () => checkWinnerS(gameState);
const enumerateLegalActions = (pid) => enumerateLegalActionsState(gameState, pid);
const calculateRent = (pid, color) => calculateRentS(gameState, pid, color);
import fs from 'fs';

const LOG_FILE = 'sim_logs.jsonl';

function logResult(gameId, winner, turns, actionHistory) {
    const log = { gameId, winner, turns, actionCount: actionHistory.length };
    fs.appendFileSync(LOG_FILE, JSON.stringify(log) + '\n');
}

function chooseActionRandom(actions) {
    return actions[Math.floor(Math.random() * actions.length)];
}

function chooseActionGreedy(actions, playerId) {
    const player = gameState.players[playerId];
    const scored = actions.map(action => {
        let score = 0;
        let card = null;
        if (action.cardId) {
            card = player.hand.find(c => c.data.id === action.cardId) || 
                   gameState.players[otherId(playerId)].properties[action.options?.color]?.find(c => c.data.id === action.options?.targetCardId);
        }

        if (action.type === 'play' && action.zone === 'board') score = 100;
        if (action.type === 'propose') {
            const effect = card?.data?.effect;
            if (effect === 'deal_breaker') score = 200;
            if (effect === 'sly_deal') score = 150;
            if (effect === 'collect_rent') score = 120;
            if (effect === 'birthday' || effect === 'debt_collector') score = 110;
        }
        if (action.type === 'play' && action.zone === 'bank') score = 50;
        if (action.type === 'react-no') score = 500;
        if (action.type === 'concede') score = 1;
        if (action.type === 'end-turn') score = 0;
        return { action, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].action;
}

function chooseActionModel(actions, playerId) {
    const player = gameState.players[playerId];
    const oppId = otherId(playerId);
    const opp = gameState.players[oppId];

    const logs = [];
    const scored = actions.map(action => {
        let score = 0;
        let reasoning = "";
        let card = null;
        if (action.cardId) {
            card = player.hand.find(c => c.data.id === action.cardId);
        }

        if (action.type === 'play' && action.zone === 'board') {
            const color = action.options.color;
            const count = player.properties[color]?.length || 0;
            const target = PROPERTIES[color].count;
            if (count + 1 === target) {
                score = 300; reasoning = `Completing ${color} set!`;
            } else {
                score = 100; reasoning = `Advancing ${color} set.`;
            }
        } else if (action.type === 'propose') {
            const effect = card?.data?.effect;
            if (effect === 'deal_breaker') {
                score = 400; reasoning = "Seizing a full set!";
            } else if (effect === 'sly_deal') {
                score = 150; reasoning = "Snatching a territory.";
            } else if (card?.data?.type === CARD_TYPES.RENT) {
                const rentVal = calculateRent(playerId, action.options.color);
                score = 100 + rentVal; reasoning = `Collecting ${rentVal} Gold tribute.`;
            }
        } else if (action.type === 'react-no') {
            score = 1000; reasoning = "Defending the crown!";
        } else if (action.type === 'play' && action.zone === 'bank') {
            score = 50; reasoning = "Storing Gold in the Treasury.";
        } else if (action.type === 'end-turn') {
            score = 10; reasoning = "Ending my reign for now.";
        }

        return { action, score, reasoning };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    return { ...best.action, reasoning: best.reasoning };
}

function otherId(id) { return id === 0 ? 1 : 0; }

function runGame(gameId, strategies) {
    const playerCount = strategies.length;
    const deck = generateDeck(1, createRng(1000 + gameId)).map(data => ({ data, zone: 'deck', owner: null }));
    initGameState(deck, playerCount, 1000 + gameId);
    startTurn(0);

    let turns = 0;
    const actionHistory = [];
    const maxActions = 2000; 

    while (checkWinner() === null && actionHistory.length < maxActions) {
        const currentPlayerId = gameState.reactionTargetId !== null ? gameState.reactionTargetId : gameState.turn;
        const strategy = strategies[currentPlayerId];
        
        const actions = enumerateLegalActions(currentPlayerId);
        if (actions.length === 0) break;

        const action = strategy(actions, currentPlayerId);
        actionHistory.push({ playerId: currentPlayerId, action, reasoning: action.reasoning });

        // Apply action
        if (action.type === 'end-turn') {
            const success = endTurn();
            if (success) turns++;
        } else if (action.type === 'play') {
            const card = gameState.players[currentPlayerId].hand.find(c => c.data.id === action.cardId);
            if (!card) {
                console.error(`ERROR: Card ${action.cardId} not found in player ${currentPlayerId} hand!`);
                break;
            }
            playCardToZone(card, action.zone, currentPlayerId, action.options);
            if (action.zone === 'discard') {
                // For simulation, pick a target player for tribute if not specified
                const targetPlayerId = action.targetPlayerId !== undefined ? action.targetPlayerId : otherId(currentPlayerId);
                executeAction(card, currentPlayerId, targetPlayerId, action.options);
            } else {
                gameState.actionsLeft--;
            }
        } else if (action.type === 'propose') {
            const card = gameState.players[currentPlayerId].hand.find(c => c.data.id === action.cardId);
            if (!card) break;
            const targetPlayerId = action.targetPlayerId !== undefined ? action.targetPlayerId : otherId(currentPlayerId);
            const options = { ...action.options };
            if (options.targetCardId) {
                const targetP = gameState.players[targetPlayerId];
                options.targetCard = Object.values(targetP.properties).flat().find(c => c.data.id === options.targetCardId);
            }
            proposeAction(card, currentPlayerId, targetPlayerId, options);
        } else if (action.type === 'react-no') {
            const card = gameState.players[currentPlayerId].hand.find(c => c.data.id === action.cardId);
            reactJustSayNo(card, currentPlayerId);
        } else if (action.type === 'concede') {
            resolvePendingAction();
        } else if (action.type === 'discard') {
            const card = gameState.players[currentPlayerId].hand.find(c => c.data.id === action.cardId);
            playCardToZone(card, 'discard', currentPlayerId);
            gameState.mustDiscard--;
        }
    }

    const winner = checkWinner();
    logResult(gameId, winner, turns, actionHistory);
    return winner;
}

const numGames = parseInt(process.argv[2]) || 1;
const playerCount = parseInt(process.argv[3]) || 5;

console.log(`Running ${numGames} games with ${playerCount} players...`);
const strats = Array(playerCount).fill(chooseActionGreedy);

for (let i = 0; i < numGames; i++) {
    runGame(i, strats);
}
console.log('Done.');
