import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as path from 'path';
import { WebSocketServer } from 'ws';
import { ClaudeTerminalService } from './terminal/claude-terminal.service';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Set global API prefix
  app.setGlobalPrefix('api');

  // Enable graceful shutdown
  app.enableShutdownHooks();

  // Swagger API Documentation
  const config = new DocumentBuilder()
    .setTitle('Rental Manager API')
    .setDescription(
      'Headless background service for automated Hygglo rental tracking with AI-powered item extraction. ' +
      'This service continuously monitors rental listings, analyzes photos, and extracts item information.',
    )
    .setVersion('1.0')
    .addTag('Health', 'Service health and status monitoring')
    .addTag('Scanner', 'Rental scanner operations and status')
    .addTag('Rentals', 'Rental listings data access')
    .addTag('Items', 'Extracted items and catalog')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  
  // Add cache prevention middleware for Swagger docs
  app.use('/api-docs', (req: any, res: any, next: any) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
  });

  SwaggerModule.setup('api-docs', app, document, {
    customSiteTitle: 'Rental Manager API',
    customfavIcon: 'https://upload.wikimedia.org/wikipedia/commons/a/a8/NestJS.svg',
    customCss: `
      .swagger-ui .topbar { display: none; }
      .swagger-ui .info { margin: 30px 0; }
      .swagger-ui .info .title { font-size: 36px; color: #1a1a1a; font-weight: 600; }
      .swagger-ui .info .description { font-size: 15px; color: #555; line-height: 1.6; margin-top: 15px; }
      .swagger-ui .scheme-container { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; }
      .swagger-ui .opblock { border-radius: 8px; margin: 10px 0; border: 1px solid #e8e8e8; }
      .swagger-ui .opblock-tag { font-size: 20px; color: #2c3e50; font-weight: 500; }
      .swagger-ui .opblock .opblock-summary-method { border-radius: 6px; }
      .swagger-ui .btn { border-radius: 6px; }
      .swagger-ui .response-col_status { font-weight: 600; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', sans-serif; }
    `,
  });

  // Serve listing creator images as static files
  app.useStaticAssets(path.join(process.cwd(), 'listing-creator-images'), { prefix: '/listing-images' });

  const port = process.env.PORT || 3000;
  await app.listen(port);

  // Attach WebSocket server for Claude terminal
  const server = app.getHttpServer();
  const wss = new WebSocketServer({ noServer: true });
  const termService = new ClaudeTerminalService();

  server.on('upgrade', (req: any, socket: any, head: any) => {
    if (req.url === '/ws/terminal') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
    // Let other upgrade requests pass through (NestJS default handling)
  });

  wss.on('connection', (ws) => {
    logger.log('Terminal WebSocket connected');
    termService.attach(ws);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input') termService.write(msg.data);
        else if (msg.type === 'resize') termService.resize(msg.cols, msg.rows);
        else if (msg.type === 'kill') termService.kill();
      } catch { /* ignore malformed messages */ }
    });

    ws.on('close', () => {
      logger.log('Terminal WebSocket disconnected');
      termService.detach();
    });

    // Keepalive ping every 30s
    const ping = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
      else clearInterval(ping);
    }, 30_000);

    ws.on('close', () => clearInterval(ping));
  });

  logger.log(`🚀 Rental Manager Service is running on port ${port}`);
  logger.log(`📚 API Documentation available at http://localhost:${port}/api-docs`);
  logger.log(`📊 Dashboard available at http://localhost:${port}/dashboard`);
  logger.log(`🖥️  Terminal WebSocket available at ws://localhost:${port}/ws/terminal`);
  logger.log('🔍 Background scanning service has started...');
}

bootstrap();
