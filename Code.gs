/**
 * Pickleball League Tracker — Apps Script backend.
 * Bind this script to the Google Sheet (Extensions > Apps Script) that has
 * two tabs: "Players" and "Games" with the header rows described below.
 *
 * Players: PlayerId | Name | Elo | GamesPlayed | Wins | Losses | Archived
 * Games:   GameId | Date | Format | SideA_Player1 | SideA_Player2 | SideB_Player1 | SideB_Player2 | ScoreA | ScoreB | Winner | EloDeltaA | EloDeltaB | EloDeltaA1 | EloDeltaA2 | EloDeltaB1 | EloDeltaB2
 *
 * Deploy: Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.
 * To ship changes later: Manage deployments > edit existing deployment > Version: New version > Deploy.
 * (Creating a NEW deployment instead of a new version changes the URL and breaks the frontend.)
 */

var STARTING_ELO = 1000;

// Global team-skill model. Instead of permanently assigning credit at the
// moment a doubles game is played, the league re-fits every player from the
// complete network of results. This lets later games clarify earlier ones:
// if a player repeatedly loses to weaker opponents, the model can infer that
// a strong partner likely explained more of their earlier doubles success.
//
// Internally this is a regularized Bradley-Terry/logistic model. Player skill
// is stored in log-odds units and converted back to familiar Elo-like numbers
// centered on 1000 for display. The L2 prior keeps lightly-tested players near
// 1000 until the league has enough evidence to move them confidently.
var GLOBAL_MODEL_PRIOR = 0.85;
var GLOBAL_MODEL_ITERATIONS = 220;
var GLOBAL_MODEL_LEARNING_RATE = 0.10;
var ELO_PER_LOGIT = 400 / Math.log(10);

// Score margin is evidence, but intentionally mild. An 11-1 win should count
// more than 11-9 without allowing one blowout to overwhelm the network.
var SCORE_WEIGHT_PER_POINT = 0.04;
var SCORE_WEIGHT_MAX = 1.28;

// Public confidence/provisional rules. Confidence is a transparent heuristic
// based on amount + type + diversity of evidence; singles carry extra weight
// because they directly identify individual skill.
var PROVISIONAL_MIN_GAMES = 8;
var PROVISIONAL_MIN_CONFIDENCE = 55;

// How many singles matchups the leaderboard suggests. Every unarchived pair is
// scored, so this is purely a display cap on an already-ranked list.
var CALIBRATION_RECOMMENDATION_COUNT = 6;

// The exact header row each tab must have (see the top-of-file comment).
// Checked on every read, not just at setup time — a sheet reader zips these
// header cells with row values by position, so a typo'd or missing header
// doesn't fail loudly on its own; it silently produces garbage (blank Elo,
// "Player not found" from a shifted column, etc). Validating here instead
// turns that into a clear, specific error the first time anything reads
// the sheet, rather than only when someone happens to run a setup check.
var PLAYERS_HEADERS = ['PlayerId', 'Name', 'Elo', 'GamesPlayed', 'Wins', 'Losses', 'Archived'];
// EloDeltaA/EloDeltaB stay side-level (the average of that side's players —
// see recomputeAllStats()'s doubles-split comment for why the average is
// unaffected by the split). EloDeltaA1/A2/B1/B2 are the actual per-player-
// slot deltas (matching the SideA_Player1/SideA_Player2/SideB_Player1/
// SideB_Player2 columns) — blank for a singles game's unused slot.
var GAMES_HEADERS = ['GameId', 'Date', 'Format', 'SideA_Player1', 'SideA_Player2', 'SideB_Player1', 'SideB_Player2', 'ScoreA', 'ScoreB', 'Winner', 'EloDeltaA', 'EloDeltaB', 'EloDeltaA1', 'EloDeltaA2', 'EloDeltaB1', 'EloDeltaB2'];

function checkHeaders(sheetName, actualHeaders, expectedHeaders) {
  var problems = [];
  expectedHeaders.forEach(function (expected, i) {
    var actual = String(actualHeaders[i] || '').trim();
    if (actual !== expected) {
      problems.push('column ' + (i + 1) + ' should be "' + expected + '" but is "' + (actual || 'empty') + '"');
    }
  });
  if (problems.length) {
    throw new Error(
      '"' + sheetName + '" tab\'s header row doesn\'t match what\'s expected: ' +
      problems.join('; ') + '. Check the header row against the README.'
    );
  }
}

