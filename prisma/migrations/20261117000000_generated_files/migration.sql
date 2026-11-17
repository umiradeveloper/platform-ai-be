-- File hasil Hermes Agent yang bisa diunduh pengguna

-- CreateTable
CREATE TABLE `GeneratedFile` (
    `id` VARCHAR(191) NOT NULL,
    `messageId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(512) NOT NULL,
    `mimeType` VARCHAR(255) NOT NULL,
    `size` INTEGER NOT NULL DEFAULT 0,
    `sourcePath` VARCHAR(1024) NOT NULL,
    `storageKey` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `GeneratedFile_messageId_idx`(`messageId`),
    INDEX `GeneratedFile_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `GeneratedFile` ADD CONSTRAINT `GeneratedFile_messageId_fkey` FOREIGN KEY (`messageId`) REFERENCES `Message`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

