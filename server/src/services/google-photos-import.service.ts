import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  GooglePhotosImportProgressDto,
  GoogleDriveFileDto,
  FlyWorkerJobMetadata,
  FlyWorkerJobResponseDto,
  WorkerProgressDto,
  ActivityEventType,
} from 'src/dtos/google-photos-import.dto';
import { Permission, UserMetadataKey } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { FlyWorkerService } from 'src/services/fly-worker.service';

// System metadata key prefix for Fly worker jobs
const FLY_WORKER_JOB_PREFIX = 'fly-worker-job:';

interface ImportJob {
  id: string;
  userId: string;
  status: 'pending' | 'downloading' | 'processing' | 'complete' | 'failed';
  progress: GooglePhotosImportProgressDto;
  createdAt: Date;
  driveFileIds: string[];
  localFiles: string[];
  tempApiKeyId?: string;
  abortController?: AbortController;
}

@Injectable()
export class GooglePhotosImportService extends BaseService {
  private readonly jobs = new Map<string, ImportJob>();
  private readonly tempDir = '/tmp/immich-google-photos-import';
  private flyWorkerService?: FlyWorkerService;

  // Lazy initialization of FlyWorkerService to avoid circular dependencies
  private getFlyWorkerService(): FlyWorkerService {
    if (!this.flyWorkerService) {
      this.flyWorkerService = new FlyWorkerService();
    }
    return this.flyWorkerService;
  }