// Creates a tab (with the right header row) if it's missing, or fixes its
// header row if that's wrong — but ONLY when the tab has no data rows yet.
// If real rows already exist under a mismatched header, guessing at a fix
// risks misaligning actual league data, so this refuses instead and asks
// for a manual fix. Returns a human-readable description of what it did.
function ensureSheetHeaders(ss, name, expectedHeaders) {
  var sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    return 'Created "' + name + '" tab with the correct header row.';
  }

  var lastCol = sheet.getLastColumn();
  var actualHeaders = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  try {
    checkHeaders(name, actualHeaders, expectedHeaders);
    return null; // already correct, nothing to do
  } catch (err) {
    if (sheet.getLastRow() > 1) {
      throw new Error(
        '"' + name + '" tab has data rows but its header row doesn\'t match what\'s expected — ' +
        'won\'t auto-fix since that could misalign existing data. Fix the header row manually ' +
        '(see README) or clear the tab\'s data and try again.'
      );
    }
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    return 'Fixed "' + name + '" tab\'s header row.';
  }
}

// Onboarding helper for the Settings page: attempts to fix whatever's wrong
// with the Sheet's shape. Not passcode-gated — during first-time setup the
// ADMIN_PASSCODE Script Property likely isn't set yet, and this only ever
// touches a tab when there's no data at risk (see ensureSheetHeaders), so
// the same low trust level as adding a player is fine here.
function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var fixed = [];
  var errors = [];

  [['Players', PLAYERS_HEADERS], ['Games', GAMES_HEADERS]].forEach(function (pair) {
    try {
      var action = ensureSheetHeaders(ss, pair[0], pair[1]);
      if (action) fixed.push(action);
    } catch (err) {
      errors.push(err.message);
    }
  });

  if (errors.length) {
    throw new Error(fixed.concat(errors).join(' '));
  }
  if (!fixed.length) {
    throw new Error('Nothing to fix — both tabs already look correct.');
  }
  return { fixed: fixed };
}

// Every league mutation is gated behind a shared admin passcode, since this
// is a public static site with no account system. Set it once via Apps Script:
// Project Settings > Script Properties > add ADMIN_PASSCODE. Never hardcode
// the passcode itself in this file.
function checkPasscode(passcode) {
  var expected = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSCODE');
  if (!expected) {
    throw new Error('Admin passcode not configured on the server (Script Properties > ADMIN_PASSCODE)');
  }
  if (passcode !== expected) {
    throw new Error('Incorrect passcode');
  }
}

function checkPasscodeIfConfigured(passcode) {
  var expected = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSCODE');
  if (expected) checkPasscode(passcode);
}

// The league's display name, shown in the banner at the top of every page.
// Stored as a Script Property (same mechanism as ADMIN_PASSCODE) rather
// than a Sheet cell, since it's simple shared config rather than league
// data — no bearing on Elo/games, doesn't belong in either tab's schema.
// A missing property (nothing set yet) returns an empty name; the frontend
// falls back to a hardcoded default in that case.
function getLeagueName() {
  return { name: PropertiesService.getScriptProperties().getProperty('LEAGUE_NAME') || '' };
}

// Gated like editGame/deleteGame: unlike adding a player, this is a single
// shared value everyone sees, so it isn't left open the way additive,
// low-stakes writes are.
function setLeagueName(passcode, name) {
  checkPasscode(passcode);
  var trimmed = (name || '').trim();
  if (!trimmed) throw new Error('League name can\'t be empty');
  PropertiesService.getScriptProperties().setProperty('LEAGUE_NAME', trimmed);
  return { name: trimmed };
}

function doGet(e) {
  var action = e.parameter.action;
  var result;
  try {
    if (action === 'getPlayers') {
      result = getPlayers();
    } else if (action === 'getLeaderboard') {
      result = getLeaderboard();
    } else if (action === 'getGames') {
      var limit = e.parameter.limit ? parseInt(e.parameter.limit, 10) : null;
      result = getGames(limit);
    } else if (action === 'getPlayerStats') {
      result = getPlayerStats(e.parameter.name);
    } else if (action === 'getLogGameData') {
      result = getLogGameData();
    } else if (action === 'getSetupStatus') {
      result = getSetupStatus();
    } else if (action === 'getLeagueName') {
      result = getLeagueName();
    } else if (action === 'getCalibrationRecommendations') {
      result = getCalibrationRecommendations();
    } else {
      return jsonOutput({ error: 'Unknown action: ' + action });
    }
    return jsonOutput(result);
  } catch (err) {
    return jsonOutput({ error: err.message });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var result;
    if (action === 'verifyAdmin') {
      checkPasscode(body.passcode);
      result = { ok: true };
    } else if (action === 'addPlayer') {
      checkPasscode(body.passcode);
      result = addPlayer(body.name);
    } else if (action === 'archivePlayer') {
      checkPasscode(body.passcode);
      result = archivePlayer(body.playerId);
    } else if (action === 'unarchivePlayer') {
      checkPasscode(body.passcode);
      result = unarchivePlayer(body.playerId);
    } else if (action === 'logGame') {
      checkPasscode(body.passcode);
      var requestId = String(body.requestId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
      var requestCache = CacheService.getScriptCache();
      var requestKey = requestId ? 'logGame:' + requestId : '';
      var cachedResult = requestKey ? requestCache.get(requestKey) : null;
      if (cachedResult) {
        result = JSON.parse(cachedResult);
      } else {
        result = logGame(body.date, body.format, body.sideAPlayers, body.sideBPlayers, body.scoreA, body.scoreB);
        if (requestKey) requestCache.put(requestKey, JSON.stringify(result), 600);
      }
    } else if (action === 'editGame') {
      result = editGame(body.passcode, body.gameId, body.date, body.format, body.sideAPlayers, body.sideBPlayers, body.scoreA, body.scoreB);
    } else if (action === 'deleteGame') {
      result = deleteGame(body.passcode, body.gameId);
    } else if (action === 'setLeagueName') {
      result = setLeagueName(body.passcode, body.name);
    } else if (action === 'setupSheet') {
      checkPasscodeIfConfigured(body.passcode);
      result = setupSheet();
    } else if (action === 'recomputeRatings') {
      checkPasscode(body.passcode);
      recomputeAllStats();
      result = { ok: true, leaderboard: getLeaderboard(), calibration: getCalibrationRecommendations() };
    } else {
      return jsonOutput({ error: 'Unknown action: ' + action });
    }
    return jsonOutput(result);
  } catch (err) {
    return jsonOutput({ error: err.message });
  } finally {
    lock.releaseLock();
  }
}

function jsonOutput(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) {
    throw new Error('Sheet tab not found: "' + name + '". Check the Google Sheet has a tab named exactly "' + name + '".');
  }
  return sheet;
}

