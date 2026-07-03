-- Scope ASP membership leaves by contract.
--
-- The original table was keyed by `leaf_index` alone, so after a contract
-- redeploy the new ASP membership contract's leaves (starting again at index
-- 0) collided with rows already stored for the old contract and were silently
-- dropped by `ON CONFLICT(leaf_index) DO NOTHING`. The membership check joins
-- leaves to their originating contract, so the new tree looked permanently
-- empty and users were told to register at the ASP even though their leaf was
-- on-chain and ingested in `raw_contract_events`.
--
-- Re-key by (contract_id, leaf_index). Existing rows are preserved and their
-- contract is recovered through the raw event that produced them. Any raw
-- LeafAdded events that were silently dropped remain "unprocessed" (no row
-- referencing their event_id) and are re-processed into the new table on the
-- next processing round.
CREATE TABLE asp_membership_leaves_v2 (
    contract_id INTEGER NOT NULL,
    leaf_index INTEGER NOT NULL,
    leaf BLOB NOT NULL CHECK (length(leaf) = 32),
    root BLOB NOT NULL CHECK (length(root) = 32),
    -- Foreign key to `raw_contract_events.id` for the event that added the leaf.
    event_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (contract_id, leaf_index),
    FOREIGN KEY (contract_id) REFERENCES contracts(contract_id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES raw_contract_events(id) ON DELETE CASCADE
);

INSERT INTO asp_membership_leaves_v2 (contract_id, leaf_index, leaf, root, event_id)
SELECT r.contract_id, l.leaf_index, l.leaf, l.root, l.event_id
FROM asp_membership_leaves l
JOIN raw_contract_events r ON r.id = l.event_id;

DROP TABLE asp_membership_leaves;
ALTER TABLE asp_membership_leaves_v2 RENAME TO asp_membership_leaves;

CREATE INDEX idx_asp_membership_leaves_leaf ON asp_membership_leaves (leaf);
