import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Req, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { UploadsService } from './uploads.service';

const MAX_MB = Number(process.env.UPLOAD_MAX_MB) > 0 ? Number(process.env.UPLOAD_MAX_MB) : 25;
const MAX_FILES = Number(process.env.UPLOAD_MAX_FILES) > 0 ? Number(process.env.UPLOAD_MAX_FILES) : 20;

@ApiTags('Uploads')
@ApiBearerAuth()
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Get('limits')
  limits() {
    return this.uploads.limits();
  }

  /**
   * Unggah file dari komputer (multipart, field `files`). Field `names` (JSON array string) opsional:
   * nama file UTF-8 + subfolder saat mengunggah folder.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @Post()
  @UseInterceptors(FilesInterceptor('files', MAX_FILES, { storage: memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: MAX_FILES } }))
  async upload(@CurrentUser() u: AuthUser, @UploadedFiles() files: Express.Multer.File[], @Body('names') names: string | undefined, @Req() req: Request) {
    let list: string[] = [];
    if (names) {
      try {
        const parsed = JSON.parse(names);
        if (Array.isArray(parsed)) list = parsed.map((n) => String(n ?? ''));
      } catch {
        throw new BadRequestException('Field names tidak valid.');
      }
    }
    return { files: await this.uploads.save(u.id, files, list, req.ip) };
  }

  @Get(':id')
  async download(@CurrentUser() u: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const { file, stream } = await this.uploads.open(u.id, id);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name.split('/').pop()!)}`);
    stream.pipe(res);
  }

  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.uploads.remove(u.id, id);
  }
}