// Cheap connectivity/setup check for the frontend's settings page. Both
// calls below go through checkHeaders() (see top of file), so a missing
// tab or a wrong/missing header cell surfaces here as a specific, readable
// error instead of silently-wrong data. Deliberately returns simple counts
// rather than the full data, and mutates nothing.
function getSetupStatus() {
  var players = playersSheetToObjects();
  var games = gamesSheetToObjects();
  return { ok: true, playerCount: players.length, gameCount: games.length };
}

// ---- Players ----

function playersSheetToObjects() {
  var sheet = getSheet('Players');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  checkHeaders('Players', headers, PLAYERS_HEADERS);
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue; // skip blank trailing rows
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = row[c];
    }
    obj._rowIndex = i + 1; // 1-based sheet row, for in-place updates
    rows.push(obj);
  }
  return rows;
}

function getPlayers() {
  return playersSheetToObjects();
}

function getLeaderboard() {
  var players = playersSheetToObjects().filter(function (p) { return p.Archived !== true; });
  var games = gamesSheetToObjects();
  var streaks = computeStreaks(games.slice().reverse()); // most recent first
  var evidence = computeRatingEvidence(players, games);

  players.forEach(function (p) {
    var e = evidence[p.Name] || emptyEvidence();
    p.WinPct = p.GamesPlayed > 0 ? p.Wins / p.GamesPlayed : 0;
    p.Streak = streaks[p.Name] || 0;
    p.SinglesGames = e.singlesGames;
    p.DoublesGames = e.doublesGames;
    p.SinglesWins = e.singlesWins;
    p.SinglesLosses = e.singlesLosses;
    p.DoublesWins = e.doublesWins;
    p.DoublesLosses = e.doublesLosses;
    p.UniqueOpponents = Object.keys(e.opponents).length;
    p.UniquePartners = Object.keys(e.partners).length;
    p.Confidence = ratingConfidence(e);
    p.IsProvisional = p.GamesPlayed < PROVISIONAL_MIN_GAMES || p.Confidence < PROVISIONAL_MIN_CONFIDENCE;
  });

  players.sort(function (a, b) {
    if (a.IsProvisional !== b.IsProvisional) return a.IsProvisional ? 1 : -1;
    return b.Elo - a.Elo;
  });
  return players;
}

// Current streak per player, counting back from their most recent game:
// positive N = an N-game win streak, negative N = an N-game losing streak.
// Stops (and locks in) at the first game that breaks the current direction,
// so a player's entry is only ever touched until that happens once per call.
function computeStreaks(gamesMostRecentFirst) {
  var streaks = {};
  var broken = {};

  function tally(name, won) {
    if (broken[name]) return;
    var current = streaks[name] || 0;
    if (current === 0) {
      streaks[name] = won ? 1 : -1;
    } else if (current > 0 === won) {
      streaks[name] = current + (won ? 1 : -1);
    } else {
      broken[name] = true;
    }
  }

  gamesMostRecentFirst.forEach(function (g) {
    var sideANames = [g.SideA_Player1, g.SideA_Player2].filter(Boolean);
    var sideBNames = [g.SideB_Player1, g.SideB_Player2].filter(Boolean);
    var aWon = g.Winner === 'A';
    sideANames.forEach(function (n) { tally(n, aWon); });
    sideBNames.forEach(function (n) { tally(n, !aWon); });
  });

  return streaks;
}

