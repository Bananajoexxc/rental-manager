import { Module } from '@nestjs/common';
import { ValidationService } from './validation.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [ValidationService],
  exports: [ValidationService],
})
export class ValidationModule {}
