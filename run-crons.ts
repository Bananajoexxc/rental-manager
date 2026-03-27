import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { AutonomousService } from './src/autonomous/autonomous.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const autonomousService = app.get(AutonomousService);
  
  console.log('Running autoExtractAndFixTimes...');
  await autonomousService.autoExtractAndFixTimes();
  
  console.log('Running healthPing...');
  await autonomousService.healthPing();
  
  await app.close();
  console.log('Done!');
}

bootstrap();