function addPlayer(name) {
  var trimmedName = (name || '').trim().replace(/\s+/g, ' ');
  if (trimmedName.split(' ').length < 2) {
    throw new Error('Enter both a first and last name');
  }
  name = trimmedName;

  var sheet = getSheet('Players');
  var players = playersSheetToObjects();
  var duplicate = players.filter(function (p) { return String(p.Name).toLowerCase() === name.toLowerCase(); })[0];
  if (duplicate) throw new Error('A player named ' + duplicate.Name + ' already exists');
  var maxNum = 0;
  players.forEach(function (p) {
    var n = parseInt(String(p.PlayerId).replace('p', ''), 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  });
  var newId = 'p' + (maxNum + 1);
  sheet.appendRow([newId, name, STARTING_ELO, 0, 0, 0, false]);
  return { PlayerId: newId, Name: name, Elo: STARTING_ELO, GamesPlayed: 0, Wins: 0, Losses: 0, Archived: false };
}

function archivePlayer(playerId) {
  return setPlayerArchived(playerId, true);
}

function unarchivePlayer(playerId) {
  return setPlayerArchived(playerId, false);
}

function setPlayerArchived(playerId, archived) {
  var sheet = getSheet('Players');
  var players = playersSheetToObjects();
  var target = players.filter(function (p) { return p.PlayerId === playerId; })[0];
  if (!target) throw new Error('Player not found: ' + playerId);
  sheet.getRange(target._rowIndex, 7).setValue(archived); // Archived column
  return { PlayerId: playerId, Archived: archived };
}

function findPlayerByName(players, name) {
  var match = players.filter(function (p) { return p.Name === name; })[0];
  if (!match) throw new Error('Player not found: ' + name);
  return match;
}

// ---- Games ----

function gamesSheetToObjects() {
  var sheet = getSheet('Games');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  checkHeaders('Games', headers, GAMES_HEADERS);
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue;
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = row[c];
    }
    rows.push(obj);
  }
  return rows;
}

function getGames(limit) {
  var games = gamesSheetToObjects();
  games.reverse(); // most recent first (rows are appended in chronological order)
  if (limit) games = games.slice(0, limit);
  return games;
}

// Bundles what the Log Game page needs (full player roster + full game log,
// for the "most recently played with" sort) into one request instead of
// two, since each call to the Apps Script web app pays its own round-trip
// and cold-start cost — halving the number of calls roughly halves the
// wait before the pickers are usable.
function getLogGameData() {
  return { players: getPlayers(), games: getGames() };
}

// Builds one player's profile + their personal game log + a head-to-head
// breakdown against every opponent they've faced. For a doubles game, both
// opposing players are counted as an "opponent" for that single result.
function getPlayerStats(name) {
  var players = playersSheetToObjects();
  var player = players.filter(function (p) { return p.Name === name; })[0];
  if (!player) throw new Error('Player not found: ' + name);

  var leaderboard = getLeaderboard();
  var ranked = leaderboard.filter(function (p) { return !p.IsProvisional; });
  var rankIndex = -1;
  ranked.forEach(function (p, i) { if (p.Name === name) rankIndex = i; });
  var rank = rankIndex >= 0 ? rankIndex + 1 : null;
  var leaderboardPlayer = leaderboard.filter(function (p) { return p.Name === name; })[0] || player;
  var winPct = player.GamesPlayed > 0 ? player.Wins / player.GamesPlayed : 0;

  var chronologicalGames = gamesSheetToObjects();
  var ratingHistory = computePlayerRatingHistory(name, players, chronologicalGames);
  var allGames = chronologicalGames.slice().reverse(); // most recent first
  var myGames = [];
  var headToHeadMap = {};

  allGames.forEach(function (g) {
    var sideANames = [g.SideA_Player1, g.SideA_Player2].filter(Boolean);
    var sideBNames = [g.SideB_Player1, g.SideB_Player2].filter(Boolean);
    var onA = sideANames.indexOf(name) !== -1;
    var onB = sideBNames.indexOf(name) !== -1;
    if (!onA && !onB) return;

    var won = (onA && g.Winner === 'A') || (onB && g.Winner === 'B');
    var opponents = onA ? sideBNames : sideANames;
    var mySide = onA ? sideANames : sideBNames;
    var partner = mySide.filter(function (n) { return n !== name; })[0] || '';
    var myDelta;
    if (onA) myDelta = g.SideA_Player1 === name ? g.EloDeltaA1 : g.EloDeltaA2;
    else myDelta = g.SideB_Player1 === name ? g.EloDeltaB1 : g.EloDeltaB2;

    myGames.push({
      GameId: g.GameId, Date: g.Date, Format: g.Format, Opponents: opponents,
      Partner: partner,
      MyScore: onA ? g.ScoreA : g.ScoreB, OppScore: onA ? g.ScoreB : g.ScoreA,
      Won: won, EloDelta: myDelta
    });

    opponents.forEach(function (opp) {
      if (!headToHeadMap[opp]) headToHeadMap[opp] = { Opponent: opp, Wins: 0, Losses: 0 };
      if (won) headToHeadMap[opp].Wins += 1;
      else headToHeadMap[opp].Losses += 1;
    });
  });

  var headToHead = Object.keys(headToHeadMap).map(function (k) { return headToHeadMap[k]; });
  headToHead.sort(function (a, b) { return (b.Wins + b.Losses) - (a.Wins + a.Losses); });

  return {
    player: {
      Name: player.Name, Elo: player.Elo, Wins: player.Wins, Losses: player.Losses,
      GamesPlayed: player.GamesPlayed, Archived: player.Archived, WinPct: winPct, Rank: rank,
      Confidence: leaderboardPlayer.Confidence || 0,
      IsProvisional: leaderboardPlayer.IsProvisional === true,
      SinglesGames: leaderboardPlayer.SinglesGames || 0,
      DoublesGames: leaderboardPlayer.DoublesGames || 0,
      SinglesWins: leaderboardPlayer.SinglesWins || 0,
      SinglesLosses: leaderboardPlayer.SinglesLosses || 0,
      DoublesWins: leaderboardPlayer.DoublesWins || 0,
      DoublesLosses: leaderboardPlayer.DoublesLosses || 0
    },
    games: myGames,
    headToHead: headToHead,
    ratingHistory: ratingHistory
  };
}

