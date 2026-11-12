import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { PrismaService } from '../common/prisma.service';

class CreateConversationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() modelId?: string;
}
class UpdateConversationDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) title: string;
}
class ListQuery {
  @ApiPropertyOptional({ description: 'Cari judul atau isi pesan (CHAT-11)' }) @IsOptional() @IsString() @MaxLength(200) q?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @ApiPropertyOptional({ description: 'Cursor = id percakapan terakhir dari halaman sebelumnya' }) @IsOptional() @IsString() cursor?: string;
}

@ApiTags('Conversations')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateConversationDto) {
    return this.prisma.conversation.create({
      data: { userId: u.id, title: dto.title?.trim() || 'New Chat', modelId: dto.modelId },
      select: { id: true, title: true, modelId: true, createdAt: true, updatedAt: true },
    });
  }

  @Get()
  async list(@CurrentUser() u: AuthUser, @Query() q: ListQuery) {
    const limit = q.limit ?? 50;
    const search = q.q?.trim();
    const items = await this.prisma.conversation.findMany({
      where: {
        userId: u.id,
        deletedAt: null,
        ...(search
          ? { OR: [{ title: { contains: search } }, { messages: { some: { content: { contains: search } } } }] }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: { id: true, title: true, modelId: true, createdAt: true, updatedAt: true },
    });
    const hasMore = items.length > limit;
    return { items: items.slice(0, limit), nextCursor: hasMore ? items[limit - 1].id : null };
  }

  @Get(':id')
  async detail(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, userId: u.id, deletedAt: null },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true, role: true, content: true, modelId: true, inputTokens: true, outputTokens: true,
            toolEvents: true, isError: true, createdAt: true,
            attachments: { select: { id: true, source: true, name: true, path: true, size: true, truncated: true } },
            model: { select: { displayName: true, provider: true } },
          },
        },
      },
    });
    if (!conv) throw new NotFoundException('Percakapan tidak ditemukan');
    return conv;
  }

  @Patch(':id')
  async rename(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateConversationDto) {
    const r = await this.prisma.conversation.updateMany({
      where: { id, userId: u.id, deletedAt: null },
      data: { title: dto.title.trim() },
    });
    if (!r.count) throw new NotFoundException('Percakapan tidak ditemukan');
    return { id, title: dto.title.trim() };
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const r = await this.prisma.conversation.updateMany({
      where: { id, userId: u.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (!r.count) throw new NotFoundException('Percakapan tidak ditemukan');
    return { ok: true };
  }
}
