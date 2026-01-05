import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthDto } from 'src/dtos/auth.dto';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import {
  GooglePhotosImportFromDriveDto,
  GooglePhotosImportJobDto,
  GooglePhotosImportProgressDto,
  GoogleDriveFilesResponseDto,
  ImportFromDriveWorkerDto,
  FlyWorkerJobResponseDto,
  WorkerProgressDto,
} from 'src/dtos/google-photos-import.dto';
import { GooglePhotosImportService } from 'src/services/google-photos-import.service';

@ApiTags('Google Photos Import')
@Controller('google-photos')
export class GooglePhotosImportController {
  constructor(private readonly importService: GooglePhotosImportService) {}

  @Post('import')
  @Authenticated()
  @UseInterceptors(FilesInterceptor('files'))
  @ApiOperation({ summary: 'Import Google Photos Takeout ZIP files' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Google Takeout ZIP files',
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
      },
    },
  })
  @ApiResponse({ status: 201, type: GooglePhotosImportJobDto })
  async importFromFiles(
    @Auth() auth: AuthDto,
    @UploadedFiles() files: Express.Multer.File[],
  ): Promise<GooglePhotosImportJobDto> {
    return this.importService.createImportJob(auth.user.id, files);
  }

  @Post('import-from-drive')
  @Authenticated()
  @ApiOperation({ summary: 'Import Google Photos Takeout from Google Drive' })
  @ApiResponse({ status: 201, type: GooglePhotosImportJobDto })
  async importFromDrive(
    @Auth() auth: AuthDto,
    @Body() dto: GooglePhotosImportFromDriveDto,
  ): Promise<GooglePhotosImportJobDto> {
    return this.importService.createImportJobFromDrive(auth.user.id, dto.fileIds);
  }

  @Post('import-from-drive-worker')
  @Authenticated()
  @ApiOperation({ summary: 'Import Google Photos Takeout from Google Drive using Fly worker' })
  @ApiResponse({ status: 201, type: FlyWorkerJobResponseDto })
  async importFromDriveWithWorker(
    @Auth() auth: AuthDto,
    @Body() dto: ImportFromDriveWorkerDto,
  ): Promise<FlyWorkerJobResponseDto> {
    if (dto.fileIds.length !== dto.fileSizes.length) {
      throw new BadRequestException('fileIds and fileSizes arrays must have the same length');
    }
    return this.importService.createImportJobWithFlyWorker(auth.user.id, dto.fileIds, dto.fileSizes);
  }

  @Post('worker-webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive progress updates from Fly worker' })
  async receiveWorkerWebhook(
    @Headers('x-webhook-signature') signature: string,
    @Req() req: Request,
    @Body() body: WorkerProgressDto,
  ): Promise<void> {
    if (!signature) {
      throw new BadRequestException('Missing webhook signature');
    }
    // Pass the raw body string for signature verification
    // The body has already been parsed, so we need to re-stringify it consistently
    const rawBody = JSON.stringify(body);
    await this.importService.handleWorkerWebhook(signature, body, rawBody);
  }

  @Get('import/:id/progress')
  @Authenticated()
  @ApiOperation({ summary: 'Get import job progress' })
  @ApiResponse({ status: 200, type: GooglePhotosImportProgressDto })
  async getProgress(
    @Auth() auth: AuthDto,
    @Param('id') jobId: string,
  ): Promise<GooglePhotosImportProgressDto | null> {
    // Try worker job first, then fall back to in-memory job
    return this.importService.getWorkerJobProgress(jobId);
  }

  @Delete('import/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Cancel import job' })
  async cancelImport(
    @Auth() auth: AuthDto,
    @Param('id') jobId: string,
  ): Promise<void> {
    // Try to cancel worker job first, then fall back to in-memory job
    return this.importService.cancelWorkerJob(jobId);
  }

  // Google Drive OAuth endpoints
  @Post('google-drive/auth')
  @Authenticated()
  @ApiOperation({ summary: 'Initiate Google Drive OAuth flow' })
  async initiateGoogleDriveAuth(@Auth() auth: AuthDto): Promise<{ authUrl: string }> {
    // Get OAuth config from Immich's system settings (reuse existing Google OAuth credentials)
    const oauth = await this.importService.getOAuthConfig();

    if (!oauth.enabled || !oauth.clientId) {
      console.error('[Google Drive] OAuth not configured in Immich settings');
      throw new Error('Google OAuth is not configured. Please set up OAuth in Administration > Settings > OAuth Authentication.');
    }

    // Use custom redirect URI for Google Drive callback, or construct from server URL
    const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI ||
      (process.env.IMMICH_URL ? `${process.env.IMMICH_URL}/api/google-photos/google-drive/callback` : null);

    if (!redirectUri) {
      console.error('[Google Drive] No redirect URI available');
      throw new Error('Google Drive redirect URI not configured. Please set IMMICH_URL or GOOGLE_DRIVE_REDIRECT_URI environment variable.');
    }

    // Request drive.readonly scope in addition to standard OAuth scopes
    const scopes = [
      'https://www.googleapis.com/auth/drive.readonly',
    ];

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', oauth.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent'); // Force consent to get refresh token
    authUrl.searchParams.set('state', auth.user.id);

    return { authUrl: authUrl.toString() };
  }

  @Get('google-drive/callback')
  @ApiOperation({ summary: 'Google Drive OAuth callback' })
  async handleGoogleDriveCallback(
    @Query('code') code: string,
    @Query('state') userId: string,
    @Query('error') error: string,
    @Res() res: Response,
  ): Promise<void> {
    if (error) {
      console.error('[Google Drive OAuth] Error from Google:', error);
      res.redirect('/utilities/google-photos-import?error=' + encodeURIComponent(error));
      return;
    }

    if (!code || !userId) {
      console.error('[Google Drive OAuth] Missing code or state');
      res.redirect('/utilities/google-photos-import?error=' + encodeURIComponent('Missing authorization code'));
      return;
    }

    try {
      // Get OAuth config from Immich's system settings
      const oauth = await this.importService.getOAuthConfig();
      const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI ||
        (process.env.IMMICH_URL ? `${process.env.IMMICH_URL}/api/google-photos/google-drive/callback` : null);

      if (!oauth.clientId || !oauth.clientSecret || !redirectUri) {
        console.error('[Google Drive OAuth] Missing OAuth configuration:', {
          hasClientId: !!oauth.clientId,
          hasClientSecret: !!oauth.clientSecret,
          hasRedirectUri: !!redirectUri,
        });
        throw new Error('Google OAuth not configured on server');
      }

      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: oauth.clientId,
          client_secret: oauth.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        console.error('[Google Drive OAuth] Token exchange failed:', errorText);
        throw new Error('Failed to exchange code for tokens');
      }

      const tokens = await tokenResponse.json();

      // Store tokens securely for this user
      await this.importService.saveGoogleDriveTokens(userId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
      });

      console.log('[Google Drive OAuth] Successfully connected for user:', userId);
      res.redirect('/utilities/google-photos-import?connected=true');
    } catch (err) {
      console.error('[Google Drive OAuth] Callback error:', err);
      const message = err instanceof Error ? err.message : 'Failed to connect';
      res.redirect('/utilities/google-photos-import?error=' + encodeURIComponent(message));
    }
  }

  @Delete('google-drive/auth')
  @Authenticated()
  @ApiOperation({ summary: 'Disconnect Google Drive' })
  async disconnectGoogleDrive(@Auth() auth: AuthDto): Promise<void> {
    await this.importService.deleteGoogleDriveTokens(auth.user.id);
  }

  @Get('google-drive/files')
  @Authenticated()
  @ApiOperation({ summary: 'List Takeout files in Google Drive' })
  @ApiResponse({ status: 200, type: GoogleDriveFilesResponseDto })
  async listDriveFiles(
    @Auth() auth: AuthDto,
    @Query('query') query?: string,
  ): Promise<GoogleDriveFilesResponseDto> {
    const tokens = await this.importService.getGoogleDriveTokens(auth.user.id);
    if (!tokens) {
      return { files: [] };
    }

    try {
      const files = await this.importService.getGoogleDriveFiles(tokens.accessToken);
      return { files };
    } catch (error) {
      // Token might be expired or invalid
      return { files: [] };
    }
  }

  @Get('google-drive/status')
  @Authenticated()
  @ApiOperation({ summary: 'Check Google Drive connection status' })
  async getConnectionStatus(
    @Auth() auth: AuthDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ connected: boolean }> {
    // Prevent caching so connection status is always fresh
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    const connected = await this.importService.isGoogleDriveConnected(auth.user.id);
    return { connected };
  }
}
