-- SRS Module 03 ATT-004/COR-006: corrections carry the member's full
-- preference-group selection set (same shape as normal marking); the system
-- applies it verbatim on approval. Additive + nullable.
ALTER TABLE "attendance_correction_requests" ADD COLUMN "requestedSelections" JSONB;
