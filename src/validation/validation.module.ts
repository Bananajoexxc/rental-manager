import { Module } from '@nestjs/common';
import { ValidationService } from './validation.service';
import { RepairService } from './repair.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [ValidationService, RepairService],
  exports: [ValidationService, RepairService],
})
export class ValidationModule {}