function validateGameInput(format, sideAPlayers, sideBPlayers, scoreA, scoreB) {
  if (format !== 'Singles' && format !== 'Doubles') {
    throw new Error('Format must be Singles or Doubles');
  }
  var expectedCount = format === 'Singles' ? 1 : 2;
  if (sideAPlayers.length !== expectedCount || sideBPlayers.length !== expectedCount) {
    throw new Error('Expected ' + expectedCount + ' player(s) per side for ' + format);
  }
  var numScoreA = Number(scoreA);
  var numScoreB = Number(scoreB);
  if (isNaN(numScoreA) || isNaN(numScoreB) || numScoreA === numScoreB) {
    throw new Error('Scores must be numbers and cannot be tied');
  }

  var allNames = sideAPlayers.concat(sideBPlayers);
  var uniqueNames = {};
  allNames.forEach(function (n) { uniqueNames[n] = true; });
  if (Object.keys(uniqueNames).length !== allNames.length) {
    throw new Error('A player can\'t play against (or alongside) themselves in the same game');
  }

  return { scoreA: numScoreA, scoreB: numScoreB };
}

function findGameRow(gamesSheet, gameId) {
  var lastRow = gamesSheet.getLastRow();
  if (lastRow <= 1) throw new Error('Game not found: ' + gameId);
  var ids = gamesSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === gameId) return i + 2;
  }
  throw new Error('Game not found: ' + gameId);
}

// ---- Global rating model ----

function emptyEvidence() {
  return {
    games: 0,
    singlesGames: 0,
    singlesWins: 0,
    singlesLosses: 0,
    doublesGames: 0,
    doublesWins: 0,
    doublesLosses: 0,
    opponents: {},
    partners: {},
    lastSinglesDate: null
  };
}

function computeRatingEvidence(players, games) {
  var evidence = {};
  players.forEach(function (p) { evidence[p.Name] = emptyEvidence(); });
  games.forEach(function (g) {
    var sideA = [g.SideA_Player1, g.SideA_Player2].filter(Boolean);
    var sideB = [g.SideB_Player1, g.SideB_Player2].filter(Boolean);
    var isSingles = String(g.Format || '').trim().toLowerCase() === 'singles';
    sideA.concat(sideB).forEach(function (name) {
      if (!evidence[name]) evidence[name] = emptyEvidence();
      evidence[name].games += 1;
      if (isSingles) {
        evidence[name].singlesGames += 1;
        var d = new Date(g.Date);
        if (!evidence[name].lastSinglesDate || d > evidence[name].lastSinglesDate) evidence[name].lastSinglesDate = d;
      } else {
        evidence[name].doublesGames += 1;
      }
    });
    sideA.forEach(function (name) {
      if (isSingles) {
        if (g.Winner === 'A') evidence[name].singlesWins += 1;
        else evidence[name].singlesLosses += 1;
      } else {
        if (g.Winner === 'A') evidence[name].doublesWins += 1;
        else evidence[name].doublesLosses += 1;
      }
      sideB.forEach(function (opp) { evidence[name].opponents[opp] = true; });
      sideA.forEach(function (partner) { if (partner !== name) evidence[name].partners[partner] = true; });
    });
    sideB.forEach(function (name) {
      if (isSingles) {
        if (g.Winner === 'B') evidence[name].singlesWins += 1;
        else evidence[name].singlesLosses += 1;
      } else {
        if (g.Winner === 'B') evidence[name].doublesWins += 1;
        else evidence[name].doublesLosses += 1;
      }
      sideA.forEach(function (opp) { evidence[name].opponents[opp] = true; });
      sideB.forEach(function (partner) { if (partner !== name) evidence[name].partners[partner] = true; });
    });
  });
  return evidence;
}

