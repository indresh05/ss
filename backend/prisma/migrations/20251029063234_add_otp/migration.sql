-- CreateTable
CREATE TABLE "Otp" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "phone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX "Otp_phone_key" ON "Otp"("phone");

-- CreateIndex
CREATE INDEX "Otp_phone_idx" ON "Otp"("phone");
