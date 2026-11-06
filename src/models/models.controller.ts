import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../common/prisma.service';

@ApiTags('AI Models')
@ApiBearerAuth()
@Controller('models')
export class ModelsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Daftar model aktif untuk Model Selector — tanpa info kredensial atau harga internal. */
  @Get()
  async list() {
    const disabled = await this.prisma.providerConfig.findMany({ where: { isEnabled: false }, select: { type: true } });
    return this.prisma.aIModel.findMany({
      where: { isActive: true, provider: { notIn: disabled.map((d) => d.type) } },
      orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
      select: { id: true, provider: true, displayName: true, description: true, isDefault: true, maxContextTokens: true },
    });
  }
}