function ratingConfidence(e) {
  var opponentDiversity = Math.min(Object.keys(e.opponents || {}).length, 6);
  var partnerDiversity = Math.min(Object.keys(e.partners || {}).length, 5);
  var evidenceScore = e.doublesGames + (2.6 * e.singlesGames) + (0.75 * opponentDiversity) + (0.35 * partnerDiversity);
  return Math.max(10, Math.min(95, Math.round(100 * (1 - Math.exp(-evidenceScore / 11)))));
}

function scoreEvidenceWeight(scoreA, scoreB) {
  var extra = Math.max(Math.abs(Number(scoreA) - Number(scoreB)) - 2, 0);
  return Math.min(SCORE_WEIGHT_MAX, 1 + extra * SCORE_WEIGHT_PER_POINT);
}

function logistic(x) {
  if (x > 35) return 1;
  if (x < -35) return 0;
  return 1 / (1 + Math.exp(-x));
}

function fitGlobalRatings(players, games, seedSkills, iterations) {
  var names = players.map(function (p) { return p.Name; });
  var known = {};
  names.forEach(function (n) { known[n] = true; });
  var skills = {};
  names.forEach(function (n) { skills[n] = seedSkills && seedSkills[n] !== undefined ? seedSkills[n] : 0; });
  var usableGames = games.filter(function (g) {
    var namesInGame = [g.SideA_Player1, g.SideA_Player2, g.SideB_Player1, g.SideB_Player2].filter(Boolean);
    return namesInGame.length >= 2 && namesInGame.every(function (n) { return known[n]; });
  });
  var totalIterations = iterations || GLOBAL_MODEL_ITERATIONS;

  for (var iter = 0; iter < totalIterations; iter++) {
    var gradient = {};
    names.forEach(function (n) { gradient[n] = -GLOBAL_MODEL_PRIOR * skills[n]; });

    usableGames.forEach(function (g) {
      var sideA = [g.SideA_Player1, g.SideA_Player2].filter(Boolean);
      var sideB = [g.SideB_Player1, g.SideB_Player2].filter(Boolean);
      var skillA = sideA.reduce(function (sum, n) { return sum + skills[n]; }, 0) / sideA.length;
      var skillB = sideB.reduce(function (sum, n) { return sum + skills[n]; }, 0) / sideB.length;
      var pA = logistic(skillA - skillB);
      var actualA = Number(g.ScoreA) > Number(g.ScoreB) ? 1 : 0;
      var err = scoreEvidenceWeight(g.ScoreA, g.ScoreB) * (actualA - pA);
      sideA.forEach(function (n) { gradient[n] += err / sideA.length; });
      sideB.forEach(function (n) { gradient[n] -= err / sideB.length; });
    });

    var lr = GLOBAL_MODEL_LEARNING_RATE / Math.sqrt(1 + iter / 70);
    names.forEach(function (n) { skills[n] += lr * gradient[n]; });

    // Ratings are relative. Keep the league centered so 1000 remains the
    // familiar neutral midpoint and adding/removing data cannot shift everyone
    // together for no sporting reason.
    var mean = names.length ? names.reduce(function (sum, n) { return sum + skills[n]; }, 0) / names.length : 0;
    names.forEach(function (n) { skills[n] -= mean; });
  }

  var ratings = {};
  names.forEach(function (n) { ratings[n] = Math.round(STARTING_ELO + skills[n] * ELO_PER_LOGIT); });
  return { skills: skills, ratings: ratings };
}

