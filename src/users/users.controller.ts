import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { PrismaService } from '../common/prisma.service';
import { AuthService, publicUser } from '../auth/auth.service';

class UpdateProfileDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(100) name: string;
}
class ChangePasswordDto {
  @ApiProperty() @IsString() currentPassword: string;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(128) newPassword: string;
}

@ApiTags('Profile')
@ApiBearerAuth()
@Controller('me')
export class UsersController {
  constructor(private readonly prisma: PrismaService, private readonly auth: AuthService) {}

  @Get()
  async me(@CurrentUser() u: AuthUser) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    return publicUser(user);
  }

  @Patch()
  async update(@CurrentUser() u: AuthUser, @Body() dto: UpdateProfileDto) {
    const user = await this.prisma.user.update({ where: { id: u.id }, data: { name: dto.name.trim() } });
    return publicUser(user);
  }

  @HttpCode(200)
  @Post('password')
  async password(@CurrentUser() u: AuthUser, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(u.id, dto.currentPassword, dto.newPassword);
    return { ok: true };
  }
}
