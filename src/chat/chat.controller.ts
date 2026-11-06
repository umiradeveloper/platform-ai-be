import { Body, Controller, HttpCode, HttpException, Param, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { ChatService, Emit } from './chat.service';

class SendMessageDto {
  @ApiPropertyOptional({ description: 'Kosongkan untuk membuat percakapan baru' }) @IsOptional() @IsString() conversationId?: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200_000) content: string;
  @ApiPropertyOptional() @IsOptional() @IsString() modelId?: string;
}
class RegenerateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() modelId?: string;
}

/**
 * Penulis SSE "malas": header SSE baru dikirim saat event pertama, sehingga error validasi
 * (kuota habis, model nonaktif, dsb.) yang terjadi sebelumnya tetap dikembalikan sebagai HTTP error biasa.
 */
function sseWriter(req: Request, res: Response) {
  const abort = new AbortController();
  let started = false;
  let ping: NodeJS.Timeout | undefined;
  res.on('close', () => {
    if (!res.writableFinished) abort.abort('client_disconnect');
    if (ping) clearInterval(ping);
  });
  const emit: Emit = (event, data) => {
    if (!started) {
      started = true;
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // matikan buffering Nginx
      res.flushHeaders();
      // keepalive: agent seperti Hermes bisa diam lama saat menjalankan tool
      ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const end = () => {
    if (ping) clearInterval(ping);
    if (!res.writableEnded) res.end();
  };
  return { emit, end, signal: abort.signal, get started() { return started; } };
}

@ApiTags('Chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @ApiOperation({ summary: 'Kirim pesan dan tunggu jawaban lengkap (non-streaming)' })
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('completions')
  async complete(@CurrentUser() u: AuthUser, @Body() dto: SendMessageDto) {
    const events: { event: string; data: unknown }[] = [];
    const r = await this.chat.send(u, dto, (event, data) => {
      if (event === 'tool' || event === 'fallback') events.push({ event, data });
    });
    return { ...r, events };
  }

  @ApiOperation({
    summary: 'Kirim pesan dengan streaming SSE',
    description: 'Event: meta, title, delta {text}, tool {tool,label,status}, fallback, done, error',
  })
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('completions/stream')
  async stream(@CurrentUser() u: AuthUser, @Body() dto: SendMessageDto, @Req() req: Request, @Res() res: Response) {
    const sse = sseWriter(req, res);
    try {
      await this.chat.send(u, dto, sse.emit, sse.signal);
    } catch (e) {
      if (!sse.started) return this.httpError(res, e);
      sse.emit('error', { message: e?.message ?? 'Terjadi kesalahan' });
    }
    sse.end();
  }

  @ApiOperation({ summary: 'Generate ulang jawaban terakhir (SSE)' })
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/regenerate')
  async regenerate(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: RegenerateDto, @Req() req: Request, @Res() res: Response) {
    const sse = sseWriter(req, res);
    try {
      await this.chat.regenerate(u, id, dto.modelId, sse.emit, sse.signal);
    } catch (e) {
      if (!sse.started) return this.httpError(res, e);
      sse.emit('error', { message: e?.message ?? 'Terjadi kesalahan' });
    }
    sse.end();
  }

  @ApiOperation({ summary: 'Hentikan generasi yang sedang berjalan pada percakapan' })
  @HttpCode(200)
  @Post(':id/stop')
  stop(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chat.requestStop(u, id);
  }

  private httpError(res: Response, e: any) {
    const status = e instanceof HttpException ? e.getStatus() : 500;
    const body = e instanceof HttpException ? e.getResponse() : { statusCode: 500, message: 'Terjadi kesalahan pada server' };
    res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
  }
}
