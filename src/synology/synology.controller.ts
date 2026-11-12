import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { PrismaService } from '../common/prisma.service';
import { SynologyService } from './synology.service';

class ConnectDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128) account: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(256) password: string;
  @ApiPropertyOptional({ description: 'Kode OTP 2FA (6 digit) bila diminta' }) @IsOptional() @Matches(/^\d{6,8}$/, { message: 'Kode OTP harus 6–8 digit' }) otp?: string;
  @ApiPropertyOptional({ description: 'Simpan password terenkripsi agar tersambung otomatis' }) @IsOptional() @IsBoolean() remember?: boolean;
}
class BrowseQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1024) path?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit?: number;
}
class SearchQuery {
  @ApiProperty() @IsString() @MaxLength(1024) path: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(100) q: string;
}
class SaveMessageDto {
  @ApiProperty() @IsString() messageId: string;
  @ApiProperty({ example: '/proyek/Tower B/Laporan' }) @IsString() @MaxLength(1024) folder: string;
  @ApiProperty({ example: 'ringkasan-progres.md' }) @IsString() @MinLength(1) @MaxLength(150) filename: string;
}

@ApiTags('Synology')
@ApiBearerAuth()
@Controller('synology')
export class SynologyController {
  constructor(
    private readonly synology: SynologyService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('status')
  status(@CurrentUser() u: AuthUser) {
    return this.synology.status(u.id);
  }

  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @HttpCode(200)
  @Post('connect')
  connect(@CurrentUser() u: AuthUser, @Body() dto: ConnectDto, @Req() req: Request) {
    return this.synology.connect(u.id, dto.account.trim(), dto.password, dto.otp, !!dto.remember, req.ip);
  }

  @HttpCode(200)
  @Delete('connect')
  disconnect(@CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.synology.disconnect(u.id, req.ip);
  }

  @Get('browse')
  browse(@CurrentUser() u: AuthUser, @Query() q: BrowseQuery) {
    return this.synology.browse(u.id, q.path, q.offset, q.limit);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('search')
  search(@CurrentUser() u: AuthUser, @Query() q: SearchQuery) {
    return this.synology.search(u.id, q.path, q.q);
  }

  /** Simpan jawaban AI (milik user sendiri) sebagai file Markdown ke folder Synology. */
  @HttpCode(200)
  @Post('save-message')
  async saveMessage(@CurrentUser() u: AuthUser, @Body() dto: SaveMessageDto, @Req() req: Request) {
    const msg = await this.prisma.message.findFirst({
      where: { id: dto.messageId, role: 'ASSISTANT', conversation: { userId: u.id, deletedAt: null } },
      select: { content: true, conversation: { select: { title: true } } },
    });
    if (!msg) throw new NotFoundException('Pesan tidak ditemukan');
    const header = `# ${msg.conversation.title}\n\n_Dibuat dengan Umira AI · ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}_\n\n`;
    return this.synology.saveText(u.id, dto.folder, dto.filename, header + msg.content, req.ip);
  }
}
