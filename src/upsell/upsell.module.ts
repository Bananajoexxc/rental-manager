import { Module } from '@nestjs/common';
import { UpsellService } from './upsell.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [UpsellService],
  exports: [UpsellService],
})
export class UpsellModule {}
