-- Dyce Cash is shown with the sign Ð, not the naira sign (ADR-046): it is virtual and must not read as real money.
-- Only stored display text needs changing; amounts are integer kobo and are untouched.
UPDATE badges SET icon = 'Ð' WHERE icon = '₦';
