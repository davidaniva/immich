import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  ParseFilePipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiHeader, ApiTags } from '@nestjs/swagger';
import { NextFunction, Request, Response } from 'express';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import {
  AssetBulkUploadCheckResponseDto,
  AssetMediaResponseDto,
  AssetMediaStatus,
  CheckExistingAssetsResponseDto,
} from 'src/dtos/asset-media-response.dto';
import {
  AssetBulkUploadCheckDto,
  AssetMediaCreateDto,
  AssetMediaOptionsDto,
  AssetMediaReplaceDto,
  AssetMediaSize,
  CheckExistingAssetsDto,
  UploadFieldName,
} from 'src/dtos/asset-media.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { ApiTag, ImmichHeader, Permission, RouteKey, S3DeliveryMethod } from 'src/enum';
import { AssetUploadInterceptor } from 'src/middleware/asset-upload.interceptor';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard';
import { FileUploadInterceptor, getFiles } from 'src/middleware/file-upload.interceptor';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { StorageAdapterFactory } from 'src/repositories/storage/storage-adapter.factory';
import { AssetMediaService } from 'src/services/asset-media.service';
import { SystemConfigService } from 'src/services/system-config.service';
import { UploadFiles } from 'src/types';
import { cacheControlHeaders, ImmichFileResponse, ImmichS3Response, sendFile } from 'src/utils/file';
import { FileNotEmptyValidator, UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
export class AssetMediaController {
  constructor(
    private logger: LoggingRepository,
    private service: AssetMediaService,
    private configService: SystemConfigService,
    private storageAdapterFactory: StorageAdapterFactory,
  ) {}

  private async handleS3Response(res: Response, s3Response: ImmichS3Response): Promise<void> {
    const config = await this.configService.getSystemConfig();
    const s3Config = config.storage.s3;

    const cacheHeader = cacheControlHeaders[s3Response.cacheControl];
    if (cacheHeader) {
      res.set('Cache-Control', cacheHeader);
    }

    if (s3Response.fileName) {
      res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(s3Response.fileName)}`);
    }

    if (s3Config.delivery === S3DeliveryMethod.Redirect) {
      // Generate presigned URL and redirect client to S3
      const s3Adapter = this.storageAdapterFactory.getS3Adapter(s3Config);
      const presignedUrl = await s3Adapter.getPresignedDownloadUrl(s3Response.s3Key, {
        expiresIn: s3Config.presignedUrlExpiry,
      });
      res.redirect(presignedUrl);
    } else {
      // Proxy mode: stream from S3 through the server
      const s3Adapter = this.storageAdapterFactory.getS3Adapter(s3Config);
      const { stream, length, type } = await s3Adapter.readStream(s3Response.s3Key);

      res.set('Content-Type', s3Response.contentType || type || 'application/octet-stream');
      if (length) {
        res.set('Content-Length', length.toString());
      }

      stream.pipe(res);
    }
  }

  @Post()
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  @UseInterceptors(AssetUploadInterceptor, FileUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiHeader({
    name: ImmichHeader.Checksum,
    description: 'sha1 checksum that can be used for duplicate detection before the file is uploaded',
    required: false,
  })
  @ApiBody({ description: 'Asset Upload Information', type: AssetMediaCreateDto })
  @Endpoint({
    summary: 'Upload asset',
    description: 'Uploads a new asset to the server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async uploadAsset(
    @Auth() auth: AuthDto,
    @UploadedFiles(new ParseFilePipe({ validators: [new FileNotEmptyValidator(['assetData'])] })) files: UploadFiles,
    @Body() dto: AssetMediaCreateDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AssetMediaResponseDto> {
    const { file, sidecarFile } = getFiles(files);
    const responseDto = await this.service.uploadAsset(auth, dto, file, sidecarFile);

    if (responseDto.status === AssetMediaStatus.DUPLICATE) {
      res.status(HttpStatus.OK);
    }

    return responseDto;
  }

  @Get(':id/original')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
  @Endpoint({
    summary: 'Download original asset',
    description: 'Downloads the original file of the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async downloadAsset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    const response = await this.service.downloadOriginal(auth, id);

    if (response instanceof ImmichS3Response) {
      return this.handleS3Response(res, response);
    }

    await sendFile(res, next, () => Promise.resolve(response), this.logger);
  }

  @Put(':id/original')
  @UseInterceptors(FileUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @Endpoint({
    summary: 'Replace asset',
    description: 'Replace the asset with new file, without changing its id.',
    history: new HistoryBuilder().added('v1').deprecated('v1', { replacementId: 'copyAsset' }),
  })
  @Authenticated({ permission: Permission.AssetReplace, sharedLink: true })
  async replaceAsset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @UploadedFiles(new ParseFilePipe({ validators: [new FileNotEmptyValidator([UploadFieldName.ASSET_DATA])] }))
    files: UploadFiles,
    @Body() dto: AssetMediaReplaceDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AssetMediaResponseDto> {
    const { file } = getFiles(files);
    const responseDto = await this.service.replaceAsset(auth, id, dto, file);
    if (responseDto.status === AssetMediaStatus.DUPLICATE) {
      res.status(HttpStatus.OK);
    }
    return responseDto;
  }

  @Get(':id/thumbnail')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'View asset thumbnail',
    description: 'Retrieve the thumbnail image for the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async viewAsset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: AssetMediaOptionsDto,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    const viewThumbnailRes = await this.service.viewThumbnail(auth, id, dto);

    if (viewThumbnailRes instanceof ImmichFileResponse) {
      await sendFile(res, next, () => Promise.resolve(viewThumbnailRes), this.logger);
    } else if (viewThumbnailRes instanceof ImmichS3Response) {
      return this.handleS3Response(res, viewThumbnailRes);
    } else {
      // viewThumbnailRes is a AssetMediaRedirectResponse
      // which redirects to the original asset or a specific size to make better use of caching
      const { targetSize } = viewThumbnailRes;
      const [reqPath, reqSearch] = req.url.split('?');
      let redirPath: string;
      const redirSearchParams = new URLSearchParams(reqSearch);
      if (targetSize === 'original') {
        // relative path to this.downloadAsset
        redirPath = 'original';
        redirSearchParams.delete('size');
      } else if (Object.values(AssetMediaSize).includes(targetSize)) {
        redirPath = reqPath;
        redirSearchParams.set('size', targetSize);
      } else {
        throw new Error('Invalid targetSize: ' + targetSize);
      }
      const finalRedirPath = redirPath + '?' + redirSearchParams.toString();
      return res.redirect(finalRedirPath);
    }
  }

  @Get(':id/video/playback')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'Play asset video',
    description: 'Streams the video file for the specified asset. This endpoint also supports byte range requests.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async playAssetVideo(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    const response = await this.service.playbackVideo(auth, id);

    if (response instanceof ImmichS3Response) {
      return this.handleS3Response(res, response);
    }

    await sendFile(res, next, () => Promise.resolve(response), this.logger);
  }

  @Post('exist')
  @Authenticated()
  @Endpoint({
    summary: 'Check existing assets',
    description: 'Checks if multiple assets exist on the server and returns all existing - used by background backup',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  @HttpCode(HttpStatus.OK)
  checkExistingAssets(
    @Auth() auth: AuthDto,
    @Body() dto: CheckExistingAssetsDto,
  ): Promise<CheckExistingAssetsResponseDto> {
    return this.service.checkExistingAssets(auth, dto);
  }

  @Post('bulk-upload-check')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Check bulk upload',
    description: 'Determine which assets have already been uploaded to the server based on their SHA1 checksums.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  @HttpCode(HttpStatus.OK)
  checkBulkUpload(
    @Auth() auth: AuthDto,
    @Body() dto: AssetBulkUploadCheckDto,
  ): Promise<AssetBulkUploadCheckResponseDto> {
    return this.service.bulkUploadCheck(auth, dto);
  }
}
