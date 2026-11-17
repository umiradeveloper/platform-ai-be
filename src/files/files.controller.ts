import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { IsString, MaxLength } from 'class-validator';
import { SynologyService } from '../synology/synology.service';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { HermesFilesService } from './hermes-files.service';

class SaveToSynologyDto {
  @IsString() @MaxLength(1024) folder: string;
}

const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|audio\/|video\/)/;

@ApiTags('Files')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  constructor(
    private readonly files: HermesFilesService,
    private readonly synology: SynologyService,
  ) {}

  /** Unduh file hasil Hermes (hanya pemiliknya). `?inline=1` untuk pratinjau gambar/PDF. */
  @ApiQuery({ name: 'inline', required: false })
  @Get(':id')
  async download(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('inline') inline: string | undefined, @Res() res: Response) {
    const { file, stream } = await this.files.open(u.id, id);
    // SVG/HTML tidak pernah ditampilkan inline (bisa memuat skrip)
    const asInline = inline === '1' && INLINE_SAFE.test(file.mimeType);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `${asInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    stream.pipe(res);
  }

  /** Salin file hasil Hermes ke folder Synology milik user. */
  @HttpCode(200)
  @Post(':id/save-to-synology')
  async saveToSynology(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SaveToSynologyDto, @Req() req: Request) {
    const { file, buf } = await this.files.readAll(u.id, id);
    return this.synology.saveFile(u.id, dto.folder, file.name, buf, file.mimeType, req.ip);
  }
}
