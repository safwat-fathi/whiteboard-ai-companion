-- opsByBatch (undo, activity) scanned every op of the board.
CREATE INDEX board_ops_batch ON board_ops(board_id, batch_id);
-- Chat pages by (board_id, rowid): the old (board_id, created_at) index forced a temp-B-tree sort per page.
DROP INDEX messages_board;
CREATE INDEX messages_board ON messages(board_id);
-- Per-turn lookups (activity runs one per turn).
CREATE INDEX messages_turn ON messages(board_id, turn_id);
-- usage.tokensByDay filters by created_at only.
CREATE INDEX messages_created ON messages(created_at);
