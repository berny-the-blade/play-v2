// ============================================================
//  DOMINO PERNAMBUCANO — STRATEGIC SIMULATOR
//  Move-by-move reasoning, card counting, partner signaling,
//  sacrifice plays, and luck-vs-skill quantification
// ============================================================

// ========== DECK & UTILS ==========

function createDeck() {
  const deck = [];
  for (let i = 0; i <= 6; i++)
    for (let j = i; j <= 6; j++)
      deck.push({ left: i, right: j, id: `${i}-${j}` });
  return deck;
}

function shuffleDeck(deck) {
  const s = [...deck];
  for (let i = s.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [s[i], s[j]] = [s[j], s[i]];
  }
  return s;
}

function tileStr(t) { return `[${t.left}|${t.right}]`; }
function handStr(h) { return h.map(tileStr).join(' '); }
function teamOf(p) { return p % 2; }
function partnerOf(p) { return (p + 2) % 4; }
function isOpponent(me, other) { return teamOf(me) !== teamOf(other); }

// ========== KNOWLEDGE TRACKER ==========
// Tracks what each player CANNOT have (from passes) and what's been played

class Knowledge {
  constructor() {
    // For each player, track which numbers they definitely DON'T have
    this.cantHave = [new Set(), new Set(), new Set(), new Set()];
    // All tiles played so far
    this.played = new Set();
    // All tiles in the game (28 total, 4 in dorme)
    this.allTiles = createDeck();
    // Track plays per player for signaling analysis
    this.playsBy = [[], [], [], []];
    // Track passes per player
    this.passedOn = [[], [], [], []]; // [player] = [{leftEnd, rightEnd}]
  }

  recordPlay(player, tile) {
    this.played.add(tile.id);
    if (player >= 0 && player <= 3) this.playsBy[player].push(tile);
  }

  recordPass(player, leftEnd, rightEnd) {
    // Player passed = they have NO tile matching leftEnd or rightEnd
    this.cantHave[player].add(leftEnd);
    this.cantHave[player].add(rightEnd);
    this.passedOn[player].push({ leftEnd, rightEnd });
  }

  // Get tiles that COULD still be in a player's hand
  possibleTiles(player, knownHand) {
    const possible = [];
    for (const t of this.allTiles) {
      if (this.played.has(t.id)) continue;
      if (knownHand && knownHand.some(h => h.id === t.id)) continue;
      // Check if player can't have either number on this tile
      if (this.cantHave[player].has(t.left) && this.cantHave[player].has(t.right)) continue;
      // For doubles, if they can't have that number at all, exclude
      if (t.left === t.right && this.cantHave[player].has(t.left)) continue;
      possible.push(t);
    }
    return possible;
  }

  // Infer what suits a player is likely strong in (from their plays)
  inferStrength(player) {
    const suitPlayed = [0,0,0,0,0,0,0];
    for (const t of this.playsBy[player]) {
      suitPlayed[t.left]++;
      if (t.left !== t.right) suitPlayed[t.right]++;
    }
    return suitPlayed;
  }

  // What numbers are definitely NOT in a player's hand
  deadNumbers(player) {
    return [...this.cantHave[player]];
  }

  // How many unplayed tiles contain number N
  remainingWithNumber(n) {
    let count = 0;
    for (const t of this.allTiles) {
      if (this.played.has(t.id)) continue;
      if (t.left === n || t.right === n) count++;
    }
    return count;
  }
}

// ========== AI STRATEGIES ==========

