import { Injectable, Logger } from '@nestjs/common';

interface MachineConfig {
  name: string;
  region: string;
  env: Record<string, string>;
  volumeId: string;
  volumePath: string;
  memoryMb?: number;
  cpus?: number;
}

interface FlyVolume {
  id: string;
  name: string;
  size_gb: number;
  region: string;
  state: string;
}

interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
}

@Injectable()
export class FlyWorkerService {
  private readonly logger = new Logger(FlyWorkerService.name);
  private readonly apiBase = 'https://api.machines.dev/v1';

  private get apiToken(): string {
    const token = process.env.FLY_API_TOKEN;
    if (!token) {
      throw new Error('FLY_API_TOKEN environment variable is not set');
    }
    return token;
  }

  private get appName(): string {
    return process.env.FLY_WORKER_APP_NAME || 'immich-import-worker';
  }

  private get workerImage(): string {
    return process.env.FLY_WORKER_IMAGE || 'registry.fly.io/immich-import-worker:latest';
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.apiBase}${path}`;
    this.logger.debug(`Fly API ${method} ${url}`);

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Fly API error: ${response.status} ${errorText}`);
      throw new Error(`Fly API error: ${response.status} ${errorText}`);
    }

    // Some endpoints return no content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * Create a volume for the worker to store downloaded files
   */
  async createVolume(sizeGb: number, region: string = 'ord'): Promise<string> {
    const name = `vol_${Date.now()}`;

    this.logger.log(`Creating volume ${name} with ${sizeGb}GB in ${region}`);

    const volume = await this.request<FlyVolume>('POST', `/apps/${this.appName}/volumes`, {
      name,
      size_gb: sizeGb,
      region,
      // Volumes are auto-destroyed when machines using them are destroyed
      auto_backup_enabled: false,
    });

    this.logger.log(`Created volume ${volume.id}`);
    return volume.id;
  }

  /**
   * Delete a volume
   */
  async deleteVolume(volumeId: string): Promise<void> {
    this.logger.log(`Deleting volume ${volumeId}`);
    await this.request('DELETE', `/apps/${this.appName}/volumes/${volumeId}`);
    this.logger.log(`Deleted volume ${volumeId}`);
  }

  /**
   * Create and start an ephemeral worker machine
   */
  async createMachine(config: MachineConfig): Promise<string> {
    this.logger.log(`Creating machine ${config.name} in ${config.region}`);

    const machine = await this.request<FlyMachine>('POST', `/apps/${this.appName}/machines`, {
      name: config.name,
      region: config.region,
      config: {
        image: this.workerImage,
        env: config.env,
        mounts: [
          {
            volume: config.volumeId,
            path: config.volumePath,
          },
        ],
        guest: {
          cpu_kind: 'shared',
          cpus: config.cpus || 2,
          memory_mb: config.memoryMb || 2048,
        },
        // Auto-destroy when the process exits
        auto_destroy: true,
        // Restart policy - don't restart, let it die
        restart: {
          policy: 'no',
        },
      },
    });

    this.logger.log(`Created machine ${machine.id}`);
    return machine.id;
  }

  /**
   * Force destroy a machine
   */
  async destroyMachine(machineId: string): Promise<void> {
    this.logger.log(`Destroying machine ${machineId}`);
    try {
      // First try to stop it
      await this.request('POST', `/apps/${this.appName}/machines/${machineId}/stop`);
    } catch (error) {
      // Ignore stop errors, machine might already be stopped
      this.logger.debug(`Stop failed (may be already stopped): ${error}`);
    }

    try {
      // Then destroy it
      await this.request('DELETE', `/apps/${this.appName}/machines/${machineId}?force=true`);
      this.logger.log(`Destroyed machine ${machineId}`);
    } catch (error) {
      this.logger.warn(`Failed to destroy machine ${machineId}: ${error}`);
      throw error;
    }
  }

  /**
   * Get machine status
   */
  async getMachineStatus(machineId: string): Promise<string> {
    const machine = await this.request<FlyMachine>(
      'GET',
      `/apps/${this.appName}/machines/${machineId}`,
    );
    return machine.state;
  }

  /**
   * List all machines in the worker app (for cleanup purposes)
   */
  async listMachines(): Promise<FlyMachine[]> {
    return this.request<FlyMachine[]>('GET', `/apps/${this.appName}/machines`);
  }

  /**
   * List all volumes in the worker app (for cleanup purposes)
   */
  async listVolumes(): Promise<FlyVolume[]> {
    return this.request<FlyVolume[]>('GET', `/apps/${this.appName}/volumes`);
  }

  /**
   * Calculate required volume size from file sizes (in bytes)
   * Returns size in GB with buffer for extraction
   */
  calculateVolumeSizeGb(fileSizes: number[]): number {
    const totalBytes = fileSizes.reduce((sum, size) => sum + size, 0);
    // Convert to GB, add 5GB buffer for extraction overhead
    const sizeGb = Math.ceil(totalBytes / (1024 * 1024 * 1024)) + 5;
    // Minimum 10GB, maximum 100GB
    return Math.max(10, Math.min(100, sizeGb));
  }

  /**
   * Create a complete worker setup: volume + machine
   */
  async createWorker(config: {
    jobId: string;
    fileIds: string[];
    fileSizes: number[];
    accessToken: string;
    refreshToken?: string;
    immichApiKey: string;
    webhookUrl: string;
    webhookSecret: string;
    immichServerUrl: string;
    googleClientId: string;
    googleClientSecret: string;
    region?: string;
  }): Promise<{ machineId: string; volumeId: string }> {
    const region = config.region || 'ord';
    const volumeSizeGb = this.calculateVolumeSizeGb(config.fileSizes);
    this.logger.log(`Creating worker for job ${config.jobId}: ${config.fileIds.length} files, ${volumeSizeGb}GB volume`);

    // Create volume
    const volumeId = await this.createVolume(volumeSizeGb, region);

    try {
      // Create machine with environment configuration
      const machineId = await this.createMachine({
        name: `import-${config.jobId.slice(0, 8)}`,
        region,
        volumeId,
        volumePath: '/data',
        env: {
          WORKER_JOB_ID: config.jobId,
          WORKER_FILE_IDS: JSON.stringify(config.fileIds),
          WORKER_ACCESS_TOKEN: config.accessToken,
          WORKER_REFRESH_TOKEN: config.refreshToken || '',
          GOOGLE_CLIENT_ID: config.googleClientId,
          GOOGLE_CLIENT_SECRET: config.googleClientSecret,
          IMMICH_SERVER_URL: config.immichServerUrl,
          IMMICH_API_KEY: config.immichApiKey,
          WEBHOOK_URL: config.webhookUrl,
          WEBHOOK_SECRET: config.webhookSecret,
          VOLUME_PATH: '/data',
        },
      });

      return { machineId, volumeId };
    } catch (error) {
      // Clean up volume if machine creation fails
      this.logger.error(`Machine creation failed, cleaning up volume ${volumeId}`);
      try {
        await this.deleteVolume(volumeId);
      } catch (cleanupError) {
        this.logger.warn(`Failed to cleanup volume: ${cleanupError}`);
      }
      throw error;
    }
  }

  /**
   * Clean up a worker: destroy machine and volume
   */
  async cleanupWorker(machineId: string, volumeId: string): Promise<void> {
    this.logger.log(`Cleaning up worker: machine=${machineId}, volume=${volumeId}`);

    // Destroy machine first (volumes can only be deleted when not attached)
    try {
      await this.destroyMachine(machineId);
    } catch (error) {
      this.logger.warn(`Failed to destroy machine: ${error}`);
    }

    // Wait a bit for the machine to fully terminate
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Delete volume
    try {
      await this.deleteVolume(volumeId);
    } catch (error) {
      this.logger.warn(`Failed to delete volume: ${error}`);
    }
  }
}
