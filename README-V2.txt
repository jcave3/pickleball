Pickleball League Tracker v2
============================

WHAT CHANGED
- Added a public read-only experience with a locally remembered Admin Mode.
- Every game, player, settings, edit, and delete write is validated by Apps Script.
- Added Rematch, Swap Sides, Rebalance, and Undo actions after saving a game.
- Added request-level duplicate protection for game submissions.
- Added a responsive desktop side rail while keeping the mobile bottom navigation.
- Added installable-app assets, icons, and an offline-capable static app shell.
- Expanded player profiles with confidence and singles/doubles records.
- Replaced sequential doubles Elo credit splitting with a regularized global team-skill model.
- Ratings are re-fit from the complete network of singles + doubles results.
- Score margin supplies mild extra evidence but is capped.
- Added per-player rating confidence and provisional status.
- Added top 3 Recommended Singles calibration matches to the leaderboard.
- Tapping a calibration recommendation opens Log Game pre-filled as Singles.
- Added a doubles Balance These 4 Players button that evaluates all three pairings.
- The balancer displays predicted win odds and, for lopsided groups, an optional fun handicap.
- Player Rating History now comes from global-model snapshots instead of summing old Elo deltas.
- Added Settings > Recalculate ratings for migrating existing league data after deployment.

GOOGLE SHEET MIGRATION
No new Sheet columns are required. The existing 16-column Games schema is retained:
GameId, Date, Format, SideA_Player1, SideA_Player2, SideB_Player1, SideB_Player2,
ScoreA, ScoreB, Winner, EloDeltaA, EloDeltaB, EloDeltaA1, EloDeltaA2, EloDeltaB1, EloDeltaB2

The Elo-named columns are retained for backwards compatibility, but in v2 they represent
immediate model impact rather than traditional sequential Elo ledger entries.

DEPLOYMENT
1. In the Google Sheet: Extensions > Apps Script.
2. Replace Code.gs with this package's Code.gs and save.
3. Deploy > Manage deployments > edit your EXISTING web-app deployment.
4. Choose New version and deploy. Do not create a brand-new deployment unless you also want to change the API URL.
5. Replace the static site's HTML, js/, and css/ files with the files in this package.
6. Open the app > Settings > Recalculate ratings and enter the existing admin passcode.
7. Return to Leaderboard. Existing games will now be ranked with the global model and the Recommended Singles section will populate.

MODEL NOTES
- 1000 remains the neutral midpoint.
- Lightly tested players are pulled toward 1000 by regularization.
- Singles count more heavily toward confidence because they isolate individual skill.
- A player is provisional until they have at least 8 games AND 55% confidence.
- Confidence is an intentionally understandable evidence heuristic, not a formal Bayesian credible interval.
- Recommended singles emphasize uncertain players, close expected matchups, new/direct comparisons,
  and pairs whose singles evidence is old or sparse.

HANDICAP NOTE
The doubles balancer's handicap is intentionally a recreational suggestion only. If you use it,
record the actual unhandicapped on-court score if you want rating data to remain comparable.
