-- The inverse of an agent batch (a JSON Batch), so "Undo this response" works after a restart.
-- Written for agent batches only; human undo stays client-side.
ALTER TABLE board_ops ADD COLUMN inverse TEXT;
