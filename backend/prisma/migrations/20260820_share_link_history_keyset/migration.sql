-- Owner share-link history is retained up to 1,000 rows per App. Serve it with
-- an ID-complete keyset so equal timestamps cannot create gaps or duplicates.
CREATE INDEX "AppShareLink_owner_history_keyset_idx"
  ON "AppShareLink"("appId", "userId", "createdAt" DESC, "id" DESC);