function predictedWinProbability(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function computePlayerRatingHistory(playerName, players, games) {
  var history = [];
  var prefix = [];
  var seed = null;
  games.forEach(function (g) {
    prefix.push(g);
    // Warm-start from the previous fit. A shorter refinement is enough for a
    // smooth historical snapshot and keeps profile loads fast even as the
    // league grows.
    var fit = fitGlobalRatings(players, prefix, seed, 90);
    seed = fit.skills;
    history.push({ GameId: g.GameId, Date: g.Date, Elo: fit.ratings[playerName] || STARTING_ELO });
  });
  return history;
}

function getCalibrationRecommendations() {
  var players = playersSheetToObjects().filter(function (p) { return p.Archived !== true; });
  var games = gamesSheetToObjects();
  var evidence = computeRatingEvidence(players, games);
  var pairSingles = {};

  games.forEach(function (g) {
    if (g.Format !== 'Singles') return;
    var a = g.SideA_Player1;
    var b = g.SideB_Player1;
    if (!a || !b) return;
    var key = [a, b].sort().join('||');
    if (!pairSingles[key]) pairSingles[key] = { count: 0, lastDate: null };
    pairSingles[key].count += 1;
    var d = new Date(g.Date);
    if (!pairSingles[key].lastDate || d > pairSingles[key].lastDate) pairSingles[key].lastDate = d;
  });

  var enriched = players.map(function (p) {
    var e = evidence[p.Name] || emptyEvidence();
    return { name: p.Name, rating: Number(p.Elo) || STARTING_ELO, confidence: ratingConfidence(e), evidence: e };
  });
  var recommendations = [];
  var now = new Date();

  for (var i = 0; i < enriched.length; i++) {
    for (var j = i + 1; j < enriched.length; j++) {
      var a = enriched[i];
      var b = enriched[j];
      var key = [a.name, b.name].sort().join('||');
      var direct = pairSingles[key] || { count: 0, lastDate: null };
      var pA = predictedWinProbability(a.rating, b.rating);
      var balance = 4 * pA * (1 - pA); // 1.0 at 50/50, near 0 for a mismatch
      var uncertainty = ((100 - a.confidence) + (100 - b.confidence)) / 200;
      var novelty = 1 / (1 + direct.count * 1.4);
      if (direct.lastDate) {
        var days = (now.getTime() - direct.lastDate.getTime()) / 86400000;
        if (days < 14) novelty *= 0.35;
        else if (days < 35) novelty *= 0.65;
      }
      var singlesNeed = Math.min(1, ((Math.max(0, 4 - a.evidence.singlesGames)) + Math.max(0, 4 - b.evidence.singlesGames)) / 8);
      var score = 100 * (0.42 * uncertainty + 0.25 * balance + 0.21 * novelty + 0.12 * singlesNeed);

      var reasons = [];
      if (a.confidence < 55 || b.confidence < 55) reasons.push('low rating confidence');
      if (a.evidence.singlesGames < 2 || b.evidence.singlesGames < 2) reasons.push('limited singles evidence');
      if (direct.count === 0) reasons.push('no direct singles result yet');
      else if (direct.lastDate && (now.getTime() - direct.lastDate.getTime()) / 86400000 > 35) reasons.push('direct matchup needs a refresh');
      if (balance > 0.85) reasons.push('close ratings make this highly informative');

      recommendations.push({
        PlayerA: a.name, PlayerB: b.name, PriorityScore: Math.round(score),
        ExpectedA: Math.round(pA * 100), ExpectedB: Math.round((1 - pA) * 100),
        Reason: reasons.slice(0, 2).join(' · ') || 'useful cross-check of the standings'
      });
    }
  }

  recommendations.sort(function (a, b) { return b.PriorityScore - a.PriorityScore; });
  var avgConfidence = enriched.length ? Math.round(enriched.reduce(function (sum, p) { return sum + p.confidence; }, 0) / enriched.length) : 0;
  return { LeagueConfidence: avgConfidence, recommendations: recommendations.slice(0, CALIBRATION_RECOMMENDATION_COUNT) };
}

function recomputeAllStats() {
  var players = playersSheetToObjects();
  var statsByName = {};
  players.forEach(function (p) {
    statsByName[p.Name] = { Elo: STARTING_ELO, GamesPlayed: 0, Wins: 0, Losses: 0 };
  });

  var gamesSheet = getSheet('Games');
  var lastRow = gamesSheet.getLastRow();
  var values = [];
  if (lastRow > 1) {
    var numRows = lastRow - 1;
    var range = gamesSheet.getRange(2, 1, numRows, 16);
    values = range.getValues();

    // First compute plain records. The skill model below uses the complete
    // network of games at once; W/L counts remain literal game outcomes.
    values.forEach(function (row) {
      if (!row[0]) return;
      var sideA = [row[3], row[4]].filter(Boolean);
      var sideB = [row[5], row[6]].filter(Boolean);
      var aWon = Number(row[7]) > Number(row[8]);
      sideA.forEach(function (n) {
        if (!statsByName[n]) return;
        statsByName[n].GamesPlayed += 1;
        if (aWon) statsByName[n].Wins += 1; else statsByName[n].Losses += 1;
      });
      sideB.forEach(function (n) {
        if (!statsByName[n]) return;
        statsByName[n].GamesPlayed += 1;
        if (!aWon) statsByName[n].Wins += 1; else statsByName[n].Losses += 1;
      });
      row[9] = aWon ? 'A' : 'B';
    });

    var gameObjects = values.filter(function (row) { return row[0]; }).map(function (row) {
      return {
        GameId: row[0], Date: row[1], Format: row[2],
        SideA_Player1: row[3], SideA_Player2: row[4], SideB_Player1: row[5], SideB_Player2: row[6],
        ScoreA: row[7], ScoreB: row[8], Winner: row[9]
      };
    });
    var finalFit = fitGlobalRatings(players, gameObjects);
    players.forEach(function (p) { statsByName[p.Name].Elo = finalFit.ratings[p.Name] || STARTING_ELO; });

    // Keep the existing delta columns useful for history and diagnostics. These
    // are the immediate change in the global model when this result is added
    // to the evidence available at that moment. Because later games can revise
    // earlier conclusions, these deltas are explanatory impacts, not a ledger
    // that must sum exactly to today's rating.
    var prefix = [];
    var priorRatings = {};
    players.forEach(function (p) { priorRatings[p.Name] = STARTING_ELO; });
    var seed = null;
    var gameIndex = 0;
    values.forEach(function (row) {
      if (!row[0]) return;
      prefix.push(gameObjects[gameIndex++]);
      var fit = fitGlobalRatings(players, prefix, seed, 90);
      seed = fit.skills;
      var sideA = [row[3], row[4]].filter(Boolean);
      var sideB = [row[5], row[6]].filter(Boolean);
      var deltasA = sideA.map(function (n) { return Math.round(fit.ratings[n] - priorRatings[n]); });
      var deltasB = sideB.map(function (n) { return Math.round(fit.ratings[n] - priorRatings[n]); });
      row[10] = deltasA.length ? Math.round(deltasA.reduce(function (s, d) { return s + d; }, 0) / deltasA.length) : 0;
      row[11] = deltasB.length ? Math.round(deltasB.reduce(function (s, d) { return s + d; }, 0) / deltasB.length) : 0;
      row[12] = deltasA[0] || 0;
      row[13] = deltasA.length > 1 ? deltasA[1] : '';
      row[14] = deltasB[0] || 0;
      row[15] = deltasB.length > 1 ? deltasB[1] : '';
      players.forEach(function (p) { priorRatings[p.Name] = fit.ratings[p.Name] || STARTING_ELO; });
    });

    range.setValues(values);
  }

  var playersSheet = getSheet('Players');
  if (playersSheet.getLastRow() > 1) {
    var statsRange = playersSheet.getRange(2, 3, playersSheet.getLastRow() - 1, 4);
    var statsValues = statsRange.getValues();
    players.forEach(function (p) {
      var st = statsByName[p.Name];
      statsValues[p._rowIndex - 2] = [st.Elo, st.GamesPlayed, st.Wins, st.Losses];
    });
    statsRange.setValues(statsValues);
  }
}

function logGame(date, format, sideAPlayers, sideBPlayers, scoreA, scoreB) {
  var validScores = validateGameInput(format, sideAPlayers, sideBPlayers, scoreA, scoreB);

  var players = playersSheetToObjects();
  var sideAObjs = sideAPlayers.map(function (n) { return findPlayerByName(players, n); });
  var sideBObjs = sideBPlayers.map(function (n) { return findPlayerByName(players, n); });
  sideAObjs.concat(sideBObjs).forEach(function (p) {
    if (p.Archived === true) throw new Error(p.Name + ' is archived and can\'t be added to a new game');
  });

  var gamesSheet = getSheet('Games');
  var gamesCount = gamesSheet.getLastRow(); // includes header row, so this is a safe running count
  var gameId = 'g' + gamesCount;
  var gameDate = date ? new Date(date) : new Date();
  gamesSheet.appendRow([
    gameId, gameDate, format,
    sideAPlayers[0] || '', sideAPlayers[1] || '',
    sideBPlayers[0] || '', sideBPlayers[1] || '',
    validScores.scoreA, validScores.scoreB, '', 0, 0
  ]);

  recomputeAllStats();

  var savedGame = gamesSheetToObjects().filter(function (g) { return g.GameId === gameId; })[0];
  return { game: savedGame, leaderboard: getLeaderboard() };
}

// Editing or deleting an ARBITRARY past game (not just the most recent one)
// requires the admin passcode, since it can rewrite Elo history for every
// game after it and this site has no login otherwise.
function editGame(passcode, gameId, date, format, sideAPlayers, sideBPlayers, scoreA, scoreB) {
  checkPasscode(passcode);
  var validScores = validateGameInput(format, sideAPlayers, sideBPlayers, scoreA, scoreB);

  var players = playersSheetToObjects();
  sideAPlayers.concat(sideBPlayers).forEach(function (n) { findPlayerByName(players, n); });

  var gamesSheet = getSheet('Games');
  var rowIndex = findGameRow(gamesSheet, gameId);
  var gameDate = date ? new Date(date) : new Date();
  gamesSheet.getRange(rowIndex, 1, 1, 9).setValues([[
    gameId, gameDate, format,
    sideAPlayers[0] || '', sideAPlayers[1] || '',
    sideBPlayers[0] || '', sideBPlayers[1] || '',
    validScores.scoreA, validScores.scoreB
  ]]);

  recomputeAllStats();

  var savedGame = gamesSheetToObjects().filter(function (g) { return g.GameId === gameId; })[0];
  return { game: savedGame, leaderboard: getLeaderboard() };
}

function deleteGame(passcode, gameId) {
  checkPasscode(passcode);
  var gamesSheet = getSheet('Games');
  var rowIndex = findGameRow(gamesSheet, gameId);
  gamesSheet.deleteRow(rowIndex);
  recomputeAllStats();

  return { deleted: { GameId: gameId }, leaderboard: getLeaderboard() };
}