// DUMB AI: plays highest-value tile (same as current game code)
function dumbAI(hand, leftEnd, rightEnd, boardLen, _player, _knowledge) {
  const playable = hand.filter(t => canPlay(t, leftEnd, rightEnd, boardLen));
  if (playable.length === 0) return null;

  let best = playable[0], bestScore = -1;
  for (const t of playable) {
    let score = t.left + t.right;
    if (t.left === t.right) score += 10;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return { tile: best, reason: `Highest value tile ${tileStr(best)} (score=${bestScore})` };
}

// SMART AI: uses card counting, partner awareness, suit control
function smartAI(hand, leftEnd, rightEnd, boardLen, player, knowledge) {
  const playable = hand.filter(t => canPlay(t, leftEnd, rightEnd, boardLen));
  if (playable.length === 0) return null;

  if (boardLen === 0) {
    // First play of round: lead with dominant suit
    return pickOpener(hand, playable, player, knowledge);
  }

  const scored = playable.map(tile => {
    let score = 0;
    const reasons = [];

    // Determine which side this tile plays on and what the new ends would be
    const sides = getPossibleSides(tile, leftEnd, rightEnd);

    for (const sideOption of sides) {
      let sideScore = 0;
      const sideReasons = [];
      const newLeft = sideOption.side === 'left' ? sideOption.newEnd : leftEnd;
      const newRight = sideOption.side === 'right' ? sideOption.newEnd : rightEnd;

      // 1. SUIT CONTROL: leave ends that I have many tiles for
      const myLeftCount = hand.filter(t => t.id !== tile.id && (t.left === newLeft || t.right === newLeft)).length;
      const myRightCount = hand.filter(t => t.id !== tile.id && (t.left === newRight || t.right === newRight)).length;
      sideScore += (myLeftCount + myRightCount) * 15;
      if (myLeftCount + myRightCount > 0) sideReasons.push(`I have ${myLeftCount + myRightCount} more tiles for ends ${newLeft}/${newRight}`);

      // 2. BLOCKING: leave ends that opponents can't play
      const partner = partnerOf(player);
      const opp1 = (player + 1) % 4;
      const opp2 = (player + 3) % 4;

      // Check if opponents are known to NOT have these numbers
      let oppBlocked = 0;
      if (knowledge.cantHave[opp1].has(newLeft) && knowledge.cantHave[opp1].has(newRight)) {
        oppBlocked++;
        sideReasons.push(`Opp ${opp1} blocked on ${newLeft}/${newRight}`);
      }
      if (knowledge.cantHave[opp2].has(newLeft) && knowledge.cantHave[opp2].has(newRight)) {
        oppBlocked++;
        sideReasons.push(`Opp ${opp2} blocked on ${newLeft}/${newRight}`);
      }
      sideScore += oppBlocked * 25;

      // 3. PARTNER SUPPORT: leave ends partner can likely play
      const partnerStrength = knowledge.inferStrength(partner);
      const partnerLeftAffinity = partnerStrength[newLeft] || 0;
      const partnerRightAffinity = partnerStrength[newRight] || 0;
      sideScore += (partnerLeftAffinity + partnerRightAffinity) * 8;
      if (partnerLeftAffinity + partnerRightAffinity > 0)
        sideReasons.push(`Partner played ${partnerLeftAffinity + partnerRightAffinity} tiles with ${newLeft}/${newRight}`);

      // Penalize leaving ends partner can't have
      if (knowledge.cantHave[partner].has(newLeft)) { sideScore -= 10; sideReasons.push(`Partner can't have ${newLeft}`); }
      if (knowledge.cantHave[partner].has(newRight)) { sideScore -= 10; sideReasons.push(`Partner can't have ${newRight}`); }

      // 4. DUMP HEAVY TILES early to avoid losing blocked games
      sideScore += (tile.left + tile.right) * 2;
      if (tile.left + tile.right >= 9) sideReasons.push(`Dump heavy tile (${tile.left + tile.right} pips)`);

      // 5. PLAY DOUBLES EARLY (they're inflexible, only one number)
      if (tile.left === tile.right) {
        sideScore += 12;
        sideReasons.push('Play double early (inflexible)');
      }

      // 6. PROTECT ISOLATED DOUBLES: if I have an isolated double, try to set up its number
      for (const h of hand) {
        if (h.id === tile.id) continue;
        if (h.left === h.right) {
          const dblNum = h.left;
          const support = hand.filter(x => x.id !== h.id && x.id !== tile.id && (x.left === dblNum || x.right === dblNum)).length;
          if (support === 0) {
            // I have an isolated double — does this play help set up its number?
            if (newLeft === dblNum || newRight === dblNum) {
              sideScore += 20;
              sideReasons.push(`Sets up isolated double ${tileStr(h)}`);
            }
          }
        }
      }

      // 7. SCARCITY: if few tiles remain with a number, don't leave it as an end (dead end)
      const leftRemaining = knowledge.remainingWithNumber(newLeft);
      const rightRemaining = knowledge.remainingWithNumber(newRight);
      if (leftRemaining <= 1) { sideScore -= 8; sideReasons.push(`Few tiles left with ${newLeft} (${leftRemaining})`); }
      if (rightRemaining <= 1) { sideScore -= 8; sideReasons.push(`Few tiles left with ${newRight} (${rightRemaining})`); }

      // 8. SACRIFICE FOR PARTNER: if partner is down to 1-2 tiles, prioritize their numbers
      // We estimate partner's hand size
      const partnerPlays = knowledge.playsBy[partner].length;
      const estPartnerHandSize = 6 - partnerPlays; // rough estimate
      if (estPartnerHandSize <= 2 && estPartnerHandSize > 0) {
        // Partner close to winning — make sure they can play
        if (!knowledge.cantHave[partner].has(newLeft) || !knowledge.cantHave[partner].has(newRight)) {
          sideScore += 15;
          sideReasons.push(`Partner close to winning (est. ${estPartnerHandSize} tiles)`);
        }
      }

      if (sideScore > score || sides.indexOf(sideOption) === 0) {
        score = Math.max(score, sideScore);
        if (sideScore >= score) {
          reasons.length = 0;
          reasons.push(...sideReasons);
        }
      }
    }

    return { tile, score, reasons, side: getBestSide(tile, leftEnd, rightEnd, hand, knowledge, player) };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  const reasonStr = best.reasons.length > 0 ? best.reasons.join('; ') : 'Default play';
  return { tile: best.tile, side: best.side, reason: `${tileStr(best.tile)} (score=${best.score}): ${reasonStr}` };
}

function pickOpener(hand, playable, player, knowledge) {
  // When opening (empty board), play from your strongest suit
  const suitCount = [0,0,0,0,0,0,0];
  for (const t of hand) {
    suitCount[t.left]++;
    if (t.left !== t.right) suitCount[t.right]++;
  }

  let best = playable[0], bestScore = -1;
  for (const t of playable) {
    let score = 0;
    // Prefer tiles from dominant suit
    score += suitCount[t.left] * 10 + suitCount[t.right] * 10;
    // Prefer doubles (signals strength and clears inflexible tile)
    if (t.left === t.right) score += 15;
    // Prefer higher value tiles
    score += (t.left + t.right) * 2;

    if (score > bestScore) { bestScore = score; best = t; }
  }

  return { tile: best, reason: `Open with ${tileStr(best)}: dominant suit signal (suit ${best.left}=${suitCount[best.left]}, suit ${best.right}=${suitCount[best.right]})` };
}

function canPlay(tile, leftEnd, rightEnd, boardLen) {
  if (boardLen === 0) return true;
  return tile.left === leftEnd || tile.right === leftEnd ||
         tile.left === rightEnd || tile.right === rightEnd;
}

function getPossibleSides(tile, leftEnd, rightEnd) {
  const sides = [];
  const canLeft = tile.left === leftEnd || tile.right === leftEnd;
  const canRight = tile.left === rightEnd || tile.right === rightEnd;

  if (canLeft) {
    const newEnd = tile.left === leftEnd ? tile.right : tile.left;
    sides.push({ side: 'left', newEnd });
  }
  if (canRight && leftEnd !== rightEnd) {
    const newEnd = tile.right === rightEnd ? tile.left : tile.right;
    sides.push({ side: 'right', newEnd });
  }
  if (sides.length === 0 && canRight) {
    const newEnd = tile.right === rightEnd ? tile.left : tile.right;
    sides.push({ side: 'right', newEnd });
  }
  return sides;
}

function getBestSide(tile, leftEnd, rightEnd, hand, knowledge, player) {
  const canLeft = tile.left === leftEnd || tile.right === leftEnd;
  const canRight = tile.left === rightEnd || tile.right === rightEnd;
  if (canLeft && !canRight) return 'left';
  if (canRight && !canLeft) return 'right';
  if (!canLeft && !canRight) return null;

  // Both sides possible — pick the side that leaves better ends for me/partner
  const newLeftIfPlayLeft = tile.left === leftEnd ? tile.right : tile.left;
  const newRightIfPlayRight = tile.right === rightEnd ? tile.left : tile.right;

  const remaining = hand.filter(t => t.id !== tile.id);
  const leftScore = remaining.filter(t => t.left === newLeftIfPlayLeft || t.right === newLeftIfPlayLeft).length;
  const rightScore = remaining.filter(t => t.left === newRightIfPlayRight || t.right === newRightIfPlayRight).length;

  // Also consider what partner can play
  const partner = partnerOf(player);
  const pStr = knowledge.inferStrength(partner);
  const partnerLeftPref = pStr[newLeftIfPlayLeft] || 0;
  const partnerRightPref = pStr[newRightIfPlayRight] || 0;

  if ((leftScore + partnerLeftPref) >= (rightScore + partnerRightPref)) return 'left';
  return 'right';
}

// ========== GAME ENGINE ==========

function placeTile(tile, side, board, leftEnd, rightEnd) {
  let placed = { ...tile };
  if (board.length === 0) {
    return { board: [tile], leftEnd: tile.left, rightEnd: tile.right };
  }
  const newBoard = [...board];
  let newLeft = leftEnd, newRight = rightEnd;

  if (side === 'left') {
    if (tile.left === leftEnd) placed = { ...tile, left: tile.right, right: tile.left };
    newBoard.unshift(placed);
    newLeft = placed.left;
  } else {
    if (tile.right === rightEnd) placed = { ...tile, left: tile.right, right: tile.left };
    newBoard.push(placed);
    newRight = placed.right;
  }
  return { board: newBoard, leftEnd: newLeft, rightEnd: newRight };
}

function couldPlayOnBothEnds(tile, left, right) {
  if (left === null || right === null) return false;
  if (left === right) return false;
  return (tile.left === left || tile.right === left) && (tile.left === right || tile.right === right);
}

function playRound(hands, startPlayer, aiPlayers, verbose = false) {
  const h = hands.map(hand => hand.map(t => ({ ...t })));
  let board = [], leftEnd = null, rightEnd = null;
  let currentPlayer = startPlayer, passCount = 0;
  let prevLeftEnd = null, prevRightEnd = null;
  const knowledge = new Knowledge();
  const log = [];
  let moveNum = 0;

  // Mark all 4 dorme tiles as "unknown" — they're the 4 tiles not dealt
  // Players know their own hand, that's it

  while (moveNum < 200) {
    moveNum++;
    const ai = aiPlayers[currentPlayer];
    const myHand = h[currentPlayer];
    const boardLen = board.length;

    const decision = ai(myHand, leftEnd, rightEnd, boardLen, currentPlayer, knowledge);

    if (decision) {
      passCount = 0;
      const { tile, side: preferredSide, reason } = decision;

      // Determine actual side
      let side = preferredSide || null;
      if (boardLen > 0 && !side) {
        const canLeft = tile.left === leftEnd || tile.right === leftEnd;
        const canRight = tile.left === rightEnd || tile.right === rightEnd;
        if (canLeft && !canRight) side = 'left';
        else if (canRight && !canLeft) side = 'right';
        else side = 'left';
      }

      // Remove from hand
      h[currentPlayer] = h[currentPlayer].filter(t => t.id !== tile.id);
      knowledge.recordPlay(currentPlayer, tile);

      // Place on board
      const prevLeft = leftEnd, prevRight = rightEnd;
      const result = placeTile(tile, side, board, leftEnd, rightEnd);
      board = result.board;
      leftEnd = result.leftEnd;
      rightEnd = result.rightEnd;

      const entry = {
        move: moveNum,
        player: currentPlayer,
        team: teamOf(currentPlayer),
        action: 'play',
        tile: tileStr(tile),
        side: side || 'first',
        reason: reason,
        boardEnds: `${leftEnd}<--board-->${rightEnd}`,
        handSize: h[currentPlayer].length,
        hand: verbose ? handStr(h[currentPlayer]) : undefined,
      };
      log.push(entry);

      if (verbose) {
        const teamLabel = teamOf(currentPlayer) === 0 ? 'T1' : 'T2';
        console.log(`  #${moveNum} P${currentPlayer}(${teamLabel}): plays ${tileStr(tile)} on ${side || 'first'} → ends [${leftEnd}|${rightEnd}] (${h[currentPlayer].length} left)`);
        console.log(`         WHY: ${reason}`);
      }

      // Check win
      if (h[currentPlayer].length === 0) {
        const isDouble = tile.left === tile.right;
        const wasBoth = couldPlayOnBothEnds(tile, prevLeft, prevRight);
        let pts, type;
        if (isDouble && wasBoth) { pts = 4; type = 'cruzada'; }
        else if (isDouble) { pts = 2; type = 'carroca'; }
        else if (wasBoth) { pts = 3; type = 'la-e-lo'; }
        else { pts = 1; type = 'normal'; }

        return { outcome: 'win', winner: currentPlayer, team: teamOf(currentPlayer), points: pts, type, log, board, hands: h };
      }

      prevLeftEnd = leftEnd;
      prevRightEnd = rightEnd;
      currentPlayer = (currentPlayer + 1) % 4;

    } else {
      // Pass
      passCount++;
      knowledge.recordPass(currentPlayer, leftEnd, rightEnd);

      const entry = {
        move: moveNum,
        player: currentPlayer,
        team: teamOf(currentPlayer),
        action: 'pass',
        reason: `No tiles matching ends ${leftEnd}/${rightEnd}`,
        boardEnds: `${leftEnd}<--board-->${rightEnd}`,
        handSize: h[currentPlayer].length,
      };
      log.push(entry);

      if (verbose) {
        const teamLabel = teamOf(currentPlayer) === 0 ? 'T1' : 'T2';
        console.log(`  #${moveNum} P${currentPlayer}(${teamLabel}): PASSES (no ${leftEnd} or ${rightEnd}) — now known: can't have {${knowledge.deadNumbers(currentPlayer).join(',')}}`);
      }

      if (passCount >= 4) {
        const hv = h.map((hand, idx) => ({
          player: idx, team: teamOf(idx),
          points: hand.reduce((s, t) => s + t.left + t.right, 0)
        }));
        const min = Math.min(...hv.map(v => v.points));
        const winners = hv.filter(v => v.points === min);

        if (winners.length > 1 && winners.some(w => w.team === 0) && winners.some(w => w.team === 1)) {
          return { outcome: 'tie', points: 0, log, board, hands: h, handValues: hv };
        }
        const winner = winners[0];
        return { outcome: 'blocked', winner: winner.player, team: winner.team, points: 1, log, board, hands: h, handValues: hv };
      }

      currentPlayer = (currentPlayer + 1) % 4;
    }
  }
  return { outcome: 'abort', log };
}

// ========== MATCH SIMULATOR ==========

function playMatch(aiTeam0, aiTeam1, verbose = false) {
  const scores = [0, 0];
  let roundNum = 0;
  let extraPoints = 0;
  let lastWinTeam = null;
  const matchLog = [];

  const aiPlayers = [aiTeam0, aiTeam1, aiTeam0, aiTeam1]; // 0,2=team0  1,3=team1

  while (scores[0] < 6 && scores[1] < 6 && roundNum < 50) {
    roundNum++;
    const deck = shuffleDeck(createDeck());
    const hands = [[], [], [], []];
    for (let i = 0; i < 24; i++) hands[i % 4].push(deck[i]);

    let startPlayer;
    if (roundNum === 1) {
      // Auto-play highest double
      let hd = -1, hp = 0, ht = null;
      for (let p = 0; p < 4; p++)
        for (const t of hands[p])
          if (t.left === t.right && t.left > hd) { hd = t.left; hp = p; ht = t; }

      if (verbose) {
        console.log(`\n===== ROUND ${roundNum} =====`);
        console.log(`  Hands dealt:`);
        for (let p = 0; p < 4; p++) console.log(`    P${p} (T${teamOf(p)+1}): ${handStr(hands[p])}`);
        console.log(`  P${hp} auto-plays ${tileStr(ht)} (highest double)`);
      }

      hands[hp] = hands[hp].filter(t => t.id !== ht.id);
      startPlayer = (hp + 1) % 4;

      // Pre-seed a small knowledge tracker isn't needed since playRound creates its own
      // But we need to pass initial board state... let's adjust
      // Actually, we simulate from the next player with the double already on board
      // We need to modify playRound to accept initial board state

      const result = playRoundWithBoard(hands, startPlayer, aiPlayers, [ht], ht.left, ht.right, verbose);
      const pts = (result.points || 0) + extraPoints;

      if (result.outcome === 'tie') {
        extraPoints++;
        matchLog.push({ round: roundNum, outcome: 'tie', extraPoints });
        if (verbose) console.log(`  ROUND TIE — extra points now: ${extraPoints}`);
        continue;
      }

      if (result.outcome === 'abort') break;

      const totalPts = result.points + extraPoints;
      scores[result.team] += totalPts;
      lastWinTeam = result.team;
      extraPoints = 0;

      matchLog.push({ round: roundNum, outcome: result.outcome, winner: result.winner, team: result.team, points: totalPts, type: result.type });
      if (verbose) {
        console.log(`  ROUND RESULT: P${result.winner} (T${result.team+1}) wins ${totalPts}pts (${result.type || result.outcome}) — Score: T1=${scores[0]} T2=${scores[1]}`);
      }

    } else {
      // Subsequent rounds: winning team picks (we pick randomly for now)
      if (lastWinTeam !== null) {
        const opts = lastWinTeam === 0 ? [0, 2] : [1, 3];
        startPlayer = opts[Math.floor(Math.random() * 2)];
      } else {
        startPlayer = 0;
      }

      if (verbose) {
        console.log(`\n===== ROUND ${roundNum} =====`);
        console.log(`  Hands dealt:`);
        for (let p = 0; p < 4; p++) console.log(`    P${p} (T${teamOf(p)+1}): ${handStr(hands[p])}`);
        console.log(`  P${startPlayer} (T${teamOf(startPlayer)+1}) starts (winning team choice)`);
      }

      const result = playRound(hands, startPlayer, aiPlayers, verbose);

      if (result.outcome === 'tie') {
        extraPoints++;
        matchLog.push({ round: roundNum, outcome: 'tie', extraPoints });
        if (verbose) console.log(`  ROUND TIE — extra points now: ${extraPoints}`);
        continue;
      }

      if (result.outcome === 'abort') break;

      const totalPts = result.points + extraPoints;
      scores[result.team] += totalPts;
      lastWinTeam = result.team;
      extraPoints = 0;

      matchLog.push({ round: roundNum, outcome: result.outcome, winner: result.winner, team: result.team, points: totalPts, type: result.type });
      if (verbose) {
        console.log(`  ROUND RESULT: P${result.winner} (T${result.team+1}) wins ${totalPts}pts (${result.type || result.outcome}) — Score: T1=${scores[0]} T2=${scores[1]}`);
      }
    }
  }

  const winner = scores[0] >= 6 ? 0 : scores[1] >= 6 ? 1 : -1;
  return { scores, winner, rounds: roundNum, log: matchLog };
}

// Play round with pre-set board (for first round auto-double)
function playRoundWithBoard(hands, startPlayer, aiPlayers, initBoard, initLeft, initRight, verbose) {
  const h = hands.map(hand => hand.map(t => ({ ...t })));
  let board = [...initBoard], leftEnd = initLeft, rightEnd = initRight;
  let currentPlayer = startPlayer, passCount = 0;
  let prevLeftEnd = leftEnd, prevRightEnd = rightEnd;
  const knowledge = new Knowledge();
  // Record the initial double as played
  for (const t of initBoard) knowledge.recordPlay(-1, t);
  let moveNum = 0;

  while (moveNum < 200) {
    moveNum++;
    const ai = aiPlayers[currentPlayer];
    const decision = ai(h[currentPlayer], leftEnd, rightEnd, board.length, currentPlayer, knowledge);

    if (decision) {
      passCount = 0;
      const { tile, side: preferredSide, reason } = decision;
      let side = preferredSide || null;
      if (!side) {
        const cL = tile.left === leftEnd || tile.right === leftEnd;
        const cR = tile.left === rightEnd || tile.right === rightEnd;
        if (cL && !cR) side = 'left';
        else if (cR && !cL) side = 'right';
        else side = 'left';
      }

      h[currentPlayer] = h[currentPlayer].filter(t => t.id !== tile.id);
      knowledge.recordPlay(currentPlayer, tile);

      const pL = leftEnd, pR = rightEnd;
      const r = placeTile(tile, side, board, leftEnd, rightEnd);
      board = r.board; leftEnd = r.leftEnd; rightEnd = r.rightEnd;

      if (verbose) {
        const tl = teamOf(currentPlayer) === 0 ? 'T1' : 'T2';
        console.log(`  #${moveNum} P${currentPlayer}(${tl}): plays ${tileStr(tile)} on ${side} → ends [${leftEnd}|${rightEnd}] (${h[currentPlayer].length} left)`);
        console.log(`         WHY: ${reason}`);
      }

      if (h[currentPlayer].length === 0) {
        const isD = tile.left === tile.right;
        const wasBoth = couldPlayOnBothEnds(tile, pL, pR);
        let pts, type;
        if (isD && wasBoth) { pts = 4; type = 'cruzada'; }
        else if (isD) { pts = 2; type = 'carroca'; }
        else if (wasBoth) { pts = 3; type = 'la-e-lo'; }
        else { pts = 1; type = 'normal'; }
        return { outcome: 'win', winner: currentPlayer, team: teamOf(currentPlayer), points: pts, type, board, hands: h };
      }

      prevLeftEnd = leftEnd; prevRightEnd = rightEnd;
      currentPlayer = (currentPlayer + 1) % 4;
    } else {
      passCount++;
      knowledge.recordPass(currentPlayer, leftEnd, rightEnd);

      if (verbose) {
        const tl = teamOf(currentPlayer) === 0 ? 'T1' : 'T2';
        console.log(`  #${moveNum} P${currentPlayer}(${tl}): PASSES — can't have {${knowledge.deadNumbers(currentPlayer).join(',')}}`);
      }

      if (passCount >= 4) {
        const hv = h.map((hand, idx) => ({
          player: idx, team: teamOf(idx),
          points: hand.reduce((s, t) => s + t.left + t.right, 0)
        }));
        const min = Math.min(...hv.map(v => v.points));
        const winners = hv.filter(v => v.points === min);
        if (winners.length > 1 && winners.some(w => w.team === 0) && winners.some(w => w.team === 1))
          return { outcome: 'tie', points: 0, board, hands: h, handValues: hv };
        return { outcome: 'blocked', winner: winners[0].player, team: winners[0].team, points: 1, board, hands: h, handValues: hv };
      }
      currentPlayer = (currentPlayer + 1) % 4;
    }
  }
  return { outcome: 'abort' };
}


// ========== MAIN: RUN ANALYSIS ==========

const args = process.argv.slice(2);
const VERBOSE_GAMES = args.includes('--verbose') ? 3 : 0;
const NUM_MATCHES = parseInt(args.find(a => a.startsWith('--matches='))?.split('=')[1] || '10000');

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║  DOMINO PERNAMBUCANO — STRATEGIC BRAIN SIMULATOR    ║');
console.log('╚══════════════════════════════════════════════════════╝\n');

// ---- PART 1: Show verbose games with reasoning ----
if (VERBOSE_GAMES > 0) {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  PART 1: VERBOSE GAME WITH MOVE-BY-MOVE REASONING');
  console.log(`${'='.repeat(60)}`);

  for (let g = 0; g < VERBOSE_GAMES; g++) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  MATCH ${g + 1} — Smart AI (all players)`);
    console.log(`${'─'.repeat(50)}`);
    const result = playMatch(smartAI, smartAI, true);
    console.log(`\n  MATCH WINNER: Team ${result.winner + 1} (${result.scores[0]}-${result.scores[1]}) in ${result.rounds} rounds`);
  }
}

// ---- PART 2: Skill vs Luck — Smart vs Dumb over many matches ----
console.log(`\n${'='.repeat(60)}`);
console.log(`  PART 2: SKILL vs LUCK — ${NUM_MATCHES.toLocaleString()} MATCHES`);
console.log(`${'='.repeat(60)}\n`);

const configs = [
  { name: 'Dumb vs Dumb (baseline)',    t0: dumbAI,  t1: dumbAI  },
  { name: 'Smart vs Dumb',              t0: smartAI, t1: dumbAI  },
  { name: 'Dumb vs Smart',              t0: dumbAI,  t1: smartAI },
  { name: 'Smart vs Smart',             t0: smartAI, t1: smartAI },
];

for (const cfg of configs) {
  let t0wins = 0, t1wins = 0, totalRounds = 0;
  const scoreDiffs = [];

  for (let m = 0; m < NUM_MATCHES; m++) {
    const result = playMatch(cfg.t0, cfg.t1, false);
    if (result.winner === 0) t0wins++;
    else if (result.winner === 1) t1wins++;
    totalRounds += result.rounds;
    scoreDiffs.push(result.scores[0] - result.scores[1]);
  }

  const avgDiff = scoreDiffs.reduce((a, b) => a + b, 0) / scoreDiffs.length;
  console.log(`  ${cfg.name}`);
  console.log(`    Team 1 wins: ${t0wins} (${(t0wins/NUM_MATCHES*100).toFixed(1)}%)`);
  console.log(`    Team 2 wins: ${t1wins} (${(t1wins/NUM_MATCHES*100).toFixed(1)}%)`);
  console.log(`    Avg rounds:  ${(totalRounds/NUM_MATCHES).toFixed(1)}`);
  console.log(`    Avg score diff (T1-T2): ${avgDiff > 0 ? '+' : ''}${avgDiff.toFixed(2)}`);
  console.log('');
}

// ---- PART 3: Summary ----
console.log(`${'='.repeat(60)}`);
console.log('  CONCLUSIONS');
console.log(`${'='.repeat(60)}\n`);
console.log('  Run with --verbose to see detailed move-by-move reasoning');
console.log('  Run with --matches=N to change sample size');
console.log('  Example: node domino-brain.js --verbose --matches=5000\n');
