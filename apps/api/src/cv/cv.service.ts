import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { LocalUserService } from '../common/local-user.service';
import { UpdateCvDto } from './dto/update-cv.dto';

const BLANK_CV = {
  fullName: '',
  headline: '',
  email: '',
  phone: '',
  location: '',
  summary: '',
  links: [],
  skillGroups: [],
  experiences: [],
  projects: [],
  education: [],
  certifications: [],
  languages: [],
  interests: [],
  githubUsername: '',
  additionalContext: '',
  options: { fontSize: 12, compact: false, template: 'sidebar', accent: '#4f3ccb' },
};

@Injectable()
export class CvService {
  constructor(
    private prisma: PrismaService,
    private localUser: LocalUserService,
  ) {}

  async getDefaultUserId(): Promise<string> {
    return this.localUser.getDefaultUserId();
  }

  private toResponse(cv: { id: string; data: unknown }): Record<string, any> {
    return { id: cv.id, ...(cv.data as Record<string, any>) };
  }

  async getRawCV(userId: string) {
    const cv = await this.prisma.cV.findFirst({
      where: { userId },
    });

    if (cv) {
      return cv;
    }

    return this.prisma.cV.create({
      data: { userId, data: BLANK_CV },
    });
  }

  async getCV(userId: string): Promise<Record<string, any>> {
    return this.toResponse(await this.getRawCV(userId));
  }

  async createOrUpdateCV(userId: string, data: any) {
    // Check if CV exists
    const existingCV = await this.prisma.cV.findFirst({
      where: { userId },
    });

    const cv = existingCV
      ? await this.prisma.cV.update({
          where: { id: existingCV.id },
          data: { data },
        })
      : await this.prisma.cV.create({
          data: { userId, data },
        });

    return this.toResponse(cv);
  }

  async updateCV(userId: string, dto: UpdateCvDto) {
    const existing = await this.getRawCV(userId);

    // Merge with existing data. class-transformer initializes every declared
    // DTO field as an own property (value undefined) even when the request
    // never sent it, so a plain {...dto} spread would overwrite untouched
    // fields with undefined — only merge keys the request actually provided.
    const updatedData = { ...(existing.data as Record<string, any>) };
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined && key !== 'id') {
        updatedData[key] = value;
      }
    }

    const cv = await this.prisma.cV.update({
      where: { id: existing.id },
      data: {
        data: updatedData,
      },
    });

    return this.toResponse(cv);
  }

  async deleteCV(userId: string) {
    const cv = await this.getRawCV(userId);

    return this.prisma.cV.delete({
      where: { id: cv.id },
    });
  }

  async getPreview(userId: string) {
    return this.getCV(userId);
  }
}