  // Google Drive token management
  async saveGoogleDriveTokens(
    userId: string,
    tokens: { accessToken: string; refreshToken?: string; expiresIn?: number },
  ): Promise<void> {
    const expiresAt = tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
      : undefined;

    await this.userRepository.upsertMetadata(userId, {
      key: UserMetadataKey.GoogleDriveTokens,
      value: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt,
      },
    });
  }

  async getGoogleDriveTokens(
    userId: string,
  ): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string } | null> {
    const user = await this.userRepository.get(userId, { withDeleted: false });
    if (!user?.metadata) {
      return null;
    }

    const tokenMetadata = user.metadata.find(
      (m) => m.key === UserMetadataKey.GoogleDriveTokens,
    );

    if (!tokenMetadata) {
      return null;
    }

    return tokenMetadata.value as {
      accessToken: string;
      refreshToken?: string;
      expiresAt?: string;
    };
  }

  async deleteGoogleDriveTokens(userId: string): Promise<void> {
    await this.userRepository.deleteMetadata(userId, UserMetadataKey.GoogleDriveTokens);
  }

  async isGoogleDriveConnected(userId: string): Promise<boolean> {
    const tokens = await this.getGoogleDriveTokens(userId);
    return tokens !== null;
  }

  // Get OAuth config from Immich's system config
  async getOAuthConfig() {
    const config = await this.getConfig({ withCache: true });
    return config.oauth;
  }

  async createImportJob(userId: string, files: Express.Multer.File[]): Promise<{ id: string }> {
    const jobId = this.cryptoRepository.randomUUID();
    const jobDir = path.join(this.tempDir, jobId);

    await mkdir(jobDir, { recursive: true });

    // Save uploaded files to temp directory
    const savedFiles: string[] = [];
    for (const file of files) {
      const filePath = path.join(jobDir, file.originalname);
      const writeStream = createWriteStream(filePath);
      await pipeline(Readable.from(file.buffer), writeStream);
      savedFiles.push(filePath);
    }

    const job: ImportJob = {
      id: jobId,
      userId,
      status: 'pending',
      progress: {
        phase: 'downloading',
        current: 0,
        total: files.length,
        albumsFound: 0,
        photosImported: 0,
        errors: [],
        events: [],
      },
      createdAt: new Date(),
      driveFileIds: [],
      localFiles: savedFiles,
    };

    this.jobs.set(jobId, job);

    // Start processing in background
    this.processImportJob(job).catch((error) => {
      this.logger.error(`Import job ${jobId} failed: ${error}`);
      job.status = 'failed';
      job.progress.errors.push(error.message);
    });

    return { id: jobId };
  }

  async createImportJobFromDrive(userId: string, fileIds: string[]): Promise<{ id: string }> {
    const jobId = this.cryptoRepository.randomUUID();

    const job: ImportJob = {
      id: jobId,
      userId,
      status: 'pending',
      progress: {
        phase: 'downloading',
        current: 0,
        total: fileIds.length,
        albumsFound: 0,
        photosImported: 0,
        errors: [],
        events: [],
      },
      createdAt: new Date(),
      driveFileIds: fileIds,
      localFiles: [],
    };

    this.jobs.set(jobId, job);

    // Start processing in background
    this.processImportJob(job).catch((error) => {
      this.logger.error(`Import job ${jobId} failed: ${error}`);
      job.status = 'failed';
      job.progress.errors.push(error.message);
    });

    return { id: jobId };
  }

  getJobProgress(jobId: string): GooglePhotosImportProgressDto | null {
    const job = this.jobs.get(jobId);
    return job?.progress ?? null;
  }

  async cancelJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job) {
      job.abortController?.abort();
      job.status = 'failed';
      job.progress.errors.push('Cancelled by user');
      await this.cleanupJob(job);
    }
  }

  private async processImportJob(job: ImportJob): Promise<void> {
    const jobDir = path.join(this.tempDir, job.id);
    job.abortController = new AbortController();

    try {
      await mkdir(jobDir, { recursive: true });

      // Phase 1: Download files from Google Drive if needed
      if (job.driveFileIds.length > 0) {
        job.status = 'downloading';
        job.progress.phase = 'downloading';

        const tokens = await this.getGoogleDriveTokens(job.userId);
        if (!tokens) {
          throw new Error('Google Drive not connected');
        }

        for (let i = 0; i < job.driveFileIds.length; i++) {
          if (job.abortController.signal.aborted) {
            throw new Error('Import cancelled');
          }

          const fileId = job.driveFileIds[i];
          job.progress.current = i + 1;
          job.progress.currentFile = `Downloading file ${i + 1}/${job.driveFileIds.length}`;

          const filePath = await this.downloadFromDrive(fileId, jobDir, tokens.accessToken);
          job.localFiles.push(filePath);
        }
      }

      // Phase 2: Create temporary API key for immich-go
      job.status = 'processing';
      job.progress.phase = 'processing';
      job.progress.current = 0;
      job.progress.total = 0; // Will be updated by immich-go output

      const apiKey = await this.createTemporaryApiKey(job.userId);
      job.tempApiKeyId = apiKey.id;

      // Phase 3: Run immich-go
      const serverUrl = await this.getServerUrl();
      await this.runImmichGo(job, serverUrl, apiKey.secret);

      // Complete
      job.progress.phase = 'complete';
      job.status = 'complete';
    } finally {
      await this.cleanupJob(job);
    }
  }

  private async downloadFromDrive(
    fileId: string,
    targetDir: string,
    accessToken: string,
  ): Promise<string> {
    // First get file metadata to get the filename
    const metadataResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,size`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!metadataResponse.ok) {
      throw new Error(`Failed to get file metadata: ${metadataResponse.status}`);
    }

    const metadata = await metadataResponse.json();
    const filePath = path.join(targetDir, metadata.name);

    // Download the file
    const downloadResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!downloadResponse.ok) {
      throw new Error(`Failed to download file: ${downloadResponse.status}`);
    }

    const writeStream = createWriteStream(filePath);
    await pipeline(Readable.fromWeb(downloadResponse.body as any), writeStream);

    return filePath;
  }

  private async createTemporaryApiKey(
    userId: string,
  ): Promise<{ id: string; secret: string }> {
    const token = this.cryptoRepository.randomBytesAsText(32);
    const tokenHashed = this.cryptoRepository.hashSha256(token);

    const permissions = [
      Permission.UserRead,
      Permission.AssetUpload,
      Permission.AssetRead,
      Permission.AlbumCreate,
      Permission.AlbumRead,
      Permission.AlbumUpdate,
      Permission.AlbumAssetCreate,
    ];

    const entity = await this.apiKeyRepository.create({
      key: tokenHashed,
      name: 'Google Photos Import (temporary)',
      userId,
      permissions,
    });

    return { id: entity.id, secret: token };
  }

  private async getServerUrl(): Promise<string> {
    const config = await this.getConfig({ withCache: true });
    // Use internal server URL for immich-go running on same container
    return config.server.externalDomain || 'http://localhost:2283';
  }

  private async runImmichGo(
    job: ImportJob,
    serverUrl: string,
    apiKey: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        'upload',
        'from-google-photos',
        `--server=${serverUrl}`,
        `--api-key=${apiKey}`,
        '--create-albums',
        ...job.localFiles,
      ];

      this.logger.log(`Running immich-go with args: ${args.join(' ').replace(apiKey, '***')}`);

      const proc = spawn('immich-go', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;
        this.parseImmichGoOutput(job, output);
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          this.logger.error(`immich-go failed with code ${code}: ${stderr}`);
          reject(new Error(`immich-go failed: ${stderr || 'Unknown error'}`));
        }
      });

      proc.on('error', (error) => {
        reject(error);
      });

      // Handle abort
      job.abortController?.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
      });
    });
  }

  private parseImmichGoOutput(job: ImportJob, output: string): void {
    // Parse immich-go output to update progress
    // Output format varies, but typically includes lines like:
    // "Uploading: filename.jpg"
    // "Uploaded X/Y assets"
    // "Created album: Album Name"

    const lines = output.split('\n');
    for (const line of lines) {
      // Match upload progress patterns
      const uploadMatch = line.match(/(\d+)\/(\d+)/);
      if (uploadMatch) {
        job.progress.current = parseInt(uploadMatch[1], 10);
        job.progress.total = parseInt(uploadMatch[2], 10);
      }

      // Match current file being processed
      const fileMatch = line.match(/(?:Uploading|Processing):\s*(.+)/i);
      if (fileMatch) {
        job.progress.currentFile = fileMatch[1].trim();
      }

      // Match album creation
      const albumMatch = line.match(/(?:Created|Found) album/i);
      if (albumMatch) {
        job.progress.albumsFound++;
      }

      // Match errors
      if (line.toLowerCase().includes('error')) {
        job.progress.errors.push(line.trim());
      }
    }
  }

  private async cleanupJob(job: ImportJob): Promise<void> {
    // Delete temporary API key
    if (job.tempApiKeyId) {
      try {
        await this.apiKeyRepository.delete(job.userId, job.tempApiKeyId);
      } catch (error) {
        this.logger.warn(`Failed to delete temporary API key: ${error}`);
      }
    }

    // Delete temp files
    const jobDir = path.join(this.tempDir, job.id);
    try {
      await rm(jobDir, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn(`Failed to cleanup temp directory: ${error}`);
    }
  }

  // Google Drive API methods
  async getGoogleDriveFiles(accessToken: string): Promise<GoogleDriveFileDto[]> {
    const allFiles: GoogleDriveFileDto[] = [];

    this.logger.log('Searching Google Drive for Takeout files...');

    // Search for zip files with "takeout" in the name
    const zipResponse = await fetch(
      'https://www.googleapis.com/drive/v3/files?' +
        new URLSearchParams({
          q: "name contains 'takeout'",
          fields: 'files(id,name,size,createdTime,mimeType,parents)',
          orderBy: 'createdTime desc',
          pageSize: '100',
        }),
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (zipResponse.ok) {
      const data = await zipResponse.json();
      this.logger.log(`Found ${data.files?.length || 0} files with 'takeout' in name`);
      for (const file of data.files || []) {
        if (
          file.mimeType === 'application/zip' ||
          file.mimeType === 'application/x-zip-compressed' ||
          file.name.endsWith('.zip')
        ) {
          allFiles.push(file);
        }
      }
    } else {
      const errorText = await zipResponse.text();
      this.logger.error(`Failed to search for takeout files: ${zipResponse.status} - ${errorText}`);
    }

    // Also search for folders containing "Takeout"
    const folderResponse = await fetch(
      'https://www.googleapis.com/drive/v3/files?' +
        new URLSearchParams({
          q: "name contains 'Takeout' and mimeType = 'application/vnd.google-apps.folder'",
          fields: 'files(id,name)',
        }),
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (folderResponse.ok) {
      const folderData = await folderResponse.json();
      const takeoutFolders = folderData.files || [];
      this.logger.log(`Found ${takeoutFolders.length} folders named 'Takeout'`);

      for (const folder of takeoutFolders) {
        const filesInFolderResponse = await fetch(
          'https://www.googleapis.com/drive/v3/files?' +
            new URLSearchParams({
              q: `'${folder.id}' in parents and (mimeType='application/zip' or mimeType='application/x-zip-compressed')`,
              fields: 'files(id,name,size,createdTime,mimeType)',
              orderBy: 'createdTime desc',
            }),
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          },
        );

        if (filesInFolderResponse.ok) {
          const filesData = await filesInFolderResponse.json();
          for (const file of filesData.files || []) {
            if (!allFiles.some((f) => f.id === file.id)) {
              allFiles.push(file);
            }
          }
        }
      }
    }

    // If still no files found, search for ALL zip files as fallback
    if (allFiles.length === 0) {
      this.logger.log('No takeout files found, searching for ALL zip files...');
      const allZipsResponse = await fetch(
        'https://www.googleapis.com/drive/v3/files?' +
          new URLSearchParams({
            q: "mimeType='application/zip' or mimeType='application/x-zip-compressed'",
            fields: 'files(id,name,size,createdTime,mimeType)',
            orderBy: 'createdTime desc',
            pageSize: '100',
          }),
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (allZipsResponse.ok) {
        const allZipsData = await allZipsResponse.json();
        const takeoutLikeFiles = (allZipsData.files || []).filter(
          (file: { name: string }) =>
            file.name.toLowerCase().startsWith('takeout') ||
            file.name.toLowerCase().includes('takeout-'),
        );
        allFiles.push(...takeoutLikeFiles);
      }
    }

    this.logger.log(`Total files found: ${allFiles.length}`);

    // Sort by creation date descending
    allFiles.sort(
      (a, b) => new Date(b.createdTime).getTime() - new Date(a.createdTime).getTime(),
    );

    return allFiles;
  }

  // ============ Fly Worker Methods ============

  /**
   * Create an import job using an ephemeral Fly worker
   */
  async createImportJobWithFlyWorker(
    userId: string,
    fileIds: string[],
    fileSizes: number[],
  ): Promise<FlyWorkerJobResponseDto> {
    const jobId = this.cryptoRepository.randomUUID();
    const webhookSecret = this.cryptoRepository.randomBytesAsText(32);

    this.logger.log(`Creating Fly worker import job ${jobId} for user ${userId}`);

    // Get Google Drive tokens
    const tokens = await this.getGoogleDriveTokens(userId);
    if (!tokens) {
      throw new Error('Google Drive not connected');
    }

    // Get OAuth config from Immich settings (for token refresh on worker)
    const config = await this.getConfig({ withCache: true });
    const oauth = config.oauth;
    if (!oauth.enabled || !oauth.clientId || !oauth.clientSecret) {
      throw new Error('OAuth not configured. Please set up OAuth in Administration > Settings.');
    }

    // Create temporary API key for the worker
    const apiKey = await this.createTemporaryApiKey(userId);

    // Build webhook URL
    const serverUrl = config.server.externalDomain || process.env.IMMICH_URL;
    if (!serverUrl) {
      throw new Error('IMMICH_URL not configured');
    }
    const webhookUrl = `${serverUrl}/api/google-photos/worker-webhook`;

    // Initialize job metadata
    const now = new Date().toISOString();
    const jobMetadata: FlyWorkerJobMetadata = {
      jobId,
      userId,
      machineId: '',
      volumeId: '',
      status: 'creating',
      progress: {
        phase: 'downloading',
        current: 0,
        total: fileIds.length,
        albumsFound: 0,
        photosImported: 0,
        errors: [],
        events: [
          { timestamp: now, type: 'info', message: 'Starting import job...' },
        ],
      },
      webhookSecret,
      tempApiKeyId: apiKey.id,
      createdAt: now,
      updatedAt: now,
    };

    // Save initial job state
    await this.saveWorkerJob(jobMetadata);

    try {
      // Create Fly worker (volume + machine)
      const flyService = this.getFlyWorkerService();
      const { machineId, volumeId } = await flyService.createWorker({
        jobId,
        fileIds,
        fileSizes,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        immichApiKey: apiKey.secret,
        webhookUrl,
        webhookSecret,
        immichServerUrl: serverUrl,
        googleClientId: oauth.clientId,
        googleClientSecret: oauth.clientSecret,
      });

      // Update job with machine/volume IDs
      jobMetadata.machineId = machineId;
      jobMetadata.volumeId = volumeId;
      jobMetadata.status = 'downloading';
      jobMetadata.updatedAt = new Date().toISOString();
      this.addEvent(jobMetadata, 'success', 'Worker started successfully');
      this.addEvent(jobMetadata, 'info', `Preparing to download ${fileIds.length} files...`);
      await this.saveWorkerJob(jobMetadata);

      this.logger.log(`Fly worker started: machine=${machineId}, volume=${volumeId}`);

      return {
        id: jobId,
        machineId,
        volumeId,
      };
    } catch (error) {
      // Clean up on failure
      this.logger.error(`Failed to create Fly worker: ${error}`);
      jobMetadata.status = 'failed';
      jobMetadata.progress.errors.push(`Failed to create worker: ${error}`);
      jobMetadata.updatedAt = new Date().toISOString();
      await this.saveWorkerJob(jobMetadata);

      // Delete temp API key
      try {
        await this.apiKeyRepository.delete(userId, apiKey.id);
      } catch {}

      throw error;
    }
  }

  // Helper to add an event to the job's activity timeline
  private addEvent(job: FlyWorkerJobMetadata, type: ActivityEventType, message: string): void {
    job.progress.events.push({
      timestamp: new Date().toISOString(),
      type,
      message,
    });
    // Keep only last 100 events to prevent unbounded growth
    if (job.progress.events.length > 100) {
      job.progress.events = job.progress.events.slice(-100);
    }
  }

  // Stable JSON stringify with sorted keys for consistent signatures
  private stableStringify(obj: unknown): string {
    return JSON.stringify(obj, (key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value).sort().reduce((sorted: Record<string, unknown>, k) => {
          sorted[k] = (value as Record<string, unknown>)[k];
          return sorted;
        }, {});
      }
      return value;
    });
  }

  /**
   * Handle webhook progress updates from Fly worker
   */
  async handleWorkerWebhook(
    signature: string,
    payload: WorkerProgressDto,
    rawBody: string,
  ): Promise<void> {
    const { jobId, phase, progress, bytesDownloaded, totalBytes, photosImported, albumsFound, errors } = payload;

    // Get job metadata
    const job = await this.getWorkerJob(jobId);
    if (!job) {
      this.logger.warn(`Webhook for unknown job: ${jobId}`);
      throw new Error('Job not found');
    }

    // Verify HMAC signature using stable stringify (sorted keys)
    const payloadString = this.stableStringify(payload);
    const expectedSignature = createHmac('sha256', job.webhookSecret)
      .update(payloadString)
      .digest('hex');

    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      this.logger.warn(`Invalid webhook signature for job ${jobId}`);
      this.logger.warn(`  Received: ${signature}, Expected: ${expectedSignature}`);
      this.logger.warn(`  Payload: ${payloadString}`);
      throw new Error('Invalid signature');
    }

    const now = new Date().toISOString();
    const prevPhase = job.progress.phase;
    const prevCurrent = job.progress.current;

    // Update job progress
    job.status = phase === 'complete' ? 'complete' : phase === 'failed' ? 'failed' : phase;
    job.progress.phase = phase;
    job.progress.current = progress.current;
    job.progress.total = progress.total;
    job.progress.currentFile = progress.currentFile;
    job.progress.bytesDownloaded = bytesDownloaded;
    job.progress.totalBytes = totalBytes;

    if (photosImported !== undefined) {
      job.progress.photosImported = photosImported;
    }
    if (albumsFound !== undefined) {
      job.progress.albumsFound = albumsFound;
    }
    if (errors && errors.length > 0) {
      job.progress.errors.push(...errors);
      for (const error of errors) {
        this.addEvent(job, 'error', error);
      }
    }

    // Add events for phase transitions and progress
    if (phase !== prevPhase) {
      if (phase === 'downloading') {
        this.addEvent(job, 'info', 'Starting file downloads from Google Drive...');
      } else if (phase === 'processing') {
        this.addEvent(job, 'success', `Downloaded ${progress.total} files`);
        this.addEvent(job, 'info', 'Processing with immich-go...');
      } else if (phase === 'complete') {
        this.addEvent(job, 'success', `Import complete! ${job.progress.photosImported} photos imported.`);
      } else if (phase === 'failed') {
        this.addEvent(job, 'error', 'Import failed');
      }
    }

    // Add events for file downloads
    if (phase === 'downloading' && progress.currentFile && progress.current !== prevCurrent) {
      this.addEvent(job, 'download', `Downloading ${progress.currentFile}`);
    }

    // Add events for album creation
    if (albumsFound !== undefined && albumsFound > (job.progress.albumsFound || 0)) {
      this.addEvent(job, 'album', `Found ${albumsFound} albums`);
    }

    job.updatedAt = now;
    await this.saveWorkerJob(job);

    this.logger.log(`Webhook update for job ${jobId}: phase=${phase}, progress=${progress.current}/${progress.total}`);

    // Handle completion or failure
    if (phase === 'complete' || phase === 'failed') {
      // Start cleanup in background
      this.cleanupWorkerJob(jobId).catch((error) => {
        this.logger.error(`Failed to cleanup worker job ${jobId}: ${error}`);
      });
    }
  }

  /**
   * Get progress for a Fly worker job
   */
  async getWorkerJobProgress(jobId: string): Promise<GooglePhotosImportProgressDto | null> {
    const job = await this.getWorkerJob(jobId);
    if (!job) {
      // Fall back to in-memory jobs
      return this.getJobProgress(jobId);
    }
    this.logger.log(`Progress for job ${jobId}: current=${job.progress.current}, total=${job.progress.total}`);
    return job.progress;
  }

  /**
   * Cancel a Fly worker job
   */
  async cancelWorkerJob(jobId: string): Promise<void> {
    const job = await this.getWorkerJob(jobId);
    if (!job) {
      // Try canceling in-memory job
      return this.cancelJob(jobId);
    }

    job.status = 'failed';
    job.progress.errors.push('Cancelled by user');
    job.updatedAt = new Date().toISOString();
    await this.saveWorkerJob(job);

    // Clean up the worker
    await this.cleanupWorkerJob(jobId);
  }

  /**
   * Clean up Fly worker resources
   */
  async cleanupWorkerJob(jobId: string): Promise<void> {
    const job = await this.getWorkerJob(jobId);
    if (!job) {
      return;
    }

    this.logger.log(`Cleaning up Fly worker job ${jobId}`);
    job.status = 'cleanup';
    job.updatedAt = new Date().toISOString();
    await this.saveWorkerJob(job);

    // Delete temporary API key
    if (job.tempApiKeyId) {
      try {
        await this.apiKeyRepository.delete(job.userId, job.tempApiKeyId);
        this.logger.log(`Deleted temp API key for job ${jobId}`);
      } catch (error) {
        this.logger.warn(`Failed to delete temp API key: ${error}`);
      }
    }

    // Destroy Fly machine and volume
    if (job.machineId && job.volumeId) {
      try {
        const flyService = this.getFlyWorkerService();
        await flyService.cleanupWorker(job.machineId, job.volumeId);
        this.logger.log(`Destroyed Fly resources for job ${jobId}`);
      } catch (error) {
        this.logger.warn(`Failed to cleanup Fly resources: ${error}`);
      }
    }

    // Keep job metadata for a while for status queries, but mark as cleaned up
    job.updatedAt = new Date().toISOString();
    await this.saveWorkerJob(job);
  }

  // ============ Job Persistence Helpers ============

  private async saveWorkerJob(job: FlyWorkerJobMetadata): Promise<void> {
    await this.systemMetadataRepository.set(
      `${FLY_WORKER_JOB_PREFIX}${job.jobId}` as any,
      job as any,
    );
  }

  private async getWorkerJob(jobId: string): Promise<FlyWorkerJobMetadata | null> {
    const job = await this.systemMetadataRepository.get(
      `${FLY_WORKER_JOB_PREFIX}${jobId}` as any,
    );
    return job as FlyWorkerJobMetadata | null;
  }

  private async deleteWorkerJob(jobId: string): Promise<void> {
    await this.systemMetadataRepository.delete(
      `${FLY_WORKER_JOB_PREFIX}${jobId}` as any,
    );
  }
}
