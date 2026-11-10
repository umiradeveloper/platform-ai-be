-- Login dengan akun SuperApps
ALTER TABLE `User`
  ADD COLUMN `authSource` ENUM('LOCAL', 'SUPERAPPS') NOT NULL DEFAULT 'LOCAL',
  ADD COLUMN `externalId` VARCHAR(191) NULL,
  ADD COLUMN `externalRole` VARCHAR(191) NULL,
  ADD COLUMN `externalUsername` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `User_externalId_key` ON `User`(`externalId`);
