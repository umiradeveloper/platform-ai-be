import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { KnowledgeService } from './knowledge.service';

class CreateIndexDto {
  @ApiProperty({ example: '/proyek/Tower B' }) @IsString() @MinLength(2) @MaxLength(1024) path: string;
}
class UpdateIndexDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() autoRefresh?: boolean;
}
class SearchQuery {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(500) q: string;
}

@ApiTags('Knowledge')
@ApiBearerAuth()
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  /** Daftar folder basis pengetahuan milik user + status indeks. */
  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.knowledge.list(u.id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateIndexDto, @Req() req: Request) {
    return this.knowledge.create(u.id, dto.path, req.ip);
  }

  @HttpCode(200)
  @Post(':id/reindex')
  reindex(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.knowledge.reindex(u.id, id);
  }

  @Patch(':id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateIndexDto) {
    return this.knowledge.update(u.id, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string, @Req() req: Request) {
    return this.knowledge.remove(u.id, id, req.ip);
  }

  /** Uji pencarian: potongan teks paling relevan dari seluruh folder user. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('search')
  async search(@CurrentUser() u: AuthUser, @Query() q: SearchQuery) {
    const hits = await this.knowledge.search(u.id, q.q);
    return { q: q.q, hits: hits.map((h) => ({ ...h, text: h.text.length > 600 ? `${h.text.slice(0, 600)}…` : h.text })) };
  }
}
