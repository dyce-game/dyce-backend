-- Switch Mini Golf on (docs/ADDING_A_GAME.md in the app repo). Pool stays off until a Pool match has been played through settlement.
UPDATE games SET enabled = true WHERE slug = 'mini-golf';
