-- The ledger is append-only: a correction is a new reversing entry, never an edit.
-- TRUNCATE is still allowed, because the demo seed resets the whole database with it.
CREATE FUNCTION reject_ledger_entry_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_entry_change();
