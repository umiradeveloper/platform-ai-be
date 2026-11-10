import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(100) name: string;
  @ApiProperty() @IsEmail() @MaxLength(191) email: string;
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) @MaxLength(128) password: string;
}

export class LoginDto {
  @ApiPropertyOptional({ description: 'Email atau username (akun SuperApps / akun lokal)' })
  @IsOptional() @IsString() @MinLength(1) @MaxLength(191) identifier?: string;
  @ApiPropertyOptional({ description: 'Alias lama untuk identifier' }) @IsOptional() @IsString() @MaxLength(191) email?: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128) password: string;
}

export class ForgotPasswordDto {
  @ApiProperty() @IsEmail() email: string;
}

export class ResetPasswordDto {
  @ApiProperty() @IsString() @MinLength(10) token: string;
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) @MaxLength(128) password: string;
}
