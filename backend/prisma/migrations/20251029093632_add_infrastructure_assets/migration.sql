-- CreateTable
CREATE TABLE "InfrastructureAsset" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "lat" REAL NOT NULL,
    "lng" REAL NOT NULL,
    "tags" JSONB,
    "source" TEXT NOT NULL DEFAULT 'osm',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "InfrastructureAsset_type_idx" ON "InfrastructureAsset"("type");
