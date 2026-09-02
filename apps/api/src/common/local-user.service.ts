import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

const LOCAL_USER_EMAIL = 'me@local';

@Injectable()
export class LocalUserService {
  constructor(private prisma: PrismaService) {}

  async getDefaultUserId(): Promise<string> {
    const user = await this.prisma.user.upsert({
      where: { email: LOCAL_USER_EMAIL },
      update: {},
      create: { email: LOCAL_USER_EMAIL, name: 'Me' },
    });

    return user.id;
  }
}
