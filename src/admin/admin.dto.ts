import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { ProviderType, UserRole } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsEnum, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

export class CreateModelDto {
  @ApiProperty({ enum: ProviderType }) @IsEnum(ProviderType) provider: ProviderType;
  @ApiProperty({ example: 'hermes-agent' }) @IsString() @MinLength(1) @MaxLength(150) modelName: string;
  @ApiProperty({ example: 'Hermes Agent' }) @IsString() @MinLength(1) @MaxLength(100) displayName: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1000) @Max(10_000_000) maxContextTokens?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(64) @Max(1_000_000) maxOutputTokens?: number;
  @ApiPropertyOptional({ description: 'USD per 1 juta token input' }) @IsOptional() @Type(() => Number) @IsNumber() @Min(0) inputPricePer1M?: number;
  @ApiPropertyOptional({ description: 'USD per 1 juta token output' }) @IsOptional() @Type(() => Number) @IsNumber() @Min(0) outputPricePer1M?: number;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() fallbackModelId?: string | null;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
}

export class UpdateModelDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(150) modelName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) displayName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1000) @Max(10_000_000) maxContextTokens?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(64) @Max(1_000_000) maxOutputTokens?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() @Min(0) inputPricePer1M?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() @Min(0) outputPricePer1M?: number;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() fallbackModelId?: string | null;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
}

export class UpdateUserDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @ApiPropertyOptional({ enum: UserRole }) @IsOptional() @IsEnum(UserRole) role?: UserRole;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({ nullable: true, description: 'null = ikut default sistem, 0 = tanpa batas' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @Type(() => Number) @IsInt() @Min(0) dailyTokenLimit?: number | null;
}

export class CreateUserDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(100) name: string;
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(128) password: string;
  @ApiPropertyOptional({ enum: UserRole }) @IsOptional() @IsEnum(UserRole) role?: UserRole;
}

export class UpdateProviderDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) displayName?: string;
  @ApiPropertyOptional({ example: 'http://host.docker.internal:8642/v1' })
  @IsOptional() @ValidateIf((_, v) => v !== '' && v !== null) @IsUrl({ require_tld: false, require_protocol: true }) baseUrl?: string | null;
  @ApiPropertyOptional({ description: 'Kosongkan/omit untuk tidak mengubah. String kosong "" = hapus key dari DB.' })
  @IsOptional() @IsString() @MaxLength(500) apiKey?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() extraHeaders?: Record<string, string>;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isEnabled?: boolean;
}

export class UpdateSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) appName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(8000) systemPrompt?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowRegistration?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) defaultDailyTokenLimit?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(100) @Max(500_000) maxMessageChars?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(2) @Max(500) maxHistoryMessages?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() autoTitle?: boolean;
}
