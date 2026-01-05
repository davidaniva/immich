import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsNumber, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';

export class GooglePhotosImportFromDriveDto {
  @IsArray()
  @IsString({ each: true })
  @ApiProperty({ description: 'Array of Google Drive file IDs to import' })
  fileIds!: string[];
}

export class GooglePhotosImportJobDto {
  @IsUUID()
  @ApiProperty({ description: 'Import job ID' })
  id!: string;
}

export type ActivityEventType = 'info' | 'success' | 'error' | 'download' | 'upload' | 'album';

export class ActivityEventDto {
  @IsString()
  @ApiProperty({ description: 'Event timestamp' })
  timestamp!: string;

  @IsString()
  @ApiProperty({ enum: ['info', 'success', 'error', 'download', 'upload', 'album'] })
  type!: ActivityEventType;

  @IsString()
  @ApiProperty({ description: 'Event message' })
  message!: string;
}

export class GooglePhotosImportProgressDto {
  @ApiProperty({ enum: ['downloading', 'processing', 'complete', 'failed'] })
  phase!: 'downloading' | 'processing' | 'complete' | 'failed';

  @ApiProperty({ description: 'Current progress count' })
  current!: number;

  @ApiProperty({ description: 'Total items to process' })
  total!: number;

  @IsOptional()
  @IsString()
  @ApiProperty({ description: 'Current file being processed', required: false })
  currentFile?: string;

  @ApiProperty({ description: 'Number of albums found' })
  albumsFound!: number;

  @ApiProperty({ description: 'Number of photos imported' })
  photosImported!: number;

  @IsOptional()
  @IsNumber()
  @ApiProperty({ description: 'Bytes downloaded so far', required: false })
  bytesDownloaded?: number;

  @IsOptional()
  @IsNumber()
  @ApiProperty({ description: 'Total bytes to download', required: false })
  totalBytes?: number;

  @IsArray()
  @IsString({ each: true })
  @ApiProperty({ description: 'List of errors encountered' })
  errors!: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ActivityEventDto)
  @ApiProperty({ type: [ActivityEventDto], description: 'Activity timeline events' })
  events!: ActivityEventDto[];
}

export class GoogleDriveFileDto {
  @IsString()
  @ApiProperty({ description: 'Google Drive file ID' })
  id!: string;

  @IsString()
  @ApiProperty({ description: 'File name' })
  name!: string;

  @ApiProperty({ description: 'File size in bytes' })
  size!: number;

  @IsString()
  @ApiProperty({ description: 'Creation timestamp' })
  createdTime!: string;

  @IsString()
  @ApiProperty({ description: 'MIME type' })
  mimeType!: string;
}

export class GoogleDriveFilesResponseDto {
  @IsArray()
  @ApiProperty({ type: [GoogleDriveFileDto] })
  files!: GoogleDriveFileDto[];
}

// ============ Fly Worker DTOs ============

export class ImportFromDriveWorkerDto {
  @IsArray()
  @IsString({ each: true })
  @ApiProperty({ description: 'Array of Google Drive file IDs to import' })
  fileIds!: string[];

  @IsArray()
  @IsNumber({}, { each: true })
  @ApiProperty({ description: 'Array of file sizes in bytes (for volume sizing)' })
  fileSizes!: number[];
}

export class WorkerProgressPayloadDto {
  @IsNumber()
  @ApiProperty({ description: 'Current progress count' })
  current!: number;

  @IsNumber()
  @ApiProperty({ description: 'Total items to process' })
  total!: number;

  @IsOptional()
  @IsString()
  @ApiProperty({ description: 'Current file being processed', required: false })
  currentFile?: string;
}

export class WorkerProgressDto {
  @IsUUID()
  @ApiProperty({ description: 'Job ID' })
  jobId!: string;

  @IsString()
  @ApiProperty({ enum: ['downloading', 'processing', 'complete', 'failed'] })
  phase!: 'downloading' | 'processing' | 'complete' | 'failed';

  @ValidateNested()
  @Type(() => WorkerProgressPayloadDto)
  @ApiProperty({ type: WorkerProgressPayloadDto })
  progress!: WorkerProgressPayloadDto;

  @IsOptional()
  @IsNumber()
  @ApiProperty({ description: 'Bytes downloaded so far', required: false })
  bytesDownloaded?: number;

  @IsOptional()
  @IsNumber()
  @ApiProperty({ description: 'Total bytes to download', required: false })
  totalBytes?: number;

  @IsOptional()
  @IsNumber()
  @ApiProperty({ description: 'Number of photos imported', required: false })
  photosImported?: number;

  @IsOptional()
  @IsNumber()
  @ApiProperty({ description: 'Number of albums found', required: false })
  albumsFound?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ApiProperty({ description: 'List of errors', required: false })
  errors?: string[];
}

export class FlyWorkerJobResponseDto {
  @IsUUID()
  @ApiProperty({ description: 'Job ID' })
  id!: string;

  @IsString()
  @ApiProperty({ description: 'Fly machine ID' })
  machineId!: string;

  @IsString()
  @ApiProperty({ description: 'Fly volume ID' })
  volumeId!: string;
}

export type FlyWorkerJobStatus =
  | 'pending'
  | 'creating'
  | 'downloading'
  | 'processing'
  | 'complete'
  | 'failed'
  | 'cleanup';

export interface FlyWorkerJobMetadata {
  jobId: string;
  userId: string;
  machineId: string;
  volumeId: string;
  status: FlyWorkerJobStatus;
  progress: GooglePhotosImportProgressDto;
  webhookSecret: string;
  tempApiKeyId: string;
  createdAt: string;
  updatedAt: string;
}
