-- Basis pengetahuan (RAG) per user: folder Synology yang diindeks + potongan teks (FULLTEXT) + embedding opsional

-- CreateTable
CREATE TABLE `KnowledgeIndex` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `path` VARCHAR(1024) NOT NULL,
    `pathHash` CHAR(64) NOT NULL,
    `name` VARCHAR(512) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'queued',
    `progress` INTEGER NOT NULL DEFAULT 0,
    `fileCount` INTEGER NOT NULL DEFAULT 0,
    `chunkCount` INTEGER NOT NULL DEFAULT 0,
    `skippedCount` INTEGER NOT NULL DEFAULT 0,
    `error` TEXT NULL,
    `autoRefresh` BOOLEAN NOT NULL DEFAULT true,
    `lastIndexedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `KnowledgeIndex_status_idx`(`status`),
    UNIQUE INDEX `KnowledgeIndex_userId_pathHash_key`(`userId`, `pathHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KnowledgeFile` (
    `id` VARCHAR(191) NOT NULL,
    `indexId` VARCHAR(191) NOT NULL,
    `path` VARCHAR(1024) NOT NULL,
    `name` VARCHAR(512) NOT NULL,
    `size` INTEGER NOT NULL DEFAULT 0,
    `mtime` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL DEFAULT 'ok',
    `note` VARCHAR(512) NULL,
    `chunkCount` INTEGER NOT NULL DEFAULT 0,

    INDEX `KnowledgeFile_indexId_idx`(`indexId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KnowledgeChunk` (
    `id` VARCHAR(191) NOT NULL,
    `fileId` VARCHAR(191) NOT NULL,
    `indexId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `ordinal` INTEGER NOT NULL,
    `text` TEXT NOT NULL,
    `embedding` MEDIUMBLOB NULL,

    INDEX `KnowledgeChunk_userId_indexId_idx`(`userId`, `indexId`),
    INDEX `KnowledgeChunk_fileId_idx`(`fileId`),
    FULLTEXT INDEX `KnowledgeChunk_text_idx`(`text`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `KnowledgeIndex` ADD CONSTRAINT `KnowledgeIndex_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeFile` ADD CONSTRAINT `KnowledgeFile_indexId_fkey` FOREIGN KEY (`indexId`) REFERENCES `KnowledgeIndex`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeChunk` ADD CONSTRAINT `KnowledgeChunk_fileId_fkey` FOREIGN KEY (`fileId`) REFERENCES `KnowledgeFile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

